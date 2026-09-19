// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title ITrueSendPolicy
/// @notice Events and errors shared by every TrueSend policy holder.
/// @dev Declared in one place so the indexer, the web app and the browser extension can all
///      consume a single ABI regardless of which mode (delegated account or custodial vault)
///      the user picked.
interface ITrueSendPolicy {
    /*//////////////////////////////////////////////////////////////
                                  TYPES
    //////////////////////////////////////////////////////////////*/

    enum TransferStatus {
        None,
        Queued,
        Executed,
        Cancelled
    }

    /*//////////////////////////////////////////////////////////////
                                  EVENTS
    //////////////////////////////////////////////////////////////*/

    event PolicyInitialized(address indexed owner, uint32 cooldown, uint32 trustDelay, address guardian);

    /// @notice A transfer that cleared the policy and settled in the same transaction.
    event TransferSent(address indexed to, address indexed token, uint256 amount);
    /// @notice A transfer to an untrusted recipient (or over the daily allowance) that must wait.
    event TransferQueued(
        uint256 indexed id, address indexed to, address indexed token, uint256 amount, uint64 unlockAt
    );
    event TransferExecuted(uint256 indexed id, address indexed to, address indexed token, uint256 amount);
    event TransferCancelled(uint256 indexed id, address indexed by);

    event TrustedAdded(address indexed recipient, uint64 activeAt);
    event TrustedRemoved(address indexed recipient, address indexed by);

    event CooldownUpdated(uint32 cooldown);
    event CooldownChangeQueued(uint32 cooldown, uint64 unlockAt);
    event CooldownChangeCancelled(address indexed by);

    event GuardianUpdated(address indexed guardian);
    event GuardianChangeQueued(address indexed guardian, uint64 unlockAt);
    event GuardianChangeCancelled(address indexed by);

    event DailyLimitUpdated(address indexed token, uint256 amount);
    event DailyLimitChangeQueued(address indexed token, uint256 amount, uint64 unlockAt);
    event DailyLimitChangeCancelled(address indexed token, address indexed by);

    event Deposited(address indexed token, address indexed from, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                                  ERRORS
    //////////////////////////////////////////////////////////////*/

    error AlreadyInitialized();
    error NotInitialized();
    error Unauthorized();
    error InvalidRecipient();
    error InvalidAmount();
    error InvalidCooldown();
    error InvalidGuardian();
    error AlreadyTrusted();
    error NotTrusted();
    error TransferNotQueued();
    error TransferLocked(uint64 unlockAt);
    error NothingQueued();
    error ChangeLocked(uint64 unlockAt);
    error NativeTransferFailed();
    error InsufficientBalance();
}
