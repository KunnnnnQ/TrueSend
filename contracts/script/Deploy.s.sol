// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";

import {GuardedAccount} from "../src/GuardedAccount.sol";
import {SafeVault} from "../src/SafeVault.sol";
import {SafeVaultFactory} from "../src/SafeVaultFactory.sol";

/// @notice Deploys the three singletons TrueSend needs on a chain.
///
/// @dev Nothing here is per-user. `GuardedAccount` is the code EOAs delegate to, `SafeVault` is
///      the clone template, and the factory stamps out vaults. All three are ownerless and hold
///      no funds, so a single deployment serves every user of the chain.
///
///      Writes `deployments/<chainid>.json` for the web app and the indexer to read, so no
///      address is ever copied by hand between the contracts and the frontend.
contract Deploy is Script {
    function run() external {
        vm.startBroadcast();

        GuardedAccount accountImplementation = new GuardedAccount();
        SafeVault vaultImplementation = new SafeVault();
        SafeVaultFactory factory = new SafeVaultFactory(address(vaultImplementation));

        vm.stopBroadcast();

        console.log("chain id            ", block.chainid);
        console.log("GuardedAccount impl ", address(accountImplementation));
        console.log("SafeVault impl      ", address(vaultImplementation));
        console.log("SafeVaultFactory    ", address(factory));

        _write(address(accountImplementation), address(vaultImplementation), address(factory));
    }

    function _write(address account, address vault, address factory) private {
        string memory key = "truesend";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeAddress(key, "guardedAccountImplementation", account);
        vm.serializeAddress(key, "safeVaultImplementation", vault);
        string memory json = vm.serializeAddress(key, "safeVaultFactory", factory);

        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console.log("wrote               ", path);
    }
}
