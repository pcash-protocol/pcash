// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";

contract RejectingRecipient {
    receive() external payable {
        revert("no");
    }
}

/// Seller whose receive hook tries to buy the same offer again with its own
/// claim key, then accepts the original payment.
contract ReentrantSeller {
    PaymentRouter public immutable router;
    bytes public reentryError;
    bytes32 internal offerId;
    uint256 internal anchorBlockNumber;
    bytes32 internal anchorBlockHash;
    uint64 internal notAfter;
    uint256 internal amount;

    constructor(PaymentRouter router_) payable {
        router = router_;
    }

    function arm(
        bytes32 offerId_,
        uint256 anchorBlockNumber_,
        bytes32 anchorBlockHash_,
        uint64 notAfter_,
        uint256 amount_
    ) external {
        offerId = offerId_;
        anchorBlockNumber = anchorBlockNumber_;
        anchorBlockHash = anchorBlockHash_;
        notAfter = notAfter_;
        amount = amount_;
    }

    receive() external payable {
        if (amount == 0) return;
        uint256 value = amount;
        amount = 0;
        try router.buy{value: value}(
            offerId,
            payable(address(this)),
            bytes32(uint256(0xBAD)),
            anchorBlockNumber,
            anchorBlockHash,
            notAfter,
            hex"",
            hex""
        ) {} catch (bytes memory reason) {
            reentryError = reason;
        }
    }
}

contract ForwardingBuyer {
    function buy(
        PaymentRouter router,
        bytes32 offerId,
        address payable seller,
        bytes32 commitment,
        uint256 anchorBlockNumber,
        bytes32 anchorBlockHash,
        uint64 notAfter,
        bytes calldata recoveryData
    ) external payable {
        router.buy{value: msg.value}(
            offerId, seller, commitment, anchorBlockNumber, anchorBlockHash, notAfter, recoveryData, hex""
        );
    }
}

