// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {EAS} from "eas-contracts/EAS.sol";
import {ISchemaRegistry, SchemaRegistry} from "eas-contracts/SchemaRegistry.sol";
import {ISchemaResolver} from "eas-contracts/resolver/ISchemaResolver.sol";
import {
    AttestationRequest,
    AttestationRequestData,
    RevocationRequest,
    RevocationRequestData
} from "eas-contracts/IEAS.sol";
import {NO_EXPIRATION_TIME} from "eas-contracts/Common.sol";

import {PoisonRegistry} from "../src/PoisonRegistry.sol";

/// @notice The registry, driven through a real EAS deployment rather than a mock.
///
/// @dev Mocking EAS would test the resolver's logic against an imagined caller. Running the real
///      contracts means the attestation encoding, the resolver hook and the revocation path are
///      all exercised the way they will be on chain — which matters, because the one thing this
///      contract does that cannot be checked anywhere else is reject an attestation, and a
///      rejection that does not actually reach EAS is not a rejection.
contract PoisonRegistryTest is Test {
    string constant SCHEMA = "address subject,uint8 role,address imitates,bytes32 evidence";

    SchemaRegistry schemaRegistry;
    EAS eas;
    PoisonRegistry registry;
    bytes32 schemaUid;

    address reporter = makeAddr("reporter");
    address otherReporter = makeAddr("otherReporter");

    /// @dev An address the victim really paid.
    address constant ALICE = 0xAb58c49b70d5E2f1a0C9f3d7E6B4a2C8d1f00e93;
    /// @dev Ground out to share Alice's first four and last four characters.
    address constant POISONED = 0xaB58C41122334455667788990011223344f00e93;
    /// @dev Signs the transactions that plant fabrications. The high-leverage subject.
    address constant PLANTER = 0xD6434D157f254276D69eDE3bd9fC805482206908;
    address constant UNRELATED = 0x742d35Cc6634C0532925a3b844Bc454e4438f44e;

    function setUp() public {
        schemaRegistry = new SchemaRegistry();
        eas = new EAS(ISchemaRegistry(address(schemaRegistry)));
        registry = new PoisonRegistry(eas);
        schemaUid = schemaRegistry.register(SCHEMA, ISchemaResolver(address(registry)), true);
    }

    function _report(
        address from,
        address subject,
        PoisonRegistry.Role role,
        address imitates,
        bytes32 evidence
    ) internal returns (bytes32 uid) {
        bytes memory data = abi.encode(
            PoisonRegistry.Report({subject: subject, role: role, imitates: imitates, evidence: evidence})
        );

        vm.prank(from);
        return eas.attest(
            AttestationRequest({
                schema: schemaUid,
                data: AttestationRequestData({
                    recipient: subject,
                    expirationTime: NO_EXPIRATION_TIME,
                    revocable: true,
                    refUID: bytes32(0),
                    data: data,
                    value: 0
                })
            })
        );
    }

    /*//////////////////////////////////////////////////////////////
                         WHAT THE CHAIN CAN PROVE
    //////////////////////////////////////////////////////////////*/

    /// @notice The half of the registry that needs no trust: a lookalike claim is checkable, and
    ///         this contract checks it.
    function test_lookalikeReportIsAcceptedAndMarkedVerified() public {
        _report(reporter, POISONED, PoisonRegistry.Role.Lookalike, ALICE, bytes32("evidence"));

        PoisonRegistry.Tally memory counts = registry.tally(POISONED);
        assertEq(counts.reports, 1);
        assertEq(counts.reporters, 1);
        assertEq(counts.verified, 1, "a proven claim is marked proven");
    }

    /// @notice A false lookalike claim never reaches the registry at all.
    function test_lookalikeReportIsRejectedWhenTheAddressesDoNotCollide() public {
        vm.expectRevert();
        _report(reporter, UNRELATED, PoisonRegistry.Role.Lookalike, ALICE, bytes32(0));

        assertEq(registry.tally(UNRELATED).reports, 0);
    }

    function test_isLookalikeMatchesTheRuleTheEngineUses() public view {
        assertTrue(registry.isLookalike(POISONED, ALICE));
        assertFalse(registry.isLookalike(UNRELATED, ALICE));
        assertFalse(registry.isLookalike(ALICE, ALICE), "an address does not imitate itself");
    }

    /// @notice The exported constant is the contract between this and the off-chain detector.
    /// @dev `MIN_AFFIX_MATCH` in `packages/engine` is 4. If either moves without the other, the
    ///      registry starts accepting claims the app will not show, or rejecting ones it will.
    function test_affixThresholdIsFourCharactersEachEnd() public view {
        assertEq(registry.MIN_AFFIX_NIBBLES(), 4);

        // Shares exactly four at each end and nothing more: the floor, and it must pass.
        address floorCase = 0xab58000000000000000000000000000000000E93;
        assertTrue(registry.isLookalike(floorCase, ALICE));

        // One character short at the front.
        address justUnder = 0xab59000000000000000000000000000000000E93;
        assertFalse(registry.isLookalike(justUnder, ALICE));
    }

    /*//////////////////////////////////////////////////////////////
                       WHAT THE CHAIN CANNOT PROVE
    //////////////////////////////////////////////////////////////*/

    /// @notice The high-leverage report. Eighteen planters accounted for every fabrication in the
    ///         sampled window, so these are the entries that scale.
    function test_planterReportIsAcceptedButNotMarkedVerified() public {
        _report(reporter, PLANTER, PoisonRegistry.Role.Planter, address(0), bytes32("tx"));

        PoisonRegistry.Tally memory counts = registry.tally(PLANTER);
        assertEq(counts.reports, 1);
        assertEq(counts.reporters, 1);
        assertEq(
            counts.verified,
            0,
            "nothing on chain can re-execute a past transaction, so this claim is unproven and says so"
        );
    }

    /// @notice A planter report that names an imitated address would read as though the pairing
    ///         had been checked. Nothing here can check it, so the report is refused.
    function test_planterReportCannotSmuggleInAnUncheckedPairing() public {
        vm.expectRevert();
        _report(reporter, PLANTER, PoisonRegistry.Role.Planter, ALICE, bytes32(0));
    }

    /*//////////////////////////////////////////////////////////////
                              COUNTING
    //////////////////////////////////////////////////////////////*/

    /// @notice Distinct reporters is the number worth weighting by; total reports is not, because
    ///         one address can make as many as it likes.
    function test_repeatedReportsFromOneAddressCountAsOneReporter() public {
        _report(reporter, PLANTER, PoisonRegistry.Role.Planter, address(0), bytes32("a"));
        _report(reporter, PLANTER, PoisonRegistry.Role.Planter, address(0), bytes32("b"));
        _report(reporter, PLANTER, PoisonRegistry.Role.Planter, address(0), bytes32("c"));

        PoisonRegistry.Tally memory counts = registry.tally(PLANTER);
        assertEq(counts.reports, 3);
        assertEq(counts.reporters, 1, "three attestations, one voice");
    }

    function test_separateReportersAreCountedSeparately() public {
        _report(reporter, PLANTER, PoisonRegistry.Role.Planter, address(0), bytes32("a"));
        _report(otherReporter, PLANTER, PoisonRegistry.Role.Planter, address(0), bytes32("b"));

        assertEq(registry.tally(PLANTER).reporters, 2);
        assertTrue(registry.hasReported(PLANTER, reporter));
        assertTrue(registry.hasReported(PLANTER, otherReporter));
    }

    function test_nobodyHasReportedAnAddressNobodyReported() public view {
        assertEq(registry.tally(UNRELATED).reports, 0);
        assertFalse(registry.hasReported(UNRELATED, reporter));
    }

    /*//////////////////////////////////////////////////////////////
                             TAKING IT BACK
    //////////////////////////////////////////////////////////////*/

    /// @notice A count that only ever grows stops meaning anything, so a reporter who was wrong
    ///         has to be able to withdraw.
    function test_revokingAReportRemovesIt() public {
        bytes32 uid = _report(reporter, POISONED, PoisonRegistry.Role.Lookalike, ALICE, bytes32(0));

        vm.prank(reporter);
        eas.revoke(RevocationRequest({schema: schemaUid, data: RevocationRequestData({uid: uid, value: 0})}));

        PoisonRegistry.Tally memory counts = registry.tally(POISONED);
        assertEq(counts.reports, 0);
        assertEq(counts.reporters, 0);
        assertEq(counts.verified, 0);
        assertFalse(registry.hasReported(POISONED, reporter));
    }

    function test_withdrawingOneOfSeveralKeepsTheReporterCounted() public {
        _report(reporter, PLANTER, PoisonRegistry.Role.Planter, address(0), bytes32("a"));
        bytes32 second = _report(reporter, PLANTER, PoisonRegistry.Role.Planter, address(0), bytes32("b"));

        vm.prank(reporter);
        eas.revoke(
            RevocationRequest({schema: schemaUid, data: RevocationRequestData({uid: second, value: 0})})
        );

        PoisonRegistry.Tally memory counts = registry.tally(PLANTER);
        assertEq(counts.reports, 1);
        assertEq(counts.reporters, 1, "they still have one live report");
    }

    /*//////////////////////////////////////////////////////////////
                             MALFORMED
    //////////////////////////////////////////////////////////////*/

    function test_reportWithNoSubjectIsRefused() public {
        vm.expectRevert();
        _report(reporter, address(0), PoisonRegistry.Role.Planter, address(0), bytes32(0));
    }

    function test_reportWithNoRoleIsRefused() public {
        vm.expectRevert();
        _report(reporter, PLANTER, PoisonRegistry.Role.Unknown, address(0), bytes32(0));
    }

    function test_lookalikeReportWithoutAnImitatedAddressIsRefused() public {
        vm.expectRevert();
        _report(reporter, POISONED, PoisonRegistry.Role.Lookalike, address(0), bytes32(0));
    }

    /// @notice An address does not imitate itself, and a report saying it does would add a
    ///         "verified" mark to a claim with no content.
    function test_anAddressCannotBeReportedForImitatingItself() public {
        vm.expectRevert();
        _report(reporter, POISONED, PoisonRegistry.Role.Lookalike, POISONED, bytes32(0));

        assertEq(registry.tally(POISONED).reports, 0);
    }

    /// @notice Reporting yourself is either a mistake or an attempt to inflate a count.
    function test_reportingYourselfIsRefused() public {
        vm.expectRevert();
        _report(reporter, reporter, PoisonRegistry.Role.Planter, address(0), bytes32(0));
    }

    /*//////////////////////////////////////////////////////////////
                                 FUZZ
    //////////////////////////////////////////////////////////////*/

    /// @notice Whatever is reported, the rule the contract enforces is the rule it publishes.
    function testFuzz_onlyProvableClaimsAreEverMarkedVerified(address subject, address imitates) public {
        vm.assume(subject != address(0) && subject != reporter && subject != imitates);
        vm.assume(imitates != address(0));

        bool shouldPass = registry.isLookalike(subject, imitates);
        if (!shouldPass) vm.expectRevert();

        _report(reporter, subject, PoisonRegistry.Role.Lookalike, imitates, bytes32(0));

        assertEq(registry.tally(subject).verified, shouldPass ? 1 : 0);
    }

    /// @notice Two addresses share their affixes, or they do not — the check is symmetric, so a
    ///         report cannot be made to pass by swapping which one is named.
    function testFuzz_lookalikeCheckIsSymmetric(address a, address b) public view {
        assertEq(registry.isLookalike(a, b), registry.isLookalike(b, a));
    }
}
