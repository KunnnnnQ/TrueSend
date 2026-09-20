/**
 * `@truesend/chain` — everything that needs a node.
 *
 * The split from `@truesend/engine` is deliberate: the engine is pure and decides, this package
 * fetches and never decides. Both the web app and the indexer import from here, so there is one
 * implementation of "read the history and check who signed it" rather than two that drift.
 */

export {
  DEFAULT_RPC,
  createChainClient,
  splitOnRefusal,
  type BlockRange,
} from "./client.js";

export {
  scanHistory,
  type KnownToken,
  type ScanOptions,
  type ScanProgress,
  type ScanResult,
} from "./history.js";

export {
  POLICY_EVENTS,
  TRANSFER_STATUS,
  findQueuedTransfers,
  findSettledTransfers,
  readPolicy,
  readQueue,
  type PolicyState,
  type QueuedTransfer,
  type TransferQueuedEvent,
} from "./policy.js";

export {guardedAccountAbi, safeVaultAbi, safeVaultFactoryAbi} from "./abi/index.js";
/** Both modes inherit one `GuardedBase`, so every policy call has the same signature on each. */
export {safeVaultAbi as policyAbi} from "./abi/index.js";
