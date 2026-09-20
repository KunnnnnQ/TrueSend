// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {GuardedAccount} from "../src/GuardedAccount.sol";
import {ITrueSendPolicy} from "../src/interfaces/ITrueSendPolicy.sol";
import {PolicyLib} from "../src/PolicyLib.sol";
import {SafeVault} from "../src/SafeVault.sol";
import {SafeVaultFactory} from "../src/SafeVaultFactory.sol";
import {MockERC20} from "./mocks/Mocks.sol";

/// @notice Every guard clause in the policy, exercised.
///
/// @dev The behaviour suite covers what the contracts do when things go right. This one covers
///      what they do when they do not, which in a contract whose whole job is refusing things is
///      where the interesting behaviour lives — and where an untested branch is a branch that has
///      never once been shown to refuse anything.
///
///      Written after a coverage report named eighteen untaken branches and every single one
///      turned out to be an error path.
contract PolicyGuardsTest is Test {
    uint32 constant COOLDOWN = 24 hours;
    uint32 constant TRUST_DELAY = 12 hours;

    SafeVaultFactory factory;
    SafeVault vault;
    MockERC20 usdc;

    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");
    address stranger = makeAddr("stranger");
    address alice = makeAddr("alice");

    function setUp() public {
        vm.warp(1_700_000_000);
        factory = new SafeVaultFactory(address(new SafeVault()));
        vault = SafeVault(payable(factory.deploy(owner, COOLDOWN, TRUST_DELAY, guardian, bytes32(0))));
        usdc = new MockERC20("USD Coin", "USDC", 6);
        vm.deal(address(vault), 10 ether);
    }

    /*//////////////////////////////////////////////////////////////
                         BEFORE THERE IS A POLICY
    //////////////////////////////////////////////////////////////*/

    /// @notice A vault clone with no policy refuses everything, because it has no owner either.
    /// @dev The error is `Unauthorized` rather than `NotInitialized`, which reads oddly until you
    ///      notice it is the more accurate of the two: an uninitialised vault stores no owner, so
    ///      nobody is authorised, and `onlyOwner` is reached first. `msg.sender` is never zero for
    ///      a real call, so there is no caller this lets through.
    function test_anUninitialisedVaultHasNoOwnerAndRefusesEveryone() public {
        SafeVault bare = new SafeVault();

        vm.startPrank(owner);
        vm.expectRevert(ITrueSendPolicy.Unauthorized.selector);
        bare.send(alice, PolicyLib.NATIVE, 1 ether);

        vm.expectRevert(ITrueSendPolicy.Unauthorized.selector);
        bare.addTrusted(alice);

        vm.expectRevert(ITrueSendPolicy.Unauthorized.selector);
        bare.setCooldown(1 hours);
        vm.stopPrank();

        assertEq(bare.owner(), address(0), "there is nobody to authorise");
    }

    /// @notice A delegated account whose policy has not been switched on yet.
    ///
    /// @dev The realistic shape of "owner set, policy absent": under EIP-7702 the owner is the
    ///      account itself from the moment the delegation lands, which can be a block before
    ///      anybody calls `initialize`. A self-call in that window passes the ownership check and
    ///      has to be stopped by the initialisation check — if it were not, the account would be
    ///      moving funds under a policy with a cooldown of zero.
    function test_aDelegatedAccountRefusesToActBeforeItsPolicyExists() public {
        uint256 pk = 0xA11CE;
        address account = vm.addr(pk);
        vm.deal(account, 10 ether);

        vm.signAndAttachDelegation(address(new GuardedAccount()), pk);

        vm.startPrank(account);
        vm.expectRevert(ITrueSendPolicy.NotInitialized.selector);
        GuardedAccount(payable(account)).send(alice, PolicyLib.NATIVE, 1 ether);

        vm.expectRevert(ITrueSendPolicy.NotInitialized.selector);
        GuardedAccount(payable(account)).addTrusted(alice);

        vm.expectRevert(ITrueSendPolicy.NotInitialized.selector);
        GuardedAccount(payable(account)).executeQueued(1);

        vm.expectRevert(ITrueSendPolicy.NotInitialized.selector);
        GuardedAccount(payable(account)).cancelQueued(1);
        vm.stopPrank();

        assertEq(alice.balance, 0, "nothing left the account");
    }

    function test_initializeRejectsATrustDelayBeyondTheCeiling() public {
        vm.expectRevert(ITrueSendPolicy.InvalidCooldown.selector);
        factory.deploy(owner, COOLDOWN, uint32(PolicyLib.MAX_TRUST_DELAY) + 1, guardian, bytes32(uint256(1)));
    }

    function test_vaultRefusesAnOwnerOfZero() public {
        SafeVault bare = new SafeVault();
        vm.expectRevert(ITrueSendPolicy.InvalidRecipient.selector);
        bare.initialize(address(0), COOLDOWN, TRUST_DELAY, guardian);
    }

    function test_factoryRefusesAnImplementationOfZero() public {
        vm.expectRevert(SafeVaultFactory.VaultDeploymentFailed.selector);
        new SafeVaultFactory(address(0));
    }

    /*//////////////////////////////////////////////////////////////
                             TRUSTED LIST
    //////////////////////////////////////////////////////////////*/

    function test_cannotTrustNothingOrItself() public {
        vm.startPrank(owner);
        vm.expectRevert(ITrueSendPolicy.InvalidRecipient.selector);
        vault.addTrusted(address(0));

        vm.expectRevert(ITrueSendPolicy.InvalidRecipient.selector);
        vault.addTrusted(address(vault));
        vm.stopPrank();
    }

    function test_cannotUntrustSomebodyWhoWasNeverTrusted() public {
        vm.prank(owner);
        vm.expectRevert(ITrueSendPolicy.NotTrusted.selector);
        vault.removeTrusted(alice);
    }

    /*//////////////////////////////////////////////////////////////
                          QUEUE STATE MACHINE
    //////////////////////////////////////////////////////////////*/

    /// @notice A transfer leaves the queue exactly once. Cancelling twice, or cancelling one that
    ///         already settled, has to be refused rather than silently accepted — a second
    ///         "cancelled" on an executed transfer would tell the owner their funds are safe.
    function test_aTransferCannotLeaveTheQueueTwice() public {
        vm.startPrank(owner);
        uint256 id = vault.send(alice, PolicyLib.NATIVE, 1 ether);
        vault.cancelQueued(id);

        vm.expectRevert(ITrueSendPolicy.TransferNotQueued.selector);
        vault.cancelQueued(id);

        uint256 second = vault.send(alice, PolicyLib.NATIVE, 1 ether);
        vm.warp(vm.getBlockTimestamp() + COOLDOWN);
        vault.executeQueued(second);

        vm.expectRevert(ITrueSendPolicy.TransferNotQueued.selector);
        vault.cancelQueued(second);

        vm.expectRevert(ITrueSendPolicy.TransferNotQueued.selector);
        vault.executeQueued(second);
        vm.stopPrank();
    }

    function test_anIdThatWasNeverIssuedIsNotQueued() public {
        vm.prank(owner);
        vm.expectRevert(ITrueSendPolicy.TransferNotQueued.selector);
        vault.cancelQueued(999);
    }

    /// @notice The queue promises an amount; if the funds have gone the promise must fail loudly
    ///         rather than send whatever is left.
    function test_settlingMoreThanTheVaultHoldsIsRefused() public {
        vm.startPrank(owner);
        uint256 id = vault.send(alice, PolicyLib.NATIVE, 9 ether);

        // Trusted recipient drains the balance in the meantime.
        vault.addTrusted(stranger);
        vm.warp(vm.getBlockTimestamp() + TRUST_DELAY);
        vault.send(stranger, PolicyLib.NATIVE, 10 ether);

        vm.warp(vm.getBlockTimestamp() + COOLDOWN);
        vm.expectRevert(ITrueSendPolicy.InsufficientBalance.selector);
        vault.executeQueued(id);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                        NOTHING QUEUED TO APPLY
    //////////////////////////////////////////////////////////////*/

    /// @notice Applying a change that was never queued must not quietly succeed and write a zero.
    ///         For the cooldown that would mean switching the protection off.
    function test_applyingAChangeThatWasNeverQueuedIsRefused() public {
        vm.startPrank(owner);
        vm.expectRevert(ITrueSendPolicy.NothingQueued.selector);
        vault.applyCooldownChange();

        vm.expectRevert(ITrueSendPolicy.NothingQueued.selector);
        vault.applyGuardianChange();

        vm.expectRevert(ITrueSendPolicy.NothingQueued.selector);
        vault.applyDailyLimitChange(PolicyLib.NATIVE);
        vm.stopPrank();

        assertEq(vault.policy().cooldown, COOLDOWN, "the cooldown is untouched");
    }

    function test_cancellingAChangeThatWasNeverQueuedIsRefused() public {
        vm.startPrank(owner);
        vm.expectRevert(ITrueSendPolicy.NothingQueued.selector);
        vault.cancelCooldownChange();

        vm.expectRevert(ITrueSendPolicy.NothingQueued.selector);
        vault.cancelGuardianChange();

        vm.expectRevert(ITrueSendPolicy.NothingQueued.selector);
        vault.cancelDailyLimitChange(PolicyLib.NATIVE);
        vm.stopPrank();
    }

    function test_aQueuedGuardianChangeCannotBeAppliedEarly() public {
        address replacement = makeAddr("replacement");

        vm.startPrank(owner);
        vault.setGuardian(replacement);
        uint64 unlockAt = vault.policy().pendingGuardianUnlockAt;

        vm.warp(unlockAt - 1);
        vm.expectRevert(abi.encodeWithSelector(ITrueSendPolicy.ChangeLocked.selector, unlockAt));
        vault.applyGuardianChange();

        assertEq(vault.policy().guardian, guardian, "the incumbent is still in place");
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                              GUARDIAN
    //////////////////////////////////////////////////////////////*/

    /// @notice A guardian that is the owner is not a second pair of eyes, it is the same pair.
    function test_theOwnerCannotBeItsOwnGuardian() public {
        vm.prank(owner);
        vm.expectRevert(ITrueSendPolicy.InvalidGuardian.selector);
        vault.setGuardian(owner);
    }

    /// @notice Setting no guardian when there is no guardian is a mistake, not a no-op, and
    ///         accepting it would emit an event saying something changed.
    function test_appointingNobodyAsAFirstGuardianIsRefused() public {
        SafeVault solo =
            SafeVault(payable(factory.deploy(owner, COOLDOWN, TRUST_DELAY, address(0), bytes32(uint256(2)))));

        vm.prank(owner);
        vm.expectRevert(ITrueSendPolicy.InvalidGuardian.selector);
        solo.setGuardian(address(0));
    }

    /// @notice With no guardian appointed, the veto powers belong to the owner alone. A stranger
    ///         must not slip through the `guardian == address(0)` case.
    function test_withNoGuardianAStrangerHasNoVeto() public {
        SafeVault solo =
            SafeVault(payable(factory.deploy(owner, COOLDOWN, TRUST_DELAY, address(0), bytes32(uint256(3)))));
        vm.deal(address(solo), 1 ether);

        vm.prank(owner);
        uint256 id = solo.send(alice, PolicyLib.NATIVE, 0.5 ether);

        vm.prank(stranger);
        vm.expectRevert(ITrueSendPolicy.Unauthorized.selector);
        solo.cancelQueued(id);

        vm.prank(address(0));
        vm.expectRevert(ITrueSendPolicy.Unauthorized.selector);
        solo.cancelQueued(id);
    }

    /*//////////////////////////////////////////////////////////////
                               COOLDOWN
    //////////////////////////////////////////////////////////////*/

    /// @notice A cooldown of zero would make every transfer instant, which is the one value the
    ///         policy must never hold.
    function test_aCooldownOfZeroIsRefused() public {
        vm.prank(owner);
        vm.expectRevert(ITrueSendPolicy.InvalidCooldown.selector);
        vault.setCooldown(0);
    }

    function test_aCooldownBeyondTheCeilingIsRefused() public {
        vm.prank(owner);
        vm.expectRevert(ITrueSendPolicy.InvalidCooldown.selector);
        vault.setCooldown(uint32(PolicyLib.MAX_COOLDOWN) + 1);
    }

    /*//////////////////////////////////////////////////////////////
                               DEPOSITS
    //////////////////////////////////////////////////////////////*/

    function test_depositingNothingIsRefused() public {
        vm.prank(alice);
        vm.expectRevert(ITrueSendPolicy.InvalidAmount.selector);
        vault.depositERC20(address(usdc), 0);
    }

    /*//////////////////////////////////////////////////////////////
                             AUTHORISATION
    //////////////////////////////////////////////////////////////*/

    /// @notice The guardian subtracts permission and never adds it. Everything that changes the
    ///         policy in a direction the owner did not ask for has to be closed to it.
    function test_theGuardianCannotChangeThePolicy() public {
        vm.startPrank(guardian);

        vm.expectRevert(ITrueSendPolicy.Unauthorized.selector);
        vault.setCooldown(48 hours);

        vm.expectRevert(ITrueSendPolicy.Unauthorized.selector);
        vault.addTrusted(alice);

        vm.expectRevert(ITrueSendPolicy.Unauthorized.selector);
        vault.setDailyLimit(PolicyLib.NATIVE, 1 ether);

        vm.expectRevert(ITrueSendPolicy.Unauthorized.selector);
        vault.applyCooldownChange();

        vm.expectRevert(ITrueSendPolicy.Unauthorized.selector);
        vault.applyGuardianChange();
        vm.stopPrank();
    }

    function test_aStrangerCannotTouchAnything() public {
        vm.startPrank(stranger);
        for (uint256 i = 0; i < 1; i++) {
            vm.expectRevert(ITrueSendPolicy.Unauthorized.selector);
            vault.send(stranger, PolicyLib.NATIVE, 1 ether);

            vm.expectRevert(ITrueSendPolicy.Unauthorized.selector);
            vault.addTrusted(stranger);

            vm.expectRevert(ITrueSendPolicy.Unauthorized.selector);
            vault.removeTrusted(alice);

            vm.expectRevert(ITrueSendPolicy.Unauthorized.selector);
            vault.cancelCooldownChange();
        }
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                                 FUZZ
    //////////////////////////////////////////////////////////////*/

    /// @notice However a cooldown is set, the value in force is never zero and never above the
    ///         ceiling. A zero would settle everything instantly; there is no state that allows it.
    function testFuzz_theCooldownInForceIsAlwaysUsable(uint32 attempt, bool apply_) public {
        vm.startPrank(owner);
        try vault.setCooldown(attempt) {} catch {}
        if (apply_) {
            vm.warp(vm.getBlockTimestamp() + COOLDOWN);
            try vault.applyCooldownChange() {} catch {}
        }
        vm.stopPrank();

        uint32 inForce = vault.policy().cooldown;
        assertGt(inForce, 0);
        assertLe(inForce, PolicyLib.MAX_COOLDOWN);
    }

    /// @notice Nobody but the owner and the guardian ever gets past the authorisation check.
    function testFuzz_onlyTheOwnerAndGuardianAreEverAuthorised(address caller) public {
        vm.assume(caller != owner && caller != guardian);

        vm.prank(owner);
        uint256 id = vault.send(alice, PolicyLib.NATIVE, 1 ether);

        vm.prank(caller);
        vm.expectRevert(ITrueSendPolicy.Unauthorized.selector);
        vault.cancelQueued(id);

        assertEq(
            uint8(vault.getTransfer(id).status), uint8(ITrueSendPolicy.TransferStatus.Queued), "still queued"
        );
    }
}
