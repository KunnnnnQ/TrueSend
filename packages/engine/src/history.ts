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
  /**
   * `tx.from` — the address that actually signed the transaction carrying this log.
   *
   * Only ever read for a log that names the owner as the sender: that is the one claim a signature
   * makes true or false. A transfer the owner merely received reads the same whoever sent it, so a
   * scan may leave this out there, and `scanHistory` does — across the histories of the 143
   * victims in `analysis/`'s Poison-Hunter replay, 32% of transactions were received-only.
   * Missing on a log that does name the owner as sender, it counts as not signed by the owner:
   * a record nobody has seen the owner's signature on is never taken for their payment.
   */
  signer?: Address;
  /**
   * Whether an inbound transfer is small enough to be unsolicited dust.
   *
   * Decided by the caller because it needs the token's decimals and some idea of its price,
   * neither of which belongs in a pure module.
   */
  dust?: boolean;
  txHash?: string;
}

/**
 * A `Transfer` log the scan could not check: who signed its transaction, or when its block was,
 * never came back from the endpoint.
 *
 * Folded in as nothing more than the fact that it exists. It cannot be a payment, since nobody has
 * seen the owner's signature on it, and it cannot be called a fabrication, since nobody has seen
 * anyone else's. What it can still do is keep the address involved from looking settled — see
 * `AddressSighting.uncheckedCount`.
 */
export interface UncheckedTransfer {
  token: Address;
  from: Address;
  to: Address;
  value: bigint;
  txHash?: string;
}

/** Whether `address` signed the transaction carrying this transfer, as far as anyone checked. */
export function signedBy(transfer: Pick<TransferRecord, "signer">, address: Address): boolean {
  return transfer.signer !== undefined && normalizeAddress(transfer.signer) === address;
}

/** Mints and burns name this address; it is not an account anyone can be paid at. */
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/**
 * Fold a raw transfer list into one summary per counterparty.
 *
 * The rule that matters is four lines down: a transfer log naming the owner as sender counts as a
 * payment they made **only if they signed the transaction**. Otherwise it is not `outgoingCount`,
 * whatever else it might be — see `couldHaveMoved` for the one exception, and the paragraph below
 * for why there is only one.
 *
 * Getting this backwards does not merely lose a signal, it inverts one. A fabricated outgoing
 * record read as genuine makes an attacker look like a counterparty the user has already paid —
 * which is precisely the effect the attacker paid gas for. See `analysis/README.md` for how often
 * this happens in practice; in the sampled window it was 99.88% of zero-value USDT transfers.
 *
 * A contract account — an ERC-4337 smart account, a Safe, anything with real code — can never be
 * `tx.from`, so `theySignedIt` below is always false for one. This function does not special-case
 * that. **An earlier version did**: it reasoned that a contract's balance only moves when its own
 * code moves it, so a value-moving record against a held token must be the account's own doing,
 * and credited it as `outgoingCount` the same as a real signature. That reasoning has exactly the
 * hole this whole module exists to close, one layer up: `held` is established by reading a
 * `Transfer` log, and a log is not evidence — a token contract the attacker deployed can emit
 * "the account received one wei of my token" for the price of nothing, and "the account sent me
 * some more of it" right after, and the fold read that as a genuine payment with no signature
 * anywhere in the chain of reasoning. That is strictly worse than the plain fabrication it was
 * supposed to catch: a plain fabrication lands in `spoofedOutgoingCount` and scores danger; this
 * landed in `outgoingCount` and **suppressed every baseline suspicion**, including the fact that
 * the address had never been seen before. Caught with a two-log reproduction before it shipped
 * anywhere; see `packages/chain/src/account.ts` for the account classification this was trying to
 * use, which is correct and still used elsewhere — the mistake was routing it into a decision this
 * module cannot make safely, not the classification itself.
 *
 * So a contract account gets exactly the same treatment as a third party settling for an EOA: a
 * value-moving record lands in `authorisedOutgoingCount`, never in `outgoingCount`. The cost is
 * real and is not hidden — `assessAddress` builds its payee set from `outgoingCount > 0`, so a
 * smart-account owner has no payees and the lookalike rule has nothing to compare against for one.
 * The fabrication rule (`spoofedOutgoingCount`) is unaffected and is the one that matters more: it
 * needs no payee, and it is what would have caught the May 2024 case regardless of account kind.
 * `docs/threat-model.md` records the lookalike gap as an open limitation rather than a closed one.
 *
 * `unchecked` is what the scan could not check, and it only ever reaches `uncheckedCount`: not the
 * payments, not the fabrications, not the tokens the owner is taken to hold, not the times.
 */
