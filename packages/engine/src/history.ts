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
 * Every counterparty in a folded history, newest first.
 *
 * Convenience for the Scan screen, which assesses the whole address book rather than one
 * recipient.
 */
export function counterparties(history: readonly AddressSighting[]): Address[] {
  return history.map((entry) => entry.address);
}
