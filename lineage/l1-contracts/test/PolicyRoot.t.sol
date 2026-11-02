// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;
import {PolicyRoot} from "../src/PolicyRoot.sol";

contract OtherPublisher {
    function publish(PolicyRoot target) external { target.publish(1); }
}

contract PolicyRootTest {
    function testPublicationSequence() external {
        PolicyRoot target = new PolicyRoot();
        target.publish(123);
        target.publish(456);
        require(target.sequence() == 2);
        require(target.provider() == address(this));
    }

    function testOtherPublisherRejected() external {
        PolicyRoot target = new PolicyRoot();
        OtherPublisher other = new OtherPublisher();
        (bool ok,) = address(other).call(abi.encodeCall(other.publish, (target)));
        require(!ok);
        require(target.sequence() == 0);
    }
}
