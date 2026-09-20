// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {GuardedBase} from "./GuardedBase.sol";
import {PolicyLib} from "./PolicyLib.sol";

/// @title SafeVault
/// @notice The same TrueSend policy, applied to funds held by the contract itself.
///
/// @dev This is the strict mode. Because the assets live *behind* the policy rather than beside
///      it, there is no path that moves them without going through the cooldown: the owner's key
///      cannot sign around it the way it can in the EIP-7702 mode. The trade-off is migration —
///      the user funds a new address and counterparties have to learn it.
///
///      It also doubles as the fallback demo path: it needs nothing from the delegation
///      tooling, so it works on any EVM chain regardless of whether Prague is live there.
///
/// @custom:storage-location erc7201:truesend.storage.SafeVault
contract SafeVault is GuardedBase {
    using SafeERC20 for IERC20;

    struct VaultStorage {
        address owner;
        PolicyLib.Policy policy;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("truesend.storage.SafeVault")) - 1)) & ~bytes32(uint256(0xff))
    ///      Namespaced for the same reason as `GuardedAccount`: clones share this implementation
    ///      and a future version must be able to sit alongside this layout, not on top of it.
    bytes32 private constant _VAULT_STORAGE =
        0x07a01c7ea28e65d04d222cef4a91560f10bc3df4b1f06102a9578f95e9c31400;

    /*//////////////////////////////////////////////////////////////
                              MODE PLUMBING
    //////////////////////////////////////////////////////////////*/

    function _vault() private pure returns (VaultStorage storage v) {
        bytes32 slot = _VAULT_STORAGE;
        assembly ("memory-safe") {
            v.slot := slot
        }
    }

    function _policy() internal view override returns (PolicyLib.Policy storage) {
        return _vault().policy;
    }

    function _owner() internal view override returns (address) {
        return _vault().owner;
    }

    /*//////////////////////////////////////////////////////////////
                              INITIALIZATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Bind this vault to an owner and switch the policy on. Callable once.
    /// @dev Intended to be called by `SafeVaultFactory` in the same transaction as the clone is
    ///      created, so there is no window in which an uninitialised vault sits on chain.
    function initialize(address owner_, uint32 cooldown_, uint32 trustDelay_, address guardian_) external {
        VaultStorage storage v = _vault();
        if (v.owner != address(0)) revert AlreadyInitialized();
        if (owner_ == address(0)) revert InvalidRecipient();

        v.owner = owner_;
        _initializePolicy(cooldown_, trustDelay_, guardian_);
    }

    /*//////////////////////////////////////////////////////////////
                                 FUNDING
    //////////////////////////////////////////////////////////////*/

    receive() external payable {
        emit Deposited(PolicyLib.NATIVE, msg.sender, msg.value);
    }

    /// @notice Pull ERC-20 funds into the vault. Requires an allowance from `msg.sender`.
    /// @dev A plain `token.transfer(vault, amount)` also works and is indistinguishable on the
    ///      balance sheet; this entry point exists so deposits produce an event the indexer can
    ///      attribute to a sender.
    function depositERC20(address token, uint256 amount) external {
        if (amount == 0) revert InvalidAmount();
        emit Deposited(token, msg.sender, amount);
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    }

    /*//////////////////////////////////////////////////////////////
                                METADATA
    //////////////////////////////////////////////////////////////*/

    function mode() external pure returns (string memory) {
        return "SafeVault/custodial";
    }

    function policyStorageSlot() external pure returns (bytes32) {
        return _VAULT_STORAGE;
    }
}
