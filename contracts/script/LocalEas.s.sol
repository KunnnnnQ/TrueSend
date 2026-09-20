// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";

import {EAS} from "eas-contracts/EAS.sol";
import {ISchemaRegistry, SchemaRegistry} from "eas-contracts/SchemaRegistry.sol";
import {ISchemaResolver} from "eas-contracts/resolver/ISchemaResolver.sol";
import {IEAS} from "eas-contracts/IEAS.sol";

import {PoisonRegistry} from "../src/PoisonRegistry.sol";

/// @notice Stands up EAS, the registry and the schema on a local chain.
///
/// @dev Public networks already have EAS, so `RegisterSchema` only deploys the resolver there. A
///      local chain has nothing, so this puts the whole stack up at once — which is what makes
///      the registry demonstrable end to end without spending testnet funds.
contract LocalEas is Script {
    string constant SCHEMA = "address subject,uint8 role,address imitates,bytes32 evidence";

    function run() external {
        vm.startBroadcast();

        SchemaRegistry schemaRegistry = new SchemaRegistry();
        EAS eas = new EAS(ISchemaRegistry(address(schemaRegistry)));
        PoisonRegistry registry = new PoisonRegistry(IEAS(address(eas)));
        bytes32 uid = schemaRegistry.register(SCHEMA, ISchemaResolver(address(registry)), true);

        vm.stopBroadcast();

        console.log("SchemaRegistry ", address(schemaRegistry));
        console.log("EAS            ", address(eas));
        console.log("PoisonRegistry ", address(registry));
        console.log("schema uid     ", vm.toString(uid));

        string memory key = "localEas";
        vm.serializeAddress(key, "eas", address(eas));
        vm.serializeAddress(key, "schemaRegistry", address(schemaRegistry));
        vm.serializeAddress(key, "poisonRegistry", address(registry));
        vm.serializeString(key, "schema", SCHEMA);
        string memory json = vm.serializeBytes32(key, "schemaUid", uid);
        vm.writeJson(json, "deployments/registry-31337.json");
    }
}
