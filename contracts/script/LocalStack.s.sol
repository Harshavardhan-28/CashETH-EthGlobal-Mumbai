// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script, console } from "forge-std/Script.sol";
import { AquaRouter } from "@1inch/aqua/contracts/AquaRouter.sol";

import { KYARegistry } from "../src/core/KYARegistry.sol";
import { IKYARegistry } from "../src/core/interfaces/IKYARegistry.sol";
import { ReceivableRegistry } from "../src/core/ReceivableRegistry.sol";
import { IReceivableRegistry } from "../src/core/interfaces/IReceivableRegistry.sol";
import { ReceivableCreditNote } from "../src/core/ReceivableCreditNote.sol";
import { IReceivableCreditNote } from "../src/core/interfaces/IReceivableCreditNote.sol";
import { CreditFacility } from "../src/core/CreditFacility.sol";
import { ICreditFacility } from "../src/core/interfaces/ICreditFacility.sol";
import { RepaymentRouter } from "../src/core/RepaymentRouter.sol";
import { CashEthSwapVMRouter } from "../src/aqua/CashEthSwapVMRouter.sol";
import { CashEthOrderBuilder } from "../src/aqua/CashEthOrderBuilder.sol";
import { MockUSDC } from "../test/mocks/MockUSDC.sol";
import { MockHSS } from "../test/mocks/MockHSS.sol";

