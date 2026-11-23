// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title DenyList
/// @notice Registry of sender deny lists for restricted PCASH assets. Each list stores its
///         issuer, the Poseidon root of its sorted denied-address tree, `delta`, and a pause flag.
///         Every change and every heartbeat emits `Publication` with the stored state; a PCASH
///         transfer rule opens that log through the L1 log tree. A publication authorizes
///         transfers for `delta` seconds after its Ethereum block's timestamp, and one with
///         `paused` set authorizes nothing. The contract publishes only what it stores, so no
///         caller can revive an earlier root.
/// @dev The contract does not compute the root. Readers rebuild each list from `ListChanged`
///      events and check the result against the published root.
contract DenyList {
    uint256 public constant BN254_SCALAR_MODULUS =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    /// @notice The least time between two heartbeats of one list. It bounds the `Publication` logs
    ///         anyone but the issuer can add to a list, which every reader of the list reads.
    uint256 public constant HEARTBEAT_COOLDOWN = 60;

    /// @dev `issuer`, `delta` and `paused` share one slot.
    struct List {
        address issuer;
        uint64 delta;
        bool paused;
        uint256 root;
    }

    /// @notice A list exists exactly when its issuer is nonzero.
    mapping(bytes32 listId => List) public lists;
    /// @notice The earliest block timestamp at which a list's next heartbeat publishes.
    mapping(bytes32 listId => uint256) public nextHeartbeatAt;

    event ListCreated(bytes32 indexed listId, address issuer);
    event ListChanged(bytes32 indexed listId, address[] added, address[] removed);
    event IssuerChanged(bytes32 indexed listId, address issuer);

    /// @notice The log transfer rules open. topic0 is the event signature, topic1 is `listId`, and
    ///         the data is `abi.encode(root, paused, delta)`, 96 bytes.
    event Publication(bytes32 indexed listId, uint256 root, bool paused, uint64 delta);

    error UnknownList(bytes32 listId);
    error ListExists(bytes32 listId);
    error NotIssuer(bytes32 listId);
    error RootOutOfField();
    error ZeroDelta();
    error ZeroIssuer();
    error ListPaused(bytes32 listId);
    error ListNotPaused(bytes32 listId);
    error StaleRoot(bytes32 listId, uint256 storedRoot);
    error HeartbeatTooSoon(bytes32 listId, uint256 nextHeartbeatAt);

    /// @notice List identifier for `create(salt, ...)` called by `creator`. Including the creator
    ///         keeps one issuer from taking another's identifier.
    function listIdOf(address creator, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(creator, salt));
    }

    /// @notice Creates a list with the caller as issuer and publishes it.
    function create(bytes32 salt, uint256 root, uint64 delta) external returns (bytes32 listId) {
        listId = listIdOf(msg.sender, salt);
        List storage list = lists[listId];
        require(list.issuer == address(0), ListExists(listId));
        require(root < BN254_SCALAR_MODULUS, RootOutOfField());
        require(delta != 0, ZeroDelta());
        list.issuer = msg.sender;
        list.root = root;
        list.delta = delta;
        emit ListCreated(listId, msg.sender);
        _publish(listId, list);
    }

    /// @notice Stores `newRoot`, emits the change, and publishes the list with its current pause
    ///         flag. `added` and `removed` are emitted as given. `expectedRoot` is the root the
    ///         change was computed from; the update reverts unless it is still the stored root, so
    ///         two changes computed from the same root cannot both apply and leave a root that
    ///         disagrees with the emitted changes.
    function update(
        bytes32 listId,
        address[] calldata added,
        address[] calldata removed,
        uint256 expectedRoot,
        uint256 newRoot
    ) external {
        List storage list = _issuerList(listId);
        require(list.root == expectedRoot, StaleRoot(listId, list.root));
        require(newRoot < BN254_SCALAR_MODULUS, RootOutOfField());
        list.root = newRoot;
        emit ListChanged(listId, added, removed);
        _publish(listId, list);
    }

    /// @notice Sets the validity window of later publications. Earlier publications keep the
    ///         `delta` they carry.
    function setDelta(bytes32 listId, uint64 delta) external {
        List storage list = _issuerList(listId);
        require(delta != 0, ZeroDelta());
        list.delta = delta;
        _publish(listId, list);
    }

    function pause(bytes32 listId) external {
        List storage list = _issuerList(listId);
        require(!list.paused, ListPaused(listId));
        list.paused = true;
        _publish(listId, list);
    }

    function unpause(bytes32 listId) external {
        List storage list = _issuerList(listId);
        require(list.paused, ListNotPaused(listId));
        list.paused = false;
        _publish(listId, list);
    }

    /// @notice Republishes the stored state of an unpaused list. Anyone may call it, once per
    ///         `HEARTBEAT_COOLDOWN` per list; a call within the cooldown reverts.
    function heartbeat(bytes32 listId) external {
        List storage list = lists[listId];
        require(list.issuer != address(0), UnknownList(listId));
        require(!list.paused, ListPaused(listId));
        uint256 next = nextHeartbeatAt[listId];
        require(block.timestamp >= next, HeartbeatTooSoon(listId, next));
        nextHeartbeatAt[listId] = block.timestamp + HEARTBEAT_COOLDOWN;
        _publish(listId, list);
    }

    function setIssuer(bytes32 listId, address newIssuer) external {
        List storage list = _issuerList(listId);
        require(newIssuer != address(0), ZeroIssuer());
        list.issuer = newIssuer;
        emit IssuerChanged(listId, newIssuer);
    }

    function _issuerList(bytes32 listId) private view returns (List storage list) {
        list = lists[listId];
        address issuer = list.issuer;
        require(issuer != address(0), UnknownList(listId));
        require(msg.sender == issuer, NotIssuer(listId));
    }

    function _publish(bytes32 listId, List storage list) private {
        emit Publication(listId, list.root, list.paused, list.delta);
    }
}
