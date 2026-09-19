// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {ITrueSendPolicy} from "../src/interfaces/ITrueSendPolicy.sol";
import {PolicyLib} from "../src/PolicyLib.sol";
import {SafeVault} from "../src/SafeVault.sol";
import {SafeVaultFactory} from "../src/SafeVaultFactory.sol";

uint32 constant INITIAL_COOLDOWN = 24 hours;
uint32 constant TRUST_DELAY = 12 hours;

/// @notice Drives a vault through arbitrary sequences of policy operations and records, for every
///         wei that actually left it, the conditions that were true at the moment it left.
///
/// @dev The handler owns its vault outright rather than pranking as a separate owner. Under the
///      invariant runner a `vm.prank` inside a handler does not reach the nested call, so every
///      `send` came back `Unauthorized`, the ghost log stayed empty and the invariants below were
///      passing on an empty set. `afterInvariant` now fails loudly if that ever happens again.
contract PolicyHandler is Test {
    SafeVault public vault;
    address[4] public recipients;

    struct Payout {
        address to;
        uint256 amount;
        uint64 at;
        bool wasTrusted;
        bool viaQueue;
        uint64 unlockAt;
    }

    Payout[] public payouts;
    uint256 public totalPaidOut;

    /// @dev Kept as a diagnostic: a campaign where everything reverts is worth noticing.
    uint256 public sendFailures;
    uint256 public executeFailures;

    uint256[] internal liveIds;

    constructor(SafeVaultFactory factory) {
        vault = SafeVault(
            payable(factory.deploy(address(this), INITIAL_COOLDOWN, TRUST_DELAY, address(0), bytes32(0)))
        );
        recipients = [
            makeAddr("recipient-a"), makeAddr("recipient-b"), makeAddr("recipient-c"), makeAddr("recipient-d")
        ];
    }

    function _pick(uint256 seed) internal view returns (address) {
        return recipients[seed % recipients.length];
    }

    function _record(address to, uint256 amount, bool viaQueue, uint64 unlockAt) internal {
        payouts.push(
            Payout({
                to: to,
                amount: amount,
                at: uint64(vm.getBlockTimestamp()),
                wasTrusted: vault.isTrusted(to),
                viaQueue: viaQueue,
                unlockAt: unlockAt
            })
        );
        totalPaidOut += amount;
    }

    function payoutCount() external view returns (uint256) {
        return payouts.length;
    }

    function liveIdCount() external view returns (uint256) {
        return liveIds.length;
    }

    /*//////////////////////////////////////////////////////////////
                                 ACTIONS
    //////////////////////////////////////////////////////////////*/

    function doSend(uint256 seed, uint256 amount) external {
        address to = _pick(seed);
        amount = bound(amount, 1, 5 ether);
        if (address(vault).balance < amount) return;

        try vault.send(to, PolicyLib.NATIVE, amount) returns (uint256 id) {
            if (id == 0) {
                _record(to, amount, false, 0);
            } else {
                liveIds.push(id);
            }
        } catch {
            sendFailures++;
        }
    }

    /// @dev Scans from a fuzzed offset for an entry that is actually settleable rather than
    ///      picking one at random. A purely random pick almost never landed on an unlocked entry,
    ///      so the campaign queued transfers forever and never settled one.
    function doExecute(uint256 seed) external {
        uint256 n = liveIds.length;
        // `seed % n` first: a fuzzer handing us a seed near max uint256 would overflow `seed + i`.
        uint256 start = n == 0 ? 0 : seed % n;
        for (uint256 i = 0; i < n; i++) {
            uint256 id = liveIds[(start + i) % n];
            PolicyLib.PendingTransfer memory t = vault.getTransfer(id);
            if (t.status != ITrueSendPolicy.TransferStatus.Queued) continue;
            if (vm.getBlockTimestamp() < t.unlockAt) continue;
            if (address(vault).balance < t.amount) continue;

            try vault.executeQueued(id) {
                _record(t.to, t.amount, true, t.unlockAt);
            } catch {
                executeFailures++;
            }
            return;
        }
    }

    /// @dev Cancels only entries that are still inside their hold. That is both what a user or
    ///      guardian actually does — you cancel because you spotted something during the wait —
    ///      and necessary for the campaign to be useful: an unrestricted cancel fired at roughly
    ///      the same rate as execute and starved the settlement path completely, leaving every
    ///      invariant below to pass over an empty ghost log. Cancelling *after* the unlock is
    ///      still allowed by the contract and is covered by `test_cancelQueued_worksAfterUnlockTime`.
    function doCancel(uint256 seed) external {
        uint256 n = liveIds.length;
        // `seed % n` first: a fuzzer handing us a seed near max uint256 would overflow `seed + i`.
        uint256 start = n == 0 ? 0 : seed % n;
        for (uint256 i = 0; i < n; i++) {
            uint256 id = liveIds[(start + i) % n];
            PolicyLib.PendingTransfer memory t = vault.getTransfer(id);
            if (t.status != ITrueSendPolicy.TransferStatus.Queued) continue;
            if (vm.getBlockTimestamp() >= t.unlockAt) continue;

            try vault.cancelQueued(id) {} catch {}
            return;
        }
    }

    function doAddTrusted(uint256 seed) external {
        try vault.addTrusted(_pick(seed)) {} catch {}
    }

    function doRemoveTrusted(uint256 seed) external {
        try vault.removeTrusted(_pick(seed)) {} catch {}
    }

    function doSetCooldown(uint32 value) external {
        try vault.setCooldown(uint32(bound(value, 1, PolicyLib.MAX_COOLDOWN))) {} catch {}
    }

    function doApplyCooldown() external {
        try vault.applyCooldownChange() {} catch {}
    }

    function doSetDailyLimit(uint256 value) external {
        try vault.setDailyLimit(PolicyLib.NATIVE, bound(value, 0, 20 ether)) {} catch {}
    }

    function doWarp(uint256 secs) external {
        vm.warp(vm.getBlockTimestamp() + bound(secs, 1 minutes, 2 days));
    }
}

