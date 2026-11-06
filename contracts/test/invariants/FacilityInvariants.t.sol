// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { KYARegistry } from "../../src/core/KYARegistry.sol";
import { IKYARegistry } from "../../src/core/interfaces/IKYARegistry.sol";
import { ReceivableRegistry } from "../../src/core/ReceivableRegistry.sol";
import { IReceivableRegistry } from "../../src/core/interfaces/IReceivableRegistry.sol";
import { ReceivableCreditNote } from "../../src/core/ReceivableCreditNote.sol";
import { IReceivableCreditNote } from "../../src/core/interfaces/IReceivableCreditNote.sol";
import { CreditFacility } from "../../src/core/CreditFacility.sol";
import { ICreditFacility } from "../../src/core/interfaces/ICreditFacility.sol";
import { RepaymentRouter } from "../../src/core/RepaymentRouter.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { MockSwapRouter } from "../mocks/MockSwapRouter.sol";
import { MockHSS } from "../mocks/MockHSS.sol";
import { FacilityHandler } from "./FacilityHandler.sol";

/// @title Facility invariants
/// @notice Real KYARegistry, ReceivableRegistry, ReceivableCreditNote, CreditFacility and RepaymentRouter, wired as
///         in `RepaymentRouter.t.sol`; `MockSwapRouter` stands in for the SwapVM router (1:1 RCN -> USDC fills),
///         `MockHSS` sits at 0x16b and `MockUSDC` is the currency. `FacilityHandler` opens and funds up to eight
///         receivables (each with its own seller) through 1-3 lender fills, sets budgets, reserves, commits and
///         releases spend through four wallets, warps time, marks overdue/default (directly and through the
///         scheduled calls), flags disputes and repays (partial, exact, overpaying, after Repaid).
///
/// Definitions, per receivable `id` the handler funded (`info = facility.facilityInfo(id)`, sums over
/// `facility.makers(id)` and over the handler's three workers):
///
///  1. invariant_debtNeverExceedsBorrowingBase
///     The debt drawn from lenders never exceeds the borrowing base:
///       sum(position.principal) == info.funded <= info.receivableAmount * advanceBps / 10_000, and <= limit,
///     where advanceBps and limit are what `openAndFund` was called with. Debt only shrinks afterwards:
///       paidPrincipal <= principal for every position, so outstanding principal <= funded.
///     Fees accrue with time, so the router's `lenderDue(id)` is pinned at funding time: read right after
///     `openAndFund` it equals sum(principal) + sum(feeOf(principal, apr, start, start)), i.e. the principal
///     plus each lender's minimum-term (30-day) fee and nothing else. (It cannot equal sum(principal) alone:
///     the router always charges at least `MIN_TERM`.)
///     RCN backs exactly the outstanding principal: rcn.totalSupply() == sum over ids of outstanding principal,
///     all of it held by the lenders.
///
///  2. invariant_budgetsNeverExceedFunded
///       facility.allocated(id) == sum(budget.alloc) <= info.funded, every worker's spent + reserved <= alloc,
///       sum(budget.reserved) == info.reserved and sum(budget.spent) == info.committed.
///
///  3. invariant_sellerGetsNothingWhileLendersOwed
///     A seller's USDC balance only changes in a repayment of its own receivable that leaves it Repaid (the
///     final repayment, which also closes the facility and returns the undrawn advance), in a repayment of an
///     already Repaid receivable, or in a release on its Closed facility; it never decreases. Hence
///       registry.state(id) != Repaid  =>  usdc.balanceOf(seller) == 0,
///     and Repaid <=> facility Closed, with every position's principal fully repaid. Every repayment's split
///     matches the waterfall computed beforehand (lenders get min(amount, lenderDue), none more than it is
///     owed, the seller the rest plus the undrawn advance on the closing payment), and the router keeps nothing.
///
///  4. invariant_stateOnlyMovesForward
///     The registry state moves only along None -> Confirmed -> Financed -> {Overdue, Defaulted, Repaid},
///     Overdue -> {Defaulted, Repaid}, Defaulted -> Repaid; the facility status only along
///     None -> Active -> {Frozen, Closed}, Frozen -> Closed. Checked after every handler action against the last
///     seen value. Early overdue/default calls and public releases inside the grace period are rejected.
///
///  5. invariant_committedPlusReservedPlusAvailableEqualsFunded
///     For an Active or Frozen facility: info.committed + info.reserved + available(id) == info.funded, with
///     info.reserved / info.committed equal to the handler's ghost sums of Open / Committed reservations (for
///     every facility). The facility is solvent and holds nothing else: its USDC balance equals the sum of
///     available(id) over Active/Frozen facilities. Each spend wallet holds exactly its open reservation.
contract FacilityInvariantsTest is Test {
    address internal constant HSS = address(0x16b);
    uint256 internal constant BUYER_PK = 0xB0B;
    uint256 internal constant SELLER_PK_BASE = 0x5E11E40;

    address internal owner = makeAddr("owner");
    address internal coordinator = makeAddr("coordinator");
    address internal aqua = makeAddr("aqua");

    MockUSDC internal usdc;
    KYARegistry internal kya;
    ReceivableRegistry internal registry;
    ReceivableCreditNote internal rcn;
    MockSwapRouter internal swapRouter;
    MockHSS internal hss;
    CreditFacility internal facility;
    RepaymentRouter internal router;
    FacilityHandler internal handler;

    function setUp() public {
        vm.warp(1_750_000_000);

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
        router = new RepaymentRouter(
            IReceivableRegistry(address(registry)),
            IKYARegistry(address(kya)),
            ICreditFacility(address(facility)),
            IReceivableCreditNote(address(rcn)),
            address(usdc)
        );

        vm.startPrank(owner);
        registry.wire(address(facility), address(router));
        kya.wire(address(router), address(facility));
        rcn.wire(address(facility), address(router), address(swapRouter), aqua);
        facility.wire(address(swapRouter), address(router));
        vm.stopPrank();
        vm.deal(address(facility), 20 ether);

        _kyaRegister(vm.addr(BUYER_PK), keccak256("buyer-co"), 2, 3);
        for (uint256 i; i < 8; ++i) {
            _kyaRegister(vm.addr(SELLER_PK_BASE + i), keccak256("seller-co"), 1, 2);
        }

        handler = new FacilityHandler(
            usdc, registry, rcn, swapRouter, hss, facility, router, coordinator, BUYER_PK, SELLER_PK_BASE
        );
        assertEq(handler.MAX_IDS(), 8);

        bytes4[] memory selectors = new bytes4[](10);
        selectors[0] = FacilityHandler.openAndFund.selector;
        selectors[1] = FacilityHandler.setBudgets.selector;
        selectors[2] = FacilityHandler.reserve.selector;
        selectors[3] = FacilityHandler.commit.selector;
        selectors[4] = FacilityHandler.release.selector;
        selectors[5] = FacilityHandler.warp.selector;
        selectors[6] = FacilityHandler.markOverdue.selector;
        selectors[7] = FacilityHandler.markDefaulted.selector;
        selectors[8] = FacilityHandler.flagDispute.selector;
        selectors[9] = FacilityHandler.repay.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
    }

    // ------------------------------------------------------------------ invariants

    function invariant_debtNeverExceedsBorrowingBase() public view {
        assertEq(handler.fundingMismatch(), 0, "funding positions differ from the fills");
        uint256 outstandingTotal;
        uint256 n = handler.idsLength();
        for (uint256 k; k < n; ++k) {
            outstandingTotal += this.checkDebt(handler.ids(k));
        }
        assertEq(rcn.totalSupply(), outstandingTotal, "RCN supply != outstanding principal");
        address[3] memory lenders = handler.makerList();
        uint256 held;
        for (uint256 i; i < lenders.length; ++i) {
            held += rcn.balanceOf(lenders[i]);
        }
        assertEq(held, rcn.totalSupply(), "RCN held outside the lenders");
    }

    function invariant_budgetsNeverExceedFunded() public view {
        address[3] memory ws = handler.workerList();
        uint256 n = handler.idsLength();
        for (uint256 k; k < n; ++k) {
            bytes32 id = handler.ids(k);
            ICreditFacility.FacilityInfo memory info = facility.facilityInfo(id);
            uint256 allocSum;
            uint256 reservedSum;
            uint256 spentSum;
            for (uint256 i; i < ws.length; ++i) {
                ICreditFacility.Budget memory b = facility.budget(id, ws[i]);
                assertLe(b.spent + b.reserved, b.alloc, "worker used above its allocation");
                allocSum += b.alloc;
                reservedSum += b.reserved;
                spentSum += b.spent;
            }
            assertEq(facility.allocated(id), allocSum, "allocated != sum(alloc)");
            assertLe(allocSum, info.funded, "budgets exceed funded");
            assertEq(reservedSum, info.reserved, "sum(budget.reserved) != reserved");
            assertEq(spentSum, info.committed, "sum(budget.spent) != committed");
        }
    }

    function invariant_sellerGetsNothingWhileLendersOwed() public view {
        assertEq(handler.sellerPaidWhileOwed(), 0, "seller paid while lenders were owed");
        assertEq(handler.repayMismatch(), 0, "repayment split differs from the waterfall");
        assertEq(usdc.balanceOf(address(router)), 0, "router kept USDC");
        uint256 n = handler.idsLength();
        for (uint256 k; k < n; ++k) {
            bytes32 id = handler.ids(k);
            FacilityHandler.IdGhost memory g = handler.ghost(id);
            bool repaid = registry.state(id) == IReceivableRegistry.State.Repaid;
            bool closed = facility.facilityInfo(id).status == 3;
            assertEq(repaid, closed, "Repaid <=> Closed");
            if (!repaid) {
                assertEq(usdc.balanceOf(g.seller), 0, "seller holds USDC before lenders are whole");
                continue;
            }
            assertEq(router.lenderDue(id), 0, "lenders owed after Repaid");
            address[] memory ms = facility.makers(id);
            for (uint256 i; i < ms.length; ++i) {
                ICreditFacility.Position memory p = facility.position(id, ms[i]);
                assertEq(p.paidPrincipal, p.principal, "Repaid with principal outstanding");
            }
        }
    }

    function invariant_stateOnlyMovesForward() public view {
        assertEq(handler.badStateEdge(), 0, "registry state moved along a forbidden edge");
        assertEq(handler.badStatusEdge(), 0, "facility status moved along a forbidden edge");
        assertEq(handler.acceptedBadProbe(), 0, "early overdue/default or public release accepted");
        uint256 n = handler.idsLength();
        for (uint256 k; k < n; ++k) {
            bytes32 id = handler.ids(k);
            FacilityHandler.IdGhost memory g = handler.ghost(id);
            uint8 st = uint8(registry.state(id));
            uint8 status = facility.facilityInfo(id).status;
            assertTrue(handler.allowedStateEdge(g.lastState, st), "state edge");
            assertTrue(handler.allowedStatusEdge(g.lastStatus, status), "status edge");
            assertGe(st, uint8(IReceivableRegistry.State.Financed), "funded receivable not Financed or later");
            assertTrue(st != uint8(IReceivableRegistry.State.Cancelled), "funded receivable Cancelled");
            assertGe(status, 1, "funded facility without status");
        }
    }

    function invariant_committedPlusReservedPlusAvailableEqualsFunded() public view {
        uint256 availableSum;
        uint256 n = handler.idsLength();
        for (uint256 k; k < n; ++k) {
            bytes32 id = handler.ids(k);
            FacilityHandler.IdGhost memory g = handler.ghost(id);
            ICreditFacility.FacilityInfo memory info = facility.facilityInfo(id);
            assertEq(info.reserved, g.reserved, "reserved != sum(open reservations)");
            assertEq(info.committed, g.committed, "committed != sum(committed reservations)");
            if (info.status == 1 || info.status == 2) {
                uint256 avail = facility.available(id);
                assertEq(info.committed + info.reserved + avail, info.funded, "committed + reserved + available");
                availableSum += avail;
            } else {
                assertEq(facility.available(id), 0, "Closed facility reports availability");
            }
        }
        assertEq(usdc.balanceOf(address(facility)), availableSum, "facility USDC != sum(available)");

        FacilityHandler.OpenRes[] memory open = handler.openReservations();
        address[4] memory wallets = handler.walletList();
        for (uint256 w; w < wallets.length; ++w) {
            uint256 expected;
            bytes32 spendId;
            for (uint256 i; i < open.length; ++i) {
                if (open[i].wallet == wallets[w]) {
                    expected += open[i].amount;
                    spendId = open[i].spendId;
                }
            }
            assertEq(usdc.balanceOf(wallets[w]), expected, "spend wallet balance != open reservation");
            assertEq(facility.openReservationOf(wallets[w]), spendId, "openReservationOf");
        }
    }

    /// @dev Coverage totals across runs, only with `INVARIANT_COVERAGE=true` (see `FacilityHandler.reportCoverage`).
    function afterInvariant() external {
        if (vm.envOr("INVARIANT_COVERAGE", false)) handler.reportCoverage();
    }

    // ------------------------------------------------------------------ helpers

    /// @return outstanding The receivable's unpaid principal, after checking it against the borrowing base.
    /// @dev External (called through `this`) so via-IR does not inline it into the invariant's stack frame.
    function checkDebt(bytes32 id) external view returns (uint256 outstanding) {
        FacilityHandler.IdGhost memory g = handler.ghost(id);
        ICreditFacility.FacilityInfo memory info = facility.facilityInfo(id);
        address[] memory ms = facility.makers(id);
        uint256 principalSum;
        for (uint256 i; i < ms.length; ++i) {
            ICreditFacility.Position memory p = facility.position(id, ms[i]);
            assertLe(p.paidPrincipal, p.principal, "paid more principal than lent");
            principalSum += p.principal;
            outstanding += p.principal - p.paidPrincipal;
        }
        assertEq(principalSum, info.funded, "sum(principal) != funded");
        assertEq(info.funded, g.funded, "funded != ghost");
        assertLe(info.funded, info.receivableAmount * g.advanceBps / 10_000, "debt above borrowing base");
        assertLe(info.funded, g.limit, "debt above limit");
        assertEq(g.dueAtFunding, g.expectedDueAtFunding, "lenderDue at funding != principal + min-term fee");
        assertGe(g.dueAtFunding, principalSum, "lenderDue at funding below principal");
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
}
