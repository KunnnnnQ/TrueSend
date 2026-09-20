// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ITrueSendPolicy} from "./interfaces/ITrueSendPolicy.sol";

/// @title PolicyLib
/// @notice Storage layout and the pure state-machine rules behind a TrueSend cooldown policy.
/// @dev The library holds no addresses of its own: every function takes a `Policy storage`
///      pointer so the same rules run at an EIP-7702 delegated EOA and inside a custodial vault.
///
///      The single design rule that governs every setter in here:
///
///        * a change that makes the policy **stricter** applies immediately;
///        * a change that makes the policy **looser** is itself queued behind the current cooldown.
///
///      Without that asymmetry an attacker holding the key could simply set the cooldown to zero
///      and drain in one transaction, which would make the whole mechanism decorative.
library PolicyLib {
    /// @notice Sentinel used in place of an ERC-20 address to mean "native ETH".
    address internal constant NATIVE = address(0);

    /// @notice Upper bounds; purely to stop a fat-fingered value bricking the account forever.
    uint32 internal constant MAX_COOLDOWN = 30 days;
    uint32 internal constant MAX_TRUST_DELAY = 30 days;

    struct PendingTransfer {
        address to;
        address token;
        uint256 amount;
        uint64 queuedAt;
        uint64 unlockAt;
        ITrueSendPolicy.TransferStatus status;
    }

    struct DailyLimit {
        /// @dev 0 means "uncapped". Chosen so a fresh policy behaves predictably for trusted
        ///      recipients; the cap is an extra belt, not the primary guarantee.
        uint256 amount;
        uint256 pendingAmount;
        /// @dev 0 means "nothing queued".
        uint64 pendingUnlockAt;
    }

    struct Spend {
        uint64 day;
        uint256 amount;
    }

    struct Policy {
        bool initialized;
        uint32 cooldown;
        uint32 trustDelay;
        address guardian;
        uint32 pendingCooldown;
        uint64 pendingCooldownUnlockAt;
        address pendingGuardian;
        uint64 pendingGuardianUnlockAt;
        uint256 nextTransferId;
        mapping(address recipient => uint64 activeAt) trustedAt;
        mapping(uint256 id => PendingTransfer) transfers;
        mapping(address token => DailyLimit) limits;
        mapping(address token => Spend) spend;
    }

    /*//////////////////////////////////////////////////////////////
                                 QUERIES
    //////////////////////////////////////////////////////////////*/

    /// @notice A recipient counts as trusted only once its trust delay has elapsed.
    /// @dev The delay is what stops "attacker signs addTrusted(attacker) then drains" from
    ///      being a single-transaction move.
    function isTrustedActive(Policy storage p, address recipient) internal view returns (bool) {
        uint64 activeAt = p.trustedAt[recipient];
        return activeAt != 0 && block.timestamp >= activeAt;
    }

    /// @notice `block.timestamp` narrowed to the width every deadline in this library uses.
    /// @dev The cast is safe: `uint64` seconds overflow in the year 584_942_417_355. Kept in one
    ///      place so the justification is written once rather than at four call sites.
    function nowSeconds() internal view returns (uint64) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(block.timestamp);
    }

    function today() internal view returns (uint64) {
        return nowSeconds() / 1 days;
    }

    /// @notice How much of `token`'s daily allowance has already been used today.
    function spentToday(Policy storage p, address token) internal view returns (uint256) {
        Spend storage s = p.spend[token];
        return s.day == today() ? s.amount : 0;
    }

    /// @notice Whether `amount` would fit in today's allowance, without mutating anything.
    function fitsAllowance(Policy storage p, address token, uint256 amount) internal view returns (bool) {
        uint256 cap = p.limits[token].amount;
        if (cap == 0) return true;
        return spentToday(p, token) + amount <= cap;
    }

    /// @notice Decide, without mutating, whether a transfer would settle instantly.
    function wouldSettleInstantly(
        Policy storage p,
        address to,
        address token,
        uint256 amount
    ) internal view returns (bool) {
        return isTrustedActive(p, to) && fitsAllowance(p, token, amount);
    }

    /*//////////////////////////////////////////////////////////////
                                MUTATIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Consume `amount` of today's allowance, or report that it does not fit.
    /// @dev Returns false instead of reverting: an over-limit transfer is not an error, it just
    ///      falls through to the cooldown queue.
    function tryConsumeAllowance(Policy storage p, address token, uint256 amount) internal returns (bool) {
        uint256 cap = p.limits[token].amount;
        if (cap == 0) return true;

        Spend storage s = p.spend[token];
        uint64 day = today();
        uint256 used = s.day == day ? s.amount : 0;
        if (used + amount > cap) return false;

        s.day = day;
        s.amount = used + amount;
        return true;
    }

    /// @notice The timestamp a weakening change queued right now would unlock at.
    /// @dev `uint64 + uint32` cannot overflow at any plausible timestamp, and Solidity would
    ///      revert rather than wrap if it somehow did.
    function unlockFromNow(Policy storage p) internal view returns (uint64) {
        return nowSeconds() + p.cooldown;
    }
}
