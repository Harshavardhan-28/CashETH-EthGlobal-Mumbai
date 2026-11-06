// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { AquaRouter } from "@1inch/aqua/contracts/AquaRouter.sol";
import { AquaSwapVMRouter } from "@1inch/swap-vm/contracts/routers/AquaSwapVMRouter.sol";

/// @notice Gate: the pinned 1inch Aqua and SwapVM sources compile and deploy under our profile.
contract DepsTest is Test {
    function test_AquaSwapVMRouterWiresToAqua() public {
        AquaRouter aqua = new AquaRouter(address(this));
        AquaSwapVMRouter router =
            new AquaSwapVMRouter(address(aqua), address(0xBEEF), address(this), "CashETH SwapVM", "1.0.0");
        assertEq(address(router.AQUA()), address(aqua));
    }
}
