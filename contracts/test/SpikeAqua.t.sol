// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { AquaRouter } from "@1inch/aqua/contracts/AquaRouter.sol";
import { AquaSwapVMRouter } from "@1inch/swap-vm/contracts/routers/AquaSwapVMRouter.sol";
import { ISwapVM } from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/contracts/libs/TakerTraits.sol";

import { SpikeOrderBuilder } from "../src/spikes/SpikeOrderBuilder.sol";
import { SpikeTaker } from "../src/spikes/SpikeTaker.sol";
import { SpikeTokenB } from "../src/spikes/SpikeTokenB.sol";
import { MockHtsUsdc } from "./mocks/MockHtsUsdc.sol";

/// @notice Spike S1 locally: lender ships a 1 USDC / 1 TOKENB XYC strategy into the official Aqua
///         registry, SpikeTaker fills 0.1 TOKENB -> USDC through the unmodified AquaSwapVMRouter.
contract SpikeAquaTest is Test {
    address internal constant USDC_FACADE = 0x0000000000000000000000000000000000068cDa;
    address internal constant WHBAR = 0xb1F616b8134F602c3Bb465fB5b5e6565cCAd37Ed;
    uint256 internal constant SHIP_AMOUNT = 1_000_000; // 1 unit of each token (6 decimals)
    uint256 internal constant FILL_AMOUNT = 100_000; // 0.1 TOKENB in
    uint256 internal constant EXPECTED_OUT = 90_909; // floor(0.1e6 * 1e6 / 1.1e6)

    AquaRouter internal aqua;
    AquaSwapVMRouter internal router;
    MockHtsUsdc internal usdc;
    SpikeTokenB internal tokenB;
    SpikeOrderBuilder internal builder;
    SpikeTaker internal taker;
    address internal lender = makeAddr("lenderA");

    function setUp() public {
        aqua = new AquaRouter(address(this));
        router = new AquaSwapVMRouter(address(aqua), WHBAR, address(this), "CashETH SwapVM", "1.0.0");
        deployCodeTo("MockHtsUsdc.sol:MockHtsUsdc", USDC_FACADE);
        usdc = MockHtsUsdc(USDC_FACADE);
        tokenB = new SpikeTokenB();
        builder = new SpikeOrderBuilder();
        taker = new SpikeTaker(ISwapVM(address(router)), address(usdc), tokenB);

        vm.prank(lender);
        usdc.associate();
        usdc.mint(lender, 4 * SHIP_AMOUNT);
        tokenB.mint(lender, SHIP_AMOUNT);
        tokenB.mint(address(taker), FILL_AMOUNT);

        vm.startPrank(lender);
        usdc.approve(address(aqua), type(uint256).max);
        tokenB.approve(address(aqua), type(uint256).max);
        vm.stopPrank();
    }

    function _ship() internal returns (ISwapVM.Order memory order, bytes32 strategyHash) {
        bytes memory strategy;
        (order, strategy) = builder.buildXycOrder(lender, address(tokenB), address(usdc));
        address[] memory tokens = new address[](2);
        (tokens[0], tokens[1]) = (address(usdc), address(tokenB));
        uint256[] memory amounts = new uint256[](2);
        (amounts[0], amounts[1]) = (SHIP_AMOUNT, SHIP_AMOUNT);
        vm.prank(lender);
        strategyHash = aqua.ship(address(router), strategy, tokens, amounts);
    }

    function _isAToB() internal view returns (bool) {
        // tokenIn is TOKENB; tokenA is the lower address.
        return address(tokenB) < address(usdc);
    }

    function test_TakerAssociatesWithUsdcInConstructor() public view {
        assertTrue(usdc.associated(address(taker)));
    }

    function test_TakerConstructorRevertsWhenAssociationFails() public {
        usdc.setAssociateResponseCode(194); // TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT
        vm.expectRevert(abi.encodeWithSelector(SpikeTaker.UsdcAssociationFailed.selector, 194));
        new SpikeTaker(ISwapVM(address(router)), address(usdc), tokenB);
    }

    function test_OrderIsAquaXycWithSortedTokensAndHashMatchesStrategy() public {
        (ISwapVM.Order memory order, bytes32 strategyHash) = _ship();
        (address lo, address hi) = address(usdc) < address(tokenB)
            ? (address(usdc), address(tokenB))
            : (address(tokenB), address(usdc));
        assertEq(order.maker, lender);
        assertEq(router.hash(order), strategyHash);
        assertEq(order.data.length, 40 + 2, "tokenA || tokenB || XYCSwap instruction");
        assertEq(bytes20(this.slice(order.data, 0, 20)), bytes20(lo));
        assertEq(bytes20(this.slice(order.data, 20, 40)), bytes20(hi));
        (uint256 balUsdc, uint256 balB) =
            aqua.safeBalances(lender, address(router), strategyHash, address(usdc), address(tokenB));
        assertEq(balUsdc, SHIP_AMOUNT);
        assertEq(balB, SHIP_AMOUNT);
    }

    function test_QuoteFromTakerReturnsXycAmountOut() public {
        (ISwapVM.Order memory order, bytes32 strategyHash) = _ship();
        bytes memory takerData = builder.takerData(address(taker), true, _isAToB(), 0);
        vm.prank(address(taker));
        (uint256 amountIn, uint256 amountOut, bytes32 orderHash) = router.quote(order, FILL_AMOUNT, takerData);
        assertEq(amountIn, FILL_AMOUNT);
        assertEq(amountOut, EXPECTED_OUT);
        assertEq(orderHash, strategyHash);
    }

    function test_FillMovesUsdcFromLenderToTakerAndTokenBToLender() public {
        (ISwapVM.Order memory order, bytes32 strategyHash) = _ship();
        bytes memory takerData = builder.takerData(address(taker), true, _isAToB(), EXPECTED_OUT);

        uint256 lenderUsdcBefore = usdc.balanceOf(lender);
        (uint256 amountIn, uint256 amountOut, bytes32 orderHash) = taker.fill(order, FILL_AMOUNT, takerData);

        assertEq(amountIn, FILL_AMOUNT);
        assertEq(amountOut, EXPECTED_OUT);
        assertEq(orderHash, strategyHash);
        assertEq(usdc.balanceOf(lender), lenderUsdcBefore - EXPECTED_OUT);
        assertEq(usdc.balanceOf(address(taker)), EXPECTED_OUT);
        assertEq(tokenB.balanceOf(lender), SHIP_AMOUNT + FILL_AMOUNT);
        assertEq(tokenB.balanceOf(address(taker)), 0);
        assertEq(tokenB.balanceOf(address(router)), 0);
        assertEq(tokenB.allowance(address(taker), address(router)), 0);
        (uint256 balUsdc, uint256 balB) =
            aqua.safeBalances(lender, address(router), strategyHash, address(usdc), address(tokenB));
        assertEq(balUsdc, SHIP_AMOUNT - EXPECTED_OUT);
        assertEq(balB, SHIP_AMOUNT + FILL_AMOUNT);
    }

    function test_FillRevertsBelowThreshold() public {
        (ISwapVM.Order memory order,) = _ship();
        bytes memory takerData = builder.takerData(address(taker), true, _isAToB(), EXPECTED_OUT + 1);
        vm.expectRevert(abi.encodeWithSelector(
            TakerTraitsLib.TakerTraitsInsufficientMinOutputAmount.selector, EXPECTED_OUT, EXPECTED_OUT + 1
        ));
        taker.fill(order, FILL_AMOUNT, takerData);
    }

    function test_FillIsOwnerOnly() public {
        (ISwapVM.Order memory order,) = _ship();
        bytes memory takerData = builder.takerData(address(taker), true, _isAToB(), 0);
        vm.prank(lender);
        vm.expectRevert(SpikeTaker.NotOwner.selector);
        taker.fill(order, FILL_AMOUNT, takerData);
    }

    function test_SweepReturnsUsdcToOwner() public {
        (ISwapVM.Order memory order,) = _ship();
        taker.fill(order, FILL_AMOUNT, builder.takerData(address(taker), true, _isAToB(), 0));
        usdc.associate();
        taker.sweep(usdc, address(this));
        assertEq(usdc.balanceOf(address(this)), EXPECTED_OUT);
        assertEq(usdc.balanceOf(address(taker)), 0);
    }

    function slice(bytes calldata data, uint256 from, uint256 to) external pure returns (bytes memory) {
        return data[from:to];
    }
}
