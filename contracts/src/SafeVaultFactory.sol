// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {SafeVault} from "./SafeVault.sol";

/// @title SafeVaultFactory
/// @notice Deploys minimal-proxy `SafeVault` clones at addresses the app can show before paying
///         for the deployment.
contract SafeVaultFactory {
    /// @notice The `SafeVault` logic every clone delegates to.
    address public immutable implementation;

    event VaultDeployed(address indexed owner, address indexed vault, bytes32 salt);

    error VaultDeploymentFailed();

    constructor(address implementation_) {
        if (implementation_ == address(0)) revert VaultDeploymentFailed();
        implementation = implementation_;
    }

    /// @notice Create and initialise a vault in one transaction.
    /// @dev The owner is mixed into the salt so a deterministic address can only ever be taken by
    ///      the owner it was quoted for. Without that, anyone could front-run a user's deployment
    ///      at the predicted address and hand them a vault owned by someone else.
    function deploy(
        address owner,
        uint32 cooldown,
        uint32 trustDelay,
        address guardian,
        bytes32 salt
    ) external returns (address vault) {
        vault = Clones.cloneDeterministic(implementation, _salt(owner, salt));
        // The lint sees the CREATE2 above as an external call and wants the log first, but the
        // log needs the address that call returns. A clone's constructor runs no user code, so
        // there is nothing here to reenter.
        // forge-lint: disable-next-line(reentrancy-events)
        emit VaultDeployed(owner, vault, salt);
        SafeVault(payable(vault)).initialize(owner, cooldown, trustDelay, guardian);
    }

    /// @notice The address `deploy` would produce for these inputs.
    function predict(address owner, bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, _salt(owner, salt), address(this));
    }

    function _salt(address owner, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(owner, salt));
    }
}
