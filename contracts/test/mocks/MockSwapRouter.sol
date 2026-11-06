// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ISwapVM } from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";
import { TakerTraits, TakerTraitsLib } from "@1inch/swap-vm/contracts/libs/TakerTraits.sol";
import { MockUSDC } from "./MockUSDC.sol";

/// @dev Minimal view of the facility callback (the real `ICreditFacility` arrives in Task 3.3).
interface IOnCreditFill {
    function onCreditFill(bytes32 id, address maker, uint256 usdcIn, uint16 aprBps) external;
}

/// @dev Stand-in for the Aqua SwapVM router on the facility's RCN -> USDC fills, at a 1:1 price.
///      Tokens come from the order exactly as the real router derives them: `order.traits.tokens(order.data)`
///      gives (tokenA, tokenB) and the taker's `isAToB` flag picks tokenIn (RCN) and tokenOut (USDC), so
///      orders must be built with `MakerTraitsLib.build`. `swap` pulls `amount` tokenIn from the caller to
///      `order.maker`, pays `amount` tokenOut from this contract's pre-funded balance to the caller, then
///      calls `onCreditFill(id, order.maker, amount, aprOf[order.maker])` on the caller.
contract MockSwapRouter {
    using SafeERC20 for IERC20;

    mapping(address => uint16) public aprOf;
    bool public failNext;
    uint16 public lastAdvanceBps;

    error MockSwapFailed();

    /// @notice APR (bps) reported to the facility for fills against `maker`'s order.
    function setAprBps(address maker, uint16 aprBps) external {
        aprOf[maker] = aprBps;
    }

    /// @notice Mints `amount` MockUSDC to this router's payout pool.
    function fund(address usdc, uint256 amount) external {
        MockUSDC(usdc).mint(address(this), amount);
    }

    /// @notice While set, every swap reverts `MockSwapFailed()`. A revert rolls back any state change, so the
    ///         flag stays set until `fail(false)`.
    function fail(bool value) external {
        failNext = value;
    }

    function swap(ISwapVM.Order calldata order, uint256 amount, bytes calldata takerData)
        external
        payable
        returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)
    {
        if (failNext) revert MockSwapFailed();

        (TakerTraits traits, bytes calldata tail) = TakerTraitsLib.parse(takerData);
        bytes calldata args = traits.instructionsArgs(tail);
        bytes32 id = bytes32(args[0:32]);
        lastAdvanceBps = uint16(bytes2(args[32:34]));

        (address tokenA, address tokenB) = order.traits.tokens(order.data);
        (address tokenIn, address tokenOut) = traits.isAToB() ? (tokenA, tokenB) : (tokenB, tokenA);

        IERC20(tokenIn).safeTransferFrom(msg.sender, order.maker, amount);
        IERC20(tokenOut).safeTransfer(msg.sender, amount);
        IOnCreditFill(msg.sender).onCreditFill(id, order.maker, amount, aprOf[order.maker]);

        return (amount, amount, keccak256(abi.encode(order)));
    }
}
