// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { CreditFacilityBase } from "./CreditFacility.t.sol";
import { RepaymentRouter } from "../src/core/RepaymentRouter.sol";
import { ICreditFacility } from "../src/core/interfaces/ICreditFacility.sol";
import { IReceivableRegistry } from "../src/core/interfaces/IReceivableRegistry.sol";
import { IKYARegistry } from "../src/core/interfaces/IKYARegistry.sol";
import { IReceivableCreditNote } from "../src/core/interfaces/IReceivableCreditNote.sol";
import { IHederaScheduleService } from "../src/hedera/IHederaScheduleService.sol";
import { MockHtsUsdc } from "./mocks/MockHtsUsdc.sol";

/// @dev Facility funded through MockSwapRouter: A 4_000_000 @ 700 bps and B 2_000_000 @ 850 bps against a
///      10_000_000 receivable due in 30 days. Minimum-term fees: A 23_013, B 13_972.
contract RepaymentRouterTest is CreditFacilityBase {
    uint256 internal constant FEE_A = 23_013;
    uint256 internal constant FEE_B = 13_972;
    uint256 internal constant DUE_A = 4_023_013;
    uint256 internal constant DUE_B = 2_013_972;
    uint256 internal constant LENDERS_DUE = 6_036_985;
    uint256 internal constant FUNDED = 6_000_000;

    RepaymentRouter internal router;

    function _deployRepaymentRouter() internal override returns (address) {
        router = new RepaymentRouter(
            IReceivableRegistry(address(registry)),
            IKYARegistry(address(kya)),
            ICreditFacility(address(facility)),
            IReceivableCreditNote(address(rcn)),
            address(usdc)
        );
        return address(router);
    }

    uint256 internal constant BUYER_FLOAT = 100 * AMOUNT;

    /// @dev The buyer holds USDC and a standing approval up front, so `repay` is the only call a test's
    ///      event and call expectations see.
    function setUp() public override {
        super.setUp();
        usdc.mint(buyer, BUYER_FLOAT);
        vm.prank(buyer);
        usdc.approve(address(router), type(uint256).max);
    }

    // ------------------------------------------------------------------ helpers

    function _fund(bytes32 rid) internal {
        swapRouter.fund(address(usdc), FILL_A + FILL_B);
        vm.prank(coordinator);
        facility.openAndFund(rid, _fillsBoth(), ADVANCE_BPS, LIMIT);
    }

    /// @dev The buyer pays `amount` USDC through the router.
    function _pay(bytes32 rid, uint256 amount) internal {
        vm.prank(buyer);
        router.repay(rid, amount);
    }

    function _assertReputation(address who, uint32 onTime, uint32 late, uint32 defaults) internal view {
        (uint32 o, uint32 l, uint32 d) = kya.reputation(who);
        assertEq(o, onTime, "onTime");
        assertEq(l, late, "late");
        assertEq(d, defaults, "defaults");
    }

    function _assertPaid(address maker, uint256 paidPrincipal, uint256 paidFee) internal view {
        ICreditFacility.Position memory p = facility.position(id, maker);
        assertEq(p.paidPrincipal, paidPrincipal, "paidPrincipal");
        assertEq(p.paidFee, paidFee, "paidFee");
    }

    // ------------------------------------------------------------------ fee math

    function test_feeOf_minTerm_vectors() public view {
        uint64 t0 = uint64(block.timestamp);
        assertEq(router.MIN_TERM(), 30 days);

        // Minimum term: any elapsed time up to 30 days charges 30 days.
        assertEq(router.feeOf(FILL_A, APR_A, t0, t0), 23_013);
        assertEq(router.feeOf(FILL_A, APR_A, t0, t0 + 1 days), 23_013);
        assertEq(router.feeOf(FILL_A, APR_A, t0, t0 + 30 days), 23_013);
        assertEq(router.feeOf(FILL_B, APR_B, t0, t0), 13_972);
        assertEq(router.feeOf(FILL_B, APR_B, t0, t0 + 30 days), 13_972);
        // A timestamp before the start still charges the minimum term.
        assertEq(router.feeOf(FILL_A, APR_A, t0, t0 - 1), 23_013);

        // Past the minimum term the fee accrues on actual elapsed time.
        assertEq(router.feeOf(FILL_A, APR_A, t0, t0 + 60 days), 46_027);
        assertEq(router.feeOf(FILL_B, APR_B, t0, t0 + 60 days), 27_945);

        assertEq(router.feeOf(0, APR_A, t0, t0 + 60 days), 0);
        assertEq(router.feeOf(FILL_A, 0, t0, t0 + 60 days), 0);
    }

    // ------------------------------------------------------------------ repay

    function test_repay_full_10e6_paysLenders6036985_sellerRemainder() public {
        _fund(id);
        (uint256 pA, uint256 fA) = router.dueOf(id, makerA);
        (uint256 pB, uint256 fB) = router.dueOf(id, makerB);
        assertEq(pA, FILL_A);
        assertEq(fA, FEE_A);
        assertEq(pB, FILL_B);
        assertEq(fB, FEE_B);
        assertEq(router.lenderDue(id), LENDERS_DUE);

        vm.expectEmit(true, true, false, true, address(router));
        emit RepaymentRouter.LenderPaid(id, makerA, FILL_A, FEE_A);
        vm.expectEmit(true, true, false, true, address(router));
        emit RepaymentRouter.LenderPaid(id, makerB, FILL_B, FEE_B);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IReceivableRegistry.StateChanged(id, IReceivableRegistry.State.Financed, IReceivableRegistry.State.Repaid);
        vm.expectEmit(true, true, false, true, address(kya));
        emit IKYARegistry.RepaymentRecorded(buyer, seller, true);
        vm.expectEmit(true, false, false, true, address(facility));
        emit ICreditFacility.FacilityClosed(id, FUNDED);
        vm.expectEmit(true, true, false, true, address(router));
        emit RepaymentRouter.Repaid(id, buyer, AMOUNT, 6_036_985, 3_963_015);
        vm.prank(buyer);
        router.repay(id, AMOUNT);

        assertEq(usdc.balanceOf(makerA), 4_023_013);
        assertEq(usdc.balanceOf(makerB), 2_013_972);
        assertEq(usdc.balanceOf(makerA) + usdc.balanceOf(makerB), 6_036_985);
        // Buyer's remainder plus the facility's undrawn advance (nothing was spent).
        assertEq(usdc.balanceOf(seller), 3_963_015 + 6_000_000);
        assertEq(usdc.balanceOf(buyer), BUYER_FLOAT - AMOUNT);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(usdc.balanceOf(address(facility)), 0);

        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Repaid));
        assertEq(facility.facilityInfo(id).status, STATUS_CLOSED);
        assertEq(rcn.totalSupply(), 0);
        assertEq(rcn.balanceOf(makerA), 0);
        assertEq(rcn.balanceOf(makerB), 0);
        _assertPaid(makerA, FILL_A, FEE_A);
        _assertPaid(makerB, FILL_B, FEE_B);
        assertEq(router.lenderDue(id), 0);

        _assertReputation(buyer, 1, 0, 0);
        _assertReputation(seller, 1, 0, 0);
    }

    function test_repay_partial_lendersFirst_sellerZero() public {
        _fund(id);

        // Pro rata of total due: A 3e6 * 4_023_013 / 6_036_985 = 1_999_183 (floor), B takes the rest 1_000_817.
        // Within each share the fee goes first.
        vm.expectEmit(true, true, false, true, address(router));
        emit RepaymentRouter.LenderPaid(id, makerA, 1_976_170, FEE_A);
        vm.expectEmit(true, true, false, true, address(router));
        emit RepaymentRouter.LenderPaid(id, makerB, 986_845, FEE_B);
        vm.expectEmit(true, true, false, true, address(router));
        emit RepaymentRouter.Repaid(id, buyer, 3_000_000, 3_000_000, 0);
        _pay(id, 3_000_000);

        assertEq(usdc.balanceOf(makerA), 1_999_183);
        assertEq(usdc.balanceOf(makerB), 1_000_817);
        assertEq(usdc.balanceOf(seller), 0, "seller receives nothing while lenders are owed");
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(usdc.balanceOf(address(facility)), FUNDED, "facility stays open");

        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Financed));
        assertEq(facility.facilityInfo(id).status, STATUS_ACTIVE);
        _assertPaid(makerA, 1_976_170, FEE_A);
        _assertPaid(makerB, 986_845, FEE_B);
        assertEq(router.lenderDue(id), 3_036_985);
        (uint256 pA, uint256 fA) = router.dueOf(id, makerA);
        assertEq(pA, 2_023_830);
        assertEq(fA, 0);

        _assertReputation(buyer, 0, 0, 0);
        _assertReputation(seller, 0, 0, 0);
    }

    function test_repay_twoPartials_closeOnSecond() public {
        _fund(id);
        _pay(id, 3_000_000);
        assertEq(router.lenderDue(id), 3_036_985);

        // 35 days after funding (5 days past due): the fee now accrues on actual time, on the full principal.
        // A: 4e6 * 700 * 35d / 365d = 26_849 (3_836 more); B: 2e6 * 850 * 35d / 365d = 16_301 (2_329 more).
        vm.warp(uint256(dueDate) + 5 days);
        (uint256 pA, uint256 fA) = router.dueOf(id, makerA);
        (uint256 pB, uint256 fB) = router.dueOf(id, makerB);
        assertEq(pA, 2_023_830);
        assertEq(fA, 3_836);
        assertEq(pB, 1_013_155);
        assertEq(fB, 2_329);
        assertEq(router.lenderDue(id), 3_043_150);

        vm.expectEmit(true, true, false, true, address(router));
        emit RepaymentRouter.LenderPaid(id, makerA, 2_023_830, 3_836);
        vm.expectEmit(true, true, false, true, address(router));
        emit RepaymentRouter.LenderPaid(id, makerB, 1_013_155, 2_329);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IReceivableRegistry.StateChanged(id, IReceivableRegistry.State.Financed, IReceivableRegistry.State.Repaid);
        vm.expectEmit(true, true, false, true, address(router));
        emit RepaymentRouter.Repaid(id, buyer, 4_000_000, 3_043_150, 956_850);
        _pay(id, 4_000_000);

        assertEq(usdc.balanceOf(makerA), 1_999_183 + 2_027_666);
        assertEq(usdc.balanceOf(makerB), 1_000_817 + 1_015_484);
        assertEq(usdc.balanceOf(seller), 956_850 + FUNDED);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Repaid));
        assertEq(facility.facilityInfo(id).status, STATUS_CLOSED);
        assertEq(rcn.totalSupply(), 0);
        _assertPaid(makerA, FILL_A, 26_849);
        _assertPaid(makerB, FILL_B, 16_301);
        _assertReputation(buyer, 0, 1, 0);
        _assertReputation(seller, 1, 0, 0);
    }

    function test_repay_afterDefault_stillLendersFirst_stateRepaid() public {
        _fund(id);
        vm.warp(uint256(dueDate) + 30 days);
        vm.prank(stranger);
        facility.markDefaulted(id);
        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Defaulted));
        assertEq(facility.facilityInfo(id).status, STATUS_FROZEN);

        // 60 days elapsed since funding: A fee 46_027, B fee 27_945.
        assertEq(router.lenderDue(id), 6_073_972);

        vm.expectEmit(true, true, false, true, address(router));
        emit RepaymentRouter.LenderPaid(id, makerA, FILL_A, 46_027);
        vm.expectEmit(true, true, false, true, address(router));
        emit RepaymentRouter.LenderPaid(id, makerB, FILL_B, 27_945);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IReceivableRegistry.StateChanged(id, IReceivableRegistry.State.Defaulted, IReceivableRegistry.State.Repaid);
        vm.expectEmit(true, true, false, true, address(kya));
        emit IKYARegistry.RepaymentRecorded(buyer, seller, false);
        vm.expectEmit(true, true, false, true, address(router));
        emit RepaymentRouter.Repaid(id, buyer, AMOUNT, 6_073_972, 3_926_028);
        _pay(id, AMOUNT);

        assertEq(usdc.balanceOf(makerA), 4_046_027);
        assertEq(usdc.balanceOf(makerB), 2_027_945);
        assertEq(usdc.balanceOf(seller), 3_926_028 + FUNDED);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Repaid));
        assertEq(facility.facilityInfo(id).status, STATUS_CLOSED);
        assertEq(rcn.totalSupply(), 0);

        // Ruling R20: the default counts against both parties; the late repayment against the buyer.
        _assertReputation(buyer, 0, 1, 1);
        _assertReputation(seller, 1, 0, 1);
    }

    function test_repay_afterOverdue_paysLendersAndCloses() public {
        _fund(id);
        vm.warp(uint256(dueDate) + 7 days);
        facility.markOverdue(id);
        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Overdue));

        vm.expectEmit(true, false, false, true, address(registry));
        emit IReceivableRegistry.StateChanged(id, IReceivableRegistry.State.Overdue, IReceivableRegistry.State.Repaid);
        _pay(id, AMOUNT);

        uint256 lendersDue = router.feeOf(FILL_A, APR_A, uint64(dueDate - 30 days), uint64(block.timestamp))
            + router.feeOf(FILL_B, APR_B, uint64(dueDate - 30 days), uint64(block.timestamp)) + FUNDED;
        assertEq(usdc.balanceOf(makerA) + usdc.balanceOf(makerB), lendersDue);
        assertEq(usdc.balanceOf(seller), AMOUNT - lendersDue + FUNDED);
        assertEq(facility.facilityInfo(id).status, STATUS_CLOSED);
        _assertReputation(buyer, 0, 1, 0);
    }

    function test_repay_afterRepaid_allToSeller() public {
        _fund(id);
        _pay(id, AMOUNT);
        uint256 sellerBefore = usdc.balanceOf(seller);

        vm.expectCall(address(facility), abi.encodeWithSelector(ICreditFacility.recordRepayment.selector), 0);
        vm.expectCall(address(rcn), abi.encodeWithSelector(IReceivableCreditNote.burn.selector), 0);
        vm.expectEmit(true, true, false, true, address(router));
        emit RepaymentRouter.Repaid(id, buyer, 1_000, 0, 1_000);
        _pay(id, 1_000);

        assertEq(usdc.balanceOf(seller), sellerBefore + 1_000);
        assertEq(usdc.balanceOf(makerA), DUE_A);
        assertEq(usdc.balanceOf(makerB), DUE_B);
        assertEq(usdc.balanceOf(address(router)), 0);
        _assertReputation(buyer, 1, 0, 0);
    }

    function test_repay_burnsRcnFromMakers() public {
        _fund(id);
        assertEq(rcn.balanceOf(makerA), FILL_A);
        assertEq(rcn.balanceOf(makerB), FILL_B);

        vm.expectCall(address(rcn), abi.encodeCall(IReceivableCreditNote.burn, (makerA, 1_976_170)));
        vm.expectCall(address(rcn), abi.encodeCall(IReceivableCreditNote.burn, (makerB, 986_845)));
        vm.expectEmit(true, true, false, true, address(rcn));
        emit IERC20.Transfer(makerA, address(0), 1_976_170);
        vm.expectEmit(true, true, false, true, address(rcn));
        emit IERC20.Transfer(makerB, address(0), 986_845);
        _pay(id, 3_000_000);

        assertEq(rcn.balanceOf(makerA), FILL_A - 1_976_170);
        assertEq(rcn.balanceOf(makerB), FILL_B - 986_845);
        assertEq(rcn.totalSupply(), FUNDED - 1_976_170 - 986_845);

        _pay(id, router.lenderDue(id));
        assertEq(rcn.balanceOf(makerA), 0);
        assertEq(rcn.balanceOf(makerB), 0);
        assertEq(rcn.totalSupply(), 0);
    }

    function test_repay_updatesReputation_onTimeVsLate() public {
        bytes32 id2 = _registerReceivable(keccak256("PO-1002"), dueDate);
        _fund(id);
        _fund(id2);

        vm.warp(dueDate);
        vm.expectEmit(true, true, false, true, address(kya));
        emit IKYARegistry.RepaymentRecorded(buyer, seller, true);
        _pay(id, AMOUNT);
        _assertReputation(buyer, 1, 0, 0);
        _assertReputation(seller, 1, 0, 0);

        vm.warp(uint256(dueDate) + 1);
        vm.expectEmit(true, true, false, true, address(kya));
        emit IKYARegistry.RepaymentRecorded(buyer, seller, false);
        _pay(id2, AMOUNT);
        _assertReputation(buyer, 1, 1, 0);
        _assertReputation(seller, 2, 0, 0);
    }

    function test_close_sendsUndrawnToSeller_andDeletesSchedules() public {
        _fund(id);
        ICreditFacility.FacilityInfo memory info = facility.facilityInfo(id);
        assertTrue(info.overdueSchedule != address(0));
        assertTrue(info.defaultSchedule != address(0));

        vm.expectCall(address(facility), abi.encodeCall(ICreditFacility.closeFacility, (id)));
        vm.expectCall(HSS, abi.encodeCall(IHederaScheduleService.deleteSchedule, (info.overdueSchedule)));
        vm.expectCall(HSS, abi.encodeCall(IHederaScheduleService.deleteSchedule, (info.defaultSchedule)));
        vm.expectEmit(true, true, true, true, address(usdc));
        emit IERC20.Transfer(address(facility), seller, FUNDED);
        vm.expectEmit(true, false, false, true, address(facility));
        emit ICreditFacility.FacilityClosed(id, FUNDED);
        _pay(id, AMOUNT);

        assertTrue(hss.getSchedule(info.overdueSchedule).deleted);
        assertTrue(hss.getSchedule(info.defaultSchedule).deleted);
        assertEq(usdc.balanceOf(address(facility)), 0);
        assertEq(facility.available(id), 0);
        assertEq(usdc.balanceOf(seller), AMOUNT - LENDERS_DUE + FUNDED);
    }

    function test_repay_revertsZeroAmount() public {
        _fund(id);
        vm.prank(buyer);
        vm.expectRevert(RepaymentRouter.ZERO_AMOUNT.selector);
        router.repay(id, 0);
    }

    function test_repay_revertsNotFinanced() public {
        // None.
        vm.prank(buyer);
        vm.expectRevert(RepaymentRouter.NOT_FINANCED.selector);
        router.repay(keccak256("unknown"), 1_000);

        // Confirmed, not yet funded.
        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Confirmed));
        vm.prank(buyer);
        vm.expectRevert(RepaymentRouter.NOT_FINANCED.selector);
        router.repay(id, 1_000);

        // Cancelled.
        bytes32 hash = registry.hashCancel(id);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(sellerPk, hash);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(buyerPk, hash);
        registry.cancel(id, abi.encodePacked(r1, s1, v1), abi.encodePacked(r2, s2, v2));
        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Cancelled));
        vm.prank(buyer);
        vm.expectRevert(RepaymentRouter.NOT_FINANCED.selector);
        router.repay(id, 1_000);

        assertEq(usdc.balanceOf(buyer), BUYER_FLOAT);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function test_repay_roundingRemainderGoesToLastMaker() public {
        _fund(id);
        // 1e6 * 4_023_013 / 6_036_985 = 666_394.40...: A gets the floor, B (last) takes the remainder.
        uint256 amount = 1_000_000;
        assertTrue(amount * DUE_A % LENDERS_DUE != 0, "amount must leave dust");
        _pay(id, amount);

        assertEq(usdc.balanceOf(makerA), 666_394);
        assertEq(usdc.balanceOf(makerB), amount - amount * DUE_A / LENDERS_DUE);
        assertEq(usdc.balanceOf(makerB), 333_606);
        assertEq(usdc.balanceOf(makerA) + usdc.balanceOf(makerB), amount, "every unit reaches the lenders");
        assertEq(usdc.balanceOf(seller), 0);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(router.lenderDue(id), LENDERS_DUE - amount);
    }

    /// @dev With three or more makers the last maker's rounding remainder can exceed what it is owed (here by
    ///      1); the excess goes to the earlier makers in order, so no maker is ever paid past its due.
    function test_repay_threeMakers_remainderNeverOverpaysLastMaker() public {
        address makerC = makeAddr("lenderC");
        swapRouter.setAprBps(makerC, 900);
        swapRouter.fund(address(usdc), 7_000_000);
        ICreditFacility.Fill[] memory fills = new ICreditFacility.Fill[](3);
        fills[0] = ICreditFacility.Fill({ order: _order(makerA), amount: FILL_A, aprBps: APR_A });
        fills[1] = ICreditFacility.Fill({ order: _order(makerB), amount: FILL_B, aprBps: APR_B });
        fills[2] = ICreditFacility.Fill({ order: _order(makerC), amount: 1_000_000, aprBps: 900 });
        vm.prank(coordinator);
        facility.openAndFund(id, fills, ADVANCE_BPS, LIMIT);

        // Dues: A 4_023_013, B 2_013_972, C 1_007_397; total 7_044_382. Paying total - 1 floors A and B down
        // by one each, which would leave C a remainder of 1_007_398.
        assertEq(router.lenderDue(id), 7_044_382);
        _pay(id, 7_044_381);

        assertEq(usdc.balanceOf(makerC), 1_007_397, "last maker capped at its due");
        assertEq(usdc.balanceOf(makerA), 4_023_013, "excess dust to the first maker with room");
        assertEq(usdc.balanceOf(makerB), 2_013_971);
        assertEq(usdc.balanceOf(makerA) + usdc.balanceOf(makerB) + usdc.balanceOf(makerC), 7_044_381);
        assertEq(rcn.balanceOf(makerC), 0);
        assertEq(router.lenderDue(id), 1);
        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Financed));

        _pay(id, 1);
        assertEq(usdc.balanceOf(makerB), DUE_B);
        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Repaid));
        assertEq(rcn.totalSupply(), 0);
    }

    // ------------------------------------------------------------------ constructor

    function test_constructor_associatesUsdc_revertsAssociationFailed() public {
        MockHtsUsdc hts = new MockHtsUsdc();
        RepaymentRouter r = _newRouter(address(hts));
        assertTrue(hts.associated(address(r)));

        hts.setAssociateResponseCode(194); // TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT
        _newRouter(address(hts));

        hts.setAssociateResponseCode(21);
        vm.expectRevert(abi.encodeWithSelector(RepaymentRouter.ASSOCIATION_FAILED.selector, 21));
        _newRouter(address(hts));
    }

    function _newRouter(address usdc_) internal returns (RepaymentRouter) {
        return new RepaymentRouter(
            IReceivableRegistry(address(registry)),
            IKYARegistry(address(kya)),
            ICreditFacility(address(facility)),
            IReceivableCreditNote(address(rcn)),
            usdc_
        );
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_feeOf_monotonicInTime(uint64 dt) public view {
        uint64 t0 = uint64(block.timestamp);
        dt = uint64(bound(dt, 0, type(uint64).max - t0 - 1));
        uint256 fee = router.feeOf(FILL_A, APR_A, t0, t0 + dt);
        assertGe(router.feeOf(FILL_A, APR_A, t0, t0 + dt + 1), fee);
        assertGe(fee, 23_013, "never below the minimum-term fee");
        if (dt <= 30 days) assertEq(fee, 23_013);
    }

    /// @dev No overflow for any APR and principal up to 1e12 (1,000,000 USDC) over up to 10 years: the fee is
    ///      the exact floored formula and never above `principal * aprBps * 10 / 10_000`.
    function testFuzz_feeOf_noOverflow(uint256 principal, uint16 aprBps, uint64 dt) public view {
        principal = bound(principal, 0, 1e12);
        dt = uint64(bound(dt, 0, 10 * 365 days));
        uint64 t0 = uint64(block.timestamp);
        uint256 fee = router.feeOf(principal, aprBps, t0, t0 + dt);
        uint256 elapsed = dt < 30 days ? 30 days : dt;
        assertEq(fee, principal * aprBps * elapsed / (365 days * 10_000));
        assertLe(fee, principal * aprBps * 10 / 10_000);
    }

    function testFuzz_repay_neverPaysSellerWhileLendersOwed(uint256 amount) public {
        amount = bound(amount, 1, 3 * AMOUNT);
        _fund(id);
        _pay(id, amount);

        uint256 toLenders = usdc.balanceOf(makerA) + usdc.balanceOf(makerB);
        assertEq(usdc.balanceOf(address(router)), 0, "router keeps nothing");
        if (amount < LENDERS_DUE) {
            assertEq(toLenders, amount);
            assertEq(usdc.balanceOf(seller), 0, "seller paid while lenders are owed");
            assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Financed));
            assertEq(router.lenderDue(id), LENDERS_DUE - amount);
            assertLe(usdc.balanceOf(makerA), DUE_A);
            assertLe(usdc.balanceOf(makerB), DUE_B);
        } else {
            assertEq(usdc.balanceOf(makerA), DUE_A);
            assertEq(usdc.balanceOf(makerB), DUE_B);
            assertEq(usdc.balanceOf(seller), amount - LENDERS_DUE + FUNDED);
            assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Repaid));
            assertEq(rcn.totalSupply(), 0);
        }
    }
}
