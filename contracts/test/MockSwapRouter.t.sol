// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { ISwapVM } from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/contracts/libs/MakerTraits.sol";
import { ReceivableCreditNote } from "../src/core/ReceivableCreditNote.sol";
import { CashEthTraits } from "../src/core/libs/CashEthTraits.sol";
import { MockUSDC } from "./mocks/MockUSDC.sol";
import { MockSwapRouter } from "./mocks/MockSwapRouter.sol";

/// @dev Stands in for the facility: holds RCN, approves the router, swaps, and records the callback.
contract FillTaker {
    ReceivableCreditNote internal immutable _RCN;
    bytes32 public lastId;
    address public lastMaker;
    uint256 public lastAmount;
    uint16 public lastAprBps;
    uint256 public fills;

    constructor(ReceivableCreditNote rcn) {
        _RCN = rcn;
    }

    function take(MockSwapRouter router, ISwapVM.Order calldata order, uint256 amount, bytes calldata takerData)
        external
        returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)
    {
        _RCN.approve(address(router), amount);
        return router.swap(order, amount, takerData);
    }

    function onCreditFill(bytes32 id, address maker, uint256 amount, uint16 aprBps) external {
        lastId = id;
        lastMaker = maker;
        lastAmount = amount;
        lastAprBps = aprBps;
        fills++;
    }
}

contract MockSwapRouterTest is Test {
    bytes32 internal constant ID = keccak256("receivable-1");
    uint16 internal constant ADVANCE_BPS = 8000;
    uint256 internal constant AMOUNT = 4_000_000;

    address internal owner = makeAddr("owner");
    address internal maker = makeAddr("lenderA");
    address internal repaymentRouter = makeAddr("repaymentRouter");
    address internal aqua = makeAddr("aqua");

    MockUSDC internal usdc;
    ReceivableCreditNote internal rcn;
    MockSwapRouter internal router;
    FillTaker internal taker;
    ISwapVM.Order internal order;

    function setUp() public {
        usdc = new MockUSDC();
        rcn = new ReceivableCreditNote(owner);
        router = new MockSwapRouter();
        taker = new FillTaker(rcn);
        vm.prank(owner);
        rcn.wire(address(taker), repaymentRouter, address(router), aqua);

        vm.prank(address(taker));
        rcn.mint(address(taker), AMOUNT);
        router.fund(address(usdc), 10_000_000);
        router.setAprBps(maker, 700);
        order = _order(maker, address(rcn), address(usdc));
    }

    function test_mockUsdc_hts_facade() public {
        assertEq(usdc.decimals(), 6);
        assertEq(usdc.associate(), 22);
        assertTrue(usdc.isAssociated());
        usdc.mint(maker, 5);
        assertEq(usdc.balanceOf(maker), 5);
    }

    function test_swap_movesTokens_andCallsOnCreditFill() public {
        bytes memory data = CashEthTraits.takerData(address(taker), address(rcn), address(usdc), AMOUNT, ID, ADVANCE_BPS);

        (uint256 amountIn, uint256 amountOut, bytes32 orderHash) = taker.take(router, order, AMOUNT, data);

        assertEq(amountIn, AMOUNT);
        assertEq(amountOut, AMOUNT);
        assertEq(orderHash, keccak256(abi.encode(order)));
        assertEq(rcn.balanceOf(address(taker)), 0);
        assertEq(rcn.balanceOf(maker), AMOUNT);
        assertEq(usdc.balanceOf(address(taker)), AMOUNT);
        assertEq(usdc.balanceOf(address(router)), 10_000_000 - AMOUNT);
        assertEq(taker.fills(), 1);
        assertEq(taker.lastId(), ID);
        assertEq(taker.lastMaker(), maker);
        assertEq(taker.lastAmount(), AMOUNT);
        assertEq(taker.lastAprBps(), 700);
        assertEq(router.lastAdvanceBps(), ADVANCE_BPS);
    }

    function test_fail_revertsSwap_untilCleared() public {
        bytes memory data = CashEthTraits.takerData(address(taker), address(rcn), address(usdc), AMOUNT, ID, ADVANCE_BPS);
        router.fail(true);

        vm.expectRevert(MockSwapRouter.MockSwapFailed.selector);
        taker.take(router, order, AMOUNT, data);
        assertEq(rcn.balanceOf(address(taker)), AMOUNT);
        assertEq(taker.fills(), 0);

        router.fail(false);
        taker.take(router, order, AMOUNT, data);
        assertEq(taker.fills(), 1);
    }

    function _order(address maker_, address tokenX, address tokenY) internal pure returns (ISwapVM.Order memory) {
        (address tokenA, address tokenB) = tokenX < tokenY ? (tokenX, tokenY) : (tokenY, tokenX);
        return MakerTraitsLib.build(
            MakerTraitsLib.Args({
                maker: maker_,
                receiver: address(0),
                tokenA: tokenA,
                tokenB: tokenB,
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
                program: ""
            })
        );
    }
}
