// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {GuardedBase} from "../src/GuardedBase.sol";
import {ITrueSendPolicy} from "../src/interfaces/ITrueSendPolicy.sol";
import {PolicyLib} from "../src/PolicyLib.sol";
import {SafeVault} from "../src/SafeVault.sol";
import {SafeVaultFactory} from "../src/SafeVaultFactory.sol";
import {MockERC20, RejectingReceiver, ReenteringReceiver} from "./mocks/Mocks.sol";

/// @notice Behaviour of the cooldown policy, exercised through the custodial vault because it is
///         the mode where the guarantee is unconditional. `GuardedAccount7702.t.sol` then checks
///         that the delegated mode reaches the same state machine.
contract SafeVaultTest is Test {
    uint32 constant COOLDOWN = 24 hours;
    uint32 constant TRUST_DELAY = 12 hours;

    SafeVaultFactory factory;
    SafeVault vault;
    MockERC20 usdc;

    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");
    address stranger = makeAddr("stranger");
    address alice = makeAddr("alice");
    address poisoned = makeAddr("poisoned");

    function setUp() public {
        vm.warp(1_700_000_000);

        factory = new SafeVaultFactory(address(new SafeVault()));
        vault = SafeVault(payable(factory.deploy(owner, COOLDOWN, TRUST_DELAY, guardian, bytes32(0))));

        usdc = new MockERC20("USD Coin", "USDC", 6);
        usdc.mint(address(vault), 1_000_000e6);
        vm.deal(address(vault), 100 ether);
        vm.deal(owner, 10 ether);
    }

    /*//////////////////////////////////////////////////////////////
                              INITIALIZATION
    //////////////////////////////////////////////////////////////*/

    function test_initialize_storesPolicy() public view {
        SafeVault.PolicyView memory p = vault.policy();
        assertTrue(p.initialized);
        assertEq(p.owner, owner);
        assertEq(p.cooldown, COOLDOWN);
        assertEq(p.trustDelay, TRUST_DELAY);
        assertEq(p.guardian, guardian);
        assertEq(p.nextTransferId, 1);
    }

    function test_initialize_isSingleUse() public {
        vm.expectRevert(ITrueSendPolicy.AlreadyInitialized.selector);
        vault.initialize(stranger, COOLDOWN, TRUST_DELAY, guardian);
    }

    function test_initialize_rejectsOwnerAsGuardian() public {
        vm.expectRevert(ITrueSendPolicy.InvalidGuardian.selector);
        factory.deploy(owner, COOLDOWN, TRUST_DELAY, owner, bytes32(uint256(1)));
    }

    function test_initialize_rejectsZeroCooldown() public {
        vm.expectRevert(ITrueSendPolicy.InvalidCooldown.selector);
        factory.deploy(owner, 0, TRUST_DELAY, guardian, bytes32(uint256(2)));
    }

    function test_factory_predictsDeployedAddress() public {
        address predicted = factory.predict(alice, bytes32(uint256(7)));
        address deployed = factory.deploy(alice, COOLDOWN, TRUST_DELAY, address(0), bytes32(uint256(7)));
        assertEq(deployed, predicted);
    }

    /*//////////////////////////////////////////////////////////////
                        THE CORE PROTECTION
    //////////////////////////////////////////////////////////////*/

    /// @notice The headline property: a fresh recipient never settles in the same transaction,
    ///         no matter who is asking. This is what a poisoned address runs into.
    function test_sendToUnknownRecipient_isQueuedNotSettled() public {
        uint256 balanceBefore = poisoned.balance;

        vm.prank(owner);
        uint256 id = vault.send(poisoned, PolicyLib.NATIVE, 5 ether);

        assertEq(id, 1);
        assertEq(poisoned.balance, balanceBefore, "funds must not have moved");

        PolicyLib.PendingTransfer memory t = vault.getTransfer(id);
        assertEq(t.to, poisoned);
        assertEq(t.amount, 5 ether);
        assertEq(t.unlockAt, uint64(vm.getBlockTimestamp()) + COOLDOWN);
        assertEq(uint8(t.status), uint8(ITrueSendPolicy.TransferStatus.Queued));
    }

    function test_executeQueued_revertsBeforeUnlock() public {
        vm.prank(owner);
        uint256 id = vault.send(poisoned, PolicyLib.NATIVE, 5 ether);

        uint64 unlockAt = uint64(vm.getBlockTimestamp()) + COOLDOWN;

        vm.warp(unlockAt - 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ITrueSendPolicy.TransferLocked.selector, unlockAt));
        vault.executeQueued(id);
    }

    function test_executeQueued_settlesAfterUnlock() public {
        vm.prank(owner);
        uint256 id = vault.send(alice, PolicyLib.NATIVE, 5 ether);

        vm.warp(vm.getBlockTimestamp() + COOLDOWN);
        vm.prank(owner);
        vault.executeQueued(id);

        assertEq(alice.balance, 5 ether);
        assertEq(uint8(vault.getTransfer(id).status), uint8(ITrueSendPolicy.TransferStatus.Executed));
    }

    function test_cancelQueued_byOwner_stopsTheTransferForever() public {
        vm.prank(owner);
        uint256 id = vault.send(poisoned, PolicyLib.NATIVE, 5 ether);

        vm.prank(owner);
        vault.cancelQueued(id);

        vm.warp(vm.getBlockTimestamp() + COOLDOWN * 10);
        vm.prank(owner);
        vm.expectRevert(ITrueSendPolicy.TransferNotQueued.selector);
        vault.executeQueued(id);

        assertEq(poisoned.balance, 0);
    }

    function test_cancelQueued_byGuardian() public {
        vm.prank(owner);
        uint256 id = vault.send(poisoned, PolicyLib.NATIVE, 5 ether);

        vm.expectEmit(true, true, false, false);
        emit ITrueSendPolicy.TransferCancelled(id, guardian);
        vm.prank(guardian);
        vault.cancelQueued(id);
    }

    function test_cancelQueued_byStranger_reverts() public {
        vm.prank(owner);
        uint256 id = vault.send(poisoned, PolicyLib.NATIVE, 5 ether);

        vm.prank(stranger);
        vm.expectRevert(ITrueSendPolicy.Unauthorized.selector);
        vault.cancelQueued(id);
    }

    /// @notice Cancelling stays available past the unlock time. The cooldown is the earliest a
    ///         transfer may settle, not a window after which it becomes unstoppable.
    function test_cancelQueued_worksAfterUnlockTime() public {
        vm.prank(owner);
        uint256 id = vault.send(poisoned, PolicyLib.NATIVE, 5 ether);

        vm.warp(vm.getBlockTimestamp() + COOLDOWN + 30 days);
        vm.prank(guardian);
        vault.cancelQueued(id);

        assertEq(uint8(vault.getTransfer(id).status), uint8(ITrueSendPolicy.TransferStatus.Cancelled));
    }

    function test_guardianCannotMoveFunds() public {
        vm.prank(guardian);
        vm.expectRevert(ITrueSendPolicy.Unauthorized.selector);
        vault.send(guardian, PolicyLib.NATIVE, 1 ether);

        vm.prank(owner);
        uint256 id = vault.send(alice, PolicyLib.NATIVE, 1 ether);
        vm.warp(vm.getBlockTimestamp() + COOLDOWN);

        vm.prank(guardian);
        vm.expectRevert(ITrueSendPolicy.Unauthorized.selector);
        vault.executeQueued(id);
    }

    /*//////////////////////////////////////////////////////////////
                           TRUSTED RECIPIENTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Trust does not take effect on the spot. Without this, "add the poisoned address
    ///         to contacts, then send" would be a single-transaction bypass of the whole design.
    function test_addTrusted_doesNotTakeEffectDuringDelay() public {
        vm.prank(owner);
        vault.addTrusted(alice);

        assertFalse(vault.isTrusted(alice));

        vm.prank(owner);
        uint256 id = vault.send(alice, PolicyLib.NATIVE, 1 ether);
        assertGt(id, 0, "still queued while trust is pending");
        assertEq(alice.balance, 0);
    }

    function test_addTrusted_settlesInstantlyOnceActive() public {
        vm.prank(owner);
        vault.addTrusted(alice);

        vm.warp(vm.getBlockTimestamp() + TRUST_DELAY);
        assertTrue(vault.isTrusted(alice));

        vm.prank(owner);
        uint256 id = vault.send(alice, PolicyLib.NATIVE, 1 ether);

        assertEq(id, 0, "instant transfers carry no queue id");
        assertEq(alice.balance, 1 ether);
    }

    function test_addTrusted_twiceReverts() public {
        vm.startPrank(owner);
        vault.addTrusted(alice);
        vm.expectRevert(ITrueSendPolicy.AlreadyTrusted.selector);
        vault.addTrusted(alice);
        vm.stopPrank();
    }

    function test_removeTrusted_takesEffectImmediately() public {
        vm.startPrank(owner);
        vault.addTrusted(alice);
        vm.warp(vm.getBlockTimestamp() + TRUST_DELAY);
        assertTrue(vault.isTrusted(alice));

        vault.removeTrusted(alice);
        assertFalse(vault.isTrusted(alice));

        uint256 id = vault.send(alice, PolicyLib.NATIVE, 1 ether);
        vm.stopPrank();
        assertGt(id, 0);
    }

    function test_removeTrusted_byGuardian() public {
        vm.prank(owner);
        vault.addTrusted(alice);
        vm.warp(vm.getBlockTimestamp() + TRUST_DELAY);

        vm.prank(guardian);
        vault.removeTrusted(alice);
        assertFalse(vault.isTrusted(alice));
    }

    /*//////////////////////////////////////////////////////////////
                              DAILY LIMITS
    //////////////////////////////////////////////////////////////*/

    function test_dailyLimit_overspillFallsIntoTheQueue() public {
        vm.startPrank(owner);
        vault.setDailyLimit(PolicyLib.NATIVE, 3 ether);
        vault.addTrusted(alice);
        vm.warp(vm.getBlockTimestamp() + TRUST_DELAY);

        assertEq(vault.send(alice, PolicyLib.NATIVE, 2 ether), 0);
        assertEq(vault.spentToday(PolicyLib.NATIVE), 2 ether);

        // 2 + 2 > 3, so this one waits instead of settling.
        uint256 id = vault.send(alice, PolicyLib.NATIVE, 2 ether);
        vm.stopPrank();

        assertGt(id, 0);
        assertEq(alice.balance, 2 ether);
        assertEq(vault.spentToday(PolicyLib.NATIVE), 2 ether, "a queued transfer must not consume allowance");
    }

    function test_dailyLimit_resetsTheNextDay() public {
        vm.startPrank(owner);
        vault.setDailyLimit(PolicyLib.NATIVE, 3 ether);
        vault.addTrusted(alice);
        vm.warp(vm.getBlockTimestamp() + TRUST_DELAY);
        vault.send(alice, PolicyLib.NATIVE, 3 ether);
        assertEq(vault.spentToday(PolicyLib.NATIVE), 3 ether);

        vm.warp(vm.getBlockTimestamp() + 1 days);
        assertEq(vault.spentToday(PolicyLib.NATIVE), 0);
        assertEq(vault.send(alice, PolicyLib.NATIVE, 3 ether), 0);
        vm.stopPrank();

        assertEq(alice.balance, 6 ether);
    }

    function test_setDailyLimit_tighteningIsInstant_looseningIsQueued() public {
        vm.startPrank(owner);
        vault.setDailyLimit(PolicyLib.NATIVE, 5 ether);
        (uint256 amount,,) = vault.dailyLimit(PolicyLib.NATIVE);
        assertEq(amount, 5 ether);

        vault.setDailyLimit(PolicyLib.NATIVE, 1 ether);
        (amount,,) = vault.dailyLimit(PolicyLib.NATIVE);
        assertEq(amount, 1 ether, "lowering a cap is a tightening");

        vault.setDailyLimit(PolicyLib.NATIVE, 100 ether);
        (uint256 effective, uint256 pending, uint64 unlockAt) = vault.dailyLimit(PolicyLib.NATIVE);
        assertEq(effective, 1 ether, "raising a cap must not apply yet");
        assertEq(pending, 100 ether);
        assertEq(unlockAt, uint64(vm.getBlockTimestamp()) + COOLDOWN);

        vm.expectRevert(abi.encodeWithSelector(ITrueSendPolicy.ChangeLocked.selector, unlockAt));
        vault.applyDailyLimitChange(PolicyLib.NATIVE);

        vm.warp(unlockAt);
        vault.applyDailyLimitChange(PolicyLib.NATIVE);
        (effective,, unlockAt) = vault.dailyLimit(PolicyLib.NATIVE);
        assertEq(effective, 100 ether);
        assertEq(unlockAt, 0);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                         POLICY CHANGE ASYMMETRY
    //////////////////////////////////////////////////////////////*/

    /// @notice The property that keeps the cooldown from being decorative: an attacker holding
    ///         the key cannot simply switch it off and drain in the same transaction.
    function test_setCooldown_cannotBeLoweredWithoutWaiting() public {
        vm.startPrank(owner);
        vault.setCooldown(1 minutes);

        SafeVault.PolicyView memory p = vault.policy();
        assertEq(p.cooldown, COOLDOWN, "still the old, stronger cooldown");
        assertEq(p.pendingCooldown, 1 minutes);
        assertEq(p.pendingCooldownUnlockAt, uint64(vm.getBlockTimestamp()) + COOLDOWN);

        vm.expectRevert(
            abi.encodeWithSelector(ITrueSendPolicy.ChangeLocked.selector, p.pendingCooldownUnlockAt)
        );
        vault.applyCooldownChange();

        vm.warp(p.pendingCooldownUnlockAt);
        vault.applyCooldownChange();
        assertEq(vault.policy().cooldown, 1 minutes);
        vm.stopPrank();
    }

    function test_setCooldown_raisingIsInstant() public {
        vm.prank(owner);
        vault.setCooldown(48 hours);
        assertEq(vault.policy().cooldown, 48 hours);
    }

    function test_setCooldown_raisingDropsAPendingReduction() public {
        vm.startPrank(owner);
        vault.setCooldown(1 minutes);
        assertGt(vault.policy().pendingCooldownUnlockAt, 0);

        vault.setCooldown(48 hours);
        SafeVault.PolicyView memory p = vault.policy();
        assertEq(p.cooldown, 48 hours);
        assertEq(p.pendingCooldownUnlockAt, 0, "a tightening cancels a queued loosening");
        vm.stopPrank();
    }

    function test_guardianCanCancelACooldownReduction() public {
        vm.prank(owner);
        vault.setCooldown(1 minutes);

        vm.prank(guardian);
        vault.cancelCooldownChange();

        SafeVault.PolicyView memory p = vault.policy();
        assertEq(p.cooldown, COOLDOWN);
        assertEq(p.pendingCooldownUnlockAt, 0);
    }

    function test_setGuardian_firstAppointmentIsInstant() public {
        SafeVault fresh =
            SafeVault(payable(factory.deploy(owner, COOLDOWN, TRUST_DELAY, address(0), bytes32(uint256(9)))));

        vm.prank(owner);
        fresh.setGuardian(guardian);
        assertEq(fresh.policy().guardian, guardian);
    }

    function test_setGuardian_replacingIsQueued() public {
        address newGuardian = makeAddr("newGuardian");

        vm.startPrank(owner);
        vault.setGuardian(newGuardian);

        SafeVault.PolicyView memory p = vault.policy();
        assertEq(p.guardian, guardian, "incumbent stays until the delay elapses");
        assertEq(p.pendingGuardian, newGuardian);

        vm.warp(p.pendingGuardianUnlockAt);
        vault.applyGuardianChange();
        assertEq(vault.policy().guardian, newGuardian);
        vm.stopPrank();
    }

    /// @notice A guardian must not be able to hold the account hostage by vetoing its own
    ///         replacement. Its power is strictly negative and strictly per-transfer.
    function test_guardianCannotBlockItsOwnReplacement() public {
        vm.prank(owner);
        vault.setGuardian(makeAddr("newGuardian"));

        vm.prank(guardian);
        vm.expectRevert(ITrueSendPolicy.Unauthorized.selector);
        vault.cancelGuardianChange();

        vm.prank(owner);
        vault.cancelGuardianChange();
        assertEq(vault.policy().pendingGuardianUnlockAt, 0);
    }

    /*//////////////////////////////////////////////////////////////
                                 ERC-20
    //////////////////////////////////////////////////////////////*/

    function test_erc20_followsTheSamePath() public {
        vm.prank(owner);
        uint256 id = vault.send(poisoned, address(usdc), 1000e6);
        assertEq(usdc.balanceOf(poisoned), 0);

        vm.warp(vm.getBlockTimestamp() + COOLDOWN);
        vm.prank(owner);
        vault.executeQueued(id);
        assertEq(usdc.balanceOf(poisoned), 1000e6);
    }

    function test_depositERC20_emitsAttributableEvent() public {
        usdc.mint(alice, 500e6);
        vm.startPrank(alice);
        usdc.approve(address(vault), 500e6);

        vm.expectEmit(true, true, false, true);
        emit ITrueSendPolicy.Deposited(address(usdc), alice, 500e6);
        vault.depositERC20(address(usdc), 500e6);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                             FAILURE MODES
    //////////////////////////////////////////////////////////////*/

    function test_nativeTransferToRejectingReceiver_reverts() public {
        address rejecting = address(new RejectingReceiver());

        vm.prank(owner);
        uint256 id = vault.send(rejecting, PolicyLib.NATIVE, 1 ether);

        vm.warp(vm.getBlockTimestamp() + COOLDOWN);
        vm.prank(owner);
        vm.expectRevert(ITrueSendPolicy.NativeTransferFailed.selector);
        vault.executeQueued(id);
    }

    /// @notice A recipient that calls back in while receiving ETH must not be able to replay the
    ///         same queued transfer.
    function test_reentrantRecipientCannotReplayATransfer() public {
        ReenteringReceiver attacker = new ReenteringReceiver();

        vm.prank(owner);
        uint256 id = vault.send(address(attacker), PolicyLib.NATIVE, 1 ether);
        attacker.arm(address(vault), abi.encodeCall(GuardedBase.executeQueued, (id)));

        vm.warp(vm.getBlockTimestamp() + COOLDOWN);
        vm.prank(owner);
        vault.executeQueued(id);

        assertTrue(attacker.attempted(), "the callback did run");
        assertFalse(attacker.succeeded(), "but it did not go through");
        assertEq(address(attacker).balance, 1 ether, "paid exactly once");
    }

    function test_send_rejectsZeroAmountAndSelf() public {
        vm.startPrank(owner);
        vm.expectRevert(ITrueSendPolicy.InvalidAmount.selector);
        vault.send(alice, PolicyLib.NATIVE, 0);

        vm.expectRevert(ITrueSendPolicy.InvalidRecipient.selector);
        vault.send(address(vault), PolicyLib.NATIVE, 1 ether);

        vm.expectRevert(ITrueSendPolicy.InvalidRecipient.selector);
        vault.send(address(0), PolicyLib.NATIVE, 1 ether);
        vm.stopPrank();
    }

    function test_onlyOwnerMayStartATransfer() public {
        vm.prank(stranger);
        vm.expectRevert(ITrueSendPolicy.Unauthorized.selector);
        vault.send(stranger, PolicyLib.NATIVE, 1 ether);
    }

    /*//////////////////////////////////////////////////////////////
                                  QUOTE
    //////////////////////////////////////////////////////////////*/

    /// @notice The frontend relies on this to warn before the user signs, so it has to agree
    ///         with what `send` actually does.
    function test_quote_agreesWithSend() public {
        (bool instant, uint64 unlockAt) = vault.quote(alice, PolicyLib.NATIVE, 1 ether);
        assertFalse(instant);
        assertEq(unlockAt, uint64(vm.getBlockTimestamp()) + COOLDOWN);

        vm.startPrank(owner);
        assertGt(vault.send(alice, PolicyLib.NATIVE, 1 ether), 0);

        vault.addTrusted(alice);
        vm.warp(vm.getBlockTimestamp() + TRUST_DELAY);

        (instant, unlockAt) = vault.quote(alice, PolicyLib.NATIVE, 1 ether);
        assertTrue(instant);
        assertEq(unlockAt, 0);
        assertEq(vault.send(alice, PolicyLib.NATIVE, 1 ether), 0);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                                  FUZZ
    //////////////////////////////////////////////////////////////*/

    /// @notice For any recipient the owner has not trusted and any wait shorter than the
    ///         cooldown, the funds are still in the vault.
    function testFuzz_untrustedRecipientCannotBePaidEarly(address to, uint256 amount, uint32 wait) public {
        vm.assume(to != address(0) && to != address(vault) && to.code.length == 0);
        vm.assume(uint160(to) > 0x0a); // skip precompiles
        amount = bound(amount, 1, 50 ether);
        wait = uint32(bound(wait, 0, COOLDOWN - 1));

        uint256 before = to.balance;

        vm.prank(owner);
        uint256 id = vault.send(to, PolicyLib.NATIVE, amount);
        assertGt(id, 0);

        vm.warp(vm.getBlockTimestamp() + wait);
        vm.prank(owner);
        vm.expectRevert();
        vault.executeQueued(id);

        assertEq(to.balance, before);
    }

    /// @notice However the owner fiddles with the cooldown, the value in force never drops
    ///         without a wait at least as long as the cooldown it is replacing.
    function testFuzz_cooldownCannotBeShortenedInstantly(uint32 attempt) public {
        attempt = uint32(bound(attempt, 1, PolicyLib.MAX_COOLDOWN));

        vm.prank(owner);
        vault.setCooldown(attempt);

        uint32 inForce = vault.policy().cooldown;
        assertGe(inForce, attempt >= COOLDOWN ? attempt : COOLDOWN);
    }
}
