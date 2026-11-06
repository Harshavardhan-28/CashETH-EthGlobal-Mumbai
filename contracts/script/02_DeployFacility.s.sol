// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script, console } from "forge-std/Script.sol";

import { KYARegistry } from "../src/core/KYARegistry.sol";
import { IKYARegistry } from "../src/core/interfaces/IKYARegistry.sol";
import { ReceivableRegistry } from "../src/core/ReceivableRegistry.sol";
import { IReceivableRegistry } from "../src/core/interfaces/IReceivableRegistry.sol";
import { ReceivableCreditNote } from "../src/core/ReceivableCreditNote.sol";
import { IReceivableCreditNote } from "../src/core/interfaces/IReceivableCreditNote.sol";
import { CreditFacility } from "../src/core/CreditFacility.sol";
import { ICreditFacility } from "../src/core/interfaces/ICreditFacility.sol";
import { RepaymentRouter } from "../src/core/RepaymentRouter.sol";
import { IHRC719 } from "../src/hedera/IHRC719.sol";

/// @notice C3: deploys ReceivableCreditNote, CreditFacility and RepaymentRouter against the registries that
///         `01_DeployCore` already deployed, funds the facility with 20 HBAR (it pays for its own HSS schedules)
///         and wires the two registries to the facility and the router. `rcn.wire` and `facility.wire` need the
///         SwapVM router and stay for Task 4.3.
///
///   cd contracts && forge script script/02_DeployFacility.s.sol --rpc-url testnet \
///     --private-key $HEDERA_OPERATOR_KEY --broadcast --legacy --slow --skip-simulation \
///     --gas-estimate-multiplier 130
///
/// Env: KYA_REGISTRY, RECEIVABLE_REGISTRY, USDC_EVM_ADDRESS, COORDINATOR_EVM (required). The broadcaster (the
/// operator, which owns both registries) owns RCN and the facility.
///
/// The facility and router constructors associate with HTS USDC, so the on-chain simulation is skipped and the
/// facade's `associate()` is mocked for the local run only. The facility is created without value (the relay
/// cannot estimate a creation that carries value) and funded through `receive()` with an explicit gas limit,
/// as in spike S4. The wiring calls also carry explicit gas limits, so nothing depends on estimating a call
/// against a contract created earlier in the same broadcast.
contract DeployFacility is Script {
    uint256 internal constant FUNDING = 20 ether; // 20 HBAR in the relay's 18-decimal units
    uint256 internal constant FUNDING_GAS = 60_000;
    uint256 internal constant WIRE_GAS = 150_000;

    function run() external {
        KYARegistry kya = KYARegistry(vm.envAddress("KYA_REGISTRY"));
        ReceivableRegistry registry = ReceivableRegistry(vm.envAddress("RECEIVABLE_REGISTRY"));
        address usdc = vm.envAddress("USDC_EVM_ADDRESS");
        address coordinator = vm.envAddress("COORDINATOR_EVM");

        // revm has no HTS system contract: mock the facade's `associate()` for the local run only; the broadcast
        // creations perform the real association on-chain.
        vm.mockCall(usdc, abi.encodeWithSelector(IHRC719.associate.selector), abi.encode(uint256(22)));

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        ReceivableCreditNote rcn = new ReceivableCreditNote(deployer);
        CreditFacility facility = new CreditFacility(
            IReceivableRegistry(address(registry)),
            IKYARegistry(address(kya)),
            IReceivableCreditNote(address(rcn)),
            usdc,
            coordinator,
            deployer
        );
        RepaymentRouter router = new RepaymentRouter(
            IReceivableRegistry(address(registry)),
            IKYARegistry(address(kya)),
            ICreditFacility(address(facility)),
            IReceivableCreditNote(address(rcn)),
            usdc
        );
        (bool ok,) = payable(address(facility)).call{ value: FUNDING, gas: FUNDING_GAS }("");
        require(ok, "funding failed");
        // Argument order differs: registry.wire(facility, router), kya.wire(router, facility).
        registry.wire{ gas: WIRE_GAS }(address(facility), address(router));
        kya.wire{ gas: WIRE_GAS }(address(router), address(facility));
        vm.stopBroadcast();

        require(registry.facility() == address(facility), "registry.facility");
        require(registry.repaymentRouter() == address(router), "registry.repaymentRouter");
        require(kya.repaymentRouter() == address(router), "kya.repaymentRouter");
        require(kya.facility() == address(facility), "kya.facility");

        console.log("deployer", deployer);
        console.log("rcn", address(rcn));
        console.log("creditFacility", address(facility));
        console.log("repaymentRouter", address(router));
    }
}
