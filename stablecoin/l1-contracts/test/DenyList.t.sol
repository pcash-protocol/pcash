// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {DenyList} from "../src/DenyList.sol";

contract DenyListTest is Test {
    // keccak256("Publication(bytes32,uint256,bool,uint64)"), frozen: transfer rules match this topic.
    bytes32 constant PUBLICATION_TOPIC = 0x926351d1bdc982eb7b14f6579a5b0bba64f919d051adf326ea4cb58d3e0e1796;
    uint256 constant MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    bytes32 constant SALT = bytes32(uint256(7));
    uint256 constant ROOT = 0x1234;
    uint64 constant DELTA = 3600;

    DenyList internal denyList;
    address internal issuer = makeAddr("issuer");
    address internal stranger = makeAddr("stranger");
    bytes32 internal listId;

    function setUp() public {
        denyList = new DenyList();
        vm.prank(issuer);
        listId = denyList.create(SALT, ROOT, DELTA);
    }

    function _stored(bytes32 id) internal view returns (address issuer_, uint256 root, uint64 delta, bool paused) {
        (issuer_, delta, paused, root) = denyList.lists(id);
    }

    function _logsFrom(Vm.Log[] memory logs) internal view returns (Vm.Log[] memory out) {
        uint256 count;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(denyList)) ++count;
        }
        out = new Vm.Log[](count);
        count = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(denyList)) out[count++] = logs[i];
        }
    }

    /// Asserts that `logs` contain exactly one Publication, that it is the last log, and that it
    /// carries the list's stored state in the exact layout transfer rules open.
    function _assertOnePublicationOfStoredState(Vm.Log[] memory logs, bytes32 id) internal view {
        uint256 publications;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == PUBLICATION_TOPIC) ++publications;
        }
        assertEq(publications, 1, "publication count");
        Vm.Log memory log = logs[logs.length - 1];
        assertEq(log.emitter, address(denyList));
        assertEq(log.topics.length, 2, "topic count");
        assertEq(log.topics[0], PUBLICATION_TOPIC);
        assertEq(log.topics[1], id);
        (, uint256 root, uint64 delta, bool paused) = _stored(id);
        assertEq(log.data.length, 96, "data length");
        assertEq(log.data, abi.encode(root, paused, delta));
    }

    function test_PublicationTopicIsFrozen() public pure {
        assertEq(DenyList.Publication.selector, PUBLICATION_TOPIC);
        assertEq(keccak256("Publication(bytes32,uint256,bool,uint64)"), PUBLICATION_TOPIC);
    }

    function test_PublicationDataLayout() public {
        vm.recordLogs();
        vm.prank(issuer);
        denyList.pause(listId);
        Vm.Log[] memory logs = _logsFrom(vm.getRecordedLogs());
        assertEq(logs.length, 1);
        assertEq(
            logs[0].data,
            hex"0000000000000000000000000000000000000000000000000000000000001234"
            hex"0000000000000000000000000000000000000000000000000000000000000001"
            hex"0000000000000000000000000000000000000000000000000000000000000e10"
        );
    }

    // --- list identifiers ---

    function test_ListIdOf() public view {
        assertEq(denyList.listIdOf(issuer, SALT), keccak256(abi.encode(issuer, SALT)));
        assertEq(listId, denyList.listIdOf(issuer, SALT));
        assertTrue(denyList.listIdOf(stranger, SALT) != listId);
    }

    function test_Create_SameSaltOtherCreatorIsSeparateList() public {
        vm.prank(stranger);
        bytes32 other = denyList.create(SALT, 1, 60);
        assertTrue(other != listId);
        (address storedIssuer, uint256 root, uint64 delta, bool paused) = _stored(other);
        assertEq(storedIssuer, stranger);
        assertEq(root, 1);
        assertEq(delta, 60);
        assertFalse(paused);
        (storedIssuer, root, delta,) = _stored(listId);
        assertEq(storedIssuer, issuer);
        assertEq(root, ROOT);
        assertEq(delta, DELTA);
    }

    // --- create ---

    function test_Create_StoresAndEmitsCreatedThenPublication() public {
        bytes32 salt = bytes32(uint256(8));
        bytes32 expectedId = denyList.listIdOf(issuer, salt);
        vm.recordLogs();
        vm.prank(issuer);
        bytes32 id = denyList.create(salt, MODULUS - 1, 1);
        Vm.Log[] memory logs = _logsFrom(vm.getRecordedLogs());
        assertEq(id, expectedId);
        assertEq(logs.length, 2);
        assertEq(logs[0].topics[0], DenyList.ListCreated.selector);
        assertEq(logs[0].topics[1], id);
        assertEq(logs[0].data, abi.encode(issuer));
        _assertOnePublicationOfStoredState(logs, id);
        (address storedIssuer, uint256 root, uint64 delta, bool paused) = _stored(id);
        assertEq(storedIssuer, issuer);
        assertEq(root, MODULUS - 1);
        assertEq(delta, 1);
        assertFalse(paused);
    }

    function test_Create_RevertsWhenIdExists() public {
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(DenyList.ListExists.selector, listId));
        denyList.create(SALT, 1, 1);
    }

    function test_Create_RevertsWhenIdExistsAfterIssuerChange() public {
        vm.prank(issuer);
        denyList.setIssuer(listId, stranger);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(DenyList.ListExists.selector, listId));
        denyList.create(SALT, 1, 1);
    }

    function test_Create_RevertsOnRootOutOfField() public {
        vm.prank(stranger);
        vm.expectRevert(DenyList.RootOutOfField.selector);
        denyList.create(SALT, MODULUS, DELTA);
    }

    function test_Create_RevertsOnZeroDelta() public {
        vm.prank(stranger);
        vm.expectRevert(DenyList.ZeroDelta.selector);
        denyList.create(SALT, ROOT, 0);
    }

    // --- update ---

    function test_Update_StoresRootAndEmitsChangeThenPublication() public {
        address[] memory added = new address[](2);
        added[0] = address(0xA1);
        added[1] = address(0xA2);
        address[] memory removed = new address[](1);
        removed[0] = address(0xB1);
        vm.recordLogs();
        vm.prank(issuer);
        denyList.update(listId, added, removed, ROOT, 99);
        Vm.Log[] memory logs = _logsFrom(vm.getRecordedLogs());
        assertEq(logs.length, 2);
        assertEq(logs[0].topics.length, 2);
        assertEq(logs[0].topics[0], DenyList.ListChanged.selector);
        assertEq(logs[0].topics[1], listId);
        assertEq(logs[0].data, abi.encode(added, removed));
        _assertOnePublicationOfStoredState(logs, listId);
        (, uint256 root,,) = _stored(listId);
        assertEq(root, 99);
    }

    function test_Update_WhilePausedPublishesPaused() public {
        vm.startPrank(issuer);
        denyList.pause(listId);
        vm.recordLogs();
        denyList.update(listId, new address[](0), new address[](0), ROOT, 5);
        vm.stopPrank();
        Vm.Log[] memory logs = _logsFrom(vm.getRecordedLogs());
        _assertOnePublicationOfStoredState(logs, listId);
        assertEq(logs[logs.length - 1].data, abi.encode(uint256(5), true, DELTA));
    }

    function testFuzz_Update_PublishesStoredRoot(uint256 newRoot) public {
        newRoot = bound(newRoot, 0, MODULUS - 1);
        vm.recordLogs();
        vm.prank(issuer);
        denyList.update(listId, new address[](0), new address[](0), ROOT, newRoot);
        Vm.Log[] memory logs = _logsFrom(vm.getRecordedLogs());
        _assertOnePublicationOfStoredState(logs, listId);
        assertEq(logs[logs.length - 1].data, abi.encode(newRoot, false, DELTA));
    }

    function test_Update_RevertsForUnknownList() public {
        bytes32 unknown = bytes32(uint256(1));
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(DenyList.UnknownList.selector, unknown));
        denyList.update(unknown, new address[](0), new address[](0), ROOT, 1);
    }

    function test_Update_RevertsForNonIssuer() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(DenyList.NotIssuer.selector, listId));
        denyList.update(listId, new address[](0), new address[](0), ROOT, 1);
    }

    function test_Update_RevertsOnRootOutOfField() public {
        vm.prank(issuer);
        vm.expectRevert(DenyList.RootOutOfField.selector);
        denyList.update(listId, new address[](0), new address[](0), ROOT, MODULUS);
    }

    function test_Update_RevertsOnStaleRoot() public {
        address[] memory first = new address[](1);
        first[0] = address(0xA1);
        address[] memory second = new address[](1);
        second[0] = address(0xA2);
        vm.startPrank(issuer);
        denyList.update(listId, first, new address[](0), ROOT, 99);
        // A second change computed from the same root no longer applies.
        vm.recordLogs();
        vm.expectRevert(abi.encodeWithSelector(DenyList.StaleRoot.selector, listId, uint256(99)));
        denyList.update(listId, second, new address[](0), ROOT, 100);
        vm.stopPrank();
        assertEq(_logsFrom(vm.getRecordedLogs()).length, 0);
        (, uint256 root,,) = _stored(listId);
        assertEq(root, 99);
    }

    function test_Update_AppliesFromCurrentRoot() public {
        vm.startPrank(issuer);
        denyList.update(listId, new address[](0), new address[](0), ROOT, 99);
        denyList.update(listId, new address[](0), new address[](0), 99, 100);
        vm.stopPrank();
        (, uint256 root,,) = _stored(listId);
        assertEq(root, 100);
    }

    // --- setDelta ---

    function test_SetDelta_StoresAndPublishes() public {
        vm.recordLogs();
        vm.prank(issuer);
        denyList.setDelta(listId, 7200);
        Vm.Log[] memory logs = _logsFrom(vm.getRecordedLogs());
        assertEq(logs.length, 1);
        _assertOnePublicationOfStoredState(logs, listId);
        assertEq(logs[0].data, abi.encode(ROOT, false, uint64(7200)));
    }

    function test_SetDelta_RevertsForUnknownList() public {
        bytes32 unknown = bytes32(uint256(1));
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(DenyList.UnknownList.selector, unknown));
        denyList.setDelta(unknown, 1);
    }

    function test_SetDelta_RevertsForNonIssuer() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(DenyList.NotIssuer.selector, listId));
        denyList.setDelta(listId, 1);
    }

    function test_SetDelta_RevertsOnZero() public {
        vm.prank(issuer);
        vm.expectRevert(DenyList.ZeroDelta.selector);
        denyList.setDelta(listId, 0);
    }

    // --- pause and unpause ---

    function test_Pause_PublishesPaused() public {
        vm.recordLogs();
        vm.prank(issuer);
        denyList.pause(listId);
        Vm.Log[] memory logs = _logsFrom(vm.getRecordedLogs());
        assertEq(logs.length, 1);
        _assertOnePublicationOfStoredState(logs, listId);
        assertEq(logs[0].data, abi.encode(ROOT, true, DELTA));
    }

    function test_Unpause_PublishesUnpaused() public {
        vm.startPrank(issuer);
        denyList.pause(listId);
        vm.recordLogs();
        denyList.unpause(listId);
        vm.stopPrank();
        Vm.Log[] memory logs = _logsFrom(vm.getRecordedLogs());
        assertEq(logs.length, 1);
        _assertOnePublicationOfStoredState(logs, listId);
        assertEq(logs[0].data, abi.encode(ROOT, false, DELTA));
    }

    function test_Pause_RevertsWhenPaused() public {
        vm.startPrank(issuer);
        denyList.pause(listId);
        vm.expectRevert(abi.encodeWithSelector(DenyList.ListPaused.selector, listId));
        denyList.pause(listId);
        vm.stopPrank();
    }

    function test_Unpause_RevertsWhenNotPaused() public {
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(DenyList.ListNotPaused.selector, listId));
        denyList.unpause(listId);
    }

    function test_Pause_RevertsForUnknownList() public {
        bytes32 unknown = bytes32(uint256(1));
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(DenyList.UnknownList.selector, unknown));
        denyList.pause(unknown);
    }

    function test_Unpause_RevertsForUnknownList() public {
        bytes32 unknown = bytes32(uint256(1));
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(DenyList.UnknownList.selector, unknown));
        denyList.unpause(unknown);
    }

    function test_Pause_RevertsForNonIssuer() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(DenyList.NotIssuer.selector, listId));
        denyList.pause(listId);
    }

    function test_Unpause_RevertsForNonIssuer() public {
        vm.prank(issuer);
        denyList.pause(listId);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(DenyList.NotIssuer.selector, listId));
        denyList.unpause(listId);
    }

    // --- heartbeat ---

    function test_Heartbeat_AnyonePublishesStoredState() public {
        vm.startPrank(issuer);
        denyList.update(listId, new address[](0), new address[](0), ROOT, 42);
        denyList.setDelta(listId, 600);
        vm.stopPrank();
        vm.recordLogs();
        vm.prank(stranger);
        denyList.heartbeat(listId);
        Vm.Log[] memory logs = _logsFrom(vm.getRecordedLogs());
        assertEq(logs.length, 1);
        _assertOnePublicationOfStoredState(logs, listId);
        assertEq(logs[0].data, abi.encode(uint256(42), false, uint64(600)));
    }

    function test_Heartbeat_RevertsWhilePaused() public {
        vm.prank(issuer);
        denyList.pause(listId);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(DenyList.ListPaused.selector, listId));
        denyList.heartbeat(listId);
    }

    function test_Heartbeat_RevertsForUnknownList() public {
        bytes32 unknown = bytes32(uint256(1));
        vm.expectRevert(abi.encodeWithSelector(DenyList.UnknownList.selector, unknown));
        denyList.heartbeat(unknown);
    }

    function test_Heartbeat_LoopInOneTransactionPublishesOnce() public {
        HeartbeatLoop loop = new HeartbeatLoop(denyList);
        vm.recordLogs();
        assertEq(loop.run(listId, 50), 1);
        assertEq(_logsFrom(vm.getRecordedLogs()).length, 1);

        vm.warp(block.timestamp + denyList.HEARTBEAT_COOLDOWN());
        vm.recordLogs();
        assertEq(loop.run(listId, 50), 1);
        Vm.Log[] memory logs = _logsFrom(vm.getRecordedLogs());
        assertEq(logs.length, 1);
        _assertOnePublicationOfStoredState(logs, listId);
    }

    function test_Heartbeat_RevertsWithinTheCooldown() public {
        uint256 cooldown = denyList.HEARTBEAT_COOLDOWN();
        assertEq(cooldown, 60);
        vm.prank(stranger);
        denyList.heartbeat(listId);
        uint256 next = block.timestamp + cooldown;
        assertEq(denyList.nextHeartbeatAt(listId), next);

        vm.warp(next - 1);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(DenyList.HeartbeatTooSoon.selector, listId, next));
        denyList.heartbeat(listId);

        vm.warp(next);
        vm.prank(issuer);
        denyList.heartbeat(listId);
        assertEq(denyList.nextHeartbeatAt(listId), next + cooldown);
    }

    // The cooldown applies per list and to heartbeats only.
    function test_Heartbeat_CooldownLeavesOtherListsAndIssuerPublications() public {
        vm.prank(stranger);
        bytes32 other = denyList.create(SALT, ROOT, DELTA);
        denyList.heartbeat(listId);
        denyList.heartbeat(other);

        vm.recordLogs();
        vm.startPrank(issuer);
        denyList.update(listId, new address[](0), new address[](0), ROOT, 42);
        denyList.setDelta(listId, 600);
        denyList.pause(listId);
        denyList.unpause(listId);
        vm.stopPrank();
        assertEq(_logsFrom(vm.getRecordedLogs()).length, 5);
    }

    // --- setIssuer ---

    function test_SetIssuer_TransfersControlWithoutPublication() public {
        vm.recordLogs();
        vm.prank(issuer);
        denyList.setIssuer(listId, stranger);
        Vm.Log[] memory logs = _logsFrom(vm.getRecordedLogs());
        assertEq(logs.length, 1);
        assertEq(logs[0].topics.length, 2);
        assertEq(logs[0].topics[0], DenyList.IssuerChanged.selector);
        assertEq(logs[0].topics[1], listId);
        assertEq(logs[0].data, abi.encode(stranger));
        (address storedIssuer,,,) = _stored(listId);
        assertEq(storedIssuer, stranger);

        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(DenyList.NotIssuer.selector, listId));
        denyList.pause(listId);
        vm.prank(stranger);
        denyList.pause(listId);
    }

    function test_SetIssuer_RevertsForUnknownList() public {
        bytes32 unknown = bytes32(uint256(1));
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(DenyList.UnknownList.selector, unknown));
        denyList.setIssuer(unknown, stranger);
    }

    function test_SetIssuer_RevertsForNonIssuer() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(DenyList.NotIssuer.selector, listId));
        denyList.setIssuer(listId, stranger);
    }

    function test_SetIssuer_RevertsOnZero() public {
        vm.prank(issuer);
        vm.expectRevert(DenyList.ZeroIssuer.selector);
        denyList.setIssuer(listId, address(0));
    }
}

/// Calls `heartbeat` repeatedly in one transaction, continuing past reverts, and counts the calls
/// that published.
contract HeartbeatLoop {
    DenyList internal immutable denyList;

    constructor(DenyList denyList_) {
        denyList = denyList_;
    }

    function run(bytes32 listId, uint256 calls) external returns (uint256 published) {
        for (uint256 i; i < calls; ++i) {
            try denyList.heartbeat(listId) {
                ++published;
            } catch {}
        }
    }
}
