// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { Vm } from "forge-std/Vm.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20Errors } from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import { ISwapVM } from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/contracts/libs/MakerTraits.sol";
import { KYARegistry } from "../src/core/KYARegistry.sol";
import { IKYARegistry } from "../src/core/interfaces/IKYARegistry.sol";
import { ReceivableRegistry } from "../src/core/ReceivableRegistry.sol";
import { IReceivableRegistry } from "../src/core/interfaces/IReceivableRegistry.sol";
import { ReceivableCreditNote } from "../src/core/ReceivableCreditNote.sol";
import { IReceivableCreditNote } from "../src/core/interfaces/IReceivableCreditNote.sol";
import { CreditFacility } from "../src/core/CreditFacility.sol";
import { ICreditFacility } from "../src/core/interfaces/ICreditFacility.sol";
import { MockUSDC } from "./mocks/MockUSDC.sol";
import { MockSwapRouter } from "./mocks/MockSwapRouter.sol";
import { MockHSS } from "./mocks/MockHSS.sol";
import { MockHtsUsdc } from "./mocks/MockHtsUsdc.sol";
import { IHederaScheduleService } from "../src/hedera/IHederaScheduleService.sol";

/// @dev Shared deployment and helpers for the facility test suites (funding here, spend in CreditFacilitySpend.t.sol).
abstract contract CreditFacilityBase is Test {
    address internal constant HSS = address(0x16b);
    uint256 internal constant AMOUNT = 10_000_000;
    uint16 internal constant ADVANCE_BPS = 7500;
    uint256 internal constant LIMIT = 7_500_000;
    uint256 internal constant FILL_A = 4_000_000;
    uint256 internal constant FILL_B = 2_000_000;
    uint16 internal constant APR_A = 700;
    uint16 internal constant APR_B = 850;
    uint256 internal constant GAS = 400_000;
    /// @dev Ruling R17: the overdue check gets room for a nested `scheduleCall` when the default was skipped.
    uint256 internal constant GAS_NESTED = 1_800_000;
    /// @dev Ruling R5: a scheduled call runs at `expiry - 1 s`, so schedules sit 5 minutes past the threshold.
    uint256 internal constant SLACK = 5 minutes;

    uint8 internal constant STATUS_NONE = 0;
    uint8 internal constant STATUS_ACTIVE = 1;
    uint8 internal constant STATUS_FROZEN = 2;
    uint8 internal constant STATUS_CLOSED = 3;

    uint256 internal buyerPk = 0xB0B;
    uint256 internal sellerPk = 0x5E11E4;
    address internal buyer;
    address internal seller;

    address internal owner = makeAddr("owner");
    address internal coordinator = makeAddr("coordinator");
    address internal repaymentRouter = makeAddr("repaymentRouter");
    address internal aqua = makeAddr("aqua");
    address internal makerA = makeAddr("lenderA");
    address internal makerB = makeAddr("lenderB");
    address internal stranger = makeAddr("stranger");

    MockUSDC internal usdc;
    KYARegistry internal kya;
    ReceivableRegistry internal registry;
    ReceivableCreditNote internal rcn;
    MockSwapRouter internal swapRouter;
    MockHSS internal hss;
    CreditFacility internal facility;

    bytes32 internal id;
    uint64 internal dueDate;

    function setUp() public virtual {
        vm.warp(1_750_000_000);
        buyer = vm.addr(buyerPk);
        seller = vm.addr(sellerPk);

        usdc = new MockUSDC();
        kya = new KYARegistry(address(this), owner);
        registry = new ReceivableRegistry(IKYARegistry(address(kya)), address(usdc), owner);
        rcn = new ReceivableCreditNote(owner);
        swapRouter = new MockSwapRouter();
        vm.etch(HSS, address(new MockHSS()).code);
        hss = MockHSS(HSS);

        facility = new CreditFacility(
            IReceivableRegistry(address(registry)),
            IKYARegistry(address(kya)),
            IReceivableCreditNote(address(rcn)),
            address(usdc),
            coordinator,
            owner
        );

        vm.startPrank(owner);
        registry.wire(address(facility), repaymentRouter);
        kya.wire(repaymentRouter, address(facility));
        rcn.wire(address(facility), repaymentRouter, address(swapRouter), aqua);
        facility.wire(address(swapRouter), repaymentRouter);
        vm.stopPrank();

        // Ruling R6: deployed without value, funded with HBAR afterwards.
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(facility).call{ value: 1 ether }("");
        assertTrue(ok);
        assertEq(address(facility).balance, 1 ether);

        _kyaRegister(seller, keccak256("seller-co"), 1, 2);
        _kyaRegister(buyer, keccak256("buyer-co"), 2, 3);

        swapRouter.setAprBps(makerA, APR_A);
        swapRouter.setAprBps(makerB, APR_B);

        dueDate = uint64(block.timestamp + 30 days);
        id = _registerReceivable(keccak256("PO-1001"), dueDate);
    }

    // ------------------------------------------------------------------ helpers

    function _newFacility(address usdc_) internal returns (CreditFacility) {
        return new CreditFacility(
            IReceivableRegistry(address(registry)),
            IKYARegistry(address(kya)),
            IReceivableCreditNote(address(rcn)),
            usdc_,
            coordinator,
            owner
        );
    }

    function _fundBoth() internal {
        swapRouter.fund(address(usdc), FILL_A + FILL_B);
        vm.prank(coordinator);
        facility.openAndFund(id, _fillsBoth(), ADVANCE_BPS, LIMIT);
    }

    function _fillsBoth() internal view returns (ICreditFacility.Fill[] memory fills) {
        fills = new ICreditFacility.Fill[](2);
        fills[0] = ICreditFacility.Fill({ order: _order(makerA), amount: FILL_A, aprBps: APR_A });
        fills[1] = ICreditFacility.Fill({ order: _order(makerB), amount: FILL_B, aprBps: APR_B });
    }

    function _order(address maker) internal view returns (ISwapVM.Order memory) {
        (address tokenA, address tokenB) =
            address(rcn) < address(usdc) ? (address(rcn), address(usdc)) : (address(usdc), address(rcn));
        return MakerTraitsLib.build(
            MakerTraitsLib.Args({
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
                program: ""
            })
        );
    }

    function _assertPosition(address maker, uint256 principal, uint16 aprBps, uint64 start) internal view {
        ICreditFacility.Position memory p = facility.position(id, maker);
        assertEq(p.principal, principal);
        assertEq(p.aprBps, aprBps);
        assertEq(p.start, start);
        assertEq(p.paidPrincipal, 0);
        assertEq(p.paidFee, 0);
    }

    function _assertSchedule(address schedule, uint256 expiry, uint256 gasLimit, bytes memory callData)
        internal
        view
    {
        MockHSS.Scheduled memory s = hss.getSchedule(schedule);
        assertEq(s.scheduler, address(facility));
        assertEq(s.to, address(facility));
        assertEq(s.expirySecond, expiry);
        assertEq(s.gasLimit, gasLimit);
        assertEq(s.value, 0);
        assertEq(s.callData, callData);
        assertFalse(s.deleted);
        assertFalse(s.executed);
    }

    function _kyaRegister(address who, bytes32 group, uint8 role, uint8 lvl) internal {
        kya.register(
            who,
            IKYARegistry.Agent({
                uaidHash: keccak256(abi.encode(who)),
                ownerGroup: group,
                role: role,
                level: lvl,
                expiresAt: 0,
                revoked: false,
                mandateHash: bytes32(0)
            })
        );
    }

    function _registerReceivable(bytes32 buyerRef, uint64 due) internal returns (bytes32) {
        IReceivableRegistry.ReceivableConfirmation memory c = IReceivableRegistry.ReceivableConfirmation({
            seller: seller,
            buyer: buyer,
            currency: address(usdc),
            amount: AMOUNT,
            dueDate: due,
            buyerRef: buyerRef,
            detailsCommitment: keccak256("doc"),
            payTo: repaymentRouter,
            nonce: registry.nonces(buyer),
            deadline: uint64(block.timestamp + 1 hours)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, registry.hashConfirmation(c));
        bytes32 rid = registry.register(c, abi.encodePacked(r, s, v));
        assertEq(uint8(registry.state(rid)), uint8(IReceivableRegistry.State.Confirmed));
        return rid;
    }
}

contract CreditFacilityTest is CreditFacilityBase {
    // ------------------------------------------------------------------ openAndFund

    function test_openAndFund_fillsAandB_marksFinanced_andSchedules() public {
        swapRouter.fund(address(usdc), FILL_A + FILL_B);
        ICreditFacility.Fill[] memory fills = _fillsBoth();

        vm.prank(stranger);
        vm.expectRevert(ICreditFacility.NOT_COORDINATOR.selector);
        facility.openAndFund(id, fills, ADVANCE_BPS, LIMIT);

        address[] memory expectedMakers = new address[](2);
        expectedMakers[0] = makerA;
        expectedMakers[1] = makerB;

        vm.expectEmit(true, true, false, true, address(facility));
        emit ICreditFacility.PositionOpened(id, makerA, FILL_A, APR_A);
        vm.expectEmit(true, true, false, true, address(facility));
        emit ICreditFacility.PositionOpened(id, makerB, FILL_B, APR_B);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IReceivableRegistry.StateChanged(id, IReceivableRegistry.State.Confirmed, IReceivableRegistry.State.Financed);
        vm.expectEmit(true, false, false, true, address(facility));
        emit ICreditFacility.FacilityFunded(id, FILL_A + FILL_B, ADVANCE_BPS, expectedMakers);
        vm.expectEmit(true, false, false, true, address(facility));
        emit ICreditFacility.Scheduled(id, address(1), address(2));

        vm.prank(coordinator);
        facility.openAndFund(id, fills, ADVANCE_BPS, LIMIT);

        // Tokens: USDC from the router to the facility, RCN minted by the facility and delivered to the makers.
        assertEq(usdc.balanceOf(address(facility)), FILL_A + FILL_B);
        assertEq(usdc.balanceOf(address(swapRouter)), 0);
        assertEq(rcn.balanceOf(makerA), FILL_A);
        assertEq(rcn.balanceOf(makerB), FILL_B);
        assertEq(rcn.balanceOf(address(facility)), 0);
        assertEq(rcn.totalSupply(), FILL_A + FILL_B);
        assertEq(rcn.allowance(address(facility), address(swapRouter)), 0);
        assertEq(swapRouter.lastAdvanceBps(), ADVANCE_BPS);

        // Positions.
        _assertPosition(makerA, FILL_A, APR_A, uint64(block.timestamp));
        _assertPosition(makerB, FILL_B, APR_B, uint64(block.timestamp));
        address[] memory m = facility.makers(id);
        assertEq(m.length, 2);
        assertEq(m[0], makerA);
        assertEq(m[1], makerB);

        // Registry and facility state.
        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Financed));
        ICreditFacility.FacilityInfo memory info = facility.facilityInfo(id);
        assertEq(info.seller, seller);
        assertEq(info.buyer, buyer);
        assertEq(info.receivableAmount, AMOUNT);
        assertEq(info.dueDate, dueDate);
        assertEq(info.funded, FILL_A + FILL_B);
        assertEq(info.committed, 0);
        assertEq(info.reserved, 0);
        assertEq(info.status, STATUS_ACTIVE);
        assertEq(info.overdueSchedule, address(1));
        assertEq(info.defaultSchedule, address(2));
        assertEq(facility.available(id), FILL_A + FILL_B);

        // Schedules recorded by the HSS: self-calls, 400k gas, no value, R5 slack past each threshold.
        assertEq(hss.n(), 2);
        _assertSchedule(
            address(1), uint256(dueDate) + 7 days + SLACK, GAS, abi.encodeCall(ICreditFacility.markOverdue, (id))
        );
        _assertSchedule(
            address(2), uint256(dueDate) + 30 days + SLACK, GAS, abi.encodeCall(ICreditFacility.markDefaulted, (id))
        );
    }

    function test_openAndFund_revertsNotConfirmed() public {
        swapRouter.fund(address(usdc), 2 * (FILL_A + FILL_B));
        ICreditFacility.Fill[] memory fills = _fillsBoth();

        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.NOT_CONFIRMED.selector);
        facility.openAndFund(keccak256("unknown"), fills, ADVANCE_BPS, LIMIT);

        // A Financed receivable cannot be funded twice.
        vm.prank(coordinator);
        facility.openAndFund(id, fills, ADVANCE_BPS, LIMIT);
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.NOT_CONFIRMED.selector);
        facility.openAndFund(id, fills, ADVANCE_BPS, LIMIT);

        assertEq(rcn.totalSupply(), FILL_A + FILL_B);
        assertEq(facility.facilityInfo(id).funded, FILL_A + FILL_B);
    }

    function test_openAndFund_revertsNotCheapestFirst() public {
        swapRouter.fund(address(usdc), FILL_A + FILL_B);
        ICreditFacility.Fill[] memory ab = _fillsBoth();

        ICreditFacility.Fill[] memory ba = new ICreditFacility.Fill[](2);
        ba[0] = ab[1];
        ba[1] = ab[0];
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.NOT_CHEAPEST_FIRST.selector);
        facility.openAndFund(id, ba, ADVANCE_BPS, LIMIT);

        ICreditFacility.Fill[] memory empty = new ICreditFacility.Fill[](0);
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.NOT_CHEAPEST_FIRST.selector);
        facility.openAndFund(id, empty, ADVANCE_BPS, LIMIT);

        // Equal APRs are non-decreasing, so they are accepted (the router reports the same APR, Ruling R21).
        ICreditFacility.Fill[] memory equal = _fillsBoth();
        equal[1].aprBps = APR_A;
        swapRouter.setAprBps(makerB, APR_A);
        vm.prank(coordinator);
        facility.openAndFund(id, equal, ADVANCE_BPS, LIMIT);
        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Financed));
    }

    function test_openAndFund_revertsBorrowingBase_advance() public {
        swapRouter.fund(address(usdc), FILL_A + FILL_B);
        ICreditFacility.Fill[] memory fills = _fillsBoth();

        // 10e6 * 5999 / 10_000 = 5_999_000 < 6e6, even with an unlimited limit.
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.BORROWING_BASE_EXCEEDED.selector);
        facility.openAndFund(id, fills, 5999, type(uint256).max);

        // Exactly at the borrowing base passes.
        vm.prank(coordinator);
        facility.openAndFund(id, fills, 6000, type(uint256).max);
        assertEq(facility.facilityInfo(id).funded, FILL_A + FILL_B);
    }

    function test_openAndFund_revertsBorrowingBase_limit() public {
        swapRouter.fund(address(usdc), FILL_A + FILL_B);
        ICreditFacility.Fill[] memory fills = _fillsBoth();

        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.BORROWING_BASE_EXCEEDED.selector);
        facility.openAndFund(id, fills, ADVANCE_BPS, FILL_A + FILL_B - 1);

        vm.prank(coordinator);
        facility.openAndFund(id, fills, ADVANCE_BPS, FILL_A + FILL_B);
        assertEq(facility.facilityInfo(id).funded, FILL_A + FILL_B);
    }

    function test_openAndFund_atomic_whenSecondFillFails() public {
        // Enough USDC for fill A only: fill B's payout reverts inside the router.
        swapRouter.fund(address(usdc), FILL_A + FILL_B - 1_000_000);
        ICreditFacility.Fill[] memory fills = _fillsBoth();

        vm.prank(coordinator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, address(swapRouter), FILL_B - 1_000_000, FILL_B
            )
        );
        facility.openAndFund(id, fills, ADVANCE_BPS, LIMIT);

        assertEq(rcn.totalSupply(), 0);
        assertEq(rcn.balanceOf(makerA), 0);
        assertEq(rcn.balanceOf(makerB), 0);
        assertEq(usdc.balanceOf(address(facility)), 0);
        assertEq(usdc.balanceOf(address(swapRouter)), FILL_A + FILL_B - 1_000_000);
        _assertPosition(makerA, 0, 0, 0);
        _assertPosition(makerB, 0, 0, 0);
        assertEq(facility.makers(id).length, 0);
        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Confirmed));
        ICreditFacility.FacilityInfo memory info = facility.facilityInfo(id);
        assertEq(info.status, STATUS_NONE);
        assertEq(info.funded, 0);
        assertEq(hss.n(), 0);
    }

    // ------------------------------------------------------------------ onCreditFill

    function test_onCreditFill_revertsWithoutActiveId() public {
        vm.prank(address(swapRouter));
        vm.expectRevert(ICreditFacility.NOT_ACTIVE_ID.selector);
        facility.onCreditFill(id, makerA, FILL_A, APR_A);

        // The zero id never matches an unset activeId.
        vm.prank(address(swapRouter));
        vm.expectRevert(ICreditFacility.NOT_ACTIVE_ID.selector);
        facility.onCreditFill(bytes32(0), makerA, FILL_A, APR_A);

        // After a funding the transient id is cleared again.
        swapRouter.fund(address(usdc), FILL_A + FILL_B);
        vm.prank(coordinator);
        facility.openAndFund(id, _fillsBoth(), ADVANCE_BPS, LIMIT);
        vm.prank(address(swapRouter));
        vm.expectRevert(ICreditFacility.NOT_ACTIVE_ID.selector);
        facility.onCreditFill(id, makerA, 1, APR_A);

        _assertPosition(makerA, FILL_A, APR_A, uint64(block.timestamp));
        assertEq(facility.makers(id).length, 2);
    }

    function test_onCreditFill_onlySwapRouter() public {
        address[3] memory callers = [stranger, coordinator, repaymentRouter];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(ICreditFacility.NOT_SWAP_ROUTER.selector);
            facility.onCreditFill(id, makerA, FILL_A, APR_A);
        }
        _assertPosition(makerA, 0, 0, 0);
        assertEq(facility.makers(id).length, 0);
    }

    // ------------------------------------------------------------------ overdue / default

    function test_markOverdue_beforeGraceReverts_afterGraceWorks() public {
        vm.prank(stranger);
        vm.expectRevert(ICreditFacility.FACILITY_NOT_ACTIVE.selector);
        facility.markOverdue(id);

        _fundBoth();

        vm.warp(uint256(dueDate) + 7 days - 1);
        vm.prank(stranger);
        vm.expectRevert(ICreditFacility.NOT_DUE.selector);
        facility.markOverdue(id);

        vm.warp(uint256(dueDate) + 7 days);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IReceivableRegistry.StateChanged(id, IReceivableRegistry.State.Financed, IReceivableRegistry.State.Overdue);
        vm.expectEmit(true, false, false, true, address(facility));
        emit ICreditFacility.Overdue(id);
        vm.prank(stranger);
        facility.markOverdue(id);

        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Overdue));
        ICreditFacility.FacilityInfo memory info = facility.facilityInfo(id);
        assertEq(info.status, STATUS_FROZEN);
        // The default check was already scheduled at funding, so nothing new is scheduled.
        assertEq(info.defaultSchedule, address(2));
        assertEq(hss.n(), 2);
        (,, uint32 defaults) = kya.reputation(buyer);
        assertEq(defaults, 0);
    }

    function test_markDefaulted_recordsDefault() public {
        _fundBoth();

        vm.warp(uint256(dueDate) + 30 days - 1);
        vm.prank(stranger);
        vm.expectRevert(ICreditFacility.NOT_DUE.selector);
        facility.markDefaulted(id);

        // Straight from Financed (the overdue check was never run).
        vm.warp(uint256(dueDate) + 30 days);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IReceivableRegistry.StateChanged(
            id, IReceivableRegistry.State.Financed, IReceivableRegistry.State.Defaulted
        );
        vm.expectEmit(true, true, false, true, address(kya));
        emit IKYARegistry.DefaultRecorded(buyer, seller);
        vm.expectEmit(true, false, false, true, address(facility));
        emit ICreditFacility.Defaulted(id);
        vm.prank(stranger);
        facility.markDefaulted(id);

        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Defaulted));
        assertEq(facility.facilityInfo(id).status, STATUS_FROZEN);
        (uint32 onTime, uint32 late, uint32 defaults) = kya.reputation(buyer);
        assertEq(defaults, 1);
        assertEq(onTime, 0);
        assertEq(late, 0);
        (,, uint32 sellerDefaults) = kya.reputation(seller);
        assertEq(sellerDefaults, 0);
    }

    /// @dev The brief's "dueDate 100 days out" cannot schedule even the overdue check (dueDate + 7 days is past
    ///      the 62-day horizon), so the overdue-only case uses a 40-day receivable: overdue at day 47 is inside
    ///      the horizon, default at day 70 is not. The 100-day receivable schedules neither.
    function test_schedule_skippedBeyondHorizon() public {
        swapRouter.fund(address(usdc), 2 * (FILL_A + FILL_B));

        uint64 due100 = uint64(block.timestamp + 100 days);
        bytes32 id100 = _registerReceivable(keccak256("PO-100"), due100);
        vm.expectEmit(true, false, false, true, address(facility));
        emit ICreditFacility.Scheduled(id100, address(0), address(0));
        vm.prank(coordinator);
        facility.openAndFund(id100, _fillsBoth(), ADVANCE_BPS, LIMIT);
        assertEq(hss.n(), 0);
        assertEq(facility.facilityInfo(id100).overdueSchedule, address(0));
        assertEq(facility.facilityInfo(id100).defaultSchedule, address(0));

        uint64 due40 = uint64(block.timestamp + 40 days);
        bytes32 id40 = _registerReceivable(keccak256("PO-40"), due40);
        vm.expectEmit(true, false, false, true, address(facility));
        emit ICreditFacility.Scheduled(id40, address(1), address(0));
        vm.prank(coordinator);
        facility.openAndFund(id40, _fillsBoth(), ADVANCE_BPS, LIMIT);

        assertEq(hss.n(), 1);
        ICreditFacility.FacilityInfo memory info = facility.facilityInfo(id40);
        assertEq(info.overdueSchedule, address(1));
        assertEq(info.defaultSchedule, address(0));
        _assertSchedule(
            address(1), uint256(due40) + 7 days + SLACK, GAS_NESTED, abi.encodeCall(ICreditFacility.markOverdue, (id40))
        );

        // When the overdue check runs, the default check is inside the horizon and gets scheduled.
        vm.warp(uint256(due40) + 7 days);
        vm.expectEmit(true, false, false, true, address(facility));
        emit ICreditFacility.Scheduled(id40, address(1), address(2));
        vm.prank(stranger);
        facility.markOverdue(id40);

        assertEq(hss.n(), 2);
        info = facility.facilityInfo(id40);
        assertEq(info.overdueSchedule, address(1));
        assertEq(info.defaultSchedule, address(2));
        _assertSchedule(
            address(2), uint256(due40) + 30 days + SLACK, GAS, abi.encodeCall(ICreditFacility.markDefaulted, (id40))
        );
    }

    /// @dev Ruling R5: the network runs a scheduled call at `expiry - 1 s`; the 5-minute slack keeps that
    ///      execution past the permissionless thresholds. Uses the 40-day receivable so `fireAll` holds only
    ///      the overdue check, then only the default check that `markOverdue` scheduled.
    function test_markOverdue_viaMockHSS_fire() public {
        swapRouter.fund(address(usdc), FILL_A + FILL_B);
        uint64 due40 = uint64(block.timestamp + 40 days);
        bytes32 id40 = _registerReceivable(keccak256("PO-40"), due40);
        vm.prank(coordinator);
        facility.openAndFund(id40, _fillsBoth(), ADVANCE_BPS, LIMIT);
        assertEq(hss.n(), 1);

        vm.warp(hss.getSchedule(address(1)).expirySecond - 1);
        hss.fireAll();

        assertTrue(hss.getSchedule(address(1)).executed);
        assertEq(uint8(registry.state(id40)), uint8(IReceivableRegistry.State.Overdue));
        assertEq(facility.facilityInfo(id40).status, STATUS_FROZEN);
        assertEq(facility.facilityInfo(id40).defaultSchedule, address(2));
        assertFalse(hss.getSchedule(address(2)).executed);

        vm.warp(hss.getSchedule(address(2)).expirySecond - 1);
        hss.fireAll();

        assertTrue(hss.getSchedule(address(2)).executed);
        assertEq(uint8(registry.state(id40)), uint8(IReceivableRegistry.State.Defaulted));
        (,, uint32 defaults) = kya.reputation(buyer);
        assertEq(defaults, 1);
    }

    // ------------------------------------------------------------------ pause

    function test_pause_blocksOpenAndFund() public {
        swapRouter.fund(address(usdc), FILL_A + FILL_B);
        ICreditFacility.Fill[] memory fills = _fillsBoth();

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        facility.pause();

        vm.prank(owner);
        facility.pause();
        assertTrue(facility.paused());

        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.PAUSED.selector);
        facility.openAndFund(id, fills, ADVANCE_BPS, LIMIT);
        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Confirmed));

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        facility.unpause();

        vm.prank(owner);
        facility.unpause();
        assertFalse(facility.paused());

        vm.prank(coordinator);
        facility.openAndFund(id, fills, ADVANCE_BPS, LIMIT);
        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Financed));
    }

    // ------------------------------------------------------------------ fix round 1: schedules (R17, R18)

    function test_openAndFund_overdueGas_400k_whenBothScheduled() public {
        _fundBoth();
        assertEq(hss.n(), 2);
        assertEq(hss.getSchedule(address(1)).gasLimit, GAS);
        assertEq(hss.getSchedule(address(2)).gasLimit, GAS);
    }

    function test_openAndFund_overdueGas_1_8M_whenDefaultSkipped() public {
        swapRouter.fund(address(usdc), FILL_A + FILL_B);
        uint64 due40 = uint64(block.timestamp + 40 days);
        bytes32 id40 = _registerReceivable(keccak256("PO-40"), due40);
        vm.prank(coordinator);
        facility.openAndFund(id40, _fillsBoth(), ADVANCE_BPS, LIMIT);

        assertEq(hss.n(), 1);
        assertEq(facility.facilityInfo(id40).defaultSchedule, address(0));
        _assertSchedule(
            address(1), uint256(due40) + 7 days + SLACK, GAS_NESTED, abi.encodeCall(ICreditFacility.markOverdue, (id40))
        );
    }

    function test_openAndFund_revertsScheduleFailed() public {
        swapRouter.fund(address(usdc), FILL_A + FILL_B);
        hss.setScheduleResponseCode(21);

        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.SCHEDULE_FAILED.selector);
        facility.openAndFund(id, _fillsBoth(), ADVANCE_BPS, LIMIT);

        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Confirmed));
        assertEq(rcn.totalSupply(), 0);
        assertEq(usdc.balanceOf(address(swapRouter)), FILL_A + FILL_B);
        assertEq(facility.facilityInfo(id).status, STATUS_NONE);
        assertEq(facility.makers(id).length, 0);
        assertEq(hss.n(), 0);
    }

    function test_markOverdue_toleratesScheduleFailure() public {
        swapRouter.fund(address(usdc), 2 * (FILL_A + FILL_B));
        uint64 due40 = uint64(block.timestamp + 40 days);
        bytes32 idRefused = _registerReceivable(keccak256("PO-40a"), due40);
        bytes32 idReverted = _registerReceivable(keccak256("PO-40b"), due40);
        vm.startPrank(coordinator);
        facility.openAndFund(idRefused, _fillsBoth(), ADVANCE_BPS, LIMIT);
        facility.openAndFund(idReverted, _fillsBoth(), ADVANCE_BPS, LIMIT);
        vm.stopPrank();
        assertEq(hss.n(), 2);

        vm.warp(uint256(due40) + 7 days);

        // HSS refuses with a non-SUCCESS code: the overdue transition still happens.
        hss.setScheduleResponseCode(21);
        vm.expectEmit(true, false, false, true, address(facility));
        emit ICreditFacility.Overdue(idRefused);
        vm.expectEmit(true, false, false, true, address(facility));
        emit ICreditFacility.ScheduleSkipped(idRefused, 21);
        vm.prank(stranger);
        facility.markOverdue(idRefused);

        assertEq(uint8(registry.state(idRefused)), uint8(IReceivableRegistry.State.Overdue));
        assertEq(facility.facilityInfo(idRefused).status, STATUS_FROZEN);
        assertEq(facility.facilityInfo(idRefused).defaultSchedule, address(0));

        // The HSS call itself reverts (e.g. out of gas): skipped with code -1, still no revert.
        hss.setScheduleResponseCode(0);
        vm.mockCallRevert(HSS, abi.encodeWithSelector(IHederaScheduleService.scheduleCall.selector), "boom");
        vm.expectEmit(true, false, false, true, address(facility));
        emit ICreditFacility.ScheduleSkipped(idReverted, -1);
        vm.prank(stranger);
        facility.markOverdue(idReverted);
        vm.clearMockedCalls();

        assertEq(uint8(registry.state(idReverted)), uint8(IReceivableRegistry.State.Overdue));
        assertEq(facility.facilityInfo(idReverted).defaultSchedule, address(0));
        assertEq(hss.n(), 2);

        // The default check stays available permissionlessly.
        vm.warp(uint256(due40) + 30 days);
        facility.markDefaulted(idRefused);
        assertEq(uint8(registry.state(idRefused)), uint8(IReceivableRegistry.State.Defaulted));
    }

    function test_markOverdue_skipsPastDefaultExpiry() public {
        swapRouter.fund(address(usdc), FILL_A + FILL_B);
        uint64 due40 = uint64(block.timestamp + 40 days);
        bytes32 id40 = _registerReceivable(keccak256("PO-40"), due40);
        vm.prank(coordinator);
        facility.openAndFund(id40, _fillsBoth(), ADVANCE_BPS, LIMIT);
        assertEq(hss.n(), 1);

        // A late manual call at the default schedule's expiry: nothing to schedule any more.
        vm.warp(uint256(due40) + 30 days + SLACK);
        vm.recordLogs();
        vm.prank(stranger);
        facility.markOverdue(id40);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(facility)) continue;
            assertTrue(logs[i].topics[0] != ICreditFacility.Scheduled.selector);
            assertTrue(logs[i].topics[0] != ICreditFacility.ScheduleSkipped.selector);
        }
        assertEq(uint8(registry.state(id40)), uint8(IReceivableRegistry.State.Overdue));
        assertEq(facility.facilityInfo(id40).status, STATUS_FROZEN);
        assertEq(facility.facilityInfo(id40).defaultSchedule, address(0));
        assertEq(hss.n(), 1);

        facility.markDefaulted(id40);
        assertEq(uint8(registry.state(id40)), uint8(IReceivableRegistry.State.Defaulted));
    }

    // ------------------------------------------------------------------ fix round 1: fill reconciliation

    function test_openAndFund_revertsFillMismatch() public {
        swapRouter.fund(address(usdc), 2 * (FILL_A + FILL_B));
        ICreditFacility.Fill[] memory fills = _fillsBoth();

        // The router pays one unit short while reporting the full amount: only the USDC delta catches it.
        swapRouter.setPayAdjust(-1);
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.FILL_MISMATCH.selector);
        facility.openAndFund(id, fills, ADVANCE_BPS, LIMIT);

        // Paying extra is a mismatch too.
        swapRouter.setPayAdjust(1);
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.FILL_MISMATCH.selector);
        facility.openAndFund(id, fills, ADVANCE_BPS, LIMIT);

        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Confirmed));
        assertEq(rcn.totalSupply(), 0);
        assertEq(usdc.balanceOf(address(facility)), 0);
        assertEq(facility.makers(id).length, 0);

        swapRouter.setPayAdjust(0);
        vm.prank(coordinator);
        facility.openAndFund(id, fills, ADVANCE_BPS, LIMIT);
        assertEq(usdc.balanceOf(address(facility)), FILL_A + FILL_B);
    }

    function test_openAndFund_revertsFillMismatch_onCreditFillReport() public {
        swapRouter.fund(address(usdc), FILL_A + FILL_B);
        ICreditFacility.Fill[] memory fills = _fillsBoth();

        // Correct USDC, but the callback reports a different amount.
        swapRouter.setReportAdjust(-1);
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.FILL_MISMATCH.selector);
        facility.openAndFund(id, fills, ADVANCE_BPS, LIMIT);

        swapRouter.setReportAdjust(1);
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.FILL_MISMATCH.selector);
        facility.openAndFund(id, fills, ADVANCE_BPS, LIMIT);

        // Correct USDC and amount, but the callback credits a different maker than the order's.
        swapRouter.setReportAdjust(0);
        swapRouter.setReportedMaker(stranger);
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.FILL_MISMATCH.selector);
        facility.openAndFund(id, fills, ADVANCE_BPS, LIMIT);

        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Confirmed));
        assertEq(rcn.totalSupply(), 0);
        _assertPosition(stranger, 0, 0, 0);
        assertEq(facility.makers(id).length, 0);
    }

    function test_openAndFund_revertsBorrowingBase_advanceAbove10000() public {
        swapRouter.fund(address(usdc), FILL_A + FILL_B);

        // 6e6 is far below 10e6 * 10_001 / 10_000, but an advance above 100% is never allowed.
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.BORROWING_BASE_EXCEEDED.selector);
        facility.openAndFund(id, _fillsBoth(), 10_001, type(uint256).max);

        vm.prank(coordinator);
        facility.openAndFund(id, _fillsBoth(), 10_000, type(uint256).max);
        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Financed));
    }

    function test_openAndFund_revertsNotCheapestFirst_emptyFill() public {
        swapRouter.fund(address(usdc), FILL_A + FILL_B);

        ICreditFacility.Fill[] memory first = _fillsBoth();
        first[0].amount = 0;
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.NOT_CHEAPEST_FIRST.selector);
        facility.openAndFund(id, first, ADVANCE_BPS, LIMIT);

        ICreditFacility.Fill[] memory last = _fillsBoth();
        last[1].amount = 0;
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.NOT_CHEAPEST_FIRST.selector);
        facility.openAndFund(id, last, ADVANCE_BPS, LIMIT);

        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Confirmed));
        assertEq(rcn.totalSupply(), 0);
    }

    // ------------------------------------------------------------------ fix round 1: close, repayment, dispute

    function test_closeFacility_onlyRouter_sendsUndrawn_setsClosed_secondCloseReverts() public {
        swapRouter.fund(address(usdc), 3 * (FILL_A + FILL_B));
        bytes32 idFired = _registerReceivable(keccak256("PO-2"), dueDate);
        bytes32 idRefused = _registerReceivable(keccak256("PO-3"), dueDate);
        vm.startPrank(coordinator);
        facility.openAndFund(id, _fillsBoth(), ADVANCE_BPS, LIMIT);
        facility.openAndFund(idFired, _fillsBoth(), ADVANCE_BPS, LIMIT);
        facility.openAndFund(idRefused, _fillsBoth(), ADVANCE_BPS, LIMIT);
        vm.stopPrank();
        uint256 funded = FILL_A + FILL_B;

        address[2] memory notRouter = [stranger, coordinator];
        for (uint256 i; i < notRouter.length; ++i) {
            vm.prank(notRouter[i]);
            vm.expectRevert(ICreditFacility.NOT_REPAYMENT_ROUTER.selector);
            facility.closeFacility(id);
        }

        // Happy path: both pending schedules deleted, undrawn USDC to the seller.
        ICreditFacility.FacilityInfo memory info = facility.facilityInfo(id);
        vm.expectCall(HSS, abi.encodeCall(IHederaScheduleService.deleteSchedule, (info.overdueSchedule)));
        vm.expectCall(HSS, abi.encodeCall(IHederaScheduleService.deleteSchedule, (info.defaultSchedule)));
        vm.expectEmit(true, false, false, true, address(facility));
        emit ICreditFacility.FacilityClosed(id, funded);
        vm.prank(repaymentRouter);
        facility.closeFacility(id);

        assertEq(usdc.balanceOf(seller), funded);
        assertEq(usdc.balanceOf(address(facility)), 2 * funded);
        assertEq(facility.facilityInfo(id).status, STATUS_CLOSED);
        assertTrue(hss.getSchedule(info.overdueSchedule).deleted);
        assertTrue(hss.getSchedule(info.defaultSchedule).deleted);

        vm.prank(repaymentRouter);
        vm.expectRevert(ICreditFacility.FACILITY_NOT_ACTIVE.selector);
        facility.closeFacility(id);

        // A delete that reverts (the overdue schedule already executed) does not block the close.
        info = facility.facilityInfo(idFired);
        vm.warp(hss.getSchedule(info.overdueSchedule).expirySecond - 1);
        hss.fire(info.overdueSchedule);
        assertEq(uint8(registry.state(idFired)), uint8(IReceivableRegistry.State.Overdue));
        vm.expectCall(HSS, abi.encodeCall(IHederaScheduleService.deleteSchedule, (info.overdueSchedule)));
        vm.expectCall(HSS, abi.encodeCall(IHederaScheduleService.deleteSchedule, (info.defaultSchedule)));
        vm.prank(repaymentRouter);
        facility.closeFacility(idFired);
        assertEq(facility.facilityInfo(idFired).status, STATUS_CLOSED);
        assertTrue(hss.getSchedule(info.overdueSchedule).executed);
        assertTrue(hss.getSchedule(info.defaultSchedule).deleted);
        assertEq(usdc.balanceOf(seller), 2 * funded);

        // A delete refused with a non-SUCCESS code does not block the close either.
        hss.setDeleteResponseCode(21);
        info = facility.facilityInfo(idRefused);
        vm.expectCall(HSS, abi.encodeCall(IHederaScheduleService.deleteSchedule, (info.overdueSchedule)));
        vm.expectCall(HSS, abi.encodeCall(IHederaScheduleService.deleteSchedule, (info.defaultSchedule)));
        vm.prank(repaymentRouter);
        facility.closeFacility(idRefused);
        assertEq(facility.facilityInfo(idRefused).status, STATUS_CLOSED);
        assertFalse(hss.getSchedule(info.overdueSchedule).deleted);
        assertFalse(hss.getSchedule(info.defaultSchedule).deleted);
        assertEq(usdc.balanceOf(seller), 3 * funded);
        assertEq(usdc.balanceOf(address(facility)), 0);
    }

    function test_available_zeroOnceClosed() public {
        _fundBoth();
        assertEq(facility.available(id), FILL_A + FILL_B);

        vm.prank(repaymentRouter);
        facility.closeFacility(id);

        assertEq(facility.available(id), 0);
        ICreditFacility.FacilityInfo memory info = facility.facilityInfo(id);
        assertEq(info.funded, FILL_A + FILL_B);
        assertEq(info.status, STATUS_CLOSED);
    }

    function test_recordRepayment_onlyRouter_accumulates() public {
        _fundBoth();

        address[3] memory notRouter = [stranger, coordinator, address(swapRouter)];
        for (uint256 i; i < notRouter.length; ++i) {
            vm.prank(notRouter[i]);
            vm.expectRevert(ICreditFacility.NOT_REPAYMENT_ROUTER.selector);
            facility.recordRepayment(id, makerA, 1, 1);
        }

        vm.startPrank(repaymentRouter);
        facility.recordRepayment(id, makerA, 1_000_000, 5_000);
        facility.recordRepayment(id, makerA, 3_000_000, 18_013);
        facility.recordRepayment(id, makerB, 2_000_000, 13_972);
        vm.stopPrank();

        ICreditFacility.Position memory a = facility.position(id, makerA);
        assertEq(a.principal, FILL_A);
        assertEq(a.aprBps, APR_A);
        assertEq(a.paidPrincipal, 4_000_000);
        assertEq(a.paidFee, 23_013);
        ICreditFacility.Position memory b = facility.position(id, makerB);
        assertEq(b.principal, FILL_B);
        assertEq(b.paidPrincipal, 2_000_000);
        assertEq(b.paidFee, 13_972);
    }

    function test_flagDispute_partiesOnly_freezes() public {
        vm.prank(seller);
        vm.expectRevert(ICreditFacility.FACILITY_NOT_ACTIVE.selector);
        facility.flagDispute(id);

        _fundBoth();

        address[3] memory outsiders = [stranger, repaymentRouter, makerA];
        for (uint256 i; i < outsiders.length; ++i) {
            vm.prank(outsiders[i]);
            vm.expectRevert(ICreditFacility.NOT_PARTY.selector);
            facility.flagDispute(id);
        }
        assertEq(facility.facilityInfo(id).status, STATUS_ACTIVE);

        address[3] memory parties = [seller, buyer, coordinator];
        for (uint256 i; i < parties.length; ++i) {
            uint256 snap = vm.snapshotState();
            vm.expectEmit(true, false, false, true, address(facility));
            emit ICreditFacility.Disputed(id);
            vm.prank(parties[i]);
            facility.flagDispute(id);
            assertEq(facility.facilityInfo(id).status, STATUS_FROZEN);
            assertTrue(vm.revertToState(snap));
        }
        // Registry state is untouched by a dispute.
        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Financed));
    }

    // ------------------------------------------------------------------ fix round 1: wiring, construction

    function test_wire_once_and_nonZero() public {
        CreditFacility fresh = _newFacility(address(usdc));

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        fresh.wire(address(swapRouter), repaymentRouter);

        vm.startPrank(owner);
        vm.expectRevert(ICreditFacility.ZERO_ADDRESS.selector);
        fresh.wire(address(0), repaymentRouter);
        vm.expectRevert(ICreditFacility.ZERO_ADDRESS.selector);
        fresh.wire(address(swapRouter), address(0));

        fresh.wire(address(swapRouter), repaymentRouter);
        assertEq(fresh.swapRouter(), address(swapRouter));
        assertEq(fresh.repaymentRouter(), repaymentRouter);

        vm.expectRevert(ICreditFacility.ALREADY_WIRED.selector);
        fresh.wire(stranger, stranger);
        vm.stopPrank();
        assertEq(fresh.swapRouter(), address(swapRouter));
        assertEq(fresh.repaymentRouter(), repaymentRouter);
    }

    function test_constructor_revertsAssociationFailed() public {
        MockHtsUsdc hts = new MockHtsUsdc();

        hts.setAssociateResponseCode(21);
        vm.expectRevert(abi.encodeWithSelector(ICreditFacility.ASSOCIATION_FAILED.selector, 21));
        _newFacility(address(hts));

        // TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT is accepted.
        hts.setAssociateResponseCode(194);
        _newFacility(address(hts));

        hts.setAssociateResponseCode(22);
        CreditFacility ok = _newFacility(address(hts));
        assertTrue(hts.associated(address(ok)));
        assertEq(ok.USDC(), address(hts));
        assertEq(ok.COORDINATOR(), coordinator);
        assertEq(ok.owner(), owner);
    }
}
