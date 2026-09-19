// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {GuardedAccount} from "../src/GuardedAccount.sol";
import {ITrueSendPolicy} from "../src/interfaces/ITrueSendPolicy.sol";
import {PolicyLib} from "../src/PolicyLib.sol";
import {MockERC20} from "./mocks/Mocks.sol";

/// @notice The EIP-7702 side: what changes when the policy is installed on an address that
///         already exists, and — just as importantly — what does not change.
contract GuardedAccount7702Test is Test {
    uint32 constant COOLDOWN = 24 hours;
    uint32 constant TRUST_DELAY = 12 hours;

    GuardedAccount implementation;
    MockERC20 usdc;

    uint256 alicePk = 0xA11CE;
    address alice;

    address guardian = makeAddr("guardian");
    address attacker = makeAddr("attacker");
    address poisoned = makeAddr("poisoned");

    function setUp() public {
        vm.warp(1_700_000_000);

        implementation = new GuardedAccount();
        alice = vm.addr(alicePk);
        vm.deal(alice, 100 ether);

        usdc = new MockERC20("USD Coin", "USDC", 6);
        usdc.mint(alice, 1_000_000e6);

        // What a wallet does: sign the authorization, then call the account itself so the policy
        // is switched on in the same breath.
        vm.signAndAttachDelegation(address(implementation), alicePk);
        vm.prank(alice);
        _account().initialize(COOLDOWN, TRUST_DELAY, guardian);
    }

    function _account() internal view returns (GuardedAccount) {
        return GuardedAccount(payable(alice));
    }

    /*//////////////////////////////////////////////////////////////
                             THE DELEGATION
    //////////////////////////////////////////////////////////////*/

    function test_delegationIndicatorIsInstalled() public view {
        assertEq(alice.code, abi.encodePacked(hex"ef0100", address(implementation)));
    }

    function test_accountReportsItselfAsOwner() public view {
        assertEq(_account().owner(), alice, "under 7702 the account is its own owner");
        assertTrue(_account().policy().initialized);
    }

    /// @notice A 7702 authorization is public the moment it lands. If anyone could call
    ///         `initialize` on the freshly delegated account they would set a one-second cooldown
    ///         and a guardian of their choosing, and the protection would be gone before the user
    ///         ever used it. Only a self-call may initialize.
    function test_initializeCannotBeFrontRun() public {
        uint256 bobPk = 0xB0B;
        address bob = vm.addr(bobPk);
        vm.deal(bob, 1 ether);

        vm.signAndAttachDelegation(address(implementation), bobPk);

        vm.prank(attacker);
        vm.expectRevert(ITrueSendPolicy.Unauthorized.selector);
        GuardedAccount(payable(bob)).initialize(1, 0, attacker);

        assertFalse(GuardedAccount(payable(bob)).policy().initialized);
    }

    function test_initializeIsSingleUse() public {
        vm.prank(alice);
        vm.expectRevert(ITrueSendPolicy.AlreadyInitialized.selector);
        _account().initialize(1 hours, 0, attacker);
    }

    /*//////////////////////////////////////////////////////////////
                        THE POLICY, ON AN EOA
    //////////////////////////////////////////////////////////////*/

    function test_sendThroughTheAccountIsHeld() public {
        vm.prank(alice);
        uint256 id = _account().send(poisoned, PolicyLib.NATIVE, 10 ether);

        assertGt(id, 0);
        assertEq(poisoned.balance, 0);

        vm.prank(alice);
        _account().cancelQueued(id);
        assertEq(uint8(_account().getTransfer(id).status), uint8(ITrueSendPolicy.TransferStatus.Cancelled));
    }

    function test_guardianCanVetoOnADelegatedAccount() public {
        vm.prank(alice);
        uint256 id = _account().send(poisoned, address(usdc), 50_000e6);

        vm.prank(guardian);
        _account().cancelQueued(id);

        vm.warp(vm.getBlockTimestamp() + COOLDOWN);
        vm.prank(alice);
        vm.expectRevert(ITrueSendPolicy.TransferNotQueued.selector);
        _account().executeQueued(id);

        assertEq(usdc.balanceOf(poisoned), 0);
    }

    function test_erc20MovesFromTheEoaItself() public {
        vm.prank(alice);
        uint256 id = _account().send(poisoned, address(usdc), 1000e6);

        vm.warp(vm.getBlockTimestamp() + COOLDOWN);
        vm.prank(alice);
        _account().executeQueued(id);

        assertEq(usdc.balanceOf(poisoned), 1000e6, "tokens leave the EOA, not a separate vault");
    }

    /*//////////////////////////////////////////////////////////////
                          EOA COMPATIBILITY
    //////////////////////////////////////////////////////////////*/

    /// @notice A delegate without a payable `receive` would silently break every inbound payment
    ///         to an address that has been working for years. That would be a worse bug than the
    ///         attack being defended against.
    function test_accountStillReceivesPlainEth() public {
        uint256 before = alice.balance;

        vm.deal(attacker, 1 ether);
        vm.prank(attacker);
        (bool ok,) = alice.call{value: 1 ether}("");

        assertTrue(ok);
        assertEq(alice.balance, before + 1 ether);
    }

    /// @notice Calling an EOA with unknown calldata succeeds and does nothing. The delegate keeps
    ///         that behaviour so integrations that probe an address do not start reverting.
    function test_accountStillAcceptsUnknownCalldata() public {
        vm.prank(attacker);
        (bool ok,) = alice.call(hex"deadbeef");
        assertTrue(ok);
    }

    function test_accountStillReceivesTokens() public {
        usdc.mint(attacker, 100e6);
        vm.prank(attacker);
        usdc.transfer(alice, 100e6);
        assertEq(usdc.balanceOf(alice), 1_000_000e6 + 100e6);
    }

    /*//////////////////////////////////////////////////////////////
                       ERC-7201 STORAGE DISCIPLINE
    //////////////////////////////////////////////////////////////*/

    /// @notice Everything this delegate writes lands in the user's own account. A future TrueSend
    ///         version, or any other delegate the user installs later, must be able to use slot 0
    ///         without corrupting this policy — so nothing may be written near the bottom of the
    ///         storage space.
    function test_writesStayInsideTheNamespace() public {
        vm.record();

        vm.startPrank(alice);
        _account().addTrusted(poisoned);
        _account().setCooldown(48 hours);
        _account().send(poisoned, PolicyLib.NATIVE, 1 ether);
        vm.stopPrank();

        (, bytes32[] memory writes) = vm.accesses(alice);
        assertGt(writes.length, 0, "the calls above do write state");

        for (uint256 i = 0; i < writes.length; i++) {
            assertGt(uint256(writes[i]), 1024, "wrote into the low slots a naive layout would use");
        }
    }

    function test_namespaceMatchesTheErc7201Derivation() public view {
        bytes32 expected = keccak256(abi.encode(uint256(keccak256("truesend.storage.GuardedAccount")) - 1))
            & ~bytes32(uint256(0xff));

        assertEq(_account().policyStorageSlot(), expected);
        assertEq(uint256(expected) & 0xff, 0, "ERC-7201 requires the low byte to be zeroed");
    }

    /*//////////////////////////////////////////////////////////////
                          THE KNOWN BOUNDARY
    //////////////////////////////////////////////////////////////*/

    /// @notice This test asserts a *limitation*, on purpose.
    ///
    ///         EIP-7702 changes what happens when someone calls the EOA. It does not take away
    ///         the key's ability to originate an ordinary transaction, so a key holder can still
    ///         sign a plain `token.transfer(...)` and never touch the policy. No delegate can
    ///         prevent that; it is a property of the EIP, not a gap in this implementation.
    ///
    ///         The claim this project makes is therefore scoped: every payment routed through the
    ///         account interface is subject to the cooldown. Users who want the policy to be
    ///         unbypassable by construction use `SafeVault`, where the funds sit behind it.
    ///         Pinning the boundary down in a test keeps the README honest as the code changes.
    function test_documentedLimitation_rawTransferBypassesThePolicy() public {
        vm.prank(alice);
        usdc.transfer(poisoned, 1000e6);

        assertEq(usdc.balanceOf(poisoned), 1000e6, "the raw transfer went through, as the EIP allows");
        assertEq(_account().policy().nextTransferId, 1, "and the policy never saw it");
    }

    /// @notice The same boundary for native ETH.
    function test_documentedLimitation_rawEthTransferBypassesThePolicy() public {
        vm.prank(alice);
        (bool ok,) = poisoned.call{value: 1 ether}("");

        assertTrue(ok);
        assertEq(poisoned.balance, 1 ether);
        assertEq(_account().policy().nextTransferId, 1);
    }
}
