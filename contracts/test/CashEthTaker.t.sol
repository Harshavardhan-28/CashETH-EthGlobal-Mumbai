// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { AquaRouter } from "@1inch/aqua/contracts/AquaRouter.sol";
import { ISwapVM } from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/contracts/libs/TakerTraits.sol";

import { CashEthSwapVMRouter } from "../src/aqua/CashEthSwapVMRouter.sol";
import { CashEthOrderBuilder } from "../src/aqua/CashEthOrderBuilder.sol";
import { CashEthTaker } from "../src/core/CashEthTaker.sol";
import { TestStablecoin } from "../src/core/TestStablecoin.sol";
import { MockHtsUsdc } from "./mocks/MockHtsUsdc.sol";

/// @notice Task 4.3: the trader's taker contract against a real base-yield strategy (Salt -> FeeFlatIn ->
///         XYCSwap) on the real CashETH SwapVM router, in both directions and both amount modes.
contract CashEthTakerTest is Test {
    address internal constant WETH = 0xb1F616b8134F602c3Bb465fB5b5e6565cCAd37Ed;

    uint256 internal constant POOL = 1_000_000_000; // 1,000 USDC / 1,000 tUSDT virtual
    uint32 internal constant FEE = 30_000; // 0.3% (FeeFlatIn denominates in 1e7)
    uint256 internal constant SWAP_IN = 10_000_000;
    uint256 internal constant SWAP_OUT = 9_871_580; // floor(9_970_000 * 1e9 / (1e9 + 9_970_000))

    address internal trader = makeAddr("trader");
    address internal lp = makeAddr("lp");

    AquaRouter internal aqua;
    MockHtsUsdc internal usdc;
    TestStablecoin internal tUsdt;
    CashEthSwapVMRouter internal router;
    CashEthOrderBuilder internal builder;
    CashEthTaker internal taker;

    ISwapVM.Order internal order;
    bytes32 internal strategyHash;

    function setUp() public {
        aqua = new AquaRouter(address(this));
        usdc = new MockHtsUsdc();
        tUsdt = new TestStablecoin(address(this));
        router = new CashEthSwapVMRouter(
            address(aqua),
            WETH,
            address(this),
            "CashETH SwapVM",
            "1.0.0",
            makeAddr("registry"),
            makeAddr("kya"),
            makeAddr("facility")
        );
        builder = new CashEthOrderBuilder();
        taker = new CashEthTaker(ISwapVM(address(router)), address(usdc), trader);

        // HTS stand-in: every USDC holder is associated (the router holds tokenIn between transferFrom and push).
        vm.prank(lp);
        usdc.associate();
        vm.prank(trader);
        usdc.associate();
        vm.prank(address(router));
        usdc.associate();

        usdc.mint(lp, POOL);
        tUsdt.mint(lp, POOL);
        vm.startPrank(lp);
        usdc.approve(address(aqua), type(uint256).max);
        tUsdt.approve(address(aqua), type(uint256).max);
        vm.stopPrank();

        bytes memory strategy;
        (order, strategy) = builder.buildBaseYieldOrder(lp, address(usdc), address(tUsdt), FEE, 1);
        address[] memory tokens = new address[](2);
        (tokens[0], tokens[1]) = (address(usdc), address(tUsdt));
        uint256[] memory amounts = new uint256[](2);
        (amounts[0], amounts[1]) = (POOL, POOL);
        vm.prank(lp);
        strategyHash = aqua.ship(address(router), strategy, tokens, amounts);
    }

    function _takerData(address tokenIn, bool exactIn, uint256 threshold) internal view returns (bytes memory) {
        // The builder orders the pair by address: tokenA is the lower one.
        address tokenA = address(usdc) < address(tUsdt) ? address(usdc) : address(tUsdt);
        return TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: address(taker),
                isExactIn: exactIn,
                shouldUnwrapWeth: false,
                isStrictThresholdAmount: false,
                isFirstTransferFromTaker: false,
                useTransferFromAndAquaPush: true,
                isAToB: tokenIn == tokenA,
                allowPartialFill: false,
                usePermit2: false,
                threshold: abi.encode(threshold),
                to: address(taker),
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
    }

    function test_constructor_associatesUsdcAndSetsOwner() public view {
        assertTrue(usdc.associated(address(taker)));
        assertEq(taker.owner(), trader);
        assertEq(address(taker.ROUTER()), address(router));
        assertEq(taker.USDC(), address(usdc));
    }

    function test_constructor_acceptsAlreadyAssociated() public {
        usdc.setAssociateResponseCode(194);
        new CashEthTaker(ISwapVM(address(router)), address(usdc), trader);
    }

    function test_constructor_revertsWhenAssociationFails() public {
        usdc.setAssociateResponseCode(184);
        vm.expectRevert(abi.encodeWithSelector(CashEthTaker.UsdcAssociationFailed.selector, 184));
        new CashEthTaker(ISwapVM(address(router)), address(usdc), trader);
    }

    function test_fill_exactIn_tUsdtToUsdc() public {
        tUsdt.mint(address(taker), SWAP_IN);
        vm.prank(trader);
        (uint256 amountIn, uint256 amountOut, bytes32 orderHash) =
            taker.fill(order, SWAP_IN, _takerData(address(tUsdt), true, SWAP_OUT));

        assertEq(orderHash, strategyHash);
        assertEq(amountIn, SWAP_IN);
        assertEq(amountOut, SWAP_OUT);
        assertEq(usdc.balanceOf(address(taker)), SWAP_OUT);
        assertEq(tUsdt.balanceOf(address(taker)), 0);
        assertEq(tUsdt.balanceOf(lp), POOL + SWAP_IN);
        assertEq(tUsdt.allowance(address(taker), address(router)), 0, "allowance reset");
    }

    function test_fill_exactIn_usdcToTusdt() public {
        usdc.mint(address(taker), SWAP_IN);
        vm.prank(trader);
        (uint256 amountIn, uint256 amountOut,) = taker.fill(order, SWAP_IN, _takerData(address(usdc), true, SWAP_OUT));

        assertEq(amountIn, SWAP_IN);
        assertEq(amountOut, SWAP_OUT, "symmetric pool, same output");
        assertEq(tUsdt.balanceOf(address(taker)), SWAP_OUT);
        assertEq(usdc.balanceOf(address(taker)), 0);
        assertEq(usdc.balanceOf(lp), POOL + SWAP_IN);
        assertEq(usdc.allowance(address(taker), address(router)), 0, "allowance reset");
    }

    function test_fill_exactOut_approvesQuotedInput() public {
        uint256 wantOut = 5_000_000;
        tUsdt.mint(address(taker), 2 * wantOut); // more than needed: only the quoted input may be spent
        vm.prank(trader);
        (uint256 quotedIn,,) = router.quote(order, wantOut, _takerData(address(tUsdt), false, type(uint256).max));

        vm.prank(trader);
        (uint256 amountIn, uint256 amountOut,) =
            taker.fill(order, wantOut, _takerData(address(tUsdt), false, type(uint256).max));

        assertEq(amountOut, wantOut);
        assertEq(amountIn, quotedIn);
        assertEq(usdc.balanceOf(address(taker)), wantOut);
        assertEq(tUsdt.balanceOf(address(taker)), 2 * wantOut - quotedIn);
        assertEq(tUsdt.allowance(address(taker), address(router)), 0);
    }

    function test_fill_emitsFilled() public {
        tUsdt.mint(address(taker), SWAP_IN);
        vm.expectEmit(address(taker));
        emit CashEthTaker.Filled(strategyHash, address(tUsdt), address(usdc), SWAP_IN, SWAP_OUT);
        vm.prank(trader);
        taker.fill(order, SWAP_IN, _takerData(address(tUsdt), true, 0));
    }

    function test_fill_revertsForNonOwner() public {
        bytes memory td = _takerData(address(tUsdt), true, 0);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        taker.fill(order, SWAP_IN, td);
    }

    function test_fill_revertsBelowThreshold() public {
        tUsdt.mint(address(taker), SWAP_IN);
        bytes memory td = _takerData(address(tUsdt), true, SWAP_OUT + 1);
        vm.prank(trader);
        vm.expectRevert(
            abi.encodeWithSelector(
                TakerTraitsLib.TakerTraitsInsufficientMinOutputAmount.selector, SWAP_OUT, SWAP_OUT + 1
            )
        );
        taker.fill(order, SWAP_IN, td);
    }

    function test_sweep_returnsWholeBalance() public {
        tUsdt.mint(address(taker), SWAP_IN);
        vm.prank(trader);
        taker.fill(order, SWAP_IN, _takerData(address(tUsdt), true, 0));

        vm.prank(trader);
        taker.sweep(usdc, trader);
        assertEq(usdc.balanceOf(trader), SWAP_OUT);
        assertEq(usdc.balanceOf(address(taker)), 0);
    }

    function test_sweep_revertsForNonOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        taker.sweep(usdc, address(this));
    }
}
