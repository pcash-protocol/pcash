// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title ReserveVault
/// @notice Holds an issuer's reserve token. A deposit names a commitment to its PCASH recipient
///         and a nonce, and emits `Deposit`; a PCASH mint rule opens that log. The issuer chooses
///         which addresses may deposit, caps each deposit, can pause deposits, credits value it
///         received outside the vault through the same event once per commitment and nonce, and
///         pays each redemption out once.
contract ReserveVault {
    using SafeERC20 for IERC20;

    /// @notice The largest deposit or credit: one PCASH note holds less than 2^128 units.
    uint256 public constant MAX_AMOUNT = type(uint128).max;
    uint256 public constant BN254_SCALAR_MODULUS =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    IERC20 public immutable token;
    address public issuer;
    uint256 public depositCap;
    bool public depositsPaused;

    mapping(address depositor => bool) public allowed;
    mapping(bytes32 redemptionId => bool) public paidOut;
    /// @notice Whether the issuer has credited a commitment and nonce, keyed by
    ///         `keccak256(abi.encode(recipientCommitment, nonce))`.
    mapping(bytes32 creditId => bool) public credited;

    /// @notice The log mint rules open. topic0 is the event signature, topic1 is `depositor`, and
    ///         the data is `abi.encode(recipientCommitment, nonce, amount)`, 96 bytes.
    event Deposit(address indexed depositor, bytes32 recipientCommitment, bytes32 nonce, uint256 amount);
    event Payout(bytes32 indexed redemptionId, address indexed to, uint256 amount);
    event IssuerChanged(address issuer);
    event AllowedChanged(address indexed depositor, bool allowed);
    event DepositCapChanged(uint256 depositCap);
    event DepositsPausedChanged(bool paused);

    error ZeroAmount();
    error AmountAboveMaximum(uint256 amount);
    error AmountAboveCap(uint256 amount, uint256 depositCap);
    error NotAllowed(address depositor);
    error DepositsPaused();
    error ZeroIssuer();
    error NotIssuer();
    error AlreadyPaidOut(bytes32 redemptionId);
    error AlreadyCredited(bytes32 recipientCommitment, bytes32 nonce);
    error ZeroRecipientCommitment();
    error RecipientCommitmentOutOfField();
    error NonceOutOfField();

    constructor(IERC20 token_, address issuer_, uint256 depositCap_) {
        require(issuer_ != address(0), ZeroIssuer());
        token = token_;
        issuer = issuer_;
        depositCap = depositCap_;
    }

    modifier onlyIssuer() {
        require(msg.sender == issuer, NotIssuer());
        _;
    }

    /// @notice Pulls `amount` from the caller, who must be allowed and have approved it, for
    ///         minting on PCASH to whoever opens `recipientCommitment`.
    function deposit(uint256 amount, bytes32 recipientCommitment, bytes32 nonce) external {
        require(!depositsPaused, DepositsPaused());
        require(allowed[msg.sender], NotAllowed(msg.sender));
        require(amount <= depositCap, AmountAboveCap(amount, depositCap));
        _emitDeposit(msg.sender, recipientCommitment, nonce, amount);
        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Emits a deposit from the issuer without taking tokens, once per commitment and
    ///         nonce, so a credit sent again after an unconfirmed first attempt reverts instead of
    ///         crediting twice. Deposits are not deduplicated: each one is a separate payment.
    function credit(bytes32 recipientCommitment, bytes32 nonce, uint256 amount) external onlyIssuer {
        bytes32 creditId = keccak256(abi.encode(recipientCommitment, nonce));
        require(!credited[creditId], AlreadyCredited(recipientCommitment, nonce));
        credited[creditId] = true;
        _emitDeposit(msg.sender, recipientCommitment, nonce, amount);
    }

    function payout(address to, uint256 amount, bytes32 redemptionId) external onlyIssuer {
        require(!paidOut[redemptionId], AlreadyPaidOut(redemptionId));
        paidOut[redemptionId] = true;
        token.safeTransfer(to, amount);
        emit Payout(redemptionId, to, amount);
    }

    function setIssuer(address newIssuer) external onlyIssuer {
        require(newIssuer != address(0), ZeroIssuer());
        issuer = newIssuer;
        emit IssuerChanged(newIssuer);
    }

    function setAllowed(address depositor, bool isAllowed) external onlyIssuer {
        allowed[depositor] = isAllowed;
        emit AllowedChanged(depositor, isAllowed);
    }

    function setDepositCap(uint256 newDepositCap) external onlyIssuer {
        depositCap = newDepositCap;
        emit DepositCapChanged(newDepositCap);
    }

    function setDepositsPaused(bool paused) external onlyIssuer {
        depositsPaused = paused;
        emit DepositsPausedChanged(paused);
    }

    /// @dev A wallet mints only a deposit whose recipient commitment is a nonzero field element and
    ///      whose nonce is a field element, so the vault refuses any other.
    function _emitDeposit(address depositor, bytes32 recipientCommitment, bytes32 nonce, uint256 amount) private {
        require(amount != 0, ZeroAmount());
        require(amount <= MAX_AMOUNT, AmountAboveMaximum(amount));
        require(recipientCommitment != 0, ZeroRecipientCommitment());
        require(uint256(recipientCommitment) < BN254_SCALAR_MODULUS, RecipientCommitmentOutOfField());
        require(uint256(nonce) < BN254_SCALAR_MODULUS, NonceOutOfField());
        emit Deposit(depositor, recipientCommitment, nonce, amount);
    }
}
