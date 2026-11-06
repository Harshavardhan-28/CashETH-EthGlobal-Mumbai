// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ISwapVM } from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/contracts/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/contracts/libs/TakerTraits.sol";
import { XYCSwap } from "@1inch/swap-vm/contracts/instructions/XYCSwap.sol";

/// @title SpikeOrderBuilder
/// @notice Spike S1 helper: builds an Aqua-mode XYC order and taker data with the pinned SwapVM
///         libraries, so off-chain callers get the bytes via eth_call instead of re-encoding traits.
contract SpikeOrderBuilder {
    /// @notice Aqua-mode order whose program is a single `XYCSwap` (balances come from Aqua).
    /// @dev Tokens are sorted inside; `strategy = abi.encode(order)` so Aqua's strategyHash
    ///      (`keccak256(strategy)`) equals the router's `hash(order)` for Aqua orders.
    function buildXycOrder(address maker, address tokenA, address tokenB)
        external
        pure
        returns (ISwapVM.Order memory order, bytes memory strategy)
    {
        if (tokenA > tokenB) (tokenA, tokenB) = (tokenB, tokenA);
        order = MakerTraitsLib.build(MakerTraitsLib.Args({
            maker: maker,
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
            program: XYCSwap.build()
        }));
        strategy = abi.encode(order);
    }

    /// @notice Taker data for a taker contract that holds tokenIn: transferFrom + Aqua push,
    ///         maker-to-taker transfer first, no callbacks, output sent to `taker`.
    /// @param threshold Min amountOut (exactIn) or max amountIn (exactOut); 0 means none.
    function takerData(address taker, bool isExactIn, bool isAToB, uint256 threshold)
        external
        pure
        returns (bytes memory)
    {
        return TakerTraitsLib.build(TakerTraitsLib.Args({
            taker: taker,
            isExactIn: isExactIn,
            shouldUnwrapWeth: false,
            isStrictThresholdAmount: false,
            isFirstTransferFromTaker: false,
            useTransferFromAndAquaPush: true,
            isAToB: isAToB,
            allowPartialFill: false,
            usePermit2: false,
            threshold: threshold == 0 ? bytes("") : abi.encode(threshold),
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
        }));
    }
}
