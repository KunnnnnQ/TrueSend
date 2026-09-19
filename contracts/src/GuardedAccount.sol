// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {GuardedBase} from "./GuardedBase.sol";
import {PolicyLib} from "./PolicyLib.sol";

/// @title GuardedAccount
/// @notice TrueSend policy installed directly on an existing EOA via an EIP-7702 delegation.
///         Zero migration: the user keeps the address every counterparty already knows.
///
/// @dev ## What this does and does not guarantee
///
///      Under EIP-7702 the delegation changes what happens when someone *calls* the EOA. It does
///      not take away the key's ability to *originate* an ordinary transaction. A key holder can
///      therefore still sign a plain `token.transfer(...)` straight from the EOA and never touch
///      this contract at all.
///
///      So the honest claim for this mode is: every payment routed through the account interface
///      (which is what the TrueSend app, the extension and any integrating wallet do) is subject
///      to the cooldown, the guardian veto and the alerts. It is a safe default path, not a lock.
///      Users who want the policy to be unbypassable by construction should use `SafeVault`,
///      where the funds sit behind the policy instead of beside it.
///
///      That distinction is deliberate and is spelled out in `docs/threat-model.md`.
///
/// @custom:storage-location erc7201:truesend.storage.GuardedAccount
contract GuardedAccount is GuardedBase {
    /// @dev keccak256(abi.encode(uint256(keccak256("truesend.storage.GuardedAccount")) - 1)) & ~bytes32(uint256(0xff))
    ///
    ///      ERC-7201 namespacing is not cosmetic here. These slots are written into the user's own
    ///      account. If a later TrueSend version, or any other delegate the user installs, used
    ///      sequential slots starting at 0, the two would silently corrupt each other. The value is
    ///      re-derived and asserted in `test/StorageLayout.t.sol`.
    bytes32 private constant _POLICY_STORAGE =
        0xc4dec960f2a66e8df3b9257ee5c35b99943f72c868615902775ec41efead6800;

    /*//////////////////////////////////////////////////////////////
                              MODE PLUMBING
    //////////////////////////////////////////////////////////////*/

    function _policy() internal pure override returns (PolicyLib.Policy storage p) {
        bytes32 slot = _POLICY_STORAGE;
        assembly ("memory-safe") {
            p.slot := slot
        }
    }

    /// @dev Under 7702 the code runs *as* the EOA, so the account and its owner are the same
    ///      address. Every owner-gated call is therefore a self-call from the EOA.
    function _owner() internal view override returns (address) {
        return address(this);
    }

    /*//////////////////////////////////////////////////////////////
                              INITIALIZATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Turn on the policy for this account.
    /// @dev Must be a self-call (`onlyOwner` resolves to `msg.sender == address(this)`).
    ///
    ///      This is the front-running guard. A 7702 authorization is a public object: once it
    ///      lands, anyone can see the EOA now carries this code and could race to call
    ///      `initialize` with a cooldown of one second and a guardian they control. Requiring the
    ///      call to come from the account itself closes that window. In practice the wallet sends
    ///      the authorization and this call in the same transaction.
    ///
    /// @param cooldown_ Seconds an untrusted transfer waits before it can settle.
    /// @param trustDelay_ Seconds before a newly added trusted recipient goes live. May be 0.
    /// @param guardian_ Optional second address that may veto, never spend. May be `address(0)`.
    function initialize(uint32 cooldown_, uint32 trustDelay_, address guardian_) external onlyOwner {
        _initializePolicy(cooldown_, trustDelay_, guardian_);
    }

    /*//////////////////////////////////////////////////////////////
                            EOA COMPATIBILITY
    //////////////////////////////////////////////////////////////*/

    /// @dev An EOA accepts value from anyone, and accepts calls with unknown calldata without
    ///      reverting. A delegate that dropped either behaviour would quietly break the user's
    ///      incoming payments, which is a far worse outcome than the attack being defended
    ///      against. Both are kept, and neither touches policy state.
    receive() external payable {}

    fallback() external payable {}

    /*//////////////////////////////////////////////////////////////
                                METADATA
    //////////////////////////////////////////////////////////////*/

    function mode() external pure returns (string memory) {
        return "GuardedAccount/7702";
    }

    /// @notice The ERC-7201 slot this implementation keeps its policy in.
    /// @dev Exposed so a wallet can check compatibility before offering an upgrade.
    function policyStorageSlot() external pure returns (bytes32) {
        return _POLICY_STORAGE;
    }
}
