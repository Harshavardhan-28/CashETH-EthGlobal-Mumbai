// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script, console } from "forge-std/Script.sol";
import { AquaRouter } from "@1inch/aqua/contracts/AquaRouter.sol";

import { CashEthSwapVMRouter } from "../src/aqua/CashEthSwapVMRouter.sol";
import { CashEthOrderBuilder } from "../src/aqua/CashEthOrderBuilder.sol";
import { TestStablecoin } from "../src/core/TestStablecoin.sol";
import { CashEthTaker } from "../src/core/CashEthTaker.sol";
import { IHRC719 } from "../src/hedera/IHRC719.sol";

/// @notice C4: deploys CashETH's own Aqua registry (`AquaRouter`, owner = operator; spike S1's registry is left
///         untouched), the modified SwapVM router `CashEthSwapVMRouter` (Aqua opcodes + `ReceivableCredit`),
///         the on-chain `CashEthOrderBuilder`, the test stablecoin tUSDT (owner = operator) and the trader's
///         `CashEthTaker` (owner = operator). The one-time `rcn.wire` / `facility.wire` and the tUSDT mints are
///         sent by `scripts/c4-deploy-and-wire.ts` after this script, each recorded with its transaction.
///
///   cd contracts && forge script script/03_DeployAqua.s.sol --rpc-url testnet \
///     --private-key $HEDERA_OPERATOR_KEY --broadcast --legacy --slow --skip-simulation \
///     --gas-estimate-multiplier 130
///
/// Env: USDC_EVM_ADDRESS, RECEIVABLE_REGISTRY, KYA_REGISTRY, CREDIT_FACILITY (required).
///
/// Every contract is created from its standalone `out/` artifact (see `_create`).
/// The taker's constructor associates with HTS USDC, so the on-chain simulation is skipped and the facade's
/// `associate()` is mocked for the local run only (as in spike S1, whose ~24 KB router deployed this way).
contract DeployAqua is Script {
    address internal constant WHBAR = 0xb1F616b8134F602c3Bb465fB5b5e6565cCAd37Ed;
    string internal constant ROUTER_NAME = "CashETH SwapVM";
    string internal constant ROUTER_VERSION = "1.0.0";

    /// @dev Creates from the standalone artifact in `out/` (the code `forge build --sizes` measures). With
    ///      via-IR, a contract compiled as a sub-object of this script (`new X(...)`) can come out with
    ///      different bytes (the router's was 285 B longer), and forge then mis-decodes its constructor args.
    function _create(string memory artifact, bytes memory args) internal returns (address deployed) {
        bytes memory initcode = abi.encodePacked(vm.getCode(artifact), args);
        assembly ("memory-safe") {
            deployed := create(0, add(initcode, 0x20), mload(initcode))
        }
        require(deployed != address(0), artifact);
    }

    function run() external {
        address usdc = vm.envAddress("USDC_EVM_ADDRESS");
        address registry = vm.envAddress("RECEIVABLE_REGISTRY");
        address kya = vm.envAddress("KYA_REGISTRY");
        address facility = vm.envAddress("CREDIT_FACILITY");

        vm.mockCall(usdc, abi.encodeWithSelector(IHRC719.associate.selector), abi.encode(uint256(22)));

        vm.startBroadcast();
        (, address operator,) = vm.readCallers();
        AquaRouter aqua = AquaRouter(payable(_create("AquaRouter.sol:AquaRouter", abi.encode(operator))));
        CashEthSwapVMRouter router = CashEthSwapVMRouter(
            payable(
                _create(
                    "CashEthSwapVMRouter.sol:CashEthSwapVMRouter",
                    abi.encode(address(aqua), WHBAR, operator, ROUTER_NAME, ROUTER_VERSION, registry, kya, facility)
                )
            )
        );
        CashEthOrderBuilder builder = CashEthOrderBuilder(_create("CashEthOrderBuilder.sol:CashEthOrderBuilder", ""));
        TestStablecoin tUsdt = TestStablecoin(_create("TestStablecoin.sol:TestStablecoin", abi.encode(operator)));
        CashEthTaker taker =
            CashEthTaker(_create("CashEthTaker.sol:CashEthTaker", abi.encode(address(router), usdc, operator)));
        vm.stopBroadcast();

        require(address(router.REGISTRY()) == registry, "router.REGISTRY");
        require(address(router.KYA()) == kya, "router.KYA");
        require(router.FACILITY() == facility, "router.FACILITY");
        require(tUsdt.owner() == operator, "tUsdt.owner");
        require(taker.owner() == operator, "taker.owner");

        console.log("operator", operator);
        console.log("aqua", address(aqua));
        console.log("swapRouter", address(router));
        console.log("orderBuilder", address(builder));
        console.log("tUsdt", address(tUsdt));
        console.log("taker", address(taker));
    }
}
