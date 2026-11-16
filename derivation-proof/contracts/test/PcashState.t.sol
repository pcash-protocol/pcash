// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {ISP1Verifier} from "@sp1-contracts/src/ISP1Verifier.sol";
import {ExecutedVerifier} from "../src/ExecutedVerifier.sol";
import {PcashState} from "../src/PcashState.sol";

interface Vm {
    function roll(uint256 blockNumber) external;
    function getBlockNumber() external view returns (uint256);
    function prank(address sender) external;
    function expectRevert(bytes4 selector) external;
    function etch(address target, bytes calldata code) external;
    function store(address target, bytes32 slot, bytes32 value) external;
}

/// `PcashState` with `ExecutedVerifier`, whose proof is the outputs it expects.
contract PcashStateTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 constant INTERVAL = 10;
    uint32 constant PCASH_CHAIN_ID = 7;
    address constant INBOX = address(0xca511);
    uint64 constant GENESIS_L1_BLOCK = 1_000;
    bytes32 constant GENESIS_L1_BLOCK_HASH = keccak256("genesis");
    bytes32 constant START_ROOT = keccak256("start");
    address constant PROVER = address(0xC3);
    address constant STRANGER = address(0xD4);

    /// EIP-2935's history contract and its code on Ethereum and Sepolia.
    address constant HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935;
    bytes constant HISTORY_CODE =
        hex"3373fffffffffffffffffffffffffffffffffffffffe14604657602036036042575f35600143038111604257611fff81430311604257611fff9006545f5260205ff35b5f5ffd5b5f35611fff60014303065500";
    uint256 constant HISTORY_WINDOW = 8191;

    PcashState pcashState;

    function setUp() public {
        vm.roll(20_000);
        vm.etch(HISTORY, HISTORY_CODE);
        pcashState = new PcashState(
            INTERVAL,
            START_ROOT,
            0,
            PCASH_CHAIN_ID,
            INBOX,
            GENESIS_L1_BLOCK,
            GENESIS_L1_BLOCK_HASH,
            ISP1Verifier(address(new ExecutedVerifier())),
            bytes32("aggregation"),
            bytes32("range")
        );
    }

    /// The outputs a proof of `root` at `pcashBlock` from the anchor commits.
    function outputs(bytes32 root, uint256 pcashBlock, bytes32 l1Head, address prover)
        internal
        view
        returns (bytes memory)
    {
        return abi.encode(
            PcashState.AggregationOutputs({
                l1Head: l1Head,
                l2PreRoot: pcashState.anchorRoot(),
                claimRoot: root,
                claimBlockNum: pcashBlock,
                configHash: pcashState.CONFIG_HASH(),
                rangeVkeyCommitment: pcashState.RANGE_VKEY_COMMITMENT(),
                proverAddress: prover
            })
        );
    }

    /// Record `hash` as Ethereum block `number`'s in the history contract, as
    /// the system call at the start of block `number + 1` does.
    function setHistory(uint256 number, bytes32 hash) internal {
        vm.store(HISTORY, bytes32(number % HISTORY_WINDOW), hash);
    }

    /// The previous Ethereum block, with `hash` in the history contract.
    function recentHead(bytes32 hash) internal returns (uint256 head) {
        head = vm.getBlockNumber() - 1;
        setHistory(head, hash);
    }

    function prove(bytes32 root, uint256 pcashBlock) internal {
        uint256 head = recentHead(keccak256(abi.encode("head", pcashBlock)));
        bytes memory proof = outputs(root, pcashBlock, keccak256(abi.encode("head", pcashBlock)), PROVER);
        vm.prank(PROVER);
        pcashState.proveBlock(pcashBlock, root, head, proof);
    }

    function check(bool condition, string memory message) internal pure {
        require(condition, message);
    }

    function testProofsAdvanceTheAnchorByTheInterval() public {
        prove(keccak256("a"), INTERVAL);
        prove(keccak256("b"), 2 * INTERVAL);
        (bytes32 root, uint256 anchor) = pcashState.getAnchorRoot();
        check(root == keccak256("b") && anchor == 2 * INTERVAL, "anchor");
    }

    function testOnlyTheNextCheckpointCanBeProven() public {
        uint256 head = recentHead(keccak256("head"));
        for (uint256 pcashBlock = INTERVAL - 1; pcashBlock <= INTERVAL + 1; pcashBlock += 2) {
            bytes memory proof = outputs(keccak256("a"), pcashBlock, keccak256("head"), PROVER);
            vm.prank(PROVER);
            vm.expectRevert(PcashState.NotNextCheckpoint.selector);
            pcashState.proveBlock(pcashBlock, keccak256("a"), head, proof);
        }
    }

    function testProofIsBoundToItsProver() public {
        uint256 head = recentHead(keccak256("head"));
        bytes memory proof = outputs(keccak256("a"), INTERVAL, keccak256("head"), PROVER);
        vm.prank(STRANGER);
        vm.expectRevert(ExecutedVerifier.PublicValuesMismatch.selector);
        pcashState.proveBlock(INTERVAL, keccak256("a"), head, proof);
    }

    function testProofIsBoundToItsRootAndHead() public {
        uint256 head = recentHead(keccak256("head"));
        bytes memory proof = outputs(keccak256("a"), INTERVAL, keccak256("head"), PROVER);
        vm.prank(PROVER);
        vm.expectRevert(ExecutedVerifier.PublicValuesMismatch.selector);
        pcashState.proveBlock(INTERVAL, keccak256("other"), head, proof);
        setHistory(head, keccak256("other head"));
        vm.prank(PROVER);
        vm.expectRevert(ExecutedVerifier.PublicValuesMismatch.selector);
        pcashState.proveBlock(INTERVAL, keccak256("a"), head, proof);
    }

    function testAHeadAsOldAsTheHistoryHoldsIsAccepted() public {
        uint256 head = recentHead(keccak256("head"));
        bytes memory proof = outputs(keccak256("a"), INTERVAL, keccak256("head"), PROVER);
        vm.roll(head + HISTORY_WINDOW);
        vm.prank(PROVER);
        pcashState.proveBlock(INTERVAL, keccak256("a"), head, proof);
        check(pcashState.anchorBlock() == INTERVAL, "anchor");
    }

    function testAHeadOutsideTheHistoryIsRefused() public {
        uint256 head = recentHead(keccak256("head"));
        bytes memory proof = outputs(keccak256("a"), INTERVAL, keccak256("head"), PROVER);
        vm.roll(head + HISTORY_WINDOW + 1);
        vm.prank(PROVER);
        vm.expectRevert(PcashState.L1BlockHashNotAvailable.selector);
        pcashState.proveBlock(INTERVAL, keccak256("a"), head, proof);
        vm.prank(PROVER);
        vm.expectRevert(PcashState.L1BlockHashNotAvailable.selector);
        pcashState.proveBlock(INTERVAL, keccak256("a"), vm.getBlockNumber(), proof);
    }
}
