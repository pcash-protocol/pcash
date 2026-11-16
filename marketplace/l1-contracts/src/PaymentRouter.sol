// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title PaymentRouter
/// @notice Records one payment per marketplace offer, pays the seller and
///         website fee within that payment, and carries the buyer's PCASH claim
///         batch in the same Ethereum transaction as a `PcashBatch` event.
///         `buy` pays and carries the first batch. `retry` carries a fresh batch
///         for a recorded payment; anyone may call it, and only the holder of the
///         claim key can make a batch that succeeds.
///         The guardian can pause `buy`; it cannot move funds, change terms, or
///         stop `retry`, so claims on payments already made are unaffected.
contract PaymentRouter is Pausable, ReentrancyGuardTransient {
    uint256 public constant BN254_SCALAR_MODULUS =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint16 public constant FEE_BPS_DENOMINATOR = 10_000;

    /// @notice Address paid the deployment's fixed website fee.
    address payable public immutable feeRecipient;

    /// @notice Website fee in basis points of the buyer's gross payment.
    uint16 public immutable feeBps;

    /// @notice Address allowed to pause and unpause `buy`.
    address public immutable guardian;

    /// @notice First block to scan for this router's payments.
    uint256 public immutable deploymentBlock;

    /// @notice Emitted for the first payment of a particular offer tuple.
    /// @dev `offerId`, `seller`, and `amount` identify the offer. The escrow's claim binds those
    ///      values to the escrow note through the `PcashBatch` context. `recoveryData` is the
    ///      buyer's opaque recovery material; the router does not parse it.
    event Payment(
        bytes32 indexed offerId,
        address indexed seller,
        address indexed payer,
        uint256 amount,
        bytes32 claimKeyCommitment,
        bytes recoveryData
    );

    /// @notice Carries a PCASH claim batch for the PCASH node to derive.
    /// @dev `context` is `abi.encode(offerId, seller, amount, claimKeyCommitment)`, where `amount`
    ///      is the gross payment. The router does not parse `batch`.
    event PcashBatch(bytes context, bytes batch);

    /// @notice Claim-key commitment recorded for the exact (offerId, seller, amount) tuple; zero if
    ///         the tuple has not been paid.
    mapping(bytes32 paymentKey => bytes32 claimKeyCommitment) public paid;

    error ZeroValue();
    error ZeroSeller();
    error InvalidOfferId();
    error ZeroFeeRecipient();
    error InvalidFeeBps();
    error ZeroGuardian();
    error NotGuardian();
    error InvalidAnchor();
    error NotAfterPassed();
    error ZeroClaimKeyCommitment();
    error AlreadyPaid(bytes32 paymentKey);
    error NotPaid(bytes32 paymentKey);

    constructor(address payable feeRecipient_, uint16 feeBps_, address guardian_) {
        require(feeRecipient_ != address(0), ZeroFeeRecipient());
        require(feeBps_ != 0 && feeBps_ < FEE_BPS_DENOMINATOR, InvalidFeeBps());
        require(guardian_ != address(0), ZeroGuardian());
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
        guardian = guardian_;
        deploymentBlock = block.number;
    }

    modifier onlyGuardian() {
        require(msg.sender == guardian, NotGuardian());
        _;
    }

    /// @notice Stops `buy`. `retry` is unaffected, and reclaims never call the router.
    function pause() external onlyGuardian {
        _pause();
    }

    function unpause() external onlyGuardian {
        _unpause();
    }

    /// @notice Fee paid for one gross payment, rounded down to wei.
    function websiteFee(uint256 gross) public view returns (uint256) {
        return gross * feeBps / FEE_BPS_DENOMINATOR;
    }

    /// @notice Derives the one-shot key used by `buy` and `retry`.
    /// @dev Amount is included so an irrelevant wrong-value payment cannot consume
    ///      the valid offer. The claim() function only accepts the advertised offer amount.
    function paymentKey(bytes32 offerId, address seller, uint256 amount) public pure returns (bytes32) {
        return keccak256(abi.encode(offerId, seller, amount));
    }

    /// @notice Records one gross payment, pays the seller net and website fee, and carries the
    ///         buyer's claim batch.
    /// @dev A failed transfer reverts the whole payment. `nonReentrant` is what stops a
    ///      recipient from paying the same offer again from its receive hook.
    ///      The anchor and `notAfter` are supplied by the buyer and protect only the buyer; the
    ///      escrow enforces the real deadline.
    /// @param offerId Per-offer identifier committed by the escrow's claim.
    /// @param seller Recipient of the call value after the website fee.
    /// @param claimKeyCommitment Nonzero claim-key commitment recorded for this payment.
    /// @param anchorBlockNumber L1 block of the pcash snapshot the buyer verified.
    /// @param anchorBlockHash Hash of that snapshot block on the buyer's canonical branch.
    /// @param notAfter Latest block timestamp at which the call may execute. A block-count limit
    ///        cannot bound elapsed time, so the buyer's client derives it from its proof's snapshot
    ///        timestamp and the claim deadline.
    /// @param recoveryData Buyer recovery material emitted in `Payment`.
    /// @param batch PCASH claim batch carried in `PcashBatch`.
    function buy(
        bytes32 offerId,
        address payable seller,
        bytes32 claimKeyCommitment,
        uint256 anchorBlockNumber,
        bytes32 anchorBlockHash,
        uint64 notAfter,
        bytes calldata recoveryData,
        bytes calldata batch
    ) external payable whenNotPaused nonReentrant {
        require(msg.value != 0, ZeroValue());
        require(seller != address(0), ZeroSeller());
        require(uint256(offerId) < BN254_SCALAR_MODULUS, InvalidOfferId());
        require(claimKeyCommitment != bytes32(0), ZeroClaimKeyCommitment());
        require(block.timestamp <= notAfter, NotAfterPassed());
        // `blockhash` is zero for the current block and for blocks older than the last 256.
        require(anchorBlockHash != bytes32(0) && blockhash(anchorBlockNumber) == anchorBlockHash, InvalidAnchor());

        _recordPayment(offerId, seller, claimKeyCommitment, recoveryData);
        _carry(offerId, seller, msg.value, claimKeyCommitment, batch);
    }

    /// @notice Carries a fresh claim batch for a payment already recorded by `buy`.
    /// @dev Not pausable and has no deadline check: the guardian's pause must not affect claims on
    ///      payments already made, and the escrow enforces its own deadline. Anyone may call it.
    ///      The context names the claim-key commitment recorded by `buy`, so a batch can spend
    ///      only that payment's escrow note, and a stale claim fails on PCASH.
    /// @param offerId Offer identifier of the recorded payment.
    /// @param seller Seller of the recorded payment.
    /// @param amount Gross amount of the recorded payment.
    /// @param batch PCASH claim batch carried in `PcashBatch`.
    function retry(bytes32 offerId, address seller, uint256 amount, bytes calldata batch) external {
        bytes32 key = paymentKey(offerId, seller, amount);
        bytes32 claimKeyCommitment = paid[key];
        require(claimKeyCommitment != bytes32(0), NotPaid(key));

        _carry(offerId, seller, amount, claimKeyCommitment, batch);
    }

    /// @dev Pays the seller and website fee out of `msg.value` and records the payment.
    function _recordPayment(
        bytes32 offerId,
        address payable seller,
        bytes32 claimKeyCommitment,
        bytes calldata recoveryData
    ) private {
        bytes32 key = paymentKey(offerId, seller, msg.value);
        require(paid[key] == bytes32(0), AlreadyPaid(key));

        uint256 fee = websiteFee(msg.value);
        Address.sendValue(seller, msg.value - fee);
        Address.sendValue(feeRecipient, fee);

        paid[key] = claimKeyCommitment;
        emit Payment(offerId, seller, msg.sender, msg.value, claimKeyCommitment, recoveryData);
    }

    function _carry(
        bytes32 offerId,
        address seller,
        uint256 amount,
        bytes32 claimKeyCommitment,
        bytes calldata batch
    ) private {
        emit PcashBatch(abi.encode(offerId, seller, amount, claimKeyCommitment), batch);
    }
}
