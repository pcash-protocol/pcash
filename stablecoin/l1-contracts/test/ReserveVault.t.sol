// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ReserveVault} from "../src/ReserveVault.sol";
import {MockUSDC} from "../src/testing/MockUSDC.sol";

contract ReserveVaultTest is Test {
    // keccak256("Deposit(address,bytes32,bytes32,uint256)"), frozen: the deposit-mint rule's
    // DEPOSIT_TOPIC0 (circuits/rules/deposit_mint/src/main.nr) carries the same halves.
    bytes32 internal constant DEPOSIT_TOPIC = 0x6d06ca7726c7d8bc263bc28d3b225203f440dc69a5650bc9ce8bdf6a5687cce3;
    uint256 internal constant CAP = 100e6;
    uint256 internal constant MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    MockUSDC internal usdc;
    ReserveVault internal vault;
    address internal issuer = makeAddr("issuer");
    address internal depositor = makeAddr("depositor");
    address internal recipient = makeAddr("recipient");
    bytes32 internal recipientCommitment = _field("recipient commitment");
    bytes32 internal nonce = _field("nonce");

    function _field(string memory label) internal pure returns (bytes32) {
        return bytes32(uint256(keccak256(bytes(label))) % MODULUS);
    }

    function setUp() public {
        usdc = new MockUSDC();
        vault = new ReserveVault(IERC20(address(usdc)), issuer, CAP);
        vm.prank(issuer);
        vault.setAllowed(depositor, true);
        usdc.mint(depositor, 1_000e6);
        vm.prank(depositor);
        usdc.approve(address(vault), type(uint256).max);
    }

    function _deposit(uint256 amount) internal {
        vm.prank(depositor);
        vault.deposit(amount, recipientCommitment, nonce);
    }

    function test_MockUSDC() public view {
        assertEq(usdc.name(), "USD Coin");
        assertEq(usdc.symbol(), "USDC");
        assertEq(usdc.decimals(), 6);
    }

    function test_Constructor() public {
        ReserveVault fresh = new ReserveVault(IERC20(address(usdc)), issuer, CAP);
        assertEq(address(fresh.token()), address(usdc));
        assertEq(fresh.issuer(), issuer);
        assertEq(fresh.depositCap(), CAP);
        assertFalse(fresh.depositsPaused());
        assertFalse(fresh.allowed(depositor));
    }

    function test_Constructor_RevertsOnZeroIssuer() public {
        vm.expectRevert(ReserveVault.ZeroIssuer.selector);
        new ReserveVault(IERC20(address(usdc)), address(0), CAP);
    }

    function test_DepositTopicIsFrozen() public pure {
        assertEq(ReserveVault.Deposit.selector, DEPOSIT_TOPIC);
        assertEq(keccak256("Deposit(address,bytes32,bytes32,uint256)"), DEPOSIT_TOPIC);
    }

    // --- deposit ---

    function test_Deposit_PullsTokensAndEmits() public {
        vm.expectEmit(address(vault));
        emit ReserveVault.Deposit(depositor, recipientCommitment, nonce, 10e6);
        _deposit(10e6);

        assertEq(usdc.balanceOf(address(vault)), 10e6);
        assertEq(usdc.balanceOf(depositor), 990e6);
    }

    // Topics [topic0, depositor] and 96 data bytes, as the mint rule opens them.
    function test_Deposit_DataLayout() public {
        vm.recordLogs();
        _deposit(10e6);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory log;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(vault)) log = logs[i];
        }
        assertEq(log.topics.length, 2);
        assertEq(log.topics[0], DEPOSIT_TOPIC);
        assertEq(log.topics[1], bytes32(uint256(uint160(depositor))));
        assertEq(log.data, abi.encode(recipientCommitment, nonce, uint256(10e6)));
        assertEq(log.data.length, 96);
    }

    function test_Deposit_AcceptsTheCap() public {
        _deposit(CAP);
        assertEq(usdc.balanceOf(address(vault)), CAP);
    }

    function test_Deposit_RevertsAboveTheCap() public {
        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(ReserveVault.AmountAboveCap.selector, CAP + 1, CAP));
        vault.deposit(CAP + 1, recipientCommitment, nonce);
    }

    function test_Deposit_RevertsOnZeroAmount() public {
        vm.prank(depositor);
        vm.expectRevert(ReserveVault.ZeroAmount.selector);
        vault.deposit(0, recipientCommitment, nonce);
    }

    function test_Deposit_AcceptsTheMaximumAmount() public {
        uint256 max = vault.MAX_AMOUNT();
        assertEq(max, 2 ** 128 - 1);
        vm.prank(issuer);
        vault.setDepositCap(type(uint256).max);
        usdc.mint(depositor, max);
        _deposit(max);
        assertEq(usdc.balanceOf(address(vault)), max);
    }

    function test_Deposit_RevertsAboveTheMaximumAmount() public {
        vm.prank(issuer);
        vault.setDepositCap(type(uint256).max);
        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(ReserveVault.AmountAboveMaximum.selector, 2 ** 128));
        vault.deposit(2 ** 128, recipientCommitment, nonce);
    }

    function test_Deposit_RevertsForAnAddressNotAllowed() public {
        usdc.mint(recipient, 1e6);
        vm.prank(recipient);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(recipient);
        vm.expectRevert(abi.encodeWithSelector(ReserveVault.NotAllowed.selector, recipient));
        vault.deposit(1e6, recipientCommitment, nonce);
    }

    function test_Deposit_RevertsWhilePaused() public {
        vm.prank(issuer);
        vault.setDepositsPaused(true);
        vm.prank(depositor);
        vm.expectRevert(ReserveVault.DepositsPaused.selector);
        vault.deposit(1e6, recipientCommitment, nonce);

        vm.prank(issuer);
        vault.setDepositsPaused(false);
        _deposit(1e6);
        assertEq(usdc.balanceOf(address(vault)), 1e6);
    }

    function test_Deposit_RevertsWithoutAllowance() public {
        usdc.mint(recipient, 1e6);
        vm.prank(issuer);
        vault.setAllowed(recipient, true);
        vm.prank(recipient);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(vault), 0, 1e6)
        );
        vault.deposit(1e6, recipientCommitment, nonce);
    }

    function test_Deposit_RevertsOnUnmintableWords() public {
        vm.startPrank(depositor);
        vm.expectRevert(ReserveVault.ZeroRecipientCommitment.selector);
        vault.deposit(1e6, bytes32(0), nonce);
        vm.expectRevert(ReserveVault.RecipientCommitmentOutOfField.selector);
        vault.deposit(1e6, bytes32(MODULUS), nonce);
        vm.expectRevert(ReserveVault.NonceOutOfField.selector);
        vault.deposit(1e6, recipientCommitment, bytes32(MODULUS));
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function test_Deposit_AcceptsTheLargestFieldWords() public {
        bytes32 largest = bytes32(MODULUS - 1);
        vm.expectEmit(address(vault));
        emit ReserveVault.Deposit(depositor, largest, largest, 1e6);
        vm.prank(depositor);
        vault.deposit(1e6, largest, largest);
        vm.expectEmit(address(vault));
        emit ReserveVault.Deposit(depositor, recipientCommitment, bytes32(0), 1e6);
        vm.prank(depositor);
        vault.deposit(1e6, recipientCommitment, bytes32(0));
    }

    // --- credit ---

    function test_Credit_EmitsADepositFromTheIssuerWithoutTokens() public {
        vm.expectEmit(address(vault));
        emit ReserveVault.Deposit(issuer, recipientCommitment, nonce, 500e6);
        vm.prank(issuer);
        vault.credit(recipientCommitment, nonce, 500e6);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    // The deposit policy governs deposits only.
    function test_Credit_IgnoresTheDepositPolicy() public {
        vm.startPrank(issuer);
        vault.setDepositsPaused(true);
        vault.credit(recipientCommitment, nonce, CAP + 1);
        vm.stopPrank();
    }

    function test_Credit_RecordsThePair() public {
        bytes32 creditId = keccak256(abi.encode(recipientCommitment, nonce));
        assertFalse(vault.credited(creditId));
        vm.prank(issuer);
        vault.credit(recipientCommitment, nonce, 1e6);
        assertTrue(vault.credited(creditId));
        assertFalse(vault.credited(keccak256(abi.encode(recipientCommitment, _field("other nonce")))));
    }

    function test_Credit_RevertsForACreditedPair() public {
        vm.prank(issuer);
        vault.credit(recipientCommitment, nonce, 1e6);

        vm.recordLogs();
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(ReserveVault.AlreadyCredited.selector, recipientCommitment, nonce));
        vault.credit(recipientCommitment, nonce, 1e6);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_Credit_AcceptsTheCommitmentWithAnotherNonce() public {
        bytes32 otherNonce = _field("other nonce");
        vm.startPrank(issuer);
        vault.credit(recipientCommitment, nonce, 1e6);
        vm.expectEmit(address(vault));
        emit ReserveVault.Deposit(issuer, recipientCommitment, otherNonce, 2e6);
        vault.credit(recipientCommitment, otherNonce, 2e6);
        vm.stopPrank();
    }

    // Each deposit is a separate payment, so deposits are not deduplicated by commitment and nonce.
    function test_Deposit_RepeatsACreditedOrDepositedPair() public {
        vm.prank(issuer);
        vault.credit(recipientCommitment, nonce, 1e6);

        vm.expectEmit(address(vault));
        emit ReserveVault.Deposit(depositor, recipientCommitment, nonce, 2e6);
        _deposit(2e6);
        vm.expectEmit(address(vault));
        emit ReserveVault.Deposit(depositor, recipientCommitment, nonce, 3e6);
        _deposit(3e6);
        assertEq(usdc.balanceOf(address(vault)), 5e6);
    }

    function test_Credit_RevertsForNonIssuer() public {
        vm.prank(depositor);
        vm.expectRevert(ReserveVault.NotIssuer.selector);
        vault.credit(recipientCommitment, nonce, 1e6);
    }

    function test_Credit_RevertsOnZeroAmount() public {
        vm.prank(issuer);
        vm.expectRevert(ReserveVault.ZeroAmount.selector);
        vault.credit(recipientCommitment, nonce, 0);
    }

    function test_Credit_RevertsAboveTheMaximumAmount() public {
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(ReserveVault.AmountAboveMaximum.selector, 2 ** 128));
        vault.credit(recipientCommitment, nonce, 2 ** 128);
    }

    function test_Credit_RevertsOnUnmintableWordsWithoutRecordingThem() public {
        vm.startPrank(issuer);
        vm.expectRevert(ReserveVault.ZeroRecipientCommitment.selector);
        vault.credit(bytes32(0), nonce, 1e6);
        vm.expectRevert(ReserveVault.RecipientCommitmentOutOfField.selector);
        vault.credit(bytes32(MODULUS), nonce, 1e6);
        vm.expectRevert(ReserveVault.NonceOutOfField.selector);
        vault.credit(recipientCommitment, bytes32(type(uint256).max), 1e6);
        vm.stopPrank();
        assertFalse(vault.credited(keccak256(abi.encode(bytes32(0), nonce))));
        assertFalse(vault.credited(keccak256(abi.encode(recipientCommitment, bytes32(type(uint256).max)))));
    }

    // --- deposit policy ---

    function test_SetAllowed() public {
        vm.expectEmit(address(vault));
        emit ReserveVault.AllowedChanged(depositor, false);
        vm.prank(issuer);
        vault.setAllowed(depositor, false);
        assertFalse(vault.allowed(depositor));

        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(ReserveVault.NotAllowed.selector, depositor));
        vault.deposit(1e6, recipientCommitment, nonce);
    }

    function test_SetDepositCap() public {
        vm.expectEmit(address(vault));
        emit ReserveVault.DepositCapChanged(5e6);
        vm.prank(issuer);
        vault.setDepositCap(5e6);
        assertEq(vault.depositCap(), 5e6);
    }

    function test_SetDepositsPaused() public {
        vm.expectEmit(address(vault));
        emit ReserveVault.DepositsPausedChanged(true);
        vm.prank(issuer);
        vault.setDepositsPaused(true);
        assertTrue(vault.depositsPaused());
    }

    function test_PolicySetters_RevertForNonIssuer() public {
        vm.startPrank(depositor);
        vm.expectRevert(ReserveVault.NotIssuer.selector);
        vault.setAllowed(recipient, true);
        vm.expectRevert(ReserveVault.NotIssuer.selector);
        vault.setDepositCap(1);
        vm.expectRevert(ReserveVault.NotIssuer.selector);
        vault.setDepositsPaused(true);
        vm.stopPrank();
    }

    // --- payout ---

    function test_Payout_PaysOnce() public {
        _deposit(10e6);
        bytes32 redemptionId = keccak256("redemption-1");
        vm.expectEmit(address(vault));
        emit ReserveVault.Payout(redemptionId, recipient, 4e6);
        vm.prank(issuer);
        vault.payout(recipient, 4e6, redemptionId);
        assertTrue(vault.paidOut(redemptionId));
        assertEq(usdc.balanceOf(recipient), 4e6);
        assertEq(usdc.balanceOf(address(vault)), 6e6);

        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(ReserveVault.AlreadyPaidOut.selector, redemptionId));
        vault.payout(recipient, 4e6, redemptionId);
        assertEq(usdc.balanceOf(recipient), 4e6);
    }

    function test_Payout_RevertsForNonIssuer() public {
        _deposit(10e6);
        vm.prank(depositor);
        vm.expectRevert(ReserveVault.NotIssuer.selector);
        vault.payout(depositor, 1e6, bytes32(uint256(1)));
    }

    function test_Payout_RevertsBeyondBalanceWithoutConsumingId() public {
        _deposit(1e6);
        bytes32 redemptionId = bytes32(uint256(1));
        vm.prank(issuer);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, address(vault), 1e6, 2e6)
        );
        vault.payout(recipient, 2e6, redemptionId);
        assertFalse(vault.paidOut(redemptionId));
    }

    // --- setIssuer ---

    function test_SetIssuer_TransfersControl() public {
        _deposit(10e6);
        address next = makeAddr("next");
        vm.expectEmit(address(vault));
        emit ReserveVault.IssuerChanged(next);
        vm.prank(issuer);
        vault.setIssuer(next);
        assertEq(vault.issuer(), next);

        vm.prank(issuer);
        vm.expectRevert(ReserveVault.NotIssuer.selector);
        vault.payout(recipient, 1e6, bytes32(uint256(1)));
        vm.prank(next);
        vault.payout(recipient, 1e6, bytes32(uint256(1)));
        assertEq(usdc.balanceOf(recipient), 1e6);

        vm.expectEmit(address(vault));
        emit ReserveVault.Deposit(next, recipientCommitment, nonce, 1e6);
        vm.prank(next);
        vault.credit(recipientCommitment, nonce, 1e6);
    }

    function test_SetIssuer_RevertsForNonIssuer() public {
        vm.prank(depositor);
        vm.expectRevert(ReserveVault.NotIssuer.selector);
        vault.setIssuer(depositor);
    }

    function test_SetIssuer_RevertsOnZero() public {
        vm.prank(issuer);
        vm.expectRevert(ReserveVault.ZeroIssuer.selector);
        vault.setIssuer(address(0));
    }
}
