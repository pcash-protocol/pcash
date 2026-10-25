// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

contract PolicyRoot {
    address public immutable provider = msg.sender;
    uint256 public sequence;
    event RootPublished(uint256 root, uint256 sequence);

    function publish(uint256 root) external {
        require(msg.sender == provider, "provider only");
        emit RootPublished(root, ++sequence);
    }
}
