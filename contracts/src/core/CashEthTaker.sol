// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ISwapVM } from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";
import { TakerTraits, TakerTraitsLib } from "@1inch/swap-vm/contracts/libs/TakerTraits.sol";

import { IHRC719 } from "../hedera/IHRC719.sol";

/// @title CashEthTaker
/// @notice The trader agent's taker contract (generalised from spike S1's `SpikeTaker`): holds the tokens it
///         sells, receives HTS USDC (it associates in its constructor), and fills any Aqua strategy on the
///         CashETH SwapVM router in either direction. The owner (the trader) funds it, calls `fill`, and
///         sweeps the proceeds back.
/// @dev `tokenIn` is derived exactly as `SwapVM` derives it: the order's token pair, flipped unless the taker
///      traits say A -> B. The router is approved for exactly the input amount (HTS allowances are exact):
///      `amount` for exact-in fills, the router's own quote for exact-out fills. The allowance is reset to
///      zero after the swap so nothing is left approved.
contract CashEthTaker is Ownable {
    using SafeERC20 for IERC20;

    /// @dev HTS response codes SUCCESS and TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT.
    uint256 private constant _HTS_SUCCESS = 22;
    uint256 private constant _HTS_ALREADY_ASSOCIATED = 194;

    ISwapVM public immutable ROUTER;
    address public immutable USDC;

    error UsdcAssociationFailed(uint256 responseCode);

    event Filled(
        bytes32 indexed orderHash, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut
    );

    constructor(ISwapVM router, address usdc, address owner_) Ownable(owner_) {
        ROUTER = router;
        USDC = usdc;
        uint256 rc = IHRC719(usdc).associate();
        require(rc == _HTS_SUCCESS || rc == _HTS_ALREADY_ASSOCIATED, UsdcAssociationFailed(rc));
    }

    /// @notice Approves the router for the input amount of `tokenIn` and swaps against `order`.
    /// @param order Aqua-mode SwapVM order (e.g. from `CashEthOrderBuilder.buildBaseYieldOrder`)
    /// @param amount Input amount for exact-in taker traits, output amount for exact-out
    /// @param takerData Packed taker traits and data (`taker` and `to` should be this contract)
    function fill(ISwapVM.Order calldata order, uint256 amount, bytes calldata takerData)
        external
        onlyOwner
        returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)
    {
        (TakerTraits traits,) = TakerTraitsLib.parse(takerData);
        (address tokenIn, address tokenOut) = order.traits.tokens(order.data);
        if (!traits.isAToB()) (tokenIn, tokenOut) = (tokenOut, tokenIn);

        uint256 approval = amount;
        if (!traits.isExactIn()) (approval,,) = ROUTER.quote(order, amount, takerData);

        IERC20(tokenIn).forceApprove(address(ROUTER), approval);
        (amountIn, amountOut, orderHash) = ROUTER.swap(order, amount, takerData);
        IERC20(tokenIn).forceApprove(address(ROUTER), 0);
        emit Filled(orderHash, tokenIn, tokenOut, amountIn, amountOut);
    }

    /// @notice Sends this contract's whole balance of `token` to `to`.
    function sweep(IERC20 token, address to) external onlyOwner {
        token.safeTransfer(to, token.balanceOf(address(this)));
    }
}
