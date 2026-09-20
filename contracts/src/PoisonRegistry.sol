// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IEAS, Attestation} from "eas-contracts/IEAS.sol";
import {SchemaResolver} from "eas-contracts/resolver/SchemaResolver.sol";

/// @title PoisonRegistry
/// @notice An EAS resolver for community reports about address poisoning.
///
/// @dev ## Why the subject is usually the planter, not the lookalike
///
///      Measured over 1200 blocks of mainnet USDT (`analysis/README.md`): 5,665 distinct lookalike
///      addresses were planted, by **18** distinct addresses, one of which accounted for 86% of
///      them. A registry of lookalikes would need thousands of entries a day, each useful to one
///      victim once. A registry of planters needs a handful, and each one covers everybody they
///      go on to target.
///
///      So the primary report is `Planter`. `Lookalike` exists too, because it is the report a
///      victim can make about their own case without knowing who planted anything.
///
///      ## What this contract can and cannot check
///
///      A `Lookalike` report is **provable on chain**, and this contract proves it: two addresses
///      either share the leading and trailing characters a wallet displays, or they do not. A
///      report that fails that check is rejected outright, so that half of the registry needs no
///      trust at all.
///
///      A `Planter` report is **not** provable here. Establishing that an address signed a
///      transaction which emitted a fabricated `Transfer` log would mean re-executing a past
///      transaction, which a resolver cannot do. Those reports carry an evidence transaction hash
///      for a human or an indexer to check, and nothing more — the contract records who said what
///      and counts distinct reporters, and deliberately does not pretend to have verified it.
///
///      ## Why this contract does not decide anything
///
///      Attesting is permissionless, as it must be for the registry to be worth having. That also
///      means anyone can report any address, including a legitimate one, and sybils are cheap. So
///      this contract publishes counts and verification status and stops there. The consumer
///      weights them — and the engine package deliberately never lets an unverified report reach
///      a "do not send" verdict on its own, because a permissionless registry that could would be
///      a griefing tool rather than a defence.
contract PoisonRegistry is SchemaResolver {
    /// @notice How many leading and trailing hex characters two addresses must share.
    /// @dev Matches `MIN_AFFIX_MATCH` in `packages/engine`, and a test asserts the two agree.
    ///      A wallet truncates to roughly six and four, so four is a floor rather than a typical
    ///      case: anything below it would not fool anyone, and a report claiming it is noise.
    uint8 public constant MIN_AFFIX_NIBBLES = 4;

    /// @dev Each hex character is four bits. Both constants are `uint8` so that every shift and
    ///      mask below is computed without a single cast — there is nothing here that could
    ///      truncate, rather than a cast plus a comment claiming it will not.
    uint8 private constant _AFFIX_BITS = MIN_AFFIX_NIBBLES * 4;

    enum Role {
        Unknown,
        /// @notice Signs transactions that plant fabricated records in other people's histories.
        Planter,
        /// @notice An address ground out to imitate another one.
        Lookalike
    }

    struct Report {
        address subject;
        Role role;
        /// @notice The address being imitated. Required for `Lookalike`, unused for `Planter`.
        address imitates;
        /// @notice A transaction anyone can go and look at. Not checked here; see the notes above.
        bytes32 evidence;
    }

    struct Tally {
        /// @notice Live attestations naming this subject.
        uint64 reports;
        /// @notice Distinct addresses that have reported it. The number worth weighting by.
        uint64 reporters;
        /// @notice Reports whose claim this contract proved, which is only ever `Lookalike` ones.
        uint64 verified;
    }

    mapping(address subject => Tally) private _tally;
    mapping(address subject => mapping(address reporter => uint64 live)) private _byReporter;

    event Reported(
        address indexed subject,
        address indexed reporter,
        Role role,
        address imitates,
        bool verified,
        bytes32 evidence
    );
    event ReportWithdrawn(address indexed subject, address indexed reporter);

    error SubjectRequired();
    error UnknownRole();
    error ImitatedAddressRequired();
    error CannotImitateItself();
    error NotALookalike(address subject, address imitates);
    error PlanterReportCannotNameAnImitatedAddress();
    error CannotReportYourself();

    constructor(IEAS eas) SchemaResolver(eas) {}

    /*//////////////////////////////////////////////////////////////
                                 QUERIES
    //////////////////////////////////////////////////////////////*/

    function tally(address subject) external view returns (Tally memory) {
        return _tally[subject];
    }

    /// @notice Whether `reporter` currently has a live report against `subject`.
    function hasReported(address subject, address reporter) external view returns (bool) {
        return _byReporter[subject][reporter] > 0;
    }

    /**
     * @notice Whether two addresses share the characters a wallet shows.
     *
     * @dev Public because it is useful on its own: a wallet can ask this before anyone has
     *      reported anything. It is also the entire basis on which a `Lookalike` report is
     *      accepted or rejected, so exposing it means the rule can be checked rather than trusted.
     */
    function isLookalike(address a, address b) public pure returns (bool) {
        if (a == b) return false;

        uint160 x = uint160(a);
        uint160 y = uint160(b);

        // Leading characters: the high bits of the 160-bit address.
        if (x >> (160 - _AFFIX_BITS) != y >> (160 - _AFFIX_BITS)) return false;

        // Trailing characters: the low bits. Built by shifting a `uint160` rather than narrowing
        // a `uint256`, so there is no cast that could truncate and none to justify.
        uint160 mask = (uint160(1) << _AFFIX_BITS) - 1;
        return (x & mask) == (y & mask);
    }

    /*//////////////////////////////////////////////////////////////
                             EAS INTEGRATION
    //////////////////////////////////////////////////////////////*/

    /// @dev Runs for every attestation against the schema this resolver is registered for.
    ///      Reverting rejects the attestation, which is how a false `Lookalike` claim never
    ///      reaches the registry at all.
    function onAttest(Attestation calldata attestation, uint256) internal override returns (bool) {
        Report memory report = abi.decode(attestation.data, (Report));

        if (report.subject == address(0)) revert SubjectRequired();
        if (report.subject == attestation.attester) revert CannotReportYourself();

        if (report.role == Role.Lookalike) {
            if (report.imitates == address(0)) revert ImitatedAddressRequired();
            if (report.imitates == report.subject) revert CannotImitateItself();
            if (!isLookalike(report.subject, report.imitates)) {
                revert NotALookalike(report.subject, report.imitates);
            }
        } else if (report.role == Role.Planter) {
            // A planter report naming an imitated address is a confused report: nothing here can
            // check that pairing, and accepting it would let it be read as though something had.
            if (report.imitates != address(0)) revert PlanterReportCannotNameAnImitatedAddress();
        } else {
            revert UnknownRole();
        }

        bool verified = report.role == Role.Lookalike;

        Tally storage counts = _tally[report.subject];
        counts.reports += 1;
        if (verified) counts.verified += 1;
        if (_byReporter[report.subject][attestation.attester]++ == 0) counts.reporters += 1;

        emit Reported(
            report.subject, attestation.attester, report.role, report.imitates, verified, report.evidence
        );

        return true;
    }

    /// @dev A reporter who was wrong, or who changed their mind, should be able to take it back —
    ///      otherwise the count only ever grows and stops meaning anything.
    function onRevoke(Attestation calldata attestation, uint256) internal override returns (bool) {
        Report memory report = abi.decode(attestation.data, (Report));

        Tally storage counts = _tally[report.subject];
        if (counts.reports > 0) counts.reports -= 1;
        if (report.role == Role.Lookalike && counts.verified > 0) counts.verified -= 1;

        uint64 live = _byReporter[report.subject][attestation.attester];
        if (live > 0) {
            _byReporter[report.subject][attestation.attester] = live - 1;
            if (live == 1 && counts.reporters > 0) counts.reporters -= 1;
        }

        emit ReportWithdrawn(report.subject, attestation.attester);
        return true;
    }
}