/// @notice The properties that have to survive any ordering of the operations above.
contract PolicyInvariantTest is StdInvariant, Test {
    uint256 constant FUNDING = 500 ether;

    SafeVault vault;
    PolicyHandler handler;

    function setUp() public {
        vm.warp(1_700_000_000);

        handler = new PolicyHandler(new SafeVaultFactory(address(new SafeVault())));
        vault = handler.vault();
        vm.deal(address(vault), FUNDING);

        targetContract(address(handler));
    }

    /// @notice Runs at the end of every campaign run.
    /// @dev Whenever the handler found an entry that was queued, unlocked and covered by the
    ///      balance, settling it must have worked. A non-zero count here means the contract
    ///      refused a transfer it had already promised.
    function afterInvariant() public view {
        assertEq(handler.executeFailures(), 0, "a settleable transfer failed to settle");
        assertEq(handler.sendFailures(), 0, "a well-formed send was rejected");
    }

    /// @notice Proves the action set above can actually reach settlement.
    ///
    /// @dev Every invariant in this file is trivially true over an empty ghost log, so the log
    ///      being non-empty is load-bearing. This is not hypothetical — two earlier versions of
    ///      this handler passed all four invariants while moving zero funds: the first pranked as
    ///      a separate owner so every call reverted, and the second let an unrestricted
    ///      `doCancel` starve the settlement path. A per-run assertion cannot express this
    ///      (a short random run legitimately may not settle anything), so it lives here as a
    ///      deterministic campaign instead.
    function test_campaignActuallyReachesSettlement() public {
        uint256 seed = 0;
        for (uint256 step = 0; step < 240; step++) {
            seed = uint256(keccak256(abi.encode(seed, step)));

            uint256 action = seed % 6;
            if (action == 0) handler.doSend(seed, seed);
            else if (action == 1) handler.doWarp(seed % 2 days);
            else if (action == 2) handler.doExecute(seed);
            else if (action == 3) handler.doCancel(seed);
            else if (action == 4) handler.doAddTrusted(seed);
            else handler.doSetDailyLimit(seed);
        }

        assertGt(handler.payoutCount(), 0, "the action set cannot reach a payout at all");
        assertGt(handler.liveIdCount(), 0, "the action set cannot reach a queued transfer");
        assertGt(handler.totalPaidOut(), 0);
        assertEq(handler.executeFailures(), 0);
        assertEq(handler.sendFailures(), 0);
    }

    /// @notice The property the whole project rests on.
    ///
    ///         Every wei that has ever left this vault did so in one of exactly two ways: it went
    ///         to a recipient whose trust delay had fully elapsed, or it sat in the queue until
    ///         its unlock time. There is no third path, under any ordering of sends, cancels,
    ///         trust changes, cooldown changes and waiting.
    function invariant_everyPayoutWasTrustedOrWaitedOutItsCooldown() public view {
        uint256 n = handler.payoutCount();
        for (uint256 i = 0; i < n; i++) {
            (, uint256 amount, uint64 at, bool wasTrusted, bool viaQueue, uint64 unlockAt) =
                handler.payouts(i);

            assertGt(amount, 0);
            if (wasTrusted) continue;

            assertTrue(viaQueue, "an untrusted recipient was paid without going through the queue");
            assertGe(at, unlockAt, "a queued transfer settled before its unlock time");
        }
    }

    /// @notice Nothing leaks: the vault holds exactly what it started with minus what the handler
    ///         observed leaving. A double-spend or a replayed queue entry would break this.
    function invariant_balanceIsFullyAccountedFor() public view {
        assertEq(address(vault).balance + handler.totalPaidOut(), FUNDING);
    }

    /// @notice The cooldown in force is never zero and never above the configured ceiling, so
    ///         there is no state in which a transfer could settle instantly to a new address.
    function invariant_cooldownStaysWithinBounds() public view {
        uint32 cooldown = vault.policy().cooldown;
        assertGt(cooldown, 0);
        assertLe(cooldown, PolicyLib.MAX_COOLDOWN);
    }

    /// @notice Ids are handed out strictly in sequence, so an indexer that follows the event
    ///         stream can never miss or duplicate a queue entry.
    function invariant_transferIdsAreDense() public view {
        uint256 next = vault.policy().nextTransferId;
        assertGt(next, 0);
        if (next > 1) {
            assertTrue(vault.getTransfer(next - 1).status != ITrueSendPolicy.TransferStatus.None);
        }
        assertTrue(vault.getTransfer(next).status == ITrueSendPolicy.TransferStatus.None);
    }
}
