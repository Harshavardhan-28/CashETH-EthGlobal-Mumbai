// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { CashEthHello } from "../src/Hello.sol";

contract HelloTest is Test {
    function test_Deploys() public {
        CashEthHello hello = new CashEthHello();
        assertTrue(address(hello) != address(0));
    }
}
