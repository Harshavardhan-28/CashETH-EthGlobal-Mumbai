// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IReceivableRegistry } from "../src/core/interfaces/IReceivableRegistry.sol";
import { ICreditFacility } from "../src/core/interfaces/ICreditFacility.sol";
import { CreditFacilityBase } from "./CreditFacility.t.sol";

/// @dev Task 3.4: per-worker budgets, limits, merchant allowlist and the two-phase spend (reserve -> commit or
///      release) on the demo facility: funded 6_000_000 by A (4_000_000 at 700 bps) and B (2_000_000 at
///      850 bps), split research 1_000_000 / compute 3_000_000 / data 1_000_000 / reserve 1_000_000.
contract CreditFacilitySpendTest is CreditFacilityBase {
    uint256 internal constant FUNDED = FILL_A + FILL_B;
    uint256 internal constant ALLOC_RESEARCH = 1_000_000;
    uint256 internal constant ALLOC_COMPUTE = 3_000_000;
    uint256 internal constant ALLOC_DATA = 1_000_000;
    uint256 internal constant ALLOC_RESERVE = 1_000_000;
    uint256 internal constant RESEARCH_MAX_TX = 500_000;
    uint256 internal constant RESEARCH_MAX_DAILY = 2_000_000;
    uint256 internal constant COMPUTE_MAX_TX = 1_000_000;
    uint256 internal constant COMPUTE_MAX_DAILY = 2_000_000;
    uint256 internal constant OTHER_MAX_TX = 1_000_000;
    uint256 internal constant OTHER_MAX_DAILY = 1_000_000;
    uint64 internal constant TTL = 10 minutes;

    uint8 internal constant RES_NONE = 0;
    uint8 internal constant RES_OPEN = 1;
    uint8 internal constant RES_COMMITTED = 2;
    uint8 internal constant RES_RELEASED = 3;

    address internal research = makeAddr("researchWorker");
    address internal compute = makeAddr("computeWorker");
    address internal dataWorker = makeAddr("dataWorker");
    address internal reserveWorker = makeAddr("reserveWorker");
    address internal researchWallet = makeAddr("researchWallet");
    address internal computeWallet = makeAddr("computeWallet");
    address internal dataWallet = makeAddr("dataWallet");
    address internal reserveWallet = makeAddr("reserveWallet");
    address internal merchant = makeAddr("merchant");
    address internal otherMerchant = makeAddr("otherMerchant");

    function setUp() public override {
        super.setUp();
        // Spend wallets keep a standing allowance so `release` can pull unspent USDC back.
        address[4] memory wallets = [researchWallet, computeWallet, dataWallet, reserveWallet];
        for (uint256 i; i < wallets.length; ++i) {
            vm.prank(wallets[i]);
            usdc.approve(address(facility), type(uint256).max);
        }
    }

    // ------------------------------------------------------------------ setBudgets

    function test_setBudgets_onlySeller() public {
        _fundBoth();
        (address[] memory workers, uint256[] memory alloc, ICreditFacility.Limits[] memory limits) = _demoBudgets();

        vm.prank(stranger);
        vm.expectRevert(ICreditFacility.NOT_SELLER.selector);
        facility.setBudgets(id, workers, alloc, limits);
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.NOT_SELLER.selector);
        facility.setBudgets(id, workers, alloc, limits);
        vm.prank(buyer);
        vm.expectRevert(ICreditFacility.NOT_SELLER.selector);
        facility.setBudgets(id, workers, alloc, limits);

        uint256[] memory shortAlloc = new uint256[](3);
        vm.prank(seller);
        vm.expectRevert(ICreditFacility.LENGTH_MISMATCH.selector);
        facility.setBudgets(id, workers, shortAlloc, limits);
        ICreditFacility.Limits[] memory shortLimits = new ICreditFacility.Limits[](3);
        vm.prank(seller);
        vm.expectRevert(ICreditFacility.LENGTH_MISMATCH.selector);
        facility.setBudgets(id, workers, alloc, shortLimits);

        vm.expectEmit(true, false, false, true, address(facility));
        emit ICreditFacility.BudgetsSet(id, workers, alloc);
        vm.prank(seller);
        facility.setBudgets(id, workers, alloc, limits);

        _assertBudget(research, ALLOC_RESEARCH, 0, 0, RESEARCH_MAX_TX, RESEARCH_MAX_DAILY, 0, 0);
        _assertBudget(compute, ALLOC_COMPUTE, 0, 0, COMPUTE_MAX_TX, COMPUTE_MAX_DAILY, 0, 0);
        _assertBudget(dataWorker, ALLOC_DATA, 0, 0, OTHER_MAX_TX, OTHER_MAX_DAILY, 0, 0);
        _assertBudget(reserveWorker, ALLOC_RESERVE, 0, 0, OTHER_MAX_TX, OTHER_MAX_DAILY, 0, 0);
        assertTrue(facility.isMerchantAllowed(id, research, merchant));
        assertFalse(facility.isMerchantAllowed(id, research, otherMerchant));
        assertFalse(facility.isMerchantAllowed(id, stranger, merchant));
        address[] memory m = facility.merchants(id, research);
        assertEq(m.length, 1);
        assertEq(m[0], merchant);

        // The seller cannot set budgets on a frozen facility, nor on one that was never funded.
        vm.prank(seller);
        facility.flagDispute(id);
        vm.prank(seller);
        vm.expectRevert(ICreditFacility.FACILITY_NOT_ACTIVE.selector);
        facility.setBudgets(id, workers, alloc, limits);
    }

    function test_setBudgets_sumExceedsFunded() public {
        _fundBoth();
        (address[] memory workers, uint256[] memory alloc, ICreditFacility.Limits[] memory limits) = _demoBudgets();

        alloc[3] = ALLOC_RESERVE + 1; // 6_000_001
        vm.prank(seller);
        vm.expectRevert(ICreditFacility.BUDGETS_EXCEED_FUNDED.selector);
        facility.setBudgets(id, workers, alloc, limits);

        alloc[3] = ALLOC_RESERVE; // exactly 6_000_000
        vm.prank(seller);
        facility.setBudgets(id, workers, alloc, limits);

        // A budget cannot be cut below what the worker already spent plus holds in open reservations.
        _reserve(keccak256("s1"), research, researchWallet, 300_000);
        _commit(keccak256("s1"));
        _reserve(keccak256("s2"), research, researchWallet, 100_000);
        (address[] memory one, uint256[] memory oneAlloc, ICreditFacility.Limits[] memory oneLimits) =
            _single(research, 399_999, RESEARCH_MAX_TX, RESEARCH_MAX_DAILY, merchant);
        vm.prank(seller);
        vm.expectRevert(ICreditFacility.BUDGETS_EXCEED_FUNDED.selector);
        facility.setBudgets(id, one, oneAlloc, oneLimits);

        oneAlloc[0] = 400_000;
        vm.prank(seller);
        facility.setBudgets(id, one, oneAlloc, oneLimits);
        _assertBudget(
            research, 400_000, 300_000, 100_000, RESEARCH_MAX_TX, RESEARCH_MAX_DAILY, 300_000, uint64(block.timestamp)
        );
    }

    // ------------------------------------------------------------------ reserve

    function test_reserve_movesUsdcToWallet() public {
        _fundWithBudgets();
        bytes32 spendId = keccak256("spend-1");
        uint64 expiry = uint64(block.timestamp) + TTL;

        vm.prank(stranger);
        vm.expectRevert(ICreditFacility.NOT_COORDINATOR.selector);
        facility.reserve(id, spendId, research, researchWallet, merchant, 400_000, expiry);

        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.RESERVATION_EXPIRED.selector);
        facility.reserve(id, spendId, research, researchWallet, merchant, 400_000, uint64(block.timestamp));

        vm.expectEmit(true, true, false, true, address(facility));
        emit ICreditFacility.SpendReserved(id, spendId, research, merchant, 400_000, expiry);
        vm.prank(coordinator);
        facility.reserve(id, spendId, research, researchWallet, merchant, 400_000, expiry);

        assertEq(usdc.balanceOf(researchWallet), 400_000);
        assertEq(usdc.balanceOf(address(facility)), FUNDED - 400_000);
        assertEq(facility.available(id), FUNDED - 400_000);
        assertEq(facility.facilityInfo(id).reserved, 400_000);
        assertEq(facility.facilityInfo(id).committed, 0);
        // Reserving does not count toward the daily limit; it starts the worker's day.
        _assertBudget(
            research, ALLOC_RESEARCH, 0, 400_000, RESEARCH_MAX_TX, RESEARCH_MAX_DAILY, 0, uint64(block.timestamp)
        );

        ICreditFacility.Reservation memory r = facility.reservation(spendId);
        assertEq(r.id, id);
        assertEq(r.worker, research);
        assertEq(r.spendWallet, researchWallet);
        assertEq(r.merchant, merchant);
        assertEq(r.amount, 400_000);
        assertEq(r.expiry, expiry);
        assertEq(r.status, RES_OPEN);
        assertEq(r.txIdHash, bytes32(0));
        assertEq(facility.reservation(keccak256("unused")).status, RES_NONE);

        // A spend id is single-use.
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.RESERVATION_EXISTS.selector);
        facility.reserve(id, spendId, research, researchWallet, merchant, 1, expiry);
    }

    function test_reserve_agentBudgetExceeded_5500() public {
        _fundWithBudgets();

        // 5_500_000 is checked against the 3_000_000 budget before the 1_000_000 per-tx limit.
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.AGENT_BUDGET_EXCEEDED.selector);
        facility.reserve(id, keccak256("big"), compute, computeWallet, merchant, 5_500_000, _expiry());

        // Open reservations count against the budget: 500k + 500k uses all of research's 1_000_000.
        _reserve(keccak256("r1"), research, researchWallet, 500_000);
        _reserve(keccak256("r2"), research, researchWallet, 500_000);
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.AGENT_BUDGET_EXCEEDED.selector);
        facility.reserve(id, keccak256("r3"), research, researchWallet, merchant, 1, _expiry());

        // A worker without a budget has nothing to spend.
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.AGENT_BUDGET_EXCEEDED.selector);
        facility.reserve(id, keccak256("nobody"), stranger, researchWallet, merchant, 1, _expiry());
    }

    function test_reserve_txLimit() public {
        _fundWithBudgets();

        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.TX_LIMIT_EXCEEDED.selector);
        facility.reserve(id, keccak256("t1"), research, researchWallet, merchant, RESEARCH_MAX_TX + 1, _expiry());

        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.TX_LIMIT_EXCEEDED.selector);
        facility.reserve(id, keccak256("t1"), research, researchWallet, merchant, 0, _expiry());

        _reserve(keccak256("t1"), research, researchWallet, RESEARCH_MAX_TX);
        assertEq(usdc.balanceOf(researchWallet), RESEARCH_MAX_TX);
    }

    function test_reserve_dailyLimit_resetsNextDay() public {
        _fundWithBudgets();
        uint64 day0 = uint64(block.timestamp);

        _reserve(keccak256("d1"), compute, computeWallet, 1_000_000);
        _commit(keccak256("d1"));
        _reserve(keccak256("d2"), compute, computeWallet, 1_000_000);
        _commit(keccak256("d2"));
        _assertBudget(compute, ALLOC_COMPUTE, 2_000_000, 0, COMPUTE_MAX_TX, COMPUTE_MAX_DAILY, 2_000_000, day0);

        // Within budget (1_000_000 left) and the per-tx limit, but over the 2_000_000 daily limit.
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.DAILY_LIMIT_EXCEEDED.selector);
        facility.reserve(id, keccak256("d3"), compute, computeWallet, merchant, 1, _expiry());

        // Check order: the daily limit is checked before the allowlist.
        vm.warp(day0 + 1 days - 1);
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.DAILY_LIMIT_EXCEEDED.selector);
        facility.reserve(id, keccak256("d3"), compute, computeWallet, otherMerchant, 1, _expiry());

        // A day after the window opened, the daily total resets and the window restarts now.
        vm.warp(day0 + 1 days);
        _reserve(keccak256("d3"), compute, computeWallet, 1_000_000);
        _assertBudget(
            compute, ALLOC_COMPUTE, 2_000_000, 1_000_000, COMPUTE_MAX_TX, COMPUTE_MAX_DAILY, 0, day0 + 1 days
        );
        _commit(keccak256("d3"));
        _assertBudget(
            compute, ALLOC_COMPUTE, 3_000_000, 0, COMPUTE_MAX_TX, COMPUTE_MAX_DAILY, 1_000_000, day0 + 1 days
        );
    }

    function test_reserve_merchantNotAllowed() public {
        _fundWithBudgets();

        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.MERCHANT_NOT_ALLOWED.selector);
        facility.reserve(id, keccak256("m1"), research, researchWallet, otherMerchant, 100_000, _expiry());

        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.MERCHANT_NOT_ALLOWED.selector);
        facility.reserve(id, keccak256("m1"), research, researchWallet, address(0), 100_000, _expiry());

        // Check order: the per-tx limit is checked before the allowlist.
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.TX_LIMIT_EXCEEDED.selector);
        facility.reserve(id, keccak256("m1"), research, researchWallet, otherMerchant, RESEARCH_MAX_TX + 1, _expiry());

        _reserve(keccak256("m1"), research, researchWallet, 100_000);
        assertEq(facility.reservation(keccak256("m1")).merchant, merchant);
    }

    function test_reserve_globalCreditLimit() public {
        _fundWithBudgets();

        // A later `setBudgets` call budgets a fifth worker; each call's sum fits `funded`, together they do not.
        address extra = makeAddr("extraWorker");
        address extraWallet = makeAddr("extraWallet");
        vm.prank(extraWallet);
        usdc.approve(address(facility), type(uint256).max);
        (address[] memory one, uint256[] memory oneAlloc, ICreditFacility.Limits[] memory oneLimits) =
            _single(extra, 1_000_000, 1_000_000, 1_000_000, merchant);
        vm.prank(seller);
        facility.setBudgets(id, one, oneAlloc, oneLimits);

        // Compute, data, reserve and half of research take 5_500_000 of the 6_000_000.
        _reserve(keccak256("c1"), compute, computeWallet, 1_000_000);
        _reserve(keccak256("c2"), compute, computeWallet, 1_000_000);
        _reserve(keccak256("c3"), compute, computeWallet, 1_000_000);
        _reserve(keccak256("dt"), dataWorker, dataWallet, 1_000_000);
        _reserve(keccak256("rs"), reserveWorker, reserveWallet, 1_000_000);
        _reserve(keccak256("r1"), research, researchWallet, 500_000);
        assertEq(facility.available(id), 500_000);

        // Within the extra worker's budget, per-tx and daily limits and allowlist, but above `available`.
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.GLOBAL_CREDIT_LIMIT_EXCEEDED.selector);
        facility.reserve(id, keccak256("x1"), extra, extraWallet, merchant, 500_001, _expiry());
        // Check order: the allowlist is checked before availability.
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.MERCHANT_NOT_ALLOWED.selector);
        facility.reserve(id, keccak256("x1"), extra, extraWallet, otherMerchant, 500_001, _expiry());

        _reserve(keccak256("x1"), extra, extraWallet, 500_000);
        assertEq(facility.available(id), 0);
        assertEq(usdc.balanceOf(address(facility)), 0);
        assertEq(facility.facilityInfo(id).reserved, FUNDED);
    }

    function test_reserve_frozenFacility() public {
        _fundWithBudgets();

        // Paused.
        vm.prank(owner);
        facility.pause();
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.PAUSED.selector);
        facility.reserve(id, keccak256("f1"), research, researchWallet, merchant, 100_000, _expiry());
        vm.prank(owner);
        facility.unpause();

        // Still Active but at the due date: no new spending.
        uint256 t0 = block.timestamp;
        vm.warp(dueDate);
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.FACILITY_NOT_ACTIVE.selector);
        facility.reserve(id, keccak256("f1"), research, researchWallet, merchant, 100_000, _expiry());
        vm.warp(t0);

        // Frozen by a dispute.
        vm.prank(seller);
        facility.flagDispute(id);
        assertEq(facility.facilityInfo(id).status, STATUS_FROZEN);
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.FACILITY_NOT_ACTIVE.selector);
        facility.reserve(id, keccak256("f1"), research, researchWallet, merchant, 100_000, _expiry());

        // An unknown facility is not Active either.
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.FACILITY_NOT_ACTIVE.selector);
        facility.reserve(keccak256("nope"), keccak256("f2"), research, researchWallet, merchant, 100_000, _expiry());

        assertEq(usdc.balanceOf(researchWallet), 0);
        assertEq(facility.available(id), FUNDED);
    }

    // ------------------------------------------------------------------ commit

    function test_commit_afterExpiryReverts() public {
        _fundWithBudgets();
        bytes32 s1 = keccak256("c1");
        bytes32 s2 = keccak256("c2");
        uint64 expiry = _expiry();
        _reserve(s1, research, researchWallet, 200_000);
        _reserve(s2, research, researchWallet, 300_000);
        bytes32 txHash = keccak256("0.0.1234@1750000000.000000001");

        vm.prank(stranger);
        vm.expectRevert(ICreditFacility.NOT_COORDINATOR.selector);
        facility.commit(s1, txHash);

        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.RESERVATION_NOT_OPEN.selector);
        facility.commit(keccak256("unknown"), txHash);

        // Committing at the expiry second is still in time.
        vm.warp(expiry);
        vm.expectEmit(true, false, false, true, address(facility));
        emit ICreditFacility.SpendCommitted(s1, txHash);
        vm.prank(coordinator);
        facility.commit(s1, txHash);

        ICreditFacility.Reservation memory r = facility.reservation(s1);
        assertEq(r.status, RES_COMMITTED);
        assertEq(r.txIdHash, txHash);
        _assertBudget(
            research, ALLOC_RESEARCH, 200_000, 300_000, RESEARCH_MAX_TX, RESEARCH_MAX_DAILY, 200_000, expiry - TTL
        );
        assertEq(facility.facilityInfo(id).committed, 200_000);
        assertEq(facility.facilityInfo(id).reserved, 300_000);

        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.RESERVATION_NOT_OPEN.selector);
        facility.commit(s1, txHash);

        // One second past the expiry the open reservation can no longer be committed.
        vm.warp(expiry + 1);
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.RESERVATION_EXPIRED.selector);
        facility.commit(s2, txHash);
        assertEq(facility.reservation(s2).status, RES_OPEN);
        assertEq(facility.facilityInfo(id).committed, 200_000);
    }

    // ------------------------------------------------------------------ release

    function test_release_pullsBack_afterExpiry_byAnyone() public {
        _fundWithBudgets();
        bytes32 s1 = keccak256("rel-1");
        uint64 expiry = _expiry();
        _reserve(s1, research, researchWallet, 450_000);
        assertEq(usdc.balanceOf(researchWallet), 450_000);

        vm.warp(expiry + 1);
        vm.expectEmit(true, false, false, true, address(facility));
        emit ICreditFacility.SpendReleased(s1, 450_000);
        vm.prank(stranger);
        facility.release(s1);

        assertEq(usdc.balanceOf(researchWallet), 0);
        assertEq(usdc.balanceOf(address(facility)), FUNDED);
        assertEq(facility.available(id), FUNDED);
        assertEq(facility.facilityInfo(id).reserved, 0);
        assertEq(facility.facilityInfo(id).committed, 0);
        assertEq(facility.reservation(s1).status, RES_RELEASED);
        _assertBudget(research, ALLOC_RESEARCH, 0, 0, RESEARCH_MAX_TX, RESEARCH_MAX_DAILY, 0, expiry - TTL);

        vm.prank(stranger);
        vm.expectRevert(ICreditFacility.RESERVATION_NOT_OPEN.selector);
        facility.release(s1);
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.RESERVATION_NOT_OPEN.selector);
        facility.commit(s1, bytes32(uint256(1)));
        vm.prank(stranger);
        vm.expectRevert(ICreditFacility.RESERVATION_NOT_OPEN.selector);
        facility.release(keccak256("unknown"));
    }

    function test_release_beforeExpiry_onlyCoordinator() public {
        _fundWithBudgets();
        bytes32 s1 = keccak256("rel-2");
        uint64 expiry = _expiry();
        _reserve(s1, research, researchWallet, 250_000);

        vm.prank(stranger);
        vm.expectRevert(ICreditFacility.NOT_COORDINATOR.selector);
        facility.release(s1);

        // At the expiry second the reservation is still live, so only the coordinator may release it.
        vm.warp(expiry);
        vm.prank(seller);
        vm.expectRevert(ICreditFacility.NOT_COORDINATOR.selector);
        facility.release(s1);

        vm.expectEmit(true, false, false, true, address(facility));
        emit ICreditFacility.SpendReleased(s1, 250_000);
        vm.prank(coordinator);
        facility.release(s1);

        assertEq(usdc.balanceOf(researchWallet), 0);
        assertEq(usdc.balanceOf(address(facility)), FUNDED);
        assertEq(facility.reservation(s1).status, RES_RELEASED);
        assertEq(facility.budget(id, research).reserved, 0);
    }

    // ------------------------------------------------------------------ accounting

    function test_accounting_committedPlusReservedPlusAvailableEqualsFunded() public {
        _fundWithBudgets();
        _assertAccounting(0, 0);

        _reserve(keccak256("a1"), compute, computeWallet, 1_000_000);
        _assertAccounting(0, 1_000_000);
        _reserve(keccak256("a2"), research, researchWallet, 300_000);
        _assertAccounting(0, 1_300_000);

        _commit(keccak256("a1"));
        _assertAccounting(1_000_000, 300_000);

        vm.prank(coordinator);
        facility.release(keccak256("a2"));
        _assertAccounting(1_000_000, 0);

        // Committed USDC stays with the spend wallet (it was paid out); released USDC is back in the facility.
        assertEq(usdc.balanceOf(computeWallet), 1_000_000);
        assertEq(usdc.balanceOf(researchWallet), 0);
    }

    function test_merchantAllowlist_replacedOnSetBudgets() public {
        _fundWithBudgets();
        _reserve(keccak256("ma1"), research, researchWallet, 100_000);
        _commit(keccak256("ma1"));
        uint64 day0 = uint64(block.timestamp);

        address merchant2 = makeAddr("merchant2");
        address[] memory list = new address[](2);
        list[0] = otherMerchant;
        list[1] = merchant2;
        address[] memory workers = new address[](1);
        workers[0] = research;
        uint256[] memory alloc = new uint256[](1);
        alloc[0] = 800_000;
        ICreditFacility.Limits[] memory limits = new ICreditFacility.Limits[](1);
        limits[0] = ICreditFacility.Limits({ maxPerTx: 200_000, maxDaily: 600_000, merchants: list });
        vm.prank(seller);
        facility.setBudgets(id, workers, alloc, limits);

        assertFalse(facility.isMerchantAllowed(id, research, merchant));
        assertTrue(facility.isMerchantAllowed(id, research, otherMerchant));
        assertTrue(facility.isMerchantAllowed(id, research, merchant2));
        address[] memory m = facility.merchants(id, research);
        assertEq(m.length, 2);
        assertEq(m[0], otherMerchant);
        assertEq(m[1], merchant2);
        // New allocation and limits; spent, reserved and the daily window are kept.
        _assertBudget(research, 800_000, 100_000, 0, 200_000, 600_000, 100_000, day0);
        // Other workers' allowlists are untouched.
        assertTrue(facility.isMerchantAllowed(id, compute, merchant));

        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.MERCHANT_NOT_ALLOWED.selector);
        facility.reserve(id, keccak256("ma2"), research, researchWallet, merchant, 100_000, _expiry());
        vm.prank(coordinator);
        facility.reserve(id, keccak256("ma2"), research, researchWallet, otherMerchant, 100_000, _expiry());

        // An empty list clears the allowlist.
        limits[0].merchants = new address[](0);
        vm.prank(seller);
        facility.setBudgets(id, workers, alloc, limits);
        assertEq(facility.merchants(id, research).length, 0);
        assertFalse(facility.isMerchantAllowed(id, research, otherMerchant));
        assertFalse(facility.isMerchantAllowed(id, research, merchant2));
    }

    // ------------------------------------------------------------------ Ruling R21

    function test_openAndFund_revertsFillMismatch_apr() public {
        swapRouter.fund(address(usdc), FUNDED);
        ICreditFacility.Fill[] memory fills = _fillsBoth();

        // Right maker and amount, but the router reports an APR other than the fill's.
        swapRouter.setAprBps(makerB, APR_B + 1);
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.FILL_MISMATCH.selector);
        facility.openAndFund(id, fills, ADVANCE_BPS, LIMIT);

        swapRouter.setAprBps(makerB, APR_B - 1);
        vm.prank(coordinator);
        vm.expectRevert(ICreditFacility.FILL_MISMATCH.selector);
        facility.openAndFund(id, fills, ADVANCE_BPS, LIMIT);

        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Confirmed));
        assertEq(rcn.totalSupply(), 0);
        assertEq(facility.makers(id).length, 0);

        swapRouter.setAprBps(makerB, APR_B);
        vm.prank(coordinator);
        facility.openAndFund(id, fills, ADVANCE_BPS, LIMIT);
        _assertPosition(makerB, FILL_B, APR_B, uint64(block.timestamp));
    }

    // ------------------------------------------------------------------ helpers

    function _fundWithBudgets() internal {
        _fundBoth();
        (address[] memory workers, uint256[] memory alloc, ICreditFacility.Limits[] memory limits) = _demoBudgets();
        vm.prank(seller);
        facility.setBudgets(id, workers, alloc, limits);
    }

    function _demoBudgets()
        internal
        view
        returns (address[] memory workers, uint256[] memory alloc, ICreditFacility.Limits[] memory limits)
    {
        address[] memory allow = new address[](1);
        allow[0] = merchant;
        workers = new address[](4);
        alloc = new uint256[](4);
        limits = new ICreditFacility.Limits[](4);
        (workers[0], alloc[0]) = (research, ALLOC_RESEARCH);
        (workers[1], alloc[1]) = (compute, ALLOC_COMPUTE);
        (workers[2], alloc[2]) = (dataWorker, ALLOC_DATA);
        (workers[3], alloc[3]) = (reserveWorker, ALLOC_RESERVE);
        limits[0] =
            ICreditFacility.Limits({ maxPerTx: RESEARCH_MAX_TX, maxDaily: RESEARCH_MAX_DAILY, merchants: allow });
        limits[1] = ICreditFacility.Limits({ maxPerTx: COMPUTE_MAX_TX, maxDaily: COMPUTE_MAX_DAILY, merchants: allow });
        limits[2] = ICreditFacility.Limits({ maxPerTx: OTHER_MAX_TX, maxDaily: OTHER_MAX_DAILY, merchants: allow });
        limits[3] = ICreditFacility.Limits({ maxPerTx: OTHER_MAX_TX, maxDaily: OTHER_MAX_DAILY, merchants: allow });
    }

    function _single(address worker, uint256 alloc_, uint256 maxPerTx, uint256 maxDaily, address allowed)
        internal
        pure
        returns (address[] memory workers, uint256[] memory alloc, ICreditFacility.Limits[] memory limits)
    {
        address[] memory allow = new address[](1);
        allow[0] = allowed;
        workers = new address[](1);
        workers[0] = worker;
        alloc = new uint256[](1);
        alloc[0] = alloc_;
        limits = new ICreditFacility.Limits[](1);
        limits[0] = ICreditFacility.Limits({ maxPerTx: maxPerTx, maxDaily: maxDaily, merchants: allow });
    }

    /// @dev `vm.getBlockTimestamp()` rather than `block.timestamp`, which via-IR may keep stale across `vm.warp`.
    function _expiry() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp()) + TTL;
    }

    function _reserve(bytes32 spendId, address worker, address wallet, uint256 amount) internal {
        vm.prank(coordinator);
        facility.reserve(id, spendId, worker, wallet, merchant, amount, _expiry());
    }

    function _commit(bytes32 spendId) internal {
        vm.prank(coordinator);
        facility.commit(spendId, keccak256(abi.encode(spendId)));
    }

    function _assertBudget(
        address worker,
        uint256 alloc,
        uint256 spent,
        uint256 reserved,
        uint256 maxPerTx,
        uint256 maxDaily,
        uint256 dailySpent,
        uint64 dayStart
    ) internal view {
        ICreditFacility.Budget memory b = facility.budget(id, worker);
        assertEq(b.alloc, alloc, "alloc");
        assertEq(b.spent, spent, "spent");
        assertEq(b.reserved, reserved, "reserved");
        assertEq(b.maxPerTx, maxPerTx, "maxPerTx");
        assertEq(b.maxDaily, maxDaily, "maxDaily");
        assertEq(b.dailySpent, dailySpent, "dailySpent");
        assertEq(b.dayStart, dayStart, "dayStart");
    }

    /// @dev `committed + reserved + available == funded`, and the facility holds exactly `available` USDC.
    function _assertAccounting(uint256 committed, uint256 reserved) internal view {
        ICreditFacility.FacilityInfo memory info = facility.facilityInfo(id);
        uint256 avail = facility.available(id);
        assertEq(info.committed, committed, "committed");
        assertEq(info.reserved, reserved, "reserved");
        assertEq(info.committed + info.reserved + avail, info.funded, "invariant");
        assertEq(info.funded, FUNDED, "funded");
        assertEq(usdc.balanceOf(address(facility)), avail, "facility balance");
    }
}
