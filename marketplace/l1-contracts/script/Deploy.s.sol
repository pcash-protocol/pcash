// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";

/// Deploys PaymentRouter. Parameterized entirely by environment:
///   PCASH_L1_KEY  deployer key (uint256)
///   PCASH_PAYMENT_ROUTER_FEE_RECIPIENT  required website-fee recipient
///   PCASH_PAYMENT_ROUTER_FEE_BPS  optional website fee in basis points (default 500)
///   PCASH_PAYMENT_ROUTER_GUARDIAN  required address allowed to pause new payments
///   PCASH_L1_RPC  target JSON-RPC endpoint (passed via --rpc-url)
///
/// Usage:
///   forge script script/Deploy.s.sol:Deploy --rpc-url $PCASH_L1_RPC --broadcast
contract Deploy is Script {
    function run() external returns (PaymentRouter router) {
        uint256 deployerKey = vm.envUint("PCASH_L1_KEY");
        address payable feeRecipient = payable(vm.envAddress("PCASH_PAYMENT_ROUTER_FEE_RECIPIENT"));
        require(feeRecipient != vm.addr(deployerKey), "fee recipient must differ from deployer");
        uint256 configuredFeeBps = vm.envOr("PCASH_PAYMENT_ROUTER_FEE_BPS", uint256(500));
        require(configuredFeeBps > 0 && configuredFeeBps < 10_000, "PCASH_PAYMENT_ROUTER_FEE_BPS must be 1..9999");
        // The range check above keeps this value below uint16 max.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint16 feeBps = uint16(configuredFeeBps);
        address guardian = vm.envAddress("PCASH_PAYMENT_ROUTER_GUARDIAN");
        vm.startBroadcast(deployerKey);
        router = new PaymentRouter(feeRecipient, feeBps, guardian);
        vm.stopBroadcast();
        console.log("PaymentRouter deployed at", address(router));
    }
}
