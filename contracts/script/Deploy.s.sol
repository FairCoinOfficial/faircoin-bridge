// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {WFAIR} from "../src/WFAIR.sol";

/// @title WFAIR deployment script
/// @notice Deploys WFAIR with the admin (all roles) set to the SAFE_ADDRESS
///         env var. Intended for Base Sepolia and Base Mainnet.
///
/// Usage:
///   forge script script/Deploy.s.sol \
///     --rpc-url $BASE_SEPOLIA_RPC_URL \
///     --broadcast --verify \
///     --etherscan-api-key $BASESCAN_API_KEY
contract Deploy is Script {
    function run() external returns (WFAIR wfair) {
        address safe = vm.envAddress("SAFE_ADDRESS");
        require(safe != address(0), "Deploy: SAFE_ADDRESS is zero");

        vm.startBroadcast();
        wfair = new WFAIR(safe);
        vm.stopBroadcast();

        console.log("WFAIR deployed at:", address(wfair));
        console.log("Admin (Safe)    :", safe);
    }
}