contract PaymentRouterTest is Test {
    uint256 internal constant ANCHOR_BLOCK = 100;
    bytes32 internal constant ANCHOR_HASH = bytes32(uint256(0xA11CE));
    address payable internal constant FEE_RECIPIENT = payable(address(0xFEE));
    uint16 internal constant FEE_BPS = 500;
    address internal constant GUARDIAN = address(0x6A4D);
    bytes32 internal constant COMMITMENT = bytes32(uint256(0xC0FFEE));
    bytes32 internal constant PCASH_BATCH_TOPIC = keccak256("PcashBatch(bytes,bytes)");

    PaymentRouter internal router;

    event Payment(
        bytes32 indexed offerId,
        address indexed seller,
        address indexed payer,
        uint256 amount,
        bytes32 claimKeyCommitment,
        bytes recoveryData
    );

    event PcashBatch(bytes context, bytes batch);

    function setUp() public {
        vm.roll(ANCHOR_BLOCK + 1);
        vm.setBlockhash(ANCHOR_BLOCK, ANCHOR_HASH);
        router = new PaymentRouter(FEE_RECIPIENT, FEE_BPS, GUARDIAN);
    }

    function test_deploymentBlockRemainsTheConstructorBlock() public {
        assertEq(router.deploymentBlock(), ANCHOR_BLOCK + 1);
        vm.roll(ANCHOR_BLOCK + 100);
        assertEq(router.deploymentBlock(), ANCHOR_BLOCK + 1);
    }

    function notAfter() internal view returns (uint64) {
        return uint64(block.timestamp + 1 hours);
    }

    function websiteFee(uint256 gross) internal pure returns (uint256) {
        return (gross * FEE_BPS) / 10_000;
    }

    function sellerNet(uint256 gross) internal pure returns (uint256) {
        return gross - websiteFee(gross);
    }

    function context(bytes32 offerId, address seller, uint256 amount, bytes32 commitment)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(offerId, seller, amount, commitment);
    }

    function buyAs(address payer, uint256 amount, bytes32 offerId, address payable seller) internal {
        vm.deal(payer, payer.balance + amount);
        vm.prank(payer, payer);
        router.buy{value: amount}(
            offerId, seller, COMMITMENT, ANCHOR_BLOCK, ANCHOR_HASH, notAfter(), hex"", hex""
        );
    }

    function retryAs(address caller, bytes32 offerId, address seller, uint256 amount, bytes memory batch) internal {
        vm.prank(caller, caller);
        router.retry(offerId, seller, amount, batch);
    }

    function routerLogs(Vm.Log[] memory logs) internal view returns (Vm.Log[] memory kept) {
        uint256 count;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(router)) count++;
        }
        kept = new Vm.Log[](count);
        count = 0;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(router)) kept[count++] = logs[i];
        }
    }

    function test_constructorBindsConfiguration() public view {
        assertEq(router.feeRecipient(), FEE_RECIPIENT);
        assertEq(router.feeBps(), FEE_BPS);
        assertEq(router.guardian(), GUARDIAN);
        assertEq(router.FEE_BPS_DENOMINATOR(), 10_000);
        assertFalse(router.paused());
    }

    function test_constructorRejectsZeroFeeRecipient() public {
        vm.expectRevert(PaymentRouter.ZeroFeeRecipient.selector);
        new PaymentRouter(payable(address(0)), FEE_BPS, GUARDIAN);
    }

    function test_constructorRejectsZeroFeeBps() public {
        vm.expectRevert(PaymentRouter.InvalidFeeBps.selector);
        new PaymentRouter(FEE_RECIPIENT, 0, GUARDIAN);
    }

    function test_constructorRejectsOneHundredPercentFee() public {
        vm.expectRevert(PaymentRouter.InvalidFeeBps.selector);
        new PaymentRouter(FEE_RECIPIENT, 10_000, GUARDIAN);
    }

    function test_constructorRejectsZeroGuardian() public {
        vm.expectRevert(PaymentRouter.ZeroGuardian.selector);
        new PaymentRouter(FEE_RECIPIENT, FEE_BPS, address(0));
    }

    function test_buy_paysSellerAndFeeRecipientAndRecordsCommitment() public {
        address payable seller = payable(makeAddr("seller"));
        bytes32 offerId = bytes32(uint256(0x0FFE1));
        uint256 amount = 1.5 ether;
        bytes32 key = router.paymentKey(offerId, seller, amount);
        assertEq(router.paid(key), bytes32(0), "unpaid before");

        buyAs(makeAddr("payer"), amount, offerId, seller);

        assertEq(router.paid(key), COMMITMENT, "claim-key commitment recorded");
        assertEq(seller.balance, sellerNet(amount), "seller net paid");
        assertEq(FEE_RECIPIENT.balance, websiteFee(amount), "website fee paid");
        assertEq(address(router).balance, 0, "router holds nothing");
    }

    function test_buy_emitsPaymentWithExactArgs() public {
        address payer = makeAddr("payer");
        address payable seller = payable(makeAddr("seller"));
        bytes32 offerId = bytes32(uint256(0x0FFE1));
        uint256 amount = 2 ether;
        bytes memory recoveryData = hex"0102030405";

        vm.deal(payer, 10 ether);
        vm.expectEmit(true, true, true, true, address(router));
        emit Payment(offerId, seller, payer, amount, COMMITMENT, recoveryData);

        vm.prank(payer, payer);
        router.buy{value: amount}(
            offerId, seller, COMMITMENT, ANCHOR_BLOCK, ANCHOR_HASH, notAfter(), recoveryData, hex""
        );
    }

    function test_buy_emitsPaymentThenPcashBatchWithExactContext() public {
        address payer = makeAddr("payer");
        address payable seller = payable(makeAddr("seller"));
        bytes32 offerId = bytes32(uint256(0x0FFE1));
        uint256 amount = 2 ether;
        bytes memory recoveryData = hex"0102030405";
        bytes memory batch = hex"aabbccddeeff00112233445566778899";
        bytes memory expectedContext = context(offerId, seller, amount, COMMITMENT);
        assertEq(expectedContext.length, 128, "context is four words");

        vm.deal(payer, amount);
        vm.expectEmit(true, true, true, true, address(router));
        emit Payment(offerId, seller, payer, amount, COMMITMENT, recoveryData);
        vm.expectEmit(false, false, false, true, address(router));
        emit PcashBatch(expectedContext, batch);
        vm.recordLogs();

        vm.prank(payer, payer);
        router.buy{value: amount}(
            offerId, seller, COMMITMENT, ANCHOR_BLOCK, ANCHOR_HASH, notAfter(), recoveryData, batch
        );

        Vm.Log[] memory logs = routerLogs(vm.getRecordedLogs());
        assertEq(logs.length, 2, "Payment and PcashBatch only");
        assertEq(logs[0].topics[0], Payment.selector, "Payment first");
        assertEq(logs[1].topics.length, 1, "PcashBatch has no indexed fields");
        assertEq(logs[1].topics[0], PCASH_BATCH_TOPIC);
        assertEq(logs[1].data, abi.encode(expectedContext, batch), "canonical (bytes, bytes) encoding");
    }

    function test_buy_carriesEmptyBatchAndRecordsPayment() public {
        address payable seller = payable(makeAddr("seller"));
        bytes32 offerId = bytes32(uint256(0x0FFE1));
        vm.expectEmit(false, false, false, true, address(router));
        emit PcashBatch(context(offerId, seller, 1 ether, COMMITMENT), hex"");

        buyAs(makeAddr("payer"), 1 ether, offerId, seller);

        assertEq(router.paid(router.paymentKey(offerId, seller, 1 ether)), COMMITMENT);
    }

    function test_buy_contextCarriesGrossValueNotNet() public {
        address payable seller = payable(makeAddr("seller"));
        bytes32 offerId = bytes32(uint256(3));
        uint256 amount = 777 gwei;
        vm.recordLogs();

        buyAs(makeAddr("payer"), amount, offerId, seller);

        Vm.Log[] memory logs = routerLogs(vm.getRecordedLogs());
        (bytes memory ctx,) = abi.decode(logs[1].data, (bytes, bytes));
        (bytes32 o, address s, uint256 a, bytes32 c) = abi.decode(ctx, (bytes32, address, uint256, bytes32));
        assertEq(o, offerId);
        assertEq(s, seller);
        assertEq(a, amount);
        assertEq(c, COMMITMENT);
    }

    function test_buy_zeroClaimKeyCommitmentReverts() public {
        address payer = makeAddr("payer");
        vm.deal(payer, 1);
        vm.expectRevert(PaymentRouter.ZeroClaimKeyCommitment.selector);
        vm.prank(payer, payer);
        router.buy{value: 1}(
            bytes32(uint256(1)),
            payable(makeAddr("seller")),
            bytes32(0),
            ANCHOR_BLOCK,
            ANCHOR_HASH,
            notAfter(),
            hex"",
            hex""
        );
    }

    function test_websiteFeeRoundsDown() public view {
        assertEq(router.websiteFee(19), 0);
        assertEq(router.websiteFee(20), 1);
        assertEq(router.websiteFee(1 ether + 19), 0.05 ether);
    }

    function test_buy_zeroFeePaysSellerGross() public {
        address payable seller = payable(makeAddr("seller"));
        buyAs(makeAddr("payer"), 19, bytes32(uint256(1)), seller);

        assertEq(seller.balance, 19);
        assertEq(FEE_RECIPIENT.balance, 0);
    }

    function test_buy_sellerIsFeeRecipientReceivesGross() public {
        uint256 amount = 1 ether;
        buyAs(makeAddr("payer"), amount, bytes32(uint256(0xFEE)), FEE_RECIPIENT);

        assertEq(FEE_RECIPIENT.balance, amount);
        assertEq(address(router).balance, 0);
    }

    function test_buy_rejectingSellerRevertsWholePayment() public {
        address payable seller = payable(address(new RejectingRecipient()));
        address payer = makeAddr("payer");
        bytes32 offerId = bytes32(uint256(1));
        vm.deal(payer, 1 ether);

        vm.expectRevert(bytes("no"));
        vm.prank(payer, payer);
        router.buy{value: 1 ether}(
            offerId, seller, COMMITMENT, ANCHOR_BLOCK, ANCHOR_HASH, notAfter(), hex"", hex""
        );

        assertEq(router.paid(router.paymentKey(offerId, seller, 1 ether)), bytes32(0));
        assertEq(payer.balance, 1 ether);
        assertEq(FEE_RECIPIENT.balance, 0);
    }

    function test_buy_rejectingFeeRecipientRevertsWholePayment() public {
        PaymentRouter rejectingFee =
            new PaymentRouter(payable(address(new RejectingRecipient())), FEE_BPS, GUARDIAN);
        address payer = makeAddr("payer");
        address payable seller = payable(makeAddr("seller"));
        bytes32 offerId = bytes32(uint256(1));
        vm.deal(payer, 1 ether);

        vm.expectRevert(bytes("no"));
        vm.prank(payer, payer);
        rejectingFee.buy{value: 1 ether}(
            offerId, seller, COMMITMENT, ANCHOR_BLOCK, ANCHOR_HASH, notAfter(), hex"", hex""
        );

        assertEq(rejectingFee.paid(rejectingFee.paymentKey(offerId, seller, 1 ether)), bytes32(0));
        assertEq(payer.balance, 1 ether);
        assertEq(seller.balance, 0, "seller transfer rolled back");
    }

    function test_buy_sellerCannotBuySameOfferFromReceiveHook() public {
        uint256 amount = 1 ether;
        bytes32 offerId = bytes32(uint256(0x0FFE1));
        ReentrantSeller seller = new ReentrantSeller{value: amount}(router);
        seller.arm(offerId, ANCHOR_BLOCK, ANCHOR_HASH, notAfter(), amount);

        vm.recordLogs();
        buyAs(makeAddr("payer"), amount, offerId, payable(address(seller)));

        assertEq(
            seller.reentryError(), abi.encodeWithSelector(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector)
        );
        Vm.Log[] memory logs = routerLogs(vm.getRecordedLogs());
        uint256 payments;
        uint256 batches;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == Payment.selector) payments++;
            if (logs[i].topics[0] == PCASH_BATCH_TOPIC) batches++;
        }
        assertEq(payments, 1, "only the buyer's payment is recorded");
        assertEq(batches, 1, "only the buyer's batch is carried");
        assertEq(address(seller).balance, amount + sellerNet(amount));
    }

    function test_buy_replayedAfterAnchorReorgRevertsWithoutPaying() public {
        address payer = makeAddr("payer");
        address payable seller = payable(makeAddr("seller"));
        bytes32 offerId = bytes32(uint256(0x0FFE1));
        uint256 amount = 1 ether;
        vm.deal(payer, amount);
        uint256 beforePayment = vm.snapshotState();

        vm.prank(payer, payer);
        router.buy{value: amount}(
            offerId, seller, COMMITMENT, ANCHOR_BLOCK, ANCHOR_HASH, notAfter(), hex"", hex""
        );
        assertEq(seller.balance, sellerNet(amount));

        assertTrue(vm.revertToState(beforePayment));
        vm.setBlockhash(ANCHOR_BLOCK, bytes32(uint256(0xBEEF)));
        vm.expectRevert(PaymentRouter.InvalidAnchor.selector);
        vm.prank(payer, payer);
        router.buy{value: amount}(
            offerId, seller, COMMITMENT, ANCHOR_BLOCK, ANCHOR_HASH, notAfter(), hex"", hex""
        );

        assertEq(router.paid(router.paymentKey(offerId, seller, amount)), bytes32(0));
        assertEq(seller.balance, 0);
        assertEq(FEE_RECIPIENT.balance, 0);
    }

    function test_buy_acceptsAnchorAtWindowBoundaryAndRejectsOlderAnchor() public {
        address payer = makeAddr("payer");
        address payable seller = payable(makeAddr("seller"));
        vm.deal(payer, 2);

        vm.roll(ANCHOR_BLOCK + 256);
        vm.prank(payer, payer);
        router.buy{value: 1}(
            bytes32(uint256(1)),
            seller,
            COMMITMENT,
            ANCHOR_BLOCK,
            ANCHOR_HASH,
            notAfter(),
            hex"",
            hex""
        );

        vm.roll(block.number + 1);
        vm.expectRevert(PaymentRouter.InvalidAnchor.selector);
        vm.prank(payer, payer);
        router.buy{value: 1}(
            bytes32(uint256(2)),
            seller,
            COMMITMENT,
            ANCHOR_BLOCK,
            ANCHOR_HASH,
            notAfter(),
            hex"",
            hex""
        );
    }

    function test_buy_zeroAnchorHashReverts() public {
        address payer = makeAddr("payer");
        vm.deal(payer, 1);
        vm.expectRevert(PaymentRouter.InvalidAnchor.selector);
        vm.prank(payer, payer);
        router.buy{value: 1}(
            bytes32(uint256(1)),
            payable(makeAddr("seller")),
            COMMITMENT,
            ANCHOR_BLOCK,
            bytes32(0),
            notAfter(),
            hex"",
            hex""
        );
    }

    function test_buy_anchorAtCurrentBlockReverts() public {
        address payer = makeAddr("payer");
        vm.deal(payer, 1);
        vm.expectRevert(PaymentRouter.InvalidAnchor.selector);
        vm.prank(payer, payer);
        router.buy{value: 1}(
            bytes32(uint256(1)),
            payable(makeAddr("seller")),
            COMMITMENT,
            block.number,
            ANCHOR_HASH,
            notAfter(),
            hex"",
            hex""
        );
    }

    function test_buy_notAfterInThePastRevertsWithoutPaying() public {
        vm.warp(10_000);
        address payer = makeAddr("payer");
        address payable seller = payable(makeAddr("seller"));
        bytes32 offerId = bytes32(uint256(1));
        vm.deal(payer, 1 ether);

        vm.expectRevert(PaymentRouter.NotAfterPassed.selector);
        vm.prank(payer, payer);
        router.buy{value: 1 ether}(
            offerId, seller, COMMITMENT, ANCHOR_BLOCK, ANCHOR_HASH, uint64(block.timestamp - 1), hex"", hex""
        );

        assertEq(router.paid(router.paymentKey(offerId, seller, 1 ether)), bytes32(0));
        assertEq(seller.balance, 0);
        assertEq(payer.balance, 1 ether);
    }

    function test_buy_notAfterEqualToBlockTimestampSucceeds() public {
        vm.warp(10_000);
        address payer = makeAddr("payer");
        vm.deal(payer, 1);
        vm.prank(payer, payer);
        router.buy{value: 1}(
            bytes32(uint256(1)),
            payable(makeAddr("seller")),
            COMMITMENT,
            ANCHOR_BLOCK,
            ANCHOR_HASH,
            uint64(block.timestamp),
            hex"",
            hex""
        );
        assertEq(router.paid(router.paymentKey(bytes32(uint256(1)), makeAddr("seller"), 1)), COMMITMENT);
    }

    function test_buy_secondExactOfferPaymentReverts() public {
        address payable seller = payable(makeAddr("seller"));
        bytes32 offerId = bytes32(uint256(7));
        uint256 amount = 1 ether;
        bytes32 key = router.paymentKey(offerId, seller, amount);
        address payer = makeAddr("payer");
        vm.deal(payer, 2 ether);

        vm.prank(payer, payer);
        router.buy{value: amount}(
            offerId, seller, COMMITMENT, ANCHOR_BLOCK, ANCHOR_HASH, notAfter(), hex"", hex""
        );

        uint256 nextAnchorBlock = ANCHOR_BLOCK + 1;
        bytes32 nextAnchorHash = bytes32(uint256(0xA11CE2));
        vm.roll(nextAnchorBlock + 1);
        vm.setBlockhash(nextAnchorBlock, nextAnchorHash);

        vm.expectRevert(abi.encodeWithSelector(PaymentRouter.AlreadyPaid.selector, key));
        vm.prank(payer, payer);
        router.buy{value: amount}(
            offerId,
            seller,
            bytes32(uint256(2)),
            nextAnchorBlock,
            nextAnchorHash,
            notAfter(),
            hex"",
            hex""
        );
        assertEq(router.paid(key), COMMITMENT, "first commitment kept");
        assertEq(seller.balance, sellerNet(amount), "duplicate did not pay seller");
        assertEq(FEE_RECIPIENT.balance, websiteFee(amount), "duplicate did not pay fee");
    }

    function test_buy_wrongAmountDoesNotConsumeAdvertisedOfferTuple() public {
        address payable seller = payable(makeAddr("seller"));
        bytes32 offerId = bytes32(uint256(7));
        address payer = makeAddr("payer");
        vm.deal(payer, 3 ether);

        vm.prank(payer, payer);
        router.buy{value: 1 wei}(
            offerId, seller, COMMITMENT, ANCHOR_BLOCK, ANCHOR_HASH, notAfter(), hex"", hex""
        );
        vm.prank(payer, payer);
        router.buy{value: 2 ether}(
            offerId, seller, bytes32(uint256(2)), ANCHOR_BLOCK, ANCHOR_HASH, notAfter(), hex"", hex""
        );

        assertEq(router.paid(router.paymentKey(offerId, seller, 1 wei)), COMMITMENT);
        assertEq(router.paid(router.paymentKey(offerId, seller, 2 ether)), bytes32(uint256(2)));
        assertEq(seller.balance, sellerNet(2 ether) + sellerNet(1 wei));
        assertEq(FEE_RECIPIENT.balance, websiteFee(2 ether) + websiteFee(1 wei));
    }

    function test_buy_zeroValueReverts() public {
        address payer = makeAddr("payer");
        vm.expectRevert(PaymentRouter.ZeroValue.selector);
        vm.prank(payer, payer);
        router.buy{value: 0}(
            bytes32(uint256(1)),
            payable(makeAddr("seller")),
            COMMITMENT,
            ANCHOR_BLOCK,
            ANCHOR_HASH,
            notAfter(),
            hex"",
            hex""
        );
    }

    function test_buy_zeroSellerReverts() public {
        address payer = makeAddr("payer");
        vm.deal(payer, 1);
        vm.expectRevert(PaymentRouter.ZeroSeller.selector);
        vm.prank(payer, payer);
        router.buy{value: 1}(
            bytes32(uint256(1)),
            payable(address(0)),
            COMMITMENT,
            ANCHOR_BLOCK,
            ANCHOR_HASH,
            notAfter(),
            hex"",
            hex""
        );
    }

    function test_buy_nonCanonicalOfferIdReverts() public {
        bytes32 offerId = bytes32(router.BN254_SCALAR_MODULUS());
        address payer = makeAddr("payer");
        vm.deal(payer, 1);
        vm.expectRevert(PaymentRouter.InvalidOfferId.selector);
        vm.prank(payer, payer);
        router.buy{value: 1}(
            offerId,
            payable(makeAddr("seller")),
            COMMITMENT,
            ANCHOR_BLOCK,
            ANCHOR_HASH,
            notAfter(),
            hex"",
            hex""
        );
    }

    function test_buy_contractForwarderRecordsAndPays() public {
        ForwardingBuyer forwarder = new ForwardingBuyer();
        address payer = makeAddr("payer");
        address payable seller = payable(makeAddr("seller"));
        bytes32 offerId = bytes32(uint256(1));
        uint256 amount = 1 ether;
        bytes memory recoveryData = hex"0102030405";
        vm.deal(payer, amount);

        // The forwarder is the payer, and its inner call's recovery data reaches the event.
        vm.expectEmit(true, true, true, true, address(router));
        emit Payment(offerId, seller, address(forwarder), amount, COMMITMENT, recoveryData);
        vm.prank(payer, payer);
        forwarder.buy{value: amount}(
            router, offerId, seller, COMMITMENT, ANCHOR_BLOCK, ANCHOR_HASH, notAfter(), recoveryData
        );

        assertEq(router.paid(router.paymentKey(offerId, seller, amount)), COMMITMENT);
        assertEq(seller.balance, sellerNet(amount));
        assertEq(FEE_RECIPIENT.balance, websiteFee(amount));
    }

    function test_buyDelegatedCodeEoaSucceeds() public {
        address payer = makeAddr("delegated-payer");
        vm.etch(payer, hex"00");
        vm.deal(payer, 1);

        vm.prank(payer, payer);
        router.buy{value: 1}(
            bytes32(uint256(1)),
            payable(makeAddr("seller")),
            COMMITMENT,
            ANCHOR_BLOCK,
            ANCHOR_HASH,
            notAfter(),
            hex"",
            hex""
        );
        assertEq(router.paid(router.paymentKey(bytes32(uint256(1)), makeAddr("seller"), 1)), COMMITMENT);
    }

    function test_twoBuysInOneTransactionBothCarryTheirBatch() public {
        address payer = makeAddr("payer");
        address payable seller = payable(makeAddr("seller"));
        vm.deal(payer, 2 ether);
        vm.recordLogs();

        vm.startPrank(payer, payer);
        router.buy{value: 1 ether}(
            bytes32(uint256(1)), seller, COMMITMENT, ANCHOR_BLOCK, ANCHOR_HASH, notAfter(), hex"", hex"01"
        );
        router.buy{value: 1 ether}(
            bytes32(uint256(2)), seller, bytes32(uint256(2)), ANCHOR_BLOCK, ANCHOR_HASH, notAfter(), hex"", hex"02"
        );
        vm.stopPrank();

        Vm.Log[] memory logs = routerLogs(vm.getRecordedLogs());
        assertEq(logs.length, 4);
        assertEq(logs[1].data, abi.encode(context(bytes32(uint256(1)), seller, 1 ether, COMMITMENT), hex"01"));
        assertEq(logs[3].data, abi.encode(context(bytes32(uint256(2)), seller, 1 ether, bytes32(uint256(2))), hex"02"));
    }

    // retry

    function test_retry_emitsRecordedClaimKeyCommitmentAndNewBatch() public {
        address payable seller = payable(makeAddr("seller"));
        bytes32 offerId = bytes32(uint256(0x0FFE1));
        uint256 amount = 1.5 ether;
        buyAs(makeAddr("payer"), amount, offerId, seller);
        bytes memory batch = hex"c0ffee00112233";
        bytes memory expectedContext = context(offerId, seller, amount, COMMITMENT);

        vm.expectEmit(false, false, false, true, address(router));
        emit PcashBatch(expectedContext, batch);
        vm.recordLogs();
        retryAs(makeAddr("anyone"), offerId, seller, amount, batch);

        Vm.Log[] memory logs = routerLogs(vm.getRecordedLogs());
        assertEq(logs.length, 1, "only PcashBatch");
        assertEq(logs[0].topics.length, 1);
        assertEq(logs[0].topics[0], PCASH_BATCH_TOPIC);
        assertEq(logs[0].data, abi.encode(expectedContext, batch), "canonical (bytes, bytes) encoding");
    }

    function test_retry_canRepeatWithEachBatch() public {
        address payable seller = payable(makeAddr("seller"));
        bytes32 offerId = bytes32(uint256(1));
        buyAs(makeAddr("payer"), 1 ether, offerId, seller);
        vm.recordLogs();

        retryAs(makeAddr("first"), offerId, seller, 1 ether, hex"01");
        retryAs(makeAddr("second"), offerId, seller, 1 ether, hex"02");

        Vm.Log[] memory logs = routerLogs(vm.getRecordedLogs());
        assertEq(logs.length, 2);
        assertEq(logs[0].data, abi.encode(context(offerId, seller, 1 ether, COMMITMENT), hex"01"));
        assertEq(logs[1].data, abi.encode(context(offerId, seller, 1 ether, COMMITMENT), hex"02"));
    }

    function test_retry_movesNoValueAndLeavesRecordUnchanged() public {
        address payable seller = payable(makeAddr("seller"));
        bytes32 offerId = bytes32(uint256(1));
        uint256 amount = 1 ether;
        buyAs(makeAddr("payer"), amount, offerId, seller);

        retryAs(makeAddr("anyone"), offerId, seller, amount, hex"01");

        assertEq(seller.balance, sellerNet(amount));
        assertEq(FEE_RECIPIENT.balance, websiteFee(amount));
        assertEq(address(router).balance, 0);
        assertEq(router.paid(router.paymentKey(offerId, seller, amount)), COMMITMENT);
    }

    function test_retry_rejectsValue() public {
        address payable seller = payable(makeAddr("seller"));
        bytes32 offerId = bytes32(uint256(1));
        buyAs(makeAddr("payer"), 1 ether, offerId, seller);
        address caller = makeAddr("anyone");
        vm.deal(caller, 1);

        vm.prank(caller, caller);
        (bool ok,) = address(router).call{value: 1}(
            abi.encodeCall(
                PaymentRouter.retry,
                (offerId, seller, 1 ether, hex"")
            )
        );
        assertFalse(ok);
        assertEq(address(router).balance, 0);
    }

    function test_retry_withoutRecordedPaymentReverts() public {
        address payable seller = payable(makeAddr("seller"));
        bytes32 offerId = bytes32(uint256(1));
        bytes32 key = router.paymentKey(offerId, seller, 1 ether);

        vm.expectRevert(abi.encodeWithSelector(PaymentRouter.NotPaid.selector, key));
        retryAs(makeAddr("anyone"), offerId, seller, 1 ether, hex"01");
    }

    function test_retry_requiresTheExactPaidTuple() public {
        address payable seller = payable(makeAddr("seller"));
        bytes32 offerId = bytes32(uint256(1));
        buyAs(makeAddr("payer"), 1 ether, offerId, seller);
        address anyone = makeAddr("anyone");

        vm.expectRevert(abi.encodeWithSelector(PaymentRouter.NotPaid.selector, router.paymentKey(offerId, seller, 1 ether + 1)));
        retryAs(anyone, offerId, seller, 1 ether + 1, hex"01");

        vm.expectRevert(abi.encodeWithSelector(PaymentRouter.NotPaid.selector, router.paymentKey(bytes32(uint256(2)), seller, 1 ether)));
        retryAs(anyone, bytes32(uint256(2)), seller, 1 ether, hex"01");

        address other = makeAddr("other-seller");
        vm.expectRevert(abi.encodeWithSelector(PaymentRouter.NotPaid.selector, router.paymentKey(offerId, other, 1 ether)));
        retryAs(anyone, offerId, other, 1 ether, hex"01");
    }

    function test_retry_worksWhilePaused() public {
        address payable seller = payable(makeAddr("seller"));
        bytes32 offerId = bytes32(uint256(1));
        buyAs(makeAddr("payer"), 1 ether, offerId, seller);

        vm.prank(GUARDIAN);
        router.pause();
        assertTrue(router.paused());

        vm.expectEmit(false, false, false, true, address(router));
        emit PcashBatch(context(offerId, seller, 1 ether, COMMITMENT), hex"01");
        retryAs(makeAddr("anyone"), offerId, seller, 1 ether, hex"01");
    }

    function test_retry_hasNoTimeOrAnchorLimit() public {
        address payable seller = payable(makeAddr("seller"));
        bytes32 offerId = bytes32(uint256(1));
        buyAs(makeAddr("payer"), 1 ether, offerId, seller);

        // Long after the payment, with its anchor out of BLOCKHASH range and reorged.
        vm.warp(block.timestamp + 30 days);
        vm.roll(block.number + 1_000);
        vm.setBlockhash(ANCHOR_BLOCK, bytes32(uint256(0xBEEF)));
        vm.expectEmit(false, false, false, true, address(router));
        emit PcashBatch(context(offerId, seller, 1 ether, COMMITMENT), hex"01");
        retryAs(makeAddr("anyone"), offerId, seller, 1 ether, hex"01");
    }

    function test_retry_cannotReplaceTheRecordedCommitment() public {
        address payable seller = payable(makeAddr("seller"));
        bytes32 offerId = bytes32(uint256(1));
        buyAs(makeAddr("payer"), 1 ether, offerId, seller);
        bytes32 key = router.paymentKey(offerId, seller, 1 ether);

        retryAs(makeAddr("anyone"), offerId, seller, 1 ether, hex"01");

        assertEq(router.paid(key), COMMITMENT);
    }

    // pause

    function test_guardianPausesAndUnpausesPayments() public {
        address payable seller = payable(makeAddr("seller"));
        address payer = makeAddr("payer");
        vm.deal(payer, 1 ether);

        vm.expectEmit(false, false, false, true, address(router));
        emit Pausable.Paused(GUARDIAN);
        vm.prank(GUARDIAN);
        router.pause();
        assertTrue(router.paused());

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(payer, payer);
        router.buy{value: 1 ether}(
            bytes32(uint256(1)), seller, COMMITMENT, ANCHOR_BLOCK, ANCHOR_HASH, notAfter(), hex"", hex""
        );

        vm.expectEmit(false, false, false, true, address(router));
        emit Pausable.Unpaused(GUARDIAN);
        vm.prank(GUARDIAN);
        router.unpause();
        assertFalse(router.paused());

        buyAs(payer, 1 ether, bytes32(uint256(1)), seller);
        assertEq(seller.balance, sellerNet(1 ether));
    }

    function test_pauseAndUnpausePreservePaymentRecords() public {
        address payable seller = payable(makeAddr("seller"));
        bytes32 offerId = bytes32(uint256(1));
        buyAs(makeAddr("payer"), 1 ether, offerId, seller);
        bytes32 key = router.paymentKey(offerId, seller, 1 ether);

        vm.startPrank(GUARDIAN);
        router.pause();
        assertEq(router.paid(key), COMMITMENT);
        router.unpause();
        vm.stopPrank();

        assertEq(router.paid(key), COMMITMENT);
        address payer = makeAddr("second-payer");
        vm.deal(payer, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(PaymentRouter.AlreadyPaid.selector, key));
        vm.prank(payer, payer);
        router.buy{value: 1 ether}(
            offerId, seller, bytes32(uint256(2)), ANCHOR_BLOCK, ANCHOR_HASH, notAfter(), hex"", hex""
        );
    }

    function test_onlyGuardianCanPauseOrUnpause() public {
        address other = makeAddr("other");
        vm.expectRevert(PaymentRouter.NotGuardian.selector);
        vm.prank(other);
        router.pause();

        vm.prank(GUARDIAN);
        router.pause();

        vm.expectRevert(PaymentRouter.NotGuardian.selector);
        vm.prank(other);
        router.unpause();
        assertTrue(router.paused());
    }

    function test_pauseRequiresUnpausedAndUnpauseRequiresPaused() public {
        vm.startPrank(GUARDIAN);
        vm.expectRevert(Pausable.ExpectedPause.selector);
        router.unpause();

        router.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        router.pause();
        vm.stopPrank();
    }
}
