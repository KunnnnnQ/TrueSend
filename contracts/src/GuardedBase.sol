// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {ITrueSendPolicy} from "./interfaces/ITrueSendPolicy.sol";
import {PolicyLib} from "./PolicyLib.sol";

/// @title GuardedBase
/// @notice The cooldown state machine, minus any opinion about where the funds live.
/// @dev Two concrete modes inherit this:
///      - `GuardedAccount`, installed on an existing EOA through an EIP-7702 delegation;
///      - `SafeVault`, an ordinary custodial contract for users who do not want to delegate.
///
///      Reentrancy protection uses the transient-storage guard so that no persistent slot is
///      touched. That matters for the 7702 mode, where every persistent slot written here lands
///      in the user's own EOA account and has to obey the ERC-7201 namespacing discipline.
abstract contract GuardedBase is ITrueSendPolicy, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using PolicyLib for PolicyLib.Policy;

    /*//////////////////////////////////////////////////////////////
                           MODE-SPECIFIC HOOKS
    //////////////////////////////////////////////////////////////*/

    /// @dev Pointer to this mode's ERC-7201 namespaced policy storage.
    function _policy() internal view virtual returns (PolicyLib.Policy storage);

    /// @dev Who may move funds. `address(this)` in the 7702 mode, a stored owner in the vault.
    function _owner() internal view virtual returns (address);

    /*//////////////////////////////////////////////////////////////
                                MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlyOwner() {
        if (msg.sender != _owner()) revert Unauthorized();
        _;
    }

    modifier whenInitialized() {
        if (!_policy().initialized) revert NotInitialized();
        _;
    }

    /// @dev The guardian may only ever *subtract* permission: veto a transfer, revoke trust.
    ///      It can never move funds and can never entrench itself (see `cancelGuardianChange`).
    function _requireOwnerOrGuardian() internal view {
        if (msg.sender == _owner()) return;
        address guardian = _policy().guardian;
        if (guardian != address(0) && msg.sender == guardian) return;
        revert Unauthorized();
    }

    /*//////////////////////////////////////////////////////////////
                              INITIALIZATION
    //////////////////////////////////////////////////////////////*/

    function _initializePolicy(uint32 cooldown_, uint32 trustDelay_, address guardian_) internal {
        PolicyLib.Policy storage p = _policy();
        if (p.initialized) revert AlreadyInitialized();
        if (cooldown_ == 0 || cooldown_ > PolicyLib.MAX_COOLDOWN) revert InvalidCooldown();
        if (trustDelay_ > PolicyLib.MAX_TRUST_DELAY) revert InvalidCooldown();
        if (guardian_ == _owner()) revert InvalidGuardian();

        p.initialized = true;
        p.cooldown = cooldown_;
        p.trustDelay = trustDelay_;
        p.guardian = guardian_;
        p.nextTransferId = 1;

        // `_owner()` is virtual, so the lint conservatively treats it as an external call. Both
        // implementations resolve it to `address(this)` or a storage read; neither can reenter.
        // forge-lint: disable-next-line(reentrancy-events)
        emit PolicyInitialized(_owner(), cooldown_, trustDelay_, guardian_);
    }

    /*//////////////////////////////////////////////////////////////
                                TRANSFERS
    //////////////////////////////////////////////////////////////*/

    /// @notice Send funds under policy. Trusted recipients settle now; everyone else waits.
    /// @param to Recipient.
    /// @param token ERC-20 address, or `address(0)` for native ETH.
    /// @param amount Amount in the token's own units.
    /// @return id 0 if the transfer settled immediately, otherwise the queue id to cancel or execute.
    function send(
        address to,
        address token,
        uint256 amount
    ) external nonReentrant onlyOwner whenInitialized returns (uint256 id) {
        if (to == address(0) || to == address(this)) revert InvalidRecipient();
        if (amount == 0) revert InvalidAmount();

        PolicyLib.Policy storage p = _policy();

        if (p.isTrustedActive(to) && p.tryConsumeAllowance(token, amount)) {
            emit TransferSent(to, token, amount);
            _moveOut(token, to, amount);
            return 0;
        }

        id = p.nextTransferId++;
        uint64 unlockAt = p.unlockFromNow();
        p.transfers[id] = PolicyLib.PendingTransfer({
            to: to,
            token: token,
            amount: amount,
            queuedAt: PolicyLib.nowSeconds(),
            unlockAt: unlockAt,
            status: TransferStatus.Queued
        });

        emit TransferQueued(id, to, token, amount, unlockAt);
    }

    /// @notice Settle a queued transfer once its cooldown has elapsed.
    /// @dev Owner-only on purpose. Letting anyone push the button after unlock would be
    ///      convenient for relayers but would take away the owner's ability to keep stalling.
    function executeQueued(uint256 id) external nonReentrant onlyOwner whenInitialized {
        PolicyLib.PendingTransfer storage t = _policy().transfers[id];
        if (t.status != TransferStatus.Queued) revert TransferNotQueued();
        if (block.timestamp < t.unlockAt) revert TransferLocked(t.unlockAt);

        t.status = TransferStatus.Executed;
        emit TransferExecuted(id, t.to, t.token, t.amount);
        _moveOut(t.token, t.to, t.amount);
    }

    /// @notice Drop a queued transfer. This is the button the whole project exists for.
    /// @dev Stays available after the unlock time too: a transfer is cancellable right up until
    ///      it is actually executed.
    function cancelQueued(uint256 id) external whenInitialized {
        _requireOwnerOrGuardian();
        PolicyLib.PendingTransfer storage t = _policy().transfers[id];
        if (t.status != TransferStatus.Queued) revert TransferNotQueued();

        t.status = TransferStatus.Cancelled;
        emit TransferCancelled(id, msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                            TRUSTED RECIPIENTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Start trusting a recipient. Trust only takes effect after `trustDelay`.
    function addTrusted(address recipient) external onlyOwner whenInitialized {
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        PolicyLib.Policy storage p = _policy();
        if (p.trustedAt[recipient] != 0) revert AlreadyTrusted();

        uint64 activeAt = PolicyLib.nowSeconds() + p.trustDelay;
        p.trustedAt[recipient] = activeAt;
        emit TrustedAdded(recipient, activeAt);
    }

    /// @notice Stop trusting a recipient, effective immediately (revoking trust is a tightening).
    function removeTrusted(address recipient) external whenInitialized {
        _requireOwnerOrGuardian();
        PolicyLib.Policy storage p = _policy();
        if (p.trustedAt[recipient] == 0) revert NotTrusted();

        delete p.trustedAt[recipient];
        emit TrustedRemoved(recipient, msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                                 COOLDOWN
    //////////////////////////////////////////////////////////////*/

    /// @notice Raising the cooldown is instant; lowering it waits out the current cooldown.
    function setCooldown(uint32 newCooldown) external onlyOwner whenInitialized {
        if (newCooldown == 0 || newCooldown > PolicyLib.MAX_COOLDOWN) revert InvalidCooldown();
        PolicyLib.Policy storage p = _policy();

        if (newCooldown >= p.cooldown) {
            p.cooldown = newCooldown;
            if (p.pendingCooldownUnlockAt != 0) {
                p.pendingCooldown = 0;
                p.pendingCooldownUnlockAt = 0;
                emit CooldownChangeCancelled(msg.sender);
            }
            emit CooldownUpdated(newCooldown);
        } else {
            uint64 unlockAt = p.unlockFromNow();
            p.pendingCooldown = newCooldown;
            p.pendingCooldownUnlockAt = unlockAt;
            emit CooldownChangeQueued(newCooldown, unlockAt);
        }
    }

    function applyCooldownChange() external onlyOwner whenInitialized {
        PolicyLib.Policy storage p = _policy();
        uint64 unlockAt = p.pendingCooldownUnlockAt;
        if (unlockAt == 0) revert NothingQueued();
        if (block.timestamp < unlockAt) revert ChangeLocked(unlockAt);

        uint32 value = p.pendingCooldown;
        p.cooldown = value;
        p.pendingCooldown = 0;
        p.pendingCooldownUnlockAt = 0;
        emit CooldownUpdated(value);
    }

    function cancelCooldownChange() external whenInitialized {
        _requireOwnerOrGuardian();
        PolicyLib.Policy storage p = _policy();
        if (p.pendingCooldownUnlockAt == 0) revert NothingQueued();

        p.pendingCooldown = 0;
        p.pendingCooldownUnlockAt = 0;
        emit CooldownChangeCancelled(msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                                 GUARDIAN
    //////////////////////////////////////////////////////////////*/

    /// @notice Appointing a first guardian is instant; replacing or removing one is queued.
    function setGuardian(address newGuardian) external onlyOwner whenInitialized {
        if (newGuardian == _owner()) revert InvalidGuardian();
        PolicyLib.Policy storage p = _policy();

        if (p.guardian == address(0)) {
            if (newGuardian == address(0)) revert InvalidGuardian();
            p.guardian = newGuardian;
            emit GuardianUpdated(newGuardian);
        } else {
            uint64 unlockAt = p.unlockFromNow();
            p.pendingGuardian = newGuardian;
            p.pendingGuardianUnlockAt = unlockAt;
            emit GuardianChangeQueued(newGuardian, unlockAt);
        }
    }

    function applyGuardianChange() external onlyOwner whenInitialized {
        PolicyLib.Policy storage p = _policy();
        uint64 unlockAt = p.pendingGuardianUnlockAt;
        if (unlockAt == 0) revert NothingQueued();
        if (block.timestamp < unlockAt) revert ChangeLocked(unlockAt);

        address value = p.pendingGuardian;
        p.guardian = value;
        p.pendingGuardian = address(0);
        p.pendingGuardianUnlockAt = 0;
        emit GuardianUpdated(value);
    }

    /// @notice Owner-only, deliberately.
    /// @dev If the sitting guardian could veto its own replacement it would hold the account
    ///      hostage forever. Its power stays strictly negative and strictly per-transfer; the
    ///      protection against a stolen key is the cooldown plus the alert the queued change
    ///      emits, not the guardian's ability to entrench itself.
    function cancelGuardianChange() external onlyOwner whenInitialized {
        PolicyLib.Policy storage p = _policy();
        if (p.pendingGuardianUnlockAt == 0) revert NothingQueued();

        p.pendingGuardian = address(0);
        p.pendingGuardianUnlockAt = 0;
        emit GuardianChangeCancelled(msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                               DAILY LIMITS
    //////////////////////////////////////////////////////////////*/

    /// @notice Cap how much can reach trusted recipients per day. 0 means uncapped.
    /// @dev Tightening (a lower non-zero cap) is instant; loosening is queued.
    function setDailyLimit(address token, uint256 newLimit) external onlyOwner whenInitialized {
        PolicyLib.Policy storage p = _policy();
        PolicyLib.DailyLimit storage limit = p.limits[token];
        uint256 current = limit.amount;
        bool tightens = newLimit != 0 && (current == 0 || newLimit <= current);

        if (tightens) {
            limit.amount = newLimit;
            if (limit.pendingUnlockAt != 0) {
                limit.pendingAmount = 0;
                limit.pendingUnlockAt = 0;
                emit DailyLimitChangeCancelled(token, msg.sender);
            }
            emit DailyLimitUpdated(token, newLimit);
        } else {
            uint64 unlockAt = p.unlockFromNow();
            limit.pendingAmount = newLimit;
            limit.pendingUnlockAt = unlockAt;
            emit DailyLimitChangeQueued(token, newLimit, unlockAt);
        }
    }

    function applyDailyLimitChange(address token) external onlyOwner whenInitialized {
        PolicyLib.DailyLimit storage limit = _policy().limits[token];
        uint64 unlockAt = limit.pendingUnlockAt;
        if (unlockAt == 0) revert NothingQueued();
        if (block.timestamp < unlockAt) revert ChangeLocked(unlockAt);

        uint256 value = limit.pendingAmount;
        limit.amount = value;
        limit.pendingAmount = 0;
        limit.pendingUnlockAt = 0;
        emit DailyLimitUpdated(token, value);
    }

    function cancelDailyLimitChange(address token) external whenInitialized {
        _requireOwnerOrGuardian();
        PolicyLib.DailyLimit storage limit = _policy().limits[token];
        if (limit.pendingUnlockAt == 0) revert NothingQueued();

        limit.pendingAmount = 0;
        limit.pendingUnlockAt = 0;
        emit DailyLimitChangeCancelled(token, msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    struct PolicyView {
        bool initialized;
        address owner;
        uint32 cooldown;
        uint32 trustDelay;
        address guardian;
        uint32 pendingCooldown;
        uint64 pendingCooldownUnlockAt;
        address pendingGuardian;
        uint64 pendingGuardianUnlockAt;
        uint256 nextTransferId;
    }

    function owner() external view returns (address) {
        return _owner();
    }

    function policy() external view returns (PolicyView memory) {
        PolicyLib.Policy storage p = _policy();
        return PolicyView({
            initialized: p.initialized,
            owner: _owner(),
            cooldown: p.cooldown,
            trustDelay: p.trustDelay,
            guardian: p.guardian,
            pendingCooldown: p.pendingCooldown,
            pendingCooldownUnlockAt: p.pendingCooldownUnlockAt,
            pendingGuardian: p.pendingGuardian,
            pendingGuardianUnlockAt: p.pendingGuardianUnlockAt,
            nextTransferId: p.nextTransferId
        });
    }

    function getTransfer(uint256 id) external view returns (PolicyLib.PendingTransfer memory) {
        return _policy().transfers[id];
    }

    function isTrusted(address recipient) external view returns (bool) {
        return _policy().isTrustedActive(recipient);
    }

    function trustedActiveAt(address recipient) external view returns (uint64) {
        return _policy().trustedAt[recipient];
    }

    function dailyLimit(address token)
        external
        view
        returns (uint256 amount, uint256 pending, uint64 unlockAt)
    {
        PolicyLib.DailyLimit storage limit = _policy().limits[token];
        return (limit.amount, limit.pendingAmount, limit.pendingUnlockAt);
    }

    function spentToday(address token) external view returns (uint256) {
        return _policy().spentToday(token);
    }

    /// @notice What `send` would do, without doing it. The web app and the extension use this to
    ///         tell the user "this goes into a 24h hold" before they sign anything.
    function quote(
        address to,
        address token,
        uint256 amount
    ) external view returns (bool instant, uint64 unlockAt) {
        PolicyLib.Policy storage p = _policy();
        instant = p.wouldSettleInstantly(to, token, amount);
        unlockAt = instant ? 0 : p.unlockFromNow();
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNALS
    //////////////////////////////////////////////////////////////*/

    function _moveOut(address token, address to, uint256 amount) internal {
        if (token == PolicyLib.NATIVE) {
            if (address(this).balance < amount) revert InsufficientBalance();
            // The destination is attacker-relevant but not attacker-controlled: reaching here
            // means the caller is the owner and the policy already cleared this recipient.
            // forge-lint: disable-next-line(arbitrary-send-eth)
            (bool ok,) = payable(to).call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }
}
