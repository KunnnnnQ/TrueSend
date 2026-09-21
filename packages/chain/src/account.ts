import type {Address, PublicClient} from "viem";

/**
 * What kind of account an address is, in the one sense this project cares about: whether
 * `tx.from` can ever be equal to it.
 *
 * Everything in the engine rests on comparing the owner against the transaction signer, and that
 * comparison is only meaningful for an account that signs. Getting the kind wrong in one
 * direction turns every payment a user made into a fabrication; in the other it would accept a
 * fabrication as a payment. So it is read from the chain rather than assumed, and the rule is
 * EIP-7702's, not a guess:
 *
 * > EOAs whose code is a valid delegation indicator, i.e. `0xef0100 || address`, to originate
 * > transactions. Accounts with any other code values may not originate transactions.
 *
 * Which gives exactly three cases, and only the third changes anything.
 */
export type AccountKind =
  /** No code. Signs its own transactions, and `tx.from` is the whole test. */
  | "eoa"
  /**
   * An EOA with an EIP-7702 delegation installed — including one running this project's own
   * `GuardedAccount`. Still an EOA underneath and still signs, so it is treated as one. Reading
   * "has code, therefore a contract" here would break the detector for exactly the users this
   * project asks to install a delegation.
   */
  | "delegated-eoa"
  /**
   * A contract account: an ERC-4337 smart account, a Safe, anything else with real code. It can
   * never originate a transaction, so it never appears as `tx.from` and "they did not sign it"
   * is the only thing that can ever be true of its transfers.
   */
  | "contract";

/** EIP-7702 writes exactly `0xef0100 || address`: three magic bytes and twenty more. */
// Case-insensitive: hex is, and a node that answered in upper case would otherwise have every
// delegated account read as a contract — which is the one misclassification that matters here.
const DELEGATION_DESIGNATOR = /^0xef0100[0-9a-f]{40}$/i;

/**
 * Classify an account from its code.
 *
 * Split out from the request so it can be tested against the byte strings that matter without a
 * node. Absent or empty code means a plain EOA, which is also the safe answer when a caller has
 * nothing: it keeps the strict signer test rather than relaxing it.
 */
export function classifyAccount(code: string | null | undefined): AccountKind {
  if (!code || code === "0x") return "eoa";
  return DELEGATION_DESIGNATOR.test(code) ? "delegated-eoa" : "contract";
}

/** Whether `tx.from === owner` is a test that can ever pass for this kind of account. */
export function canSignOwnTransactions(kind: AccountKind): boolean {
  return kind !== "contract";
}

/**
 * Ask the chain what kind of account this is. One `eth_getCode`, once per scan.
 *
 * A failure answers `eoa`, which is the conservative direction: it keeps the strict signer test
 * and can only produce a warning that should not have fired, never silence one that should.
 */
export async function accountKind(client: PublicClient, address: Address): Promise<AccountKind> {
  try {
    return classifyAccount(await client.getCode({address}));
  } catch {
    return "eoa";
  }
}
