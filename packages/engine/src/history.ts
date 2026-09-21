import {normalizeAddress, type Address} from "./address.js";
import type {AddressSighting} from "./types.js";

/**
 * One `Transfer` log, plus the one fact the log itself cannot tell you.
 *
 * `from` is what the log claims. `signer` is who actually sent the transaction. Keeping them as
 * separate fields rather than collapsing them is the whole point of this module: a log naming an
 * address as sender is not evidence that address sent anything, and every consumer that forgets
 * this rebuilds the same vulnerability independently.
 */
export interface TransferRecord {
  /** ERC-20 contract address, or `address(0)` for native value. */
  token: Address;
  /** The address the log names as the sender. */
  from: Address;
  to: Address;
  value: bigint;
  /** Unix seconds. */
  at: number;
  /** `tx.from` — the address that actually signed the transaction carrying this log. */
  signer: Address;
  /**
   * Whether an inbound transfer is small enough to be unsolicited dust.
   *
   * Decided by the caller because it needs the token's decimals and some idea of its price,
   * neither of which belongs in a pure module.
   */
  dust?: boolean;
  txHash?: string;
}

/** Mints and burns name this address; it is not an account anyone can be paid at. */
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/**
 * Fold a raw transfer list into one summary per counterparty.
 *
 * The rule that matters is four lines down: a transfer log naming the owner as sender counts as a
 * payment they made **only if they signed the transaction**. Otherwise it is a fabrication, and it
 * goes to `spoofedOutgoingCount` instead of to `outgoingCount`.
 *
 * Getting this backwards does not merely lose a signal, it inverts one. A fabricated outgoing
 * record read as genuine makes an attacker look like a counterparty the user has already paid —
 * which is precisely the effect the attacker paid gas for. See `analysis/README.md` for how often
 * this happens in practice; in the sampled window it was 99.88% of zero-value USDT transfers.
 */
export function foldHistory(
  owner: string,
  transfers: readonly TransferRecord[],
): AddressSighting[] {
  const me = normalizeAddress(owner);
  const byCounterparty = new Map<Address, AddressSighting>();
  const held = tokensTheOwnerHasHeld(me, transfers);

  const entryFor = (address: Address, at: number): AddressSighting => {
    let entry = byCounterparty.get(address);
    if (!entry) {
      entry = {
        address,
        outgoingCount: 0,
        incomingCount: 0,
        zeroValueIncoming: 0,
        dustIncoming: 0,
        spoofedOutgoingCount: 0,
        firstSeenAt: at,
        lastSeenAt: at,
      };
      byCounterparty.set(address, entry);
    }
    entry.firstSeenAt = Math.min(entry.firstSeenAt, at);
    entry.lastSeenAt = Math.max(entry.lastSeenAt, at);
    return entry;
  };

  for (const transfer of transfers) {
    const from = normalizeAddress(transfer.from);
    const to = normalizeAddress(transfer.to);

    // Self-transfers tell us nothing about a counterparty.
    if (from === to) continue;
    // A transfer to or from the zero address is a mint or a burn. Listing it as a counterparty
    // puts a row in the user's address book for something that is not an account.
    if (from === ZERO || to === ZERO) continue;

    if (from === me) {
      const entry = entryFor(to, transfer.at);
      if (normalizeAddress(transfer.signer) === me) {
        entry.outgoingCount++;
        entry.lastOutgoingAt = Math.max(entry.lastOutgoingAt ?? 0, transfer.at);
      } else if (couldHaveMoved(transfer, held)) {
        entry.authorisedOutgoingCount = (entry.authorisedOutgoingCount ?? 0) + 1;
      } else {
        entry.spoofedOutgoingCount++;
      }
      continue;
    }

    if (to === me) {
      const entry = entryFor(from, transfer.at);
      entry.incomingCount++;
      if (transfer.value === 0n) entry.zeroValueIncoming++;
      else if (transfer.dust) entry.dustIncoming++;
    }
  }

  return [...byCounterparty.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/**
 * Could this transfer have moved something the owner actually had?
 *
 * The question the fold has to answer before calling a record a fabrication. Its two halves are
 * settled very differently.
 *
 * **Zero value settles itself.** Nothing moved, so it cannot have been a payment — and it cannot
 * have been a settlement either, because nobody settles nothing. This is the classic poisoning
 * primitive: a zero-value `transferFrom` needs no allowance on most tokens, costs a little gas,
 * and plants a payment that never happened. In a sampled window, 99.88% of zero-value USDT
 * transfers named a sender who had not signed.
 *
 * **Nonzero turns on whether the owner ever had the token.** Nobody can authorise the movement of
 * something they never held, so a nonzero record of a token that has never once arrived in this
 * history, and that the owner has never signed for, is a fabrication whoever signed it. That is
 * exactly the shape of the May 2024 WBTC bait: a contract the attacker deployed, symbol `ETH`,
 * a single log naming the victim as sender, and — checked on chain — not one transfer of it ever
 * going *to* the victim. Where the owner has held it, a third party moving it is an ordinary
 * authorised movement, and calling that an attack is crying wolf at a solver.
 *
 * **What this gives up.** An attacker who also emits a fake *incoming* log of their own token
 * makes the owner look like a holder and buys the exemption, for the price of one more log.
 * Nothing here stops that, and no rule reading only logs and signatures can: the token contract
 * belongs to the attacker, so every claim it makes is theirs to choose. What the rule does is
 * make the cheapest form of the attack — one log, no setup — fail. The defence does not rest on
 * it alone either; the contracts never consult this score, and an unknown recipient is held
 * regardless of what it says.
 */
function couldHaveMoved(transfer: TransferRecord, held: ReadonlySet<Address>): boolean {
  return transfer.value > 0n && held.has(normalizeAddress(transfer.token));
}

/**
 * Tokens this history shows the owner actually having, established two ways.
 *
 * **Something arrived** — a transfer of it to the owner carrying value. Receiving needs no
 * signature, and that is the whole point. An earlier version of this reasoning asked whether the
 * owner had ever *signed* a transfer of the token and concluded that otherwise they had never
 * held it. That is false, and false in the expensive direction: a wallet paid in USDC that sells
 * it through a gasless permit never signs anything touching USDC, so every counterparty it ever
 * had would have been called an attacker.
 *
 * **Or they moved it themselves** — a transfer they signed. Nobody signs away what they do not
 * have.
 *
 * Zero-value arrivals do not count. A zero-value inbound is itself a poisoning primitive, and
 * letting one establish a holding would hand the exemption to the thing being detected.
 *
 * Bounded by whatever history it is given: a token received before the start of the scanned
 * window looks unheld. That costs a false alarm, never a miss — the right way round for a limit
 * that cannot be removed without an archive node.
 */
function tokensTheOwnerHasHeld(
  owner: Address,
  transfers: readonly TransferRecord[],
): ReadonlySet<Address> {
  const held = new Set<Address>();

  for (const transfer of transfers) {
    const token = normalizeAddress(transfer.token);
    if (normalizeAddress(transfer.to) === owner && transfer.value > 0n) held.add(token);
    if (normalizeAddress(transfer.from) === owner && normalizeAddress(transfer.signer) === owner) {
      held.add(token);
    }
  }

  return held;
}

/**
 * Every counterparty in a folded history, newest first.
 *
 * Convenience for the Scan screen, which assesses the whole address book rather than one
 * recipient.
 */
export function counterparties(history: readonly AddressSighting[]): Address[] {
  return history.map((entry) => entry.address);
}
