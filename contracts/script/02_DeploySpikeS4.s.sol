// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script, console } from "forge-std/Script.sol";

import { AlarmProbe } from "../src/spikes/AlarmProbe.sol";

/// @notice Spike S4: deploys AlarmProbe and funds it with 5 HBAR, which pays for its scheduled
///         executions. The relay takes `value` in 18-decimal units, so `5 ether` is 5 HBAR.
///
///   cd contracts && forge script script/02_DeploySpikeS4.s.sol --rpc-url testnet \
///     --private-key $HEDERA_OPERATOR_KEY --broadcast --legacy --slow --skip-simulation \
///     --gas-estimate-multiplier 130
///
/// The Hashio relay cannot estimate gas for a creation that carries value (`eth_estimateGas` fails
/// with "to field must not be empty") and Solidity has no `gas` option on `new`, so the HBAR goes in
/// through `receive()` in a second transaction with an explicit gas limit, which forge uses as is.
contract DeploySpikeS4 is Script {
    uint256 internal constant FUNDING = 5 ether; // 5 HBAR
    uint256 internal constant FUNDING_GAS = 60_000;

    function run() external {
        vm.startBroadcast();
        AlarmProbe probe = new AlarmProbe();
        (bool ok,) = payable(address(probe)).call{ value: FUNDING, gas: FUNDING_GAS }("");
        require(ok, "funding failed");
        vm.stopBroadcast();

        console.log("probe", address(probe));
    }
}
