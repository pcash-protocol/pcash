// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {ISP1Verifier} from "@sp1-contracts/src/ISP1Verifier.sol";

/// @title PcashState
/// @notice PCASH checkpoints on Ethereum, each accepted only with a proof that
/// the network's derivation reaches it from the one before.
/// @dev A proof is an aggregation of range proofs. Its outputs bind the
/// checkpoint before and after, the network, the range program, an Ethereum
/// head on this chain that the derived blocks lead to, and the prover.
contract PcashState {
    /// EIP-2935's history contract, which holds the hashes of the last 8191
    /// blocks.
    address internal constant BLOCK_HASH_HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935;

    /// PCASH blocks between checkpoints.
    uint256 public immutable INTERVAL;
    ISP1Verifier public immutable VERIFIER;
    /// The network the proofs derive, with this chain as its Ethereum.
    bytes32 public immutable CONFIG_HASH;
    bytes32 public immutable AGGREGATION_VKEY;
    bytes32 public immutable RANGE_VKEY_COMMITMENT;

    /// The latest proven checkpoint: a PCASH block and its root.
    uint256 public anchorBlock;
    bytes32 public anchorRoot;

    /// The aggregation program's committed outputs.
    struct AggregationOutputs {
        bytes32 l1Head;
        bytes32 l2PreRoot;
        bytes32 claimRoot;
        uint256 claimBlockNum;
        bytes32 configHash;
        bytes32 rangeVkeyCommitment;
        address proverAddress;
    }

    event BlockProven(uint256 indexed blockNumber, bytes32 root, address indexed prover);

    error NotNextCheckpoint();
    error L1BlockHashNotAvailable();

    constructor(
        uint256 interval,
        bytes32 startRoot,
        uint256 startBlock,
        uint32 pcashChainId,
        address inbox,
        uint64 genesisL1Block,
        bytes32 genesisL1BlockHash,
        ISP1Verifier verifier,
        bytes32 aggregationVkey,
        bytes32 rangeVkeyCommitment
    ) {
        INTERVAL = interval;
        VERIFIER = verifier;
        CONFIG_HASH = keccak256(
            // The network's configuration holds the Ethereum chain ID as a uint64.
            // forge-lint: disable-next-line(unsafe-typecast)
            abi.encode(pcashChainId, uint64(block.chainid), inbox, genesisL1Block, genesisL1BlockHash)
        );
        AGGREGATION_VKEY = aggregationVkey;
        RANGE_VKEY_COMMITMENT = rangeVkeyCommitment;
        anchorBlock = startBlock;
        anchorRoot = startRoot;
    }

    /// @notice Advance the anchor to the next checkpoint.
    /// @param blockNumber The next checkpoint's PCASH block: the anchor's plus INTERVAL
    /// @param root Its root
    /// @param l1BlockNumber The proof's Ethereum head, one of the last 8191 blocks
    /// @param proof The aggregation proof, bound to the sender
    function proveBlock(uint256 blockNumber, bytes32 root, uint256 l1BlockNumber, bytes calldata proof) external {
        if (blockNumber != anchorBlock + INTERVAL) revert NotNextCheckpoint();
        AggregationOutputs memory outputs = AggregationOutputs({
            l1Head: _l1BlockHash(l1BlockNumber),
            l2PreRoot: anchorRoot,
            claimRoot: root,
            claimBlockNum: blockNumber,
            configHash: CONFIG_HASH,
            rangeVkeyCommitment: RANGE_VKEY_COMMITMENT,
            proverAddress: msg.sender
        });
        VERIFIER.verifyProof(AGGREGATION_VKEY, abi.encode(outputs), proof);
        anchorBlock = blockNumber;
        anchorRoot = root;
        emit BlockProven(blockNumber, root, msg.sender);
    }

    /// @notice The anchor's root and PCASH block, read together.
    function getAnchorRoot() external view returns (bytes32, uint256) {
        return (anchorRoot, anchorBlock);
    }

    function _l1BlockHash(uint256 l1BlockNumber) internal view returns (bytes32) {
        (bool found, bytes memory blockHash) = BLOCK_HASH_HISTORY.staticcall(abi.encode(l1BlockNumber));
        if (!found || blockHash.length != 32) revert L1BlockHashNotAvailable();
        return abi.decode(blockHash, (bytes32));
    }
}
