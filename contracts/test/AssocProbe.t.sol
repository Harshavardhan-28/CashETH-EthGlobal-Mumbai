// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { IERC20Errors } from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import { AssocProbe } from "../src/spikes/AssocProbe.sol";
import { MockHtsUsdc } from "./mocks/MockHtsUsdc.sol";

/// @notice Spike S2 locally: the probe associates with the USDC facade in its constructor, pulls an
///         approved amount with `transferFrom` and pushes it back with `transfer`.
contract AssocProbeTest is Test {
    uint256 internal constant APPROVED = 1_000_000; // 1 USDC (6 decimals)
    uint256 internal constant MOVED = 500_000; // 0.5 USDC

    MockHtsUsdc internal usdc;
    AssocProbe internal probe;
    address internal operator = makeAddr("operator");

    function setUp() public {
        usdc = new MockHtsUsdc();
        vm.prank(operator);
        probe = new AssocProbe(address(usdc));

        vm.prank(operator);
        usdc.associate();
        usdc.mint(operator, APPROVED);
    }

    function test_ConstructorAssociatesProbe() public view {
        assertTrue(usdc.associated(address(probe)));
        assertTrue(probe.isAssociated());
        assertEq(probe.USDC(), address(usdc));
        assertEq(probe.OWNER(), operator);
    }

    function test_ConstructorAcceptsAlreadyAssociated() public {
        usdc.setAssociateResponseCode(194); // TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT
        AssocProbe again = new AssocProbe(address(usdc));
        assertEq(again.USDC(), address(usdc));
    }

    function test_ConstructorRevertsWhenAssociateFails() public {
        usdc.setAssociateResponseCode(167); // TOKEN_ID_REPEATED_IN_TOKEN_LIST, any non-success code
        vm.expectRevert(abi.encodeWithSelector(AssocProbe.AssociationFailed.selector, 167));
        new AssocProbe(address(usdc));
    }

    function test_PullThenPushMovesExactAmounts() public {
        vm.prank(operator);
        usdc.approve(address(probe), APPROVED);

        vm.prank(operator);
        probe.pull(operator, MOVED);
        assertEq(usdc.balanceOf(address(probe)), MOVED);
        assertEq(probe.balance(), MOVED);
        assertEq(usdc.balanceOf(operator), APPROVED - MOVED);
        assertEq(usdc.allowance(operator, address(probe)), APPROVED - MOVED);

        vm.prank(operator);
        probe.push(operator, MOVED);
        assertEq(usdc.balanceOf(address(probe)), 0);
        assertEq(probe.balance(), 0);
        assertEq(usdc.balanceOf(operator), APPROVED);
    }

    function test_PullRevertsWithoutAllowance() public {
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(probe), 0, MOVED)
        );
        probe.pull(operator, MOVED);
    }

    function test_OnlyOwnerCanPullOrPush() public {
        address stranger = makeAddr("stranger");
        vm.startPrank(stranger);
        vm.expectRevert(AssocProbe.NotOwner.selector);
        probe.pull(operator, MOVED);
        vm.expectRevert(AssocProbe.NotOwner.selector);
        probe.push(stranger, MOVED);
        vm.stopPrank();
    }
}