/// @notice Full CashETH stack on a local anvil node, for the TypeScript integration tests of `@casheth/aqua`
///         (packages/aqua/test/anvil.globalSetup.ts runs it). Never broadcast this to a real network: the USDC and
///         tUSDT are open-mint mocks.
///
///   anvil --port 8547 --chain-id 31337
///   LOCAL_COORDINATOR=0x.. LOCAL_SELLER=0x.. LOCAL_BUYER=0x.. LOCAL_WORKER_RESEARCH=0x.. \
///   LOCAL_LENDERS=0x..,0x..,0x..,0x.. forge script script/LocalStack.s.sol \
///     --rpc-url http://127.0.0.1:8547 --private-key <anvil key 0> --broadcast
///
/// The broadcaster deploys and owns everything and is the KYA issuer. `MockHSS` is deployed at an ordinary
/// address: the facility calls the schedule service at the hard-coded `0x16b`, so the caller copies the
/// deployed runtime code there with `anvil_setCode` (a script cannot set code on a live node).
/// Prints one `LOCALSTACK <key> <address>` line per contract for the caller to parse.
contract LocalStack is Script {
    /// @dev WHBAR on Hedera testnet; the router only stores it (no native-token unwrapping in CashETH orders).
    address internal constant WETH = 0xb1F616b8134F602c3Bb465fB5b5e6565cCAd37Ed;

    uint256 internal constant LENDER_USDC = 100_000_000; // 100 USDC
    uint256 internal constant LENDER_TUSDT = 50_000_000; // 50 tUSDT
    uint256 internal constant FACILITY_HBAR = 1 ether;

    uint8 internal constant ROLE_SELLER = 1;
    uint8 internal constant ROLE_BUYER = 2;
    uint8 internal constant ROLE_WORKER = 3;
    uint8 internal constant ROLE_LENDER = 4;

    struct Stack {
        AquaRouter aqua;
        MockUSDC usdc;
        MockUSDC tUsdt;
        KYARegistry kya;
        ReceivableRegistry registry;
        ReceivableCreditNote rcn;
        CreditFacility facility;
        RepaymentRouter repaymentRouter;
        CashEthSwapVMRouter swapRouter;
        CashEthOrderBuilder orderBuilder;
        MockHSS hss;
    }

    function run() external {
        address coordinator = vm.envAddress("LOCAL_COORDINATOR");
        address seller = vm.envAddress("LOCAL_SELLER");
        address buyer = vm.envAddress("LOCAL_BUYER");
        address workerResearch = vm.envAddress("LOCAL_WORKER_RESEARCH");
        address[] memory lenders = vm.envAddress("LOCAL_LENDERS", ",");

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        Stack memory s = _deploy(deployer, coordinator);
        _wire(s);

        (bool ok,) = address(s.facility).call{ value: FACILITY_HBAR }("");
        require(ok, "fund facility");

        _register(s.kya, seller, keccak256("seller-co"), ROLE_SELLER, 2);
        _register(s.kya, workerResearch, keccak256("seller-co"), ROLE_WORKER, 2);
        _register(s.kya, buyer, keccak256("buyer-co"), ROLE_BUYER, 3);
        for (uint256 i; i < lenders.length; i++) {
            _register(s.kya, lenders[i], keccak256(abi.encode("lender", i)), ROLE_LENDER, 2);
            s.usdc.mint(lenders[i], LENDER_USDC);
            s.tUsdt.mint(lenders[i], LENDER_TUSDT);
        }
        vm.stopBroadcast();

        _log("deployer", deployer);
        _log("aqua", address(s.aqua));
        _log("usdc", address(s.usdc));
        _log("tUsdt", address(s.tUsdt));
        _log("kyaRegistry", address(s.kya));
        _log("receivableRegistry", address(s.registry));
        _log("rcn", address(s.rcn));
        _log("creditFacility", address(s.facility));
        _log("repaymentRouter", address(s.repaymentRouter));
        _log("swapRouter", address(s.swapRouter));
        _log("orderBuilder", address(s.orderBuilder));
        _log("mockHss", address(s.hss));
    }

    function _deploy(address deployer, address coordinator) internal returns (Stack memory s) {
        s.aqua = new AquaRouter(deployer);
        s.usdc = new MockUSDC();
        s.tUsdt = new MockUSDC();
        s.kya = new KYARegistry(deployer, deployer);
        s.registry = new ReceivableRegistry(IKYARegistry(address(s.kya)), address(s.usdc), deployer);
        s.rcn = new ReceivableCreditNote(deployer);
        s.facility = new CreditFacility(
            IReceivableRegistry(address(s.registry)),
            IKYARegistry(address(s.kya)),
            IReceivableCreditNote(address(s.rcn)),
            address(s.usdc),
            coordinator,
            deployer
        );
        s.repaymentRouter = new RepaymentRouter(
            IReceivableRegistry(address(s.registry)),
            IKYARegistry(address(s.kya)),
            ICreditFacility(address(s.facility)),
            IReceivableCreditNote(address(s.rcn)),
            address(s.usdc)
        );
        // Deployed from the router's own artifact rather than with `new`: via-IR output can differ by
        // compilation unit, and when the copy embedded in this script differs from the artifact, forge cannot
        // split the init code from the constructor arguments and aborts the broadcast.
        bytes memory initCode = abi.encodePacked(
            vm.getCode("CashEthSwapVMRouter.sol:CashEthSwapVMRouter"),
            abi.encode(
                address(s.aqua),
                WETH,
                deployer,
                "CashETH SwapVM",
                "1.0.0",
                address(s.registry),
                address(s.kya),
                address(s.facility)
            )
        );
        address router;
        assembly ("memory-safe") {
            router := create(0, add(initCode, 0x20), mload(initCode))
        }
        require(router != address(0), "router deploy");
        s.swapRouter = CashEthSwapVMRouter(payable(router));
        s.orderBuilder = new CashEthOrderBuilder();
        s.hss = new MockHSS();
    }

    function _wire(Stack memory s) internal {
        s.registry.wire(address(s.facility), address(s.repaymentRouter));
        s.kya.wire(address(s.repaymentRouter), address(s.facility));
        s.rcn.wire(address(s.facility), address(s.repaymentRouter), address(s.swapRouter), address(s.aqua));
        s.facility.wire(address(s.swapRouter), address(s.repaymentRouter));
    }

    function _register(KYARegistry kya, address who, bytes32 group, uint8 role, uint8 lvl) internal {
        kya.register(
            who,
            IKYARegistry.Agent({
                uaidHash: keccak256(abi.encode(who)),
                ownerGroup: group,
                role: role,
                level: lvl,
                expiresAt: 0,
                revoked: false,
                mandateHash: bytes32(0)
            })
        );
    }

    function _log(string memory key, address value) internal pure {
        console.log("LOCALSTACK", key, value);
    }
}
