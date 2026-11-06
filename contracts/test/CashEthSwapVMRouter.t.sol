// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { AquaRouter } from "@1inch/aqua/contracts/AquaRouter.sol";
import { ISwapVM } from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/contracts/libs/TakerTraits.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/contracts/libs/MakerTraits.sol";
import { Salt } from "@1inch/swap-vm/contracts/instructions/Controls.sol";
import { FeeFlatIn } from "@1inch/swap-vm/contracts/instructions/FeeFlat.sol";
import { XYCSwap } from "@1inch/swap-vm/contracts/instructions/XYCSwap.sol";
import { Opcode } from "@1inch/swap-vm/contracts/libs/OpcodeList.sol";
import { AquaOpcodes } from "@1inch/swap-vm/contracts/opcodes/AquaOpcodes.sol";

import { KYARegistry } from "../src/core/KYARegistry.sol";
import { IKYARegistry } from "../src/core/interfaces/IKYARegistry.sol";
import { ReceivableRegistry } from "../src/core/ReceivableRegistry.sol";
import { IReceivableRegistry } from "../src/core/interfaces/IReceivableRegistry.sol";
import { ReceivableCreditNote } from "../src/core/ReceivableCreditNote.sol";
import { IReceivableCreditNote } from "../src/core/interfaces/IReceivableCreditNote.sol";
import { CreditFacility } from "../src/core/CreditFacility.sol";
import { ICreditFacility } from "../src/core/interfaces/ICreditFacility.sol";
import { CashEthTraits } from "../src/core/libs/CashEthTraits.sol";
import { ReceivableCredit } from "../src/aqua/ReceivableCredit.sol";
import { CashEthSwapVMRouter } from "../src/aqua/CashEthSwapVMRouter.sol";
import { CashEthOrderBuilder } from "../src/aqua/CashEthOrderBuilder.sol";
import { MockUSDC } from "./mocks/MockUSDC.sol";
import { MockHSS } from "./mocks/MockHSS.sol";

