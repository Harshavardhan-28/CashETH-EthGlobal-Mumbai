// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { TestStablecoin } from "../src/core/TestStablecoin.sol";

contract TestStablecoinTest is Test {
    address internal owner = makeAddr("owner");
    address internal lender = makeAddr("lender");
    TestStablecoin internal token;

    function setUp() public {
        token = new TestStablecoin(owner);
    }

    function test_metadata() public view {
        assertEq(token.name(), "CashETH Test USDT");
        assertEq(token.symbol(), "tUSDT");
        assertEq(token.decimals(), 6);
        assertEq(token.owner(), owner);
        assertEq(token.totalSupply(), 0);
    }

    function test_ownerMints() public {
        vm.prank(owner);
        token.mint(lender, 50_000_000);
        assertEq(token.balanceOf(lender), 50_000_000);
        assertEq(token.totalSupply(), 50_000_000);
    }

    function test_mint_revertsForNonOwner() public {
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, lender));
        token.mint(lender, 1);
    }

    function test_transfersAreUnrestricted() public {
        vm.prank(owner);
        token.mint(lender, 10);
        vm.prank(lender);
        assertTrue(token.transfer(address(0xBEEF), 4));
        assertEq(token.balanceOf(address(0xBEEF)), 4);
    }
}
