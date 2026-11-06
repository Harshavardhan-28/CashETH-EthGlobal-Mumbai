// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script, console } from "forge-std/Script.sol";

import { KYARegistry } from "../src/core/KYARegistry.sol";
import { IKYARegistry } from "../src/core/interfaces/IKYARegistry.sol";
import { ReceivableRegistry } from "../src/core/ReceivableRegistry.sol";

/// @notice Core deployment: KYARegistry and ReceivableRegistry (Task 3.6 extends this with the facility,
///         router and wiring). Nothing is wired here: both `wire` calls are one-time.
///
///   cd contracts && forge script script/01_DeployCore.s.sol --rpc-url testnet \
///     --private-key $HEDERA_OPERATOR_KEY --broadcast --legacy --slow --skip-simulation \
///     --gas-estimate-multiplier 130
///
/// Env: KYA_ISSUER_EVM, USDC_EVM_ADDRESS (required). The broadcaster (deployer) owns both contracts.
contract DeployCore is Script {
    function run() external {
        address issuer = vm.envAddress("KYA_ISSUER_EVM");
        address usdc = vm.envAddress("USDC_EVM_ADDRESS");

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        KYARegistry kya = new KYARegistry(issuer, deployer);
        ReceivableRegistry registry = new ReceivableRegistry(IKYARegistry(address(kya)), usdc, deployer);
        vm.stopBroadcast();

        console.log("deployer", deployer);
        console.log("kyaRegistry", address(kya));
        console.log("receivableRegistry", address(registry));
    }
}
