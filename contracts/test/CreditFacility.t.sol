// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
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

contract CreditFacilityTest is Test {
    address internal constant HSS = address(0x16b);
    uint256 internal constant AMOUNT = 10_000_000;
    uint16 internal constant ADVANCE_BPS = 7500;
    uint256 internal constant LIMIT = 7_500_000;
    uint256 internal constant FILL_A = 4_000_000;
    uint256 internal constant FILL_B = 2_000_000;
    uint16 internal constant APR_A = 700;
    uint16 internal constant APR_B = 850;
    uint256 internal constant GAS = 400_000;
    /// @dev Ruling R5: a scheduled call runs at `expiry - 1 s`, so schedules sit 5 minutes past the threshold.
    uint256 internal constant SLACK = 5 minutes;

    uint8 internal constant STATUS_NONE = 0;
    uint8 internal constant STATUS_ACTIVE = 1;
    uint8 internal constant STATUS_FROZEN = 2;

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

    function setUp() public {
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
        _assertSchedule(address(1), uint256(dueDate) + 7 days + SLACK, abi.encodeCall(ICreditFacility.markOverdue, (id)));
        _assertSchedule(
            address(2), uint256(dueDate) + 30 days + SLACK, abi.encodeCall(ICreditFacility.markDefaulted, (id))
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

        // Equal APRs are non-decreasing, so they are accepted.
        ICreditFacility.Fill[] memory equal = _fillsBoth();
        equal[1].aprBps = APR_A;
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
        _assertSchedule(address(1), uint256(due40) + 7 days + SLACK, abi.encodeCall(ICreditFacility.markOverdue, (id40)));

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
            address(2), uint256(due40) + 30 days + SLACK, abi.encodeCall(ICreditFacility.markDefaulted, (id40))
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

    // ------------------------------------------------------------------ helpers

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

    function _assertSchedule(address schedule, uint256 expiry, bytes memory callData) internal view {
        MockHSS.Scheduled memory s = hss.getSchedule(schedule);
        assertEq(s.scheduler, address(facility));
        assertEq(s.to, address(facility));
        assertEq(s.expirySecond, expiry);
        assertEq(s.gasLimit, GAS);
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
