// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";

import {ISchemaRegistry} from "eas-contracts/ISchemaRegistry.sol";
import {ISchemaResolver} from "eas-contracts/resolver/ISchemaResolver.sol";
import {IEAS} from "eas-contracts/IEAS.sol";

import {PoisonRegistry} from "../src/PoisonRegistry.sol";

/// @notice Deploys `PoisonRegistry` and registers the schema that routes through it.
///
/// @dev The EAS addresses below were confirmed on chain rather than copied from documentation:
///      calling `getSchemaRegistry()` on each EAS instance returns exactly the registry address
///      used here, on both networks. That check is cheap and this project has already been caught
///      out once by trusting a remembered address.
contract RegisterSchema is Script {
    /// @dev `address subject, uint8 role, address imitates, bytes32 evidence`.
    string constant SCHEMA = "address subject,uint8 role,address imitates,bytes32 evidence";

    function run() external {
        (address eas, address schemaRegistry) = _easFor(block.chainid);

        vm.startBroadcast();

        PoisonRegistry registry = new PoisonRegistry(IEAS(eas));
        bytes32 uid = ISchemaRegistry(schemaRegistry)
            .register(
                SCHEMA,
                ISchemaResolver(address(registry)),
                // Revocable: a count that only ever grows stops meaning anything, so a reporter who
                // was wrong has to be able to take it back.
                true
            );

        vm.stopBroadcast();

        console.log("chain id        ", block.chainid);
        console.log("EAS             ", eas);
        console.log("SchemaRegistry  ", schemaRegistry);
        console.log("PoisonRegistry  ", address(registry));
        console.log("schema          ", SCHEMA);
        console.log("schema uid      ", vm.toString(uid));

        _write(block.chainid, eas, schemaRegistry, address(registry), uid);
    }

    function _easFor(uint256 chainId) private pure returns (address eas, address schemaRegistry) {
        if (chainId == 1) {
            return (0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587, 0xA7b39296258348C78294F95B872b282326A97BDF);
        }
        if (chainId == 11_155_111) {
            return (0xC2679fBD37d54388Ce493F1DB75320D236e1815e, 0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0);
        }
        revert("No EAS deployment is known for this chain. Deploy EAS first, or add its addresses.");
    }

    function _write(
        uint256 chainId,
        address eas,
        address schemaRegistry,
        address registry,
        bytes32 uid
    ) private {
        string memory key = "registry";
        vm.serializeAddress(key, "eas", eas);
        vm.serializeAddress(key, "schemaRegistry", schemaRegistry);
        vm.serializeAddress(key, "poisonRegistry", registry);
        vm.serializeString(key, "schema", SCHEMA);
        string memory json = vm.serializeBytes32(key, "schemaUid", uid);

        string memory path = string.concat("deployments/registry-", vm.toString(chainId), ".json");
        vm.writeJson(json, path);
        console.log("wrote           ", path);
    }
}
