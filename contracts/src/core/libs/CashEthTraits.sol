// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { TakerTraitsLib } from "@1inch/swap-vm/contracts/libs/TakerTraits.sol";

/// @title CashEthTraits
/// @notice Taker traits and data the facility passes to the SwapVM router when it sells RCN for USDC
///         against a lender's Aqua order.
library CashEthTraits {
    /// @notice Instruction args carried to the maker program: the receivable id and the advance rate.
    /// @return 34 bytes: `id` (32) followed by `advanceBps` (2), big-endian.
    function takerArgs(bytes32 id, uint16 advanceBps) internal pure returns (bytes memory) {
        return abi.encodePacked(id, advanceBps);
    }

    /// @notice Exact-in RCN -> USDC taker data: the router pulls `amount` RCN from the facility
    ///         (transferFrom + Aqua push) and must deliver exactly `amount` USDC to the facility.
    function takerData(address facility, address rcn, address usdc, uint256 amount, bytes32 id, uint16 advanceBps)
        internal
        pure
        returns (bytes memory)
    {
        return TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: facility,
                isExactIn: true,
                shouldUnwrapWeth: false,
                isStrictThresholdAmount: true,
                isFirstTransferFromTaker: false,
                useTransferFromAndAquaPush: true,
                isAToB: rcn < usdc,
                allowPartialFill: false,
                usePermit2: false,
                threshold: abi.encode(amount),
                to: facility,
                deadline: 0,
                hasPreTransferInCallback: false,
                hasPreTransferOutCallback: false,
                preTransferInHookData: "",
                postTransferInHookData: "",
                preTransferOutHookData: "",
                postTransferOutHookData: "",
                preTransferInCallbackData: "",
                preTransferOutCallbackData: "",
                instructionsArgs: takerArgs(id, advanceBps),
                signature: ""
            })
        );
    }
}
