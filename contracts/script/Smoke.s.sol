// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";

import {IEAS, AttestationRequest, AttestationRequestData} from "eas-contracts/IEAS.sol";
import {NO_EXPIRATION_TIME} from "eas-contracts/Common.sol";

import {SafeVaultFactory} from "../src/SafeVaultFactory.sol";
import {SafeVault} from "../src/SafeVault.sol";
import {PolicyLib} from "../src/PolicyLib.sol";
import {ITrueSendPolicy} from "../src/interfaces/ITrueSendPolicy.sol";
import {PoisonRegistry} from "../src/PoisonRegistry.sol";

/// @notice Exercises a real deployment on a real chain. Not "did it compile" — did the security
///         property the contract exists for actually hold, against bytecode nobody can special-case.
///
/// @dev `forge test` proves the logic once, in a controlled EVM, against a suite that knows what
///      it is testing. That is necessary and it is not the same claim as "the thing deployed at
///      this address, on this chain, right now, behaves this way" — a wrong constructor argument,
///      a stale ABI, a proxy pointed at the wrong implementation, none of those show up in a test
///      run against different bytecode. This is what closes that gap, run after `Deploy.s.sol`
///      and `RegisterSchema.s.sol` rather than instead of the test suite.
///
///      Every check here spends real value or none: the native ETH queued through the vault is
///      the broadcaster's own, sent to the broadcaster's own address, and is recovered by
///      cancelling rather than left at risk. The false lookalike claim is never broadcast at all
///      — every call outside `vm.broadcast` is a local simulation against live chain state, never
///      a sent transaction, so a check that is supposed to fail costs nothing when it does. The
///      only on-chain artifact this leaves behind beyond the vault itself is one true, checkable
///      attestation.
///
///      Reads both deployment files rather than taking addresses as input, so there is no way to
///      point this at the wrong chain's contracts by a typo.
contract Smoke is Script {
    /// @dev Short enough that the "too early" check below is still true by the time it runs, long
    ///      enough that it is plainly a cooldown and not a rounding error. Real deployments choose
    ///      their own cooldown; this number is not a recommendation, it is what makes one script
    ///      run finish before its own lock expires.
    uint32 constant SMOKE_COOLDOWN = 300;

    /// @dev A verified pair from analysis/data/scan-latest.json rather than an invented one: the
    ///      planted address shares the leading and trailing characters a wallet shows with the
    ///      address it imitates, and both sides are on record with the transaction hashes that
    ///      prove it. Using ground truth here means this checks `isLookalike` against a case that
    ///      mattered, not a fixture built to make the function say yes.
    address constant REAL_PLANTED = 0x7916CDB1c89aB07F0C4261c8CBF9c88AAE1C41C0;
    address constant REAL_IMITATING = 0x7916dE5ef2389E8Ed627A9A3E92eA5BF807c41c0;

    /// @dev Anvil's well-known second test account. Used only as "an address with no relation to
    ///      the one above" for the false-claim check — a fixture everyone recognises as a fixture,
    ///      not a real identity's address being named in a rejected claim.
    address constant UNRELATED = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;

    /// @dev Deliberately small: this is a testnet check, not a funding exercise. It only ever
    ///      moves from the broadcaster back to the broadcaster.
    uint256 constant SMOKE_VALUE = 0.000_02 ether;

    bool ok = true;

    function run() external {
        address deployer = _broadcaster();
        string memory chainDeployment =
            _read(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        string memory registryDeployment =
            _read(string.concat("deployments/registry-", vm.toString(block.chainid), ".json"));

        console.log("Smoke-testing chain id", block.chainid);
        console.log("As                    ", deployer);
        console.log("");

        _checkVault(chainDeployment, deployer);
        console.log("");
        _checkRegistry(registryDeployment, deployer);

        console.log("");
        if (ok) {
            console.log("All smoke checks passed.");
        } else {
            console.log("FAILED: see above.");
            revert("smoke check failed");
        }
    }

    /*//////////////////////////////////////////////////////////////
                                SAFEVAULT
    //////////////////////////////////////////////////////////////*/

    /// @dev The property this project exists to prove: a payment to a never-seen recipient does
    ///      not go out immediately, an attempt to force it early is refused by the deployed
    ///      bytecode itself, and the owner keeps the ability to cancel until they choose not to.
    function _checkVault(string memory deployment, address deployer) internal {
        SafeVaultFactory factory = SafeVaultFactory(vm.parseJsonAddress(deployment, ".safeVaultFactory"));
        console.log("SafeVaultFactory", address(factory));

        bytes32 salt = keccak256(abi.encodePacked("truesend-smoke", block.timestamp));

        // No guardian: guardian_ == owner is rejected by the deployed contract (a guardian that is
        // the owner could not check anything), and this is what caught it — the first run of this
        // script guessed guardian = deployer and the real bytecode refused it with InvalidGuardian.
        // address(0) means "no guardian", a real configuration a user can choose, not a placeholder.
        vm.startBroadcast();
        address payable vaultAddr =
            payable(factory.deploy(deployer, SMOKE_COOLDOWN, SMOKE_COOLDOWN, address(0), salt));
        SafeVault vault = SafeVault(vaultAddr);
        console.log("deployed a fresh vault", vaultAddr);

        (bool funded,) = vaultAddr.call{value: SMOKE_VALUE}("");
        _assert(funded, "fund the vault: receive() accepted the deposit");

        // The recipient is the broadcaster's own address. If cancellation below did nothing, the
        // funds would still only ever be recoverable by the same key that sent them.
        uint256 id = vault.send(deployer, PolicyLib.NATIVE, SMOKE_VALUE);
        vm.stopBroadcast();
        _assert(id != 0, "a payment to a never-seen recipient queues rather than settling");

        PolicyLib.PendingTransfer memory pending = vault.getTransfer(id);
        _assert(
            pending.status == ITrueSendPolicy.TransferStatus.Queued,
            "the queued transfer reads back as Queued"
        );
        _assert(pending.unlockAt > block.timestamp, "its unlock time is in the future");

        // Not broadcast: a call outside vm.broadcast executes against the script's own view of
        // chain state and is never sent as a transaction, so a revert here costs nothing and
        // leaves nothing on chain. That is what makes it safe to assert on the failure path
        // directly instead of only ever checking the success path.
        (bool executedEarly,) = vaultAddr.call(abi.encodeCall(vault.executeQueued, (id)));
        _assert(!executedEarly, "executing before the cooldown elapses is refused by the deployed contract");

        vm.startBroadcast();
        vault.cancelQueued(id);
        vm.stopBroadcast();

        pending = vault.getTransfer(id);
        _assert(
            pending.status == ITrueSendPolicy.TransferStatus.Cancelled,
            "cancelling a still-queued transfer is accepted, and the owner keeps the funds"
        );

        console.log("  (the cancelled amount is still sitting in the vault - that is correct, not a bug:");
        console.log("   cancelQueued marks the entry cancelled, it does not move anything. Add yourself as");
        console.log("   trusted and wait trustDelay, or send() again once you do, to pull it back out.)");
    }

    /*//////////////////////////////////////////////////////////////
                              POISONREGISTRY
    //////////////////////////////////////////////////////////////*/

    /// @dev The other property this project exists to prove: the resolver does not take a
    ///      lookalike claim on faith. A true one is accepted and marked verified; a false one
    ///      never reaches the registry at all, on the deployed contract, against a live EAS.
    function _checkRegistry(string memory deployment, address deployer) internal {
        IEAS eas = IEAS(vm.parseJsonAddress(deployment, ".eas"));
        PoisonRegistry registry = PoisonRegistry(payable(vm.parseJsonAddress(deployment, ".poisonRegistry")));
        bytes32 schemaUid = vm.parseJsonBytes32(deployment, ".schemaUid");
        console.log("EAS            ", address(eas));
        console.log("PoisonRegistry ", address(registry));

        // Not broadcast, for the same reason as the early-execution attempt above: this claim is
        // supposed to fail, so it is simulated rather than sent. If the resolver ever let a false
        // claim through, broadcasting it would have permanently written a bad attestation; not
        // broadcasting means a bug here costs a failed assertion instead of bad on-chain data.
        bytes memory falseClaim = abi.encode(
            PoisonRegistry.Report({
                subject: deployer,
                role: PoisonRegistry.Role.Lookalike,
                imitates: UNRELATED,
                evidence: bytes32(0)
            })
        );
        (bool falseClaimAccepted,) = address(eas)
            .call(
                abi.encodeCall(
                    IEAS.attest,
                    (AttestationRequest({
                            schema: schemaUid,
                            data: AttestationRequestData({
                                recipient: deployer,
                                expirationTime: NO_EXPIRATION_TIME,
                                revocable: true,
                                refUID: bytes32(0),
                                data: falseClaim,
                                value: 0
                            })
                        }))
                )
            );
        _assert(!falseClaimAccepted, "a lookalike claim between two unrelated addresses is rejected on chain");

        // This one is broadcast: it is true, checkable by anyone who calls isLookalike on these
        // two addresses, and evidenced by the transaction hashes in analysis/data/scan-latest.json.
        bytes memory trueClaim = abi.encode(
            PoisonRegistry.Report({
                subject: REAL_PLANTED,
                role: PoisonRegistry.Role.Lookalike,
                imitates: REAL_IMITATING,
                evidence: bytes32(0)
            })
        );
        vm.startBroadcast();
        eas.attest(
            AttestationRequest({
                schema: schemaUid,
                data: AttestationRequestData({
                    recipient: REAL_PLANTED,
                    expirationTime: NO_EXPIRATION_TIME,
                    revocable: true,
                    refUID: bytes32(0),
                    data: trueClaim,
                    value: 0
                })
            })
        );
        vm.stopBroadcast();

        PoisonRegistry.Tally memory tally = registry.tally(REAL_PLANTED);
        _assert(tally.verified >= 1, "the true claim reached the registry and is marked verified");
        console.log("  reported", REAL_PLANTED, "as a lookalike of", REAL_IMITATING);
        console.log("  tally: reports", uint256(tally.reports), "reporters", uint256(tally.reporters));
        console.log("  verified", uint256(tally.verified));
    }

    /*//////////////////////////////////////////////////////////////
                                 HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev The account this run actually signs with, read from inside a broadcast.
    ///
    ///      Not `msg.sender`. forge calls `run()` from its own default sender (0x1804c8AB...) unless
    ///      `--sender` is passed, and a keystore whose password is typed at the prompt - the way
    ///      docs/deploy-sepolia.md says to run this - is unlocked too late to change that. The first
    ///      real Sepolia run took `msg.sender` as the deployer, made forge's default address the
    ///      owner of the test vault, and was then refused with `Unauthorized()` by the deployed
    ///      contract when the real broadcaster tried to queue a payment from it. Nothing was sent:
    ///      forge simulates before it broadcasts. Inside a broadcast, the caller is whoever is
    ///      signing, however they were chosen, and CI fails any script that reads `msg.sender`.
    function _broadcaster() internal returns (address account) {
        vm.startBroadcast();
        (, account,) = vm.readCallers();
        vm.stopBroadcast();
    }

    function _read(string memory path) internal view returns (string memory) {
        return vm.readFile(path);
    }

    function _assert(bool condition, string memory description) internal {
        if (condition) {
            console.log("  [ok]  ", description);
        } else {
            console.log("  [FAIL]", description);
            ok = false;
        }
    }
}
