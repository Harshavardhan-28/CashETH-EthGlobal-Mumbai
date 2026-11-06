// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script, console } from "forge-std/Script.sol";

import { IHRC719 } from "../src/hedera/IHRC719.sol";
import { AssocProbe } from "../src/spikes/AssocProbe.sol";

/// @notice Spike S2: deploys AssocProbe, which associates itself with HTS USDC in its constructor.
///
///   cd contracts && forge script script/01_DeploySpikeS2.s.sol --rpc-url testnet \
///     --private-key $HEDERA_OPERATOR_KEY --broadcast --legacy --slow --skip-simulation \
///     --gas-estimate-multiplier 130
///
/// Env: USDC_EVM_ADDRESS (required).
contract DeploySpikeS2 is Script {
    function run() external {
        address usdc = vm.envAddress("USDC_EVM_ADDRESS");

        // revm has no HTS system contract: mock the facade's `associate()` for the local run only; the
        // broadcast creation performs the real association on-chain.
        vm.mockCall(usdc, abi.encodeWithSelector(IHRC719.associate.selector), abi.encode(uint256(22)));

        vm.startBroadcast();
        AssocProbe probe = new AssocProbe(usdc);
        vm.stopBroadcast();

        console.log("probe", address(probe));
    }
}
