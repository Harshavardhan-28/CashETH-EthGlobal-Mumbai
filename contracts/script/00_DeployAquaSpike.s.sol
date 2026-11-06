// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script, console } from "forge-std/Script.sol";
import { AquaRouter } from "@1inch/aqua/contracts/AquaRouter.sol";
import { AquaSwapVMRouter } from "@1inch/swap-vm/contracts/routers/AquaSwapVMRouter.sol";
import { ISwapVM } from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";

import { SpikeOrderBuilder } from "../src/spikes/SpikeOrderBuilder.sol";
import { IHRC719, SpikeTaker } from "../src/spikes/SpikeTaker.sol";
import { SpikeTokenB } from "../src/spikes/SpikeTokenB.sol";

/// @notice Spike S1: deploys the official AquaRouter, an unmodified AquaSwapVMRouter, TOKENB, the
///         order builder and SpikeTaker on Hedera testnet.
///
///   cd contracts && forge script script/00_DeployAquaSpike.s.sol --rpc-url testnet \
///     --private-key $HEDERA_OPERATOR_KEY --broadcast --legacy --slow --skip-simulation \
///     --gas-estimate-multiplier 130
/// (`--skip-simulation`: forge's replay simulation does not carry the HTS mock below.)
///
/// Env: USDC_EVM_ADDRESS (required). SPIKE_AQUA / SPIKE_ROUTER (optional): reuse contracts that are
/// already deployed (e.g. a router created by scripts/spikes/s1-deploy-flow.ts) instead of creating them.
contract DeployAquaSpike is Script {
    address internal constant WHBAR = 0xb1F616b8134F602c3Bb465fB5b5e6565cCAd37Ed;
    string internal constant ROUTER_NAME = "CashETH SwapVM";
    string internal constant ROUTER_VERSION = "1.0.0";

    function run() external {
        address usdc = vm.envAddress("USDC_EVM_ADDRESS");
        address existingAqua = vm.envOr("SPIKE_AQUA", address(0));
        address existingRouter = vm.envOr("SPIKE_ROUTER", address(0));

        // revm has no HTS system contract, so the facade's `associate()` cannot run in forge's local
        // simulation. Mock it there only; the broadcast creation runs the real association on-chain
        // and the spike script verifies it through the mirror node.
        vm.mockCall(usdc, abi.encodeWithSelector(IHRC719.associate.selector), abi.encode(uint256(22)));

        vm.startBroadcast();
        address owner = msg.sender;
        AquaRouter aqua = existingAqua == address(0) ? new AquaRouter(owner) : AquaRouter(payable(existingAqua));
        AquaSwapVMRouter router = existingRouter == address(0)
            ? new AquaSwapVMRouter(address(aqua), WHBAR, owner, ROUTER_NAME, ROUTER_VERSION)
            : AquaSwapVMRouter(payable(existingRouter));
        SpikeTokenB tokenB = new SpikeTokenB();
        SpikeOrderBuilder builder = new SpikeOrderBuilder();
        SpikeTaker taker = new SpikeTaker(ISwapVM(address(router)), usdc, tokenB);
        vm.stopBroadcast();

        console.log("owner", owner);
        console.log("aqua", address(aqua));
        console.log("router", address(router));
        console.log("tokenB", address(tokenB));
        console.log("builder", address(builder));
        console.log("taker", address(taker));
    }
}
