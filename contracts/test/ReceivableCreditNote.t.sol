// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ReceivableCreditNote } from "../src/core/ReceivableCreditNote.sol";
import { IReceivableCreditNote } from "../src/core/interfaces/IReceivableCreditNote.sol";

contract ReceivableCreditNoteTest is Test {
    address internal owner = makeAddr("owner");
    address internal facility = makeAddr("facility");
    address internal repaymentRouter = makeAddr("repaymentRouter");
    address internal swapRouter = makeAddr("swapRouter");
    address internal aqua = makeAddr("aqua");
    address internal lender = makeAddr("lender");
    address internal lender2 = makeAddr("lender2");

    ReceivableCreditNote internal rcn;

    function setUp() public {
        rcn = new ReceivableCreditNote(owner);
        vm.prank(owner);
        rcn.wire(facility, repaymentRouter, swapRouter, aqua);
    }

    function test_decimals_is6() public view {
        assertEq(rcn.decimals(), 6);
        assertEq(rcn.name(), "CashETH Receivable Credit Note");
        assertEq(rcn.symbol(), "RCN");
    }

    function test_wire_once_and_nonZero() public {
        ReceivableCreditNote fresh = new ReceivableCreditNote(owner);

        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, lender));
        fresh.wire(facility, repaymentRouter, swapRouter, aqua);

        vm.startPrank(owner);
        vm.expectRevert(IReceivableCreditNote.ZERO_ADDRESS.selector);
        fresh.wire(address(0), repaymentRouter, swapRouter, aqua);
        vm.expectRevert(IReceivableCreditNote.ZERO_ADDRESS.selector);
        fresh.wire(facility, address(0), swapRouter, aqua);
        vm.expectRevert(IReceivableCreditNote.ZERO_ADDRESS.selector);
        fresh.wire(facility, repaymentRouter, address(0), aqua);
        vm.expectRevert(IReceivableCreditNote.ZERO_ADDRESS.selector);
        fresh.wire(facility, repaymentRouter, swapRouter, address(0));

        fresh.wire(facility, repaymentRouter, swapRouter, aqua);
        assertEq(fresh.facility(), facility);
        assertEq(fresh.repaymentRouter(), repaymentRouter);
        assertEq(fresh.swapRouter(), swapRouter);
        assertEq(fresh.aqua(), aqua);
        assertTrue(fresh.isPeer(facility));
        assertTrue(fresh.isPeer(swapRouter));
        assertTrue(fresh.isPeer(aqua));
        assertFalse(fresh.isPeer(repaymentRouter));
        assertFalse(fresh.isPeer(lender));

        vm.expectRevert(IReceivableCreditNote.ALREADY_WIRED.selector);
        fresh.wire(lender, lender, lender, lender);
        vm.stopPrank();
        assertEq(fresh.facility(), facility);
    }

    function test_mint_onlyFacility() public {
        vm.prank(lender);
        vm.expectRevert(IReceivableCreditNote.NOT_FACILITY.selector);
        rcn.mint(lender, 1_000_000);

        vm.prank(repaymentRouter);
        vm.expectRevert(IReceivableCreditNote.NOT_FACILITY.selector);
        rcn.mint(lender, 1_000_000);

        vm.expectEmit(true, true, false, true, address(rcn));
        emit IERC20.Transfer(address(0), facility, 1_000_000);
        vm.prank(facility);
        rcn.mint(facility, 1_000_000);

        assertEq(rcn.balanceOf(facility), 1_000_000);
        assertEq(rcn.totalSupply(), 1_000_000);
    }

    function test_burn_onlyRouter_noAllowance() public {
        _mintTo(lender, 5_000_000);
        assertEq(rcn.allowance(lender, repaymentRouter), 0);

        vm.prank(facility);
        vm.expectRevert(IReceivableCreditNote.NOT_ROUTER.selector);
        rcn.burn(lender, 1_000_000);

        vm.prank(lender);
        vm.expectRevert(IReceivableCreditNote.NOT_ROUTER.selector);
        rcn.burn(lender, 1_000_000);

        vm.expectEmit(true, true, false, true, address(rcn));
        emit IERC20.Transfer(lender, address(0), 2_000_000);
        vm.prank(repaymentRouter);
        rcn.burn(lender, 2_000_000);

        assertEq(rcn.balanceOf(lender), 3_000_000);
        assertEq(rcn.totalSupply(), 3_000_000);
        assertEq(rcn.allowance(lender, repaymentRouter), 0);
    }

    function test_transfer_lenderToLenderReverts() public {
        _mintTo(lender, 5_000_000);

        vm.prank(lender);
        vm.expectRevert(IReceivableCreditNote.RCN_TRANSFER_RESTRICTED.selector);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        rcn.transfer(lender2, 1_000_000);

        // An approved non-peer spender cannot move it between lenders either.
        vm.prank(lender);
        rcn.approve(lender2, 1_000_000);
        vm.prank(lender2);
        vm.expectRevert(IReceivableCreditNote.RCN_TRANSFER_RESTRICTED.selector);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        rcn.transferFrom(lender, lender2, 1_000_000);

        // Nor can a peer acting as spender: only `from` and `to` count, not `msg.sender`.
        vm.prank(lender);
        rcn.approve(swapRouter, 1_000_000);
        vm.prank(swapRouter);
        vm.expectRevert(IReceivableCreditNote.RCN_TRANSFER_RESTRICTED.selector);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        rcn.transferFrom(lender, lender2, 1_000_000);

        assertEq(rcn.balanceOf(lender), 5_000_000);
        assertEq(rcn.balanceOf(lender2), 0);
    }

    function test_transfer_lenderToFacilityAllowed() public {
        _mintTo(lender, 5_000_000);

        vm.expectEmit(true, true, false, true, address(rcn));
        emit IERC20.Transfer(lender, facility, 2_000_000);
        vm.prank(lender);
        assertTrue(rcn.transfer(facility, 2_000_000));

        assertEq(rcn.balanceOf(lender), 3_000_000);
        assertEq(rcn.balanceOf(facility), 2_000_000);

        // ... and back out of the facility to a lender.
        vm.prank(facility);
        assertTrue(rcn.transfer(lender2, 500_000));
        assertEq(rcn.balanceOf(facility), 1_500_000);
        assertEq(rcn.balanceOf(lender2), 500_000);
    }

    /// @dev The Aqua fill path: the router pulls from the facility (taker), then Aqua's `push`
    ///      moves it from the router to the maker (lender).
    function test_transfer_viaSwapRouterAllowed() public {
        vm.startPrank(facility);
        rcn.mint(facility, 4_000_000);
        rcn.approve(swapRouter, 4_000_000);
        vm.stopPrank();

        vm.prank(swapRouter);
        assertTrue(rcn.transferFrom(facility, swapRouter, 4_000_000));
        assertEq(rcn.balanceOf(facility), 0);
        assertEq(rcn.balanceOf(swapRouter), 4_000_000);

        vm.prank(swapRouter);
        rcn.approve(aqua, 4_000_000);
        vm.expectEmit(true, true, false, true, address(rcn));
        emit IERC20.Transfer(swapRouter, lender, 4_000_000);
        vm.prank(aqua);
        assertTrue(rcn.transferFrom(swapRouter, lender, 4_000_000));

        assertEq(rcn.balanceOf(swapRouter), 0);
        assertEq(rcn.balanceOf(lender), 4_000_000);
        assertEq(rcn.totalSupply(), 4_000_000);

        // A lender may hand it back to the router or to Aqua.
        vm.prank(lender);
        assertTrue(rcn.transfer(swapRouter, 1_000_000));
        vm.prank(lender);
        assertTrue(rcn.transfer(aqua, 1_000_000));
        assertEq(rcn.balanceOf(lender), 2_000_000);
        assertEq(rcn.balanceOf(swapRouter), 1_000_000);
        assertEq(rcn.balanceOf(aqua), 1_000_000);
    }

    function _mintTo(address to, uint256 amount) internal {
        vm.prank(facility);
        rcn.mint(to, amount);
    }
}
