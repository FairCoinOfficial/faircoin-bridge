// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {WFAIR} from "../src/WFAIR.sol";

/// @title WFAIR deployment script
/// @notice Deploys WFAIR with admin roles assigned to `SAFE_ADDRESS` and an
///         optional direct MINTER_ROLE grant to `MINTER_EOA` (the bridge EOA
///         used in `direct_eoa` mint-authority mode).
/// @dev `MINTER_EOA` is optional; when unset or zero, only the Safe holds
///      MINTER_ROLE and the bridge must run in `safe_proposal` mode.
///
/// Usage:
///   SAFE_ADDRESS=0x... [MINTER_EOA=0x...] \
///   forge script script/Deploy.s.sol \
///     --rpc-url $BASE_SEPOLIA_RPC_URL \
///     --broadcast --verify \
///     --etherscan-api-key $BASESCAN_API_KEY
contract Deploy is Script {
    function run() external returns (WFAIR wfair) {
        address safe = vm.envAddress("SAFE_ADDRESS");
        require(safe != address(0), "Deploy: SAFE_ADDRESS is zero");

        address minter = vm.envOr("MINTER_EOA", address(0));

        vm.startBroadcast();
        wfair = new WFAIR(safe, minter);
        vm.stopBroadcast();

        console.log("WFAIR deployed:", address(wfair));
        console.log("Admin (Safe) :", safe);
        console.log("Minter (EOA):", minter);
    }
}
