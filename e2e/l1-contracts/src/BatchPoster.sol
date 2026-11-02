// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// A contract wallet reduced to posting: its owner hands it a framed PCASH batch,
/// and it delivers the batch as its own PcashBatch event with an empty context.
contract BatchPoster {
    address public immutable owner = msg.sender;

    event PcashBatch(bytes context, bytes batch);

    function post(bytes calldata batch) external {
        require(msg.sender == owner, "owner only");
        emit PcashBatch("", batch);
    }
}