export function foldHistory(
  owner: string,
  transfers: readonly TransferRecord[],
  unchecked: readonly UncheckedTransfer[] = [],
): AddressSighting[] {
  const me = normalizeAddress(owner);
  const byCounterparty = new Map<Address, AddressSighting>();
  const held = tokensTheOwnerHasHeld(me, transfers);

  const entryFor = (address: Address, at?: number): AddressSighting => {
    let entry = byCounterparty.get(address);
    if (!entry) {
      entry = {
        address,
        outgoingCount: 0,
        incomingCount: 0,
        zeroValueIncoming: 0,
        dustIncoming: 0,
        spoofedOutgoingCount: 0,
      };
      byCounterparty.set(address, entry);
    }
    if (at !== undefined) {
      entry.firstSeenAt = Math.min(entry.firstSeenAt ?? at, at);
      entry.lastSeenAt = Math.max(entry.lastSeenAt ?? at, at);
    }
    return entry;
  };

  for (const transfer of transfers) {
    const from = normalizeAddress(transfer.from);
    const to = normalizeAddress(transfer.to);
    if (!aCounterparty(from, to)) continue;

    if (from === me) {
      const entry = entryFor(to, transfer.at);
      const theySignedIt = signedBy(transfer, me);
      const valueMoved = couldHaveMoved(transfer, held);

      // `theySignedIt` needs no account-kind check to be safe: it is structurally false for a
      // contract account (nothing without a private key can ever be `tx.from`) and only true for
      // an EOA that genuinely signed. See the doc comment above for the branch this replaced.
      if (theySignedIt) {
        entry.outgoingCount++;
        entry.lastOutgoingAt = Math.max(entry.lastOutgoingAt ?? 0, transfer.at);
        entry.firstOutgoingAt = Math.min(entry.firstOutgoingAt ?? Infinity, transfer.at);
      } else if (valueMoved) {
        entry.authorisedOutgoingCount = (entry.authorisedOutgoingCount ?? 0) + 1;
      } else {
        entry.spoofedOutgoingCount++;
        entry.firstSpoofedAt = Math.min(entry.firstSpoofedAt ?? Infinity, transfer.at);
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

  for (const record of unchecked) {
    const from = normalizeAddress(record.from);
    const to = normalizeAddress(record.to);
    if (!aCounterparty(from, to)) continue;

    const other = from === me ? to : to === me ? from : undefined;
    if (other === undefined) continue;
    const entry = entryFor(other);
    entry.uncheckedCount = (entry.uncheckedCount ?? 0) + 1;
  }

  // An address the scan could not put a time on goes first, where it is hardest to miss.
  return [...byCounterparty.values()].sort((a, b) => {
    if (a.lastSeenAt === undefined || b.lastSeenAt === undefined) {
      return (a.lastSeenAt === undefined ? 0 : 1) - (b.lastSeenAt === undefined ? 0 : 1);
    }
    return b.lastSeenAt - a.lastSeenAt;
  });
}

/**
 * Whether a transfer names a counterparty at all.
 *
 * A self-transfer tells us nothing about one. A transfer to or from the zero address is a mint or
 * a burn, and listing it would put a row in the user's address book for something that is not an
 * account. Transfers between two other parties pass here and are skipped by the caller.
 */
function aCounterparty(from: Address, to: Address): boolean {
  return from !== to && from !== ZERO && to !== ZERO;
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
    if (normalizeAddress(transfer.from) === owner && signedBy(transfer, owner)) {
      held.add(token);
    }
  }

  return held;
}

/**
 * Records a token contract made up about this owner, counted per token.
 *
 * A record of the owner *sending* a nonzero amount, in a transaction the owner did not sign, of a
 * token the owner has never held. Nobody can authorise moving what was never there, so the
 * contract wrote a transfer it had no balance for. It is the test `foldHistory` uses to call such
 * a record a fabrication (`couldHaveMoved`), asked about the token instead of the counterparty, and
 * it does not care what the token calls itself — which is the point: on live accounts it caught a
 * "cbBTC" that is not Coinbase's and two contracts with no name at all, none of which a rule about
 * names could see.
 *
 * Zero-value records are left out on purpose. They are the commonest poisoning primitive, but they
 * run on real tokens — most planted lookalikes arrive through USDT's and USDC's own zero-value
 * `transferFrom` — so they say nothing about whether the contract itself is genuine.
 *
 * Bounded by the history it is given, like `tokensTheOwnerHasHeld`: a real token received before
 * the scanned window, then moved by somebody the owner authorised, looks forged here.
 */
export function forgedTransfersByToken(
  owner: string,
  transfers: readonly TransferRecord[],
): Map<Address, number> {
  const me = normalizeAddress(owner);
  const held = tokensTheOwnerHasHeld(me, transfers);
  const forged = new Map<Address, number>();

  for (const transfer of transfers) {
    if (normalizeAddress(transfer.from) !== me) continue;
    if (signedBy(transfer, me) || transfer.value === 0n) continue;
    const token = normalizeAddress(transfer.token);
    if (held.has(token)) continue;
    forged.set(token, (forged.get(token) ?? 0) + 1);
  }

  return forged;
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
