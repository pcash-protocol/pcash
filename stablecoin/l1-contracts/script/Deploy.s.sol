// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DenyList} from "../src/DenyList.sol";
import {ReserveVault} from "../src/ReserveVault.sol";
import {MockUSDC} from "../src/testing/MockUSDC.sol";

/// Deploys DenyList, MockUSDC and a ReserveVault for MockUSDC on a local stack. No address may
/// deposit until the issuer allows it with `setAllowed`.
/// Parameterized by environment:
///   PCASH_L1_KEY  deployer key (uint256)
///   PCASH_STABLECOIN_ISSUER  optional vault issuer (default: the deployer)
///   PCASH_STABLECOIN_DEPOSIT_CAP  optional per-deposit cap in token units (default: 1,000,000 USDC)
///   PCASH_L1_RPC  target JSON-RPC endpoint (passed via --rpc-url)
///
/// Usage:
///   forge script script/Deploy.s.sol:Deploy --rpc-url $PCASH_L1_RPC --broadcast
contract Deploy is Script {
    function run() external returns (DenyList denyList, MockUSDC usdc, ReserveVault vault) {
        uint256 deployerKey = vm.envUint("PCASH_L1_KEY");
        address issuer = vm.envOr("PCASH_STABLECOIN_ISSUER", vm.addr(deployerKey));
        uint256 depositCap = vm.envOr("PCASH_STABLECOIN_DEPOSIT_CAP", uint256(1_000_000e6));
        vm.startBroadcast(deployerKey);
        denyList = new DenyList();
        usdc = new MockUSDC();
        vault = new ReserveVault(IERC20(address(usdc)), issuer, depositCap);
        vm.stopBroadcast();
        console.log("DenyList deployed at", address(denyList));
        console.log("MockUSDC deployed at", address(usdc));
        console.log("ReserveVault deployed at", address(vault));
    }
}