/// @notice Task 4.2: the real CashETH SwapVM router (Aqua opcodes + ReceivableCredit at 0x21) and the
///         on-chain order builder, end to end with the real CreditFacility, AquaRouter, RCN and registries.
contract CashEthSwapVMRouterTest is Test {
    address internal constant HSS = address(0x16b);
    address internal constant WETH = 0xb1F616b8134F602c3Bb465fB5b5e6565cCAd37Ed;

    uint256 internal constant FACE = 10_000_000; // 10 USDC receivable
    uint16 internal constant ADVANCE_BPS = 7500;
    uint256 internal constant LIMIT = 7_500_000;
    uint256 internal constant WALLET = 100_000_000; // 100 USDC in each lender wallet

    uint256 internal constant SHIP_A = 4_000_000;
    uint256 internal constant SHIP_B = 2_000_000;
    uint256 internal constant SHIP_C = 3_000_000;
    uint256 internal constant SHIP_D = 5_000_000;
    uint16 internal constant APR_A = 700;
    uint16 internal constant APR_B = 850;
    uint16 internal constant APR_C = 1300;
    uint16 internal constant APR_D = 1500;

    // Base-yield pool: 1,000 USDC / 1,000 tUSDT, 0.3% FeeFlatIn (FeeFlatIn denominates fees in 1e7).
    uint256 internal constant POOL = 1_000_000_000;
    uint32 internal constant FEE = 30_000;
    uint256 internal constant SWAP_IN = 10_000_000;
    uint256 internal constant SWAP_FEE = 30_000; // ceil(10e6 * 30_000 / 1e7)
    uint256 internal constant SWAP_OUT = 9_871_580; // floor(9_970_000 * 1e9 / (1e9 + 9_970_000))

    uint256 internal buyerPk = 0xB0B;
    uint256 internal sellerPk = 0x5E11E4;
    address internal buyer;
    address internal seller;

    address internal owner = makeAddr("owner");
    address internal coordinator = makeAddr("coordinator");
    address internal repaymentRouter = makeAddr("repaymentRouter");
    address internal makerA = makeAddr("lenderA");
    address internal makerB = makeAddr("lenderB");
    address internal makerC = makeAddr("lenderC");
    address internal makerD = makeAddr("lenderD");
    address internal stranger = makeAddr("stranger");

    AquaRouter internal aqua;
    MockUSDC internal usdc;
    MockUSDC internal tUsdt;
    KYARegistry internal kya;
    ReceivableRegistry internal registry;
    ReceivableCreditNote internal rcn;
    CreditFacility internal facility;
    CashEthSwapVMRouter internal router;
    CashEthOrderBuilder internal builder;

    bytes32 internal id;

    function setUp() public {
        vm.warp(1_750_000_000);
        buyer = vm.addr(buyerPk);
        seller = vm.addr(sellerPk);

        aqua = new AquaRouter(owner);
        usdc = new MockUSDC();
        tUsdt = new MockUSDC();
        kya = new KYARegistry(address(this), owner);
        registry = new ReceivableRegistry(IKYARegistry(address(kya)), address(usdc), owner);
        rcn = new ReceivableCreditNote(owner);
        vm.etch(HSS, address(new MockHSS()).code);

        facility = new CreditFacility(
            IReceivableRegistry(address(registry)),
            IKYARegistry(address(kya)),
            IReceivableCreditNote(address(rcn)),
            address(usdc),
            coordinator,
            owner
        );
        router = new CashEthSwapVMRouter(
            address(aqua), WETH, owner, "CashETH SwapVM", "1.0.0", address(registry), address(kya), address(facility)
        );
        builder = new CashEthOrderBuilder();

        vm.startPrank(owner);
        registry.wire(address(facility), repaymentRouter);
        kya.wire(repaymentRouter, address(facility));
        rcn.wire(address(facility), repaymentRouter, address(router), address(aqua));
        facility.wire(address(router), repaymentRouter);
        vm.stopPrank();

        vm.deal(address(this), 1 ether);
        (bool ok,) = address(facility).call{ value: 1 ether }("");
        assertTrue(ok);

        _kyaRegister(seller, keccak256("seller-co"), 1, 2);
        _kyaRegister(buyer, keccak256("buyer-co"), 2, 3);
        id = _registerReceivable(keccak256("PO-1001"));

        address[4] memory lenders = [makerA, makerB, makerC, makerD];
        for (uint256 i; i < lenders.length; i++) {
            usdc.mint(lenders[i], WALLET);
            vm.prank(lenders[i]);
            usdc.approve(address(aqua), type(uint256).max);
        }
    }

    // ------------------------------------------------------------------ helpers

    function _kyaRegister(address who, bytes32 group, uint8 role, uint8 lvl) internal {
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

    function _registerReceivable(bytes32 buyerRef) internal returns (bytes32 rid) {
        IReceivableRegistry.ReceivableConfirmation memory c = IReceivableRegistry.ReceivableConfirmation({
            seller: seller,
            buyer: buyer,
            currency: address(usdc),
            amount: FACE,
            dueDate: uint64(block.timestamp + 30 days),
            buyerRef: buyerRef,
            detailsCommitment: keccak256("doc"),
            payTo: repaymentRouter,
            nonce: registry.nonces(buyer),
            deadline: uint64(block.timestamp + 1 hours)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, registry.hashConfirmation(c));
        rid = registry.register(c, abi.encodePacked(r, s, v));
        assertEq(uint8(registry.state(rid)), uint8(IReceivableRegistry.State.Confirmed));
    }

    function _args(uint16 aprBps) internal pure returns (ReceivableCredit.Args memory a) {
        a = ReceivableCredit.Args({
            maxTenorDays: 60,
            maxAdvanceBps: 8000,
            minBuyerOnTime: 0,
            maxPerBuyer: 50_000_000,
            aprBps: aprBps,
            minSellerOnTime: 0,
            maxSellerDefaults: 0,
            minReserve: 0,
            sellerSet: new address[](0)
        });
    }

    /// @dev Builds the lender order on-chain and ships it: USDC `amount`, RCN 0.
    function _shipLender(address maker, ReceivableCredit.Args memory a, uint256 amount, uint64 salt)
        internal
        returns (ISwapVM.Order memory order, bytes32 strategyHash)
    {
        bytes memory strategy;
        (order, strategy) = builder.buildLenderOrder(maker, address(rcn), address(usdc), a, salt);
        address[] memory tokens = new address[](2);
        (tokens[0], tokens[1]) = (address(usdc), address(rcn));
        uint256[] memory amounts = new uint256[](2);
        (amounts[0], amounts[1]) = (amount, 0);
        vm.prank(maker);
        strategyHash = aqua.ship(address(router), strategy, tokens, amounts);
    }

    function _fill(ISwapVM.Order memory order, uint256 amount, uint16 aprBps)
        internal
        pure
        returns (ICreditFacility.Fill memory)
    {
        return ICreditFacility.Fill({ order: order, amount: amount, aprBps: aprBps });
    }

    function _assertArgsEq(ReceivableCredit.Args memory x, ReceivableCredit.Args memory y) internal pure {
        assertEq(x.maxTenorDays, y.maxTenorDays, "maxTenorDays");
        assertEq(x.maxAdvanceBps, y.maxAdvanceBps, "maxAdvanceBps");
        assertEq(x.minBuyerOnTime, y.minBuyerOnTime, "minBuyerOnTime");
        assertEq(x.maxPerBuyer, y.maxPerBuyer, "maxPerBuyer");
        assertEq(x.aprBps, y.aprBps, "aprBps");
        assertEq(x.minSellerOnTime, y.minSellerOnTime, "minSellerOnTime");
        assertEq(x.maxSellerDefaults, y.maxSellerDefaults, "maxSellerDefaults");
        assertEq(x.minReserve, y.minReserve, "minReserve");
        assertEq(x.sellerSet.length, y.sellerSet.length, "sellerSet.length");
        for (uint256 i; i < x.sellerSet.length; i++) {
            assertEq(x.sellerSet[i], y.sellerSet[i], "sellerSet[i]");
        }
    }

    function _sorted(address x, address y) internal pure returns (address, address) {
        return x < y ? (x, y) : (y, x);
    }

    // ------------------------------------------------------------------ router

    function test_router_constructor_revertsZeroAddress() public {
        vm.expectRevert(CashEthSwapVMRouter.ZeroAddress.selector);
        new CashEthSwapVMRouter(address(aqua), WETH, owner, "n", "v", address(0), address(kya), address(facility));
        vm.expectRevert(CashEthSwapVMRouter.ZeroAddress.selector);
        new CashEthSwapVMRouter(address(aqua), WETH, owner, "n", "v", address(registry), address(0), address(facility));
        vm.expectRevert(CashEthSwapVMRouter.ZeroAddress.selector);
        new CashEthSwapVMRouter(address(aqua), WETH, owner, "n", "v", address(registry), address(kya), address(0));

        assertEq(address(router.REGISTRY()), address(registry));
        assertEq(address(router.KYA()), address(kya));
        assertEq(router.FACILITY(), address(facility));
    }

    function test_router_dispatchesCreditOpcode() public {
        (ISwapVM.Order memory order, bytes32 strategyHash) = _shipLender(makerA, _args(APR_A), SHIP_A, 1);
        bytes memory td = builder.takerData(address(facility), address(rcn), address(usdc), SHIP_A, id, ADVANCE_BPS);

        // The 0x21 instruction runs: 1:1 pricing against the live Aqua USDC balance, quoted from the facility.
        vm.prank(address(facility));
        (uint256 amountIn, uint256 amountOut, bytes32 orderHash) = router.quote(order, SHIP_A, td);
        assertEq(amountIn, SHIP_A);
        assertEq(amountOut, SHIP_A);
        assertEq(orderHash, strategyHash);

        // One unit over the shipped USDC trips the opcode's own liquidity check.
        bytes memory tdOver =
            builder.takerData(address(facility), address(rcn), address(usdc), SHIP_A + 1, id, ADVANCE_BPS);
        vm.prank(address(facility));
        vm.expectRevert(abi.encodeWithSelector(ReceivableCredit.InsufficientLiquidity.selector, SHIP_A + 1, SHIP_A));
        router.quote(order, SHIP_A + 1, tdOver);

        // An advance above the lender's cap trips the opcode's advance check.
        bytes memory tdAdv = builder.takerData(address(facility), address(rcn), address(usdc), SHIP_A, id, 8001);
        vm.prank(address(facility));
        vm.expectRevert(abi.encodeWithSelector(ReceivableCredit.AdvanceTooHigh.selector, 8001, 8000));
        router.quote(order, SHIP_A, tdAdv);

        // A quote never mutates exposure.
        assertEq(router.exposure(makerA, buyer), 0);
    }

    function test_router_stillRunsAquaOpcodes_xycSwap() public {
        address lp = makeAddr("lp");
        address taker = makeAddr("taker");
        usdc.mint(lp, POOL);
        tUsdt.mint(lp, POOL);
        tUsdt.mint(taker, SWAP_IN);
        vm.startPrank(lp);
        usdc.approve(address(aqua), type(uint256).max);
        tUsdt.approve(address(aqua), type(uint256).max);
        vm.stopPrank();

        (ISwapVM.Order memory order, bytes memory strategy) =
            builder.buildBaseYieldOrder(lp, address(usdc), address(tUsdt), FEE, 7);
        address[] memory tokens = new address[](2);
        (tokens[0], tokens[1]) = (address(usdc), address(tUsdt));
        uint256[] memory amounts = new uint256[](2);
        (amounts[0], amounts[1]) = (POOL, POOL);
        vm.prank(lp);
        bytes32 strategyHash = aqua.ship(address(router), strategy, tokens, amounts);

        // Expected numbers derived from the curve: the fee is taken from amountIn before XYC.
        uint256 net = SWAP_IN - SWAP_FEE;
        assertEq(SWAP_OUT, net * POOL / (POOL + net), "constant check");

        // An EOA taker sells tUSDT for USDC (exact in, transferFrom + Aqua push).
        bytes memory td = TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: taker,
                isExactIn: true,
                shouldUnwrapWeth: false,
                isStrictThresholdAmount: false,
                isFirstTransferFromTaker: false,
                useTransferFromAndAquaPush: true,
                isAToB: address(tUsdt) < address(usdc),
                allowPartialFill: false,
                usePermit2: false,
                threshold: abi.encode(SWAP_OUT),
                to: taker,
                deadline: 0,
                hasPreTransferInCallback: false,
                hasPreTransferOutCallback: false,
                preTransferInHookData: "",
                postTransferInHookData: "",
                preTransferOutHookData: "",
                postTransferOutHookData: "",
                preTransferInCallbackData: "",
                preTransferOutCallbackData: "",
                instructionsArgs: "",
                signature: ""
            })
        );

        vm.startPrank(taker);
        tUsdt.approve(address(router), SWAP_IN);
        (uint256 amountIn, uint256 amountOut, bytes32 orderHash) = router.swap(order, SWAP_IN, td);
        vm.stopPrank();

        assertEq(orderHash, strategyHash);
        assertEq(amountIn, SWAP_IN, "full amount in, fee included");
        assertEq(amountOut, SWAP_OUT, "XYC on the post-fee amount");
        assertEq(usdc.balanceOf(taker), SWAP_OUT);
        assertEq(tUsdt.balanceOf(taker), 0);
        assertEq(usdc.balanceOf(lp), POOL - SWAP_OUT, "USDC leaves the LP wallet");
        assertEq(tUsdt.balanceOf(lp), POOL + SWAP_IN, "tUSDT lands in the LP wallet");

        // The fee stays in the pool: the strategy is credited the full amountIn, not the net.
        (uint256 balUsdc, uint256 balTusdt) =
            aqua.safeBalances(lp, address(router), strategyHash, address(usdc), address(tUsdt));
        assertEq(balUsdc, POOL - SWAP_OUT);
        assertEq(balTusdt, POOL + net + SWAP_FEE);
        // Without the fee the same input would have paid out more.
        assertLt(SWAP_OUT, SWAP_IN * POOL / (POOL + SWAP_IN));

        // The one upstream instruction dropped to fit EIP-170 (XYCConcentrateSwap, 0x51) is not dispatched.
        (address lo, address hi) = _sorted(address(usdc), address(tUsdt));
        ISwapVM.Order memory concentrated = MakerTraitsLib.build(
            MakerTraitsLib.Args({
                maker: lp,
                receiver: address(0),
                tokenA: lo,
                tokenB: hi,
                shouldUnwrapWeth: false,
                useAquaInsteadOfSignature: true,
                allowZeroAmountIn: false,
                usePermit2: false,
                hasPreTransferInHook: false,
                hasPostTransferInHook: false,
                hasPreTransferOutHook: false,
                hasPostTransferOutHook: false,
                preTransferInTarget: address(0),
                preTransferInData: "",
                postTransferInTarget: address(0),
                postTransferInData: "",
                preTransferOutTarget: address(0),
                preTransferOutData: "",
                postTransferOutTarget: address(0),
                postTransferOutData: "",
                program: abi.encodePacked(uint8(Opcode.XYCConcentrateSwap), uint8(0))
            })
        );
        vm.prank(lp);
        aqua.ship(address(router), abi.encode(concentrated), tokens, amounts);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(AquaOpcodes.UnknownOpcode.selector, uint256(0x51)));
        router.quote(concentrated, 1_000, td);
    }

    // ------------------------------------------------------------------ order builder

    function test_orderBuilder_roundTrip_decode() public view {
        (address lo, address hi) = _sorted(address(usdc), address(rcn));

        ReceivableCredit.Args memory a = ReceivableCredit.Args({
            maxTenorDays: 45,
            maxAdvanceBps: 9000,
            minBuyerOnTime: 3,
            maxPerBuyer: 123_456_789,
            aprBps: 1300,
            minSellerOnTime: 2,
            maxSellerDefaults: 1,
            minReserve: 5_000_000,
            sellerSet: new address[](2)
        });
        (a.sellerSet[0], a.sellerSet[1]) = (seller, stranger);
        uint64 salt = type(uint64).max - 5;

        (ISwapVM.Order memory order, bytes memory strategy) =
            builder.buildLenderOrder(makerA, address(rcn), address(usdc), a, salt);
        assertEq(order.maker, makerA);
        assertEq(strategy, abi.encode(order));
        assertEq(
            order.data,
            bytes.concat(abi.encodePacked(lo, hi), Salt.build(salt), this.buildCredit(a)),
            "tokens || Salt || ReceivableCredit"
        );
        assertTrue(MakerTraitsLib.useAquaInsteadOfSignature(order.traits));
        assertEq(MakerTraitsLib.receiver(order.traits, makerA), makerA, "receiver 0 -> maker");

        (ReceivableCredit.Args memory d, uint64 dSalt, address tokenA, address tokenB) = builder.decodeLenderOrder(order);
        _assertArgsEq(d, a);
        assertEq(dSalt, salt);
        assertEq(tokenA, lo);
        assertEq(tokenB, hi);

        // Base-yield order.
        (address ylo, address yhi) = _sorted(address(usdc), address(tUsdt));
        (ISwapVM.Order memory y, bytes memory yStrategy) =
            builder.buildBaseYieldOrder(makerB, address(tUsdt), address(usdc), FEE, 42);
        assertEq(yStrategy, abi.encode(y));
        assertEq(
            y.data,
            // forge-lint: disable-next-line(unsafe-typecast)
            bytes.concat(abi.encodePacked(ylo, yhi), Salt.build(uint64(42)), FeeFlatIn.build(uint24(FEE)), XYCSwap.build()),
            "tokens || Salt || FeeFlatIn || XYCSwap"
        );
        (uint32 fee, uint64 ySalt, address yA, address yB) = builder.decodeBaseYieldOrder(y);
        assertEq(fee, FEE);
        assertEq(ySalt, 42);
        assertEq(yA, ylo);
        assertEq(yB, yhi);

        // Each decoder rejects the other kind.
        try builder.decodeLenderOrder(y) {
            revert("lender decode accepted a base-yield order");
        } catch (bytes memory err) {
            assertEq(err, abi.encodeWithSelector(CashEthOrderBuilder.NotLenderOrder.selector));
        }
        try builder.decodeBaseYieldOrder(order) {
            revert("base-yield decode accepted a lender order");
        } catch (bytes memory err) {
            assertEq(err, abi.encodeWithSelector(CashEthOrderBuilder.NotBaseYieldOrder.selector));
        }

        // Taker data is byte-for-byte what the facility sends.
        assertEq(
            builder.takerData(address(facility), address(rcn), address(usdc), SHIP_A, id, ADVANCE_BPS),
            CashEthTraits.takerData(address(facility), address(rcn), address(usdc), SHIP_A, id, ADVANCE_BPS)
        );
    }

    function test_orderBuilder_rejectsFeeOutOfRange() public {
        vm.expectRevert(abi.encodeWithSelector(CashEthOrderBuilder.FeeOutOfRange.selector, uint32(1e7)));
        builder.buildBaseYieldOrder(makerA, address(usdc), address(tUsdt), 1e7, 1);
    }

    function test_orderHash_equalsAquaStrategyHash() public {
        (ISwapVM.Order memory order, bytes32 shipped) = _shipLender(makerA, _args(APR_A), SHIP_A, 9);
        (, bytes memory strategy) = builder.buildLenderOrder(makerA, address(rcn), address(usdc), _args(APR_A), 9);

        assertEq(router.hash(order), keccak256(strategy));
        assertEq(router.hash(order), shipped, "Aqua.ship returns keccak256(strategy)");
        assertEq(builder.strategyHash(order), shipped);
        (uint256 balUsdc,) = aqua.safeBalances(makerA, address(router), router.hash(order), address(usdc), address(rcn));
        assertEq(balUsdc, SHIP_A);

        // A different salt is a different strategy.
        (ISwapVM.Order memory other,) = builder.buildLenderOrder(makerA, address(rcn), address(usdc), _args(APR_A), 10);
        assertTrue(router.hash(other) != shipped);

        (ISwapVM.Order memory y, bytes memory yStrategy) =
            builder.buildBaseYieldOrder(makerA, address(usdc), address(tUsdt), FEE, 1);
        assertEq(router.hash(y), keccak256(yStrategy));
        assertEq(builder.strategyHash(y), keccak256(yStrategy));
    }

    // ------------------------------------------------------------------ end to end

    function test_endToEnd_openAndFund_realRouter_fillsAandB_skipsC() public {
        (ISwapVM.Order memory orderA, bytes32 hashA) = _shipLender(makerA, _args(APR_A), SHIP_A, 1);
        (ISwapVM.Order memory orderB, bytes32 hashB) = _shipLender(makerB, _args(APR_B), SHIP_B, 2);
        (, bytes32 hashC) = _shipLender(makerC, _args(APR_C), SHIP_C, 3);

        // C at 1300 bps is left out by the coordinator: A + B already cover the 6 USDC.
        ICreditFacility.Fill[] memory fills = new ICreditFacility.Fill[](2);
        fills[0] = _fill(orderA, SHIP_A, APR_A);
        fills[1] = _fill(orderB, SHIP_B, APR_B);

        vm.expectEmit(true, true, false, true, address(facility));
        emit ICreditFacility.PositionOpened(id, makerA, SHIP_A, APR_A);
        vm.expectEmit(true, true, false, true, address(facility));
        emit ICreditFacility.PositionOpened(id, makerB, SHIP_B, APR_B);
        vm.prank(coordinator);
        facility.openAndFund(id, fills, ADVANCE_BPS, LIMIT);

        // Positions, recorded through the router's onCreditFill callback with the order's own aprBps.
        ICreditFacility.Position memory pA = facility.position(id, makerA);
        assertEq(pA.principal, SHIP_A);
        assertEq(pA.aprBps, APR_A);
        assertEq(pA.start, uint64(block.timestamp));
        ICreditFacility.Position memory pB = facility.position(id, makerB);
        assertEq(pB.principal, SHIP_B);
        assertEq(pB.aprBps, APR_B);
        assertEq(facility.position(id, makerC).principal, 0);
        address[] memory m = facility.makers(id);
        assertEq(m.length, 2);
        assertEq(m[0], makerA);
        assertEq(m[1], makerB);

        // Tokens: USDC from the lenders' wallets to the facility, RCN from the facility to the lenders.
        assertEq(usdc.balanceOf(address(facility)), SHIP_A + SHIP_B);
        assertEq(usdc.balanceOf(makerA), WALLET - SHIP_A);
        assertEq(usdc.balanceOf(makerB), WALLET - SHIP_B);
        assertEq(usdc.balanceOf(makerC), WALLET, "C untouched");
        assertEq(rcn.balanceOf(makerA), SHIP_A);
        assertEq(rcn.balanceOf(makerB), SHIP_B);
        assertEq(rcn.balanceOf(makerC), 0);
        assertEq(rcn.balanceOf(address(facility)), 0);
        assertEq(rcn.balanceOf(address(router)), 0);
        assertEq(rcn.totalSupply(), SHIP_A + SHIP_B);

        // Aqua virtual balances follow the fills; C's strategy is untouched.
        (uint256 aUsdc, uint256 aRcn) = aqua.safeBalances(makerA, address(router), hashA, address(usdc), address(rcn));
        assertEq(aUsdc, 0);
        assertEq(aRcn, SHIP_A);
        (uint256 bUsdc, uint256 bRcn) = aqua.safeBalances(makerB, address(router), hashB, address(usdc), address(rcn));
        assertEq(bUsdc, 0);
        assertEq(bRcn, SHIP_B);
        (uint256 cUsdc, uint256 cRcn) = aqua.safeBalances(makerC, address(router), hashC, address(usdc), address(rcn));
        assertEq(cUsdc, SHIP_C);
        assertEq(cRcn, 0);

        // Router exposure and facility / registry state.
        assertEq(router.exposure(makerA, buyer), SHIP_A);
        assertEq(router.exposure(makerB, buyer), SHIP_B);
        assertEq(router.exposure(makerC, buyer), 0);
        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Financed));
        ICreditFacility.FacilityInfo memory info = facility.facilityInfo(id);
        assertEq(info.funded, SHIP_A + SHIP_B);
        assertEq(info.status, facility.STATUS_ACTIVE());
        assertEq(MockHSS(HSS).n(), 2, "overdue and default checks scheduled");
    }

    function test_endToEnd_revertsWhenIdNotConfirmed() public {
        (ISwapVM.Order memory orderA,) = _shipLender(makerA, _args(APR_A), 2 * SHIP_A, 1);
        ICreditFacility.Fill[] memory fills = new ICreditFacility.Fill[](1);
        fills[0] = _fill(orderA, SHIP_A, APR_A);

        // Unknown id: the facility refuses before touching the router.
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.NOT_CONFIRMED.selector);
        facility.openAndFund(keccak256("unknown"), fills, ADVANCE_BPS, LIMIT);

        // Fund once; the receivable is now Financed and cannot be funded again.
        vm.prank(coordinator);
        facility.openAndFund(id, fills, ADVANCE_BPS, LIMIT);
        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Financed));
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.NOT_CONFIRMED.selector);
        facility.openAndFund(id, fills, ADVANCE_BPS, LIMIT);

        // The opcode itself reads the live registry state: the Financed id no longer quotes.
        bytes memory td = builder.takerData(address(facility), address(rcn), address(usdc), SHIP_A, id, ADVANCE_BPS);
        vm.prank(address(facility));
        vm.expectRevert(abi.encodeWithSelector(ReceivableCredit.ReceivableNotConfirmed.selector, id));
        router.quote(orderA, SHIP_A, td);

        assertEq(rcn.totalSupply(), SHIP_A);
        assertEq(usdc.balanceOf(address(facility)), SHIP_A);
    }

    function test_endToEnd_revertsWhenTakerIsNotFacility() public {
        (ISwapVM.Order memory orderA, bytes32 hashA) = _shipLender(makerA, _args(APR_A), SHIP_A, 1);
        bytes memory td = builder.takerData(address(facility), address(rcn), address(usdc), SHIP_A, id, ADVANCE_BPS);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ReceivableCredit.NotFacilityTaker.selector, stranger));
        router.swap(orderA, SHIP_A, td);

        // A quote from anyone but the facility is refused the same way.
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ReceivableCredit.NotFacilityTaker.selector, stranger));
        router.quote(orderA, SHIP_A, td);

        assertEq(usdc.balanceOf(makerA), WALLET);
        (uint256 aUsdc,) = aqua.safeBalances(makerA, address(router), hashA, address(usdc), address(rcn));
        assertEq(aUsdc, SHIP_A);
        assertEq(router.exposure(makerA, buyer), 0);
    }

    function test_endToEnd_skipsLenderNotFundingSeller() public {
        (ISwapVM.Order memory orderA,) = _shipLender(makerA, _args(APR_A), SHIP_A, 1);
        (ISwapVM.Order memory orderB,) = _shipLender(makerB, _args(APR_B), SHIP_B, 2);
        // D is a low-tier lender that only funds one specific other seller.
        ReceivableCredit.Args memory aD = _args(APR_D);
        aD.sellerSet = new address[](1);
        aD.sellerSet[0] = makeAddr("someOtherSeller");
        (ISwapVM.Order memory orderD, bytes32 hashD) = _shipLender(makerD, aD, SHIP_D, 4);

        ICreditFacility.Fill[] memory withD = new ICreditFacility.Fill[](2);
        withD[0] = _fill(orderA, SHIP_A, APR_A);
        withD[1] = _fill(orderD, SHIP_B, APR_D);
        vm.prank(coordinator);
        vm.expectRevert(ReceivableCredit.SELLER_NOT_FUNDED_BY_LENDER.selector);
        facility.openAndFund(id, withD, ADVANCE_BPS, LIMIT);

        // The whole funding rolled back, including A's fill.
        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Confirmed));
        assertEq(rcn.totalSupply(), 0);
        assertEq(usdc.balanceOf(makerA), WALLET);
        assertEq(usdc.balanceOf(makerD), WALLET);
        assertEq(router.exposure(makerA, buyer), 0);

        // Without D the same receivable funds through A and B.
        ICreditFacility.Fill[] memory fills = new ICreditFacility.Fill[](2);
        fills[0] = _fill(orderA, SHIP_A, APR_A);
        fills[1] = _fill(orderB, SHIP_B, APR_B);
        vm.prank(coordinator);
        facility.openAndFund(id, fills, ADVANCE_BPS, LIMIT);

        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Financed));
        assertEq(usdc.balanceOf(address(facility)), SHIP_A + SHIP_B);
        assertEq(rcn.balanceOf(makerD), 0);
        assertEq(usdc.balanceOf(makerD), WALLET);
        (uint256 dUsdc,) = aqua.safeBalances(makerD, address(router), hashD, address(usdc), address(rcn));
        assertEq(dUsdc, SHIP_D);
    }

    // External wrapper: ReceivableCredit.build is internal.
    function buildCredit(ReceivableCredit.Args memory a) external pure returns (bytes memory) {
        return ReceivableCredit.build(a);
    }
}
