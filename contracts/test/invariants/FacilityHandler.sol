// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { console } from "forge-std/console.sol";
import { ISwapVM } from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/contracts/libs/MakerTraits.sol";
import { ReceivableRegistry } from "../../src/core/ReceivableRegistry.sol";
import { IReceivableRegistry } from "../../src/core/interfaces/IReceivableRegistry.sol";
import { ReceivableCreditNote } from "../../src/core/ReceivableCreditNote.sol";
import { CreditFacility } from "../../src/core/CreditFacility.sol";
import { ICreditFacility } from "../../src/core/interfaces/ICreditFacility.sol";
import { RepaymentRouter } from "../../src/core/RepaymentRouter.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { MockSwapRouter } from "../mocks/MockSwapRouter.sol";
import { MockHSS } from "../mocks/MockHSS.sol";

/// @notice Drives the real registry, RCN, facility and repayment router through random sequences of
///         funding, budgets, two-phase spend, time, overdue/default and repayment, and keeps the ghost
///         state `FacilityInvariants.t.sol` checks against.
/// @dev Inputs are guarded so calls do not revert (`fail_on_revert = false` would hide reverts anyway). Some
///      calls are unguarded probes sent through try/catch, which the contracts must reject: one in eight of
///      `openAndFund` (fills one unit above the borrowing base), `setBudgets` (allocation up to twice `funded`)
///      and `reserve` (amount up to `funded + 1`); a public `release` inside the grace period; `markOverdue` /
///      `markDefaulted` when nothing has reached its threshold. A probe the contract accepts is recorded like a
///      normal call (or counted in `acceptedBadProbe`), so the invariants judge its consequences.
///      `vm.warp` is re-applied from `currentTime` at the start of every action, so time only moves through
///      `warp` and persists across the sequence.
///      Every receivable has its own seller (sellers are pre-registered in KYA by the test), so a seller's
///      USDC balance is attributable to exactly one receivable.
contract FacilityHandler is Test {
    uint256 public constant MAX_IDS = 8;
    uint256 internal constant N_MAKERS = 3;
    uint256 internal constant N_WORKERS = 3;
    uint256 internal constant N_WALLETS = 4;
    uint256 internal constant N_MERCHANTS = 3;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant OVERDUE_AFTER = 7 days;
    uint256 internal constant DEFAULT_AFTER = 30 days;

    uint8 internal constant STATUS_ACTIVE = 1;
    uint8 internal constant STATUS_FROZEN = 2;
    uint8 internal constant STATUS_CLOSED = 3;

    MockUSDC public usdc;
    ReceivableRegistry public registry;
    ReceivableCreditNote public rcn;
    MockSwapRouter public swapRouter;
    MockHSS public hss;
    CreditFacility public facility;
    RepaymentRouter public router;
    address public coordinator;
    uint256 internal buyerPk;
    uint256 internal sellerPkBase;
    address public buyer;
    address public stranger;

    address[N_MAKERS] public makers;
    address[N_WORKERS] public workers;
    address[N_WALLETS] public wallets;
    address[N_MERCHANTS] public merchants;

    /// @notice Per-receivable ghost state.
    struct IdGhost {
        address seller;
        uint256 amount;
        uint16 advanceBps;
        uint256 limit;
        uint256 funded;
        /// @dev `router.lenderDue(id)` read right after funding, and what it must equal:
        ///      sum(principal) + sum(feeOf(principal, apr, start, start)) (the minimum-term fee).
        uint256 dueAtFunding;
        uint256 expectedDueAtFunding;
        /// @dev Ghost sums of Open and Committed reservation amounts.
        uint256 reserved;
        uint256 committed;
        /// @dev Last seen registry state, facility status and seller USDC balance.
        uint8 lastState;
        uint8 lastStatus;
        uint256 sellerBal;
    }

    struct OpenRes {
        bytes32 spendId;
        bytes32 id;
        address wallet;
        address merchant;
        uint256 amount;
        uint64 expiry;
    }

    bytes32[] public ids;
    mapping(bytes32 => IdGhost) internal _ghost;
    OpenRes[] internal _open;
    uint256 internal _spendNonce;
    uint256 internal _poNonce;

    uint256 public currentTime;

    // ---- violations (each must stay zero) ----
    /// @dev A seller's balance changed in an action that was not a repayment / Closed-facility release of
    ///      that seller's receivable, or while that receivable was not Repaid, or it went down.
    uint256 public sellerPaidWhileOwed;
    /// @dev A repayment's split differed from the waterfall computed before the call.
    uint256 public repayMismatch;
    /// @dev Funding produced positions or a funding-time lenderDue different from the fills.
    uint256 public fundingMismatch;
    uint256 public badStateEdge;
    uint256 public badStatusEdge;
    /// @dev A probe the contract should have rejected was accepted (early overdue/default, public release
    ///      inside the grace period).
    uint256 public acceptedBadProbe;

    // ---- coverage counters ----
    uint256 public nFunded;
    uint256 public nFundedMakers;
    uint256 public nBudgets;
    uint256 public nReserved;
    uint256 public nCommitted;
    uint256 public nCommittedAfterExpiry;
    uint256 public nCommittedOnClosed;
    uint256 public nReleasedByCoordinator;
    uint256 public nReleasedPublic;
    uint256 public nReleasedOnClosed;
    uint256 public nWarps;
    uint256 public nOverdue;
    uint256 public nOverdueScheduled;
    uint256 public nDefaulted;
    uint256 public nDefaultedScheduled;
    uint256 public nDisputes;
    uint256 public nRepayPartial;
    uint256 public nRepayFull;
    uint256 public nRepayAfterRepaid;
    uint256 public nRepayWhileOverdueOrDefaulted;
    uint256 public nProbesRejected;
    uint256 public nProbesAccepted;

    constructor(
        MockUSDC usdc_,
        ReceivableRegistry registry_,
        ReceivableCreditNote rcn_,
        MockSwapRouter swapRouter_,
        MockHSS hss_,
        CreditFacility facility_,
        RepaymentRouter router_,
        address coordinator_,
        uint256 buyerPk_,
        uint256 sellerPkBase_
    ) {
        usdc = usdc_;
        registry = registry_;
        rcn = rcn_;
        swapRouter = swapRouter_;
        hss = hss_;
        facility = facility_;
        router = router_;
        coordinator = coordinator_;
        buyerPk = buyerPk_;
        sellerPkBase = sellerPkBase_;
        buyer = vm.addr(buyerPk_);
        stranger = makeAddr("inv.stranger");
        currentTime = block.timestamp;

        for (uint256 i; i < N_MAKERS; ++i) {
            makers[i] = makeAddr(string.concat("inv.lender", vm.toString(i)));
        }
        for (uint256 i; i < N_WORKERS; ++i) {
            workers[i] = makeAddr(string.concat("inv.worker", vm.toString(i)));
        }
        for (uint256 i; i < N_MERCHANTS; ++i) {
            merchants[i] = makeAddr(string.concat("inv.merchant", vm.toString(i)));
        }
        for (uint256 i; i < N_WALLETS; ++i) {
            wallets[i] = makeAddr(string.concat("inv.wallet", vm.toString(i)));
            // Standing allowance the facility pulls released reservations back with.
            vm.prank(wallets[i]);
            usdc.approve(address(facility_), type(uint256).max);
        }
        vm.prank(buyer);
        usdc.approve(address(router_), type(uint256).max);
    }

    modifier useTime() {
        vm.warp(currentTime);
        _;
    }

    // ================================================================== actions

    /// @notice Registers a fresh receivable (own seller) and funds it through 1-3 lender fills, cheapest first,
    ///         within the borrowing base. One call in eight is a probe whose fills total one unit above the
    ///         borrowing base: it must revert (the receivable then stays Confirmed and untracked).
    function openAndFund(
        uint256 amountSeed,
        uint256 dueSeed,
        uint256 advSeed,
        uint256 nSeed,
        uint256 makerSeed,
        uint256[3] calldata fillSeeds,
        uint16[3] calldata aprSeeds,
        uint256 limitSeed
    ) external useTime {
        if (ids.length >= MAX_IDS) return;

        uint256 amount = _bound(amountSeed, 1_000_000, 100_000_000_000); // 1 .. 100,000 USDC
        uint16 adv = uint16(_bound(advSeed, 100, BPS));
        uint256 base = amount * adv / BPS;
        ICreditFacility.Fill[] memory fills = _buildFills(base, nSeed, makerSeed, fillSeeds, aprSeeds);
        bool probe = uint256(keccak256(abi.encode(nSeed, dueSeed))) % 8 == 0;
        if (probe) fills[fills.length - 1].amount += base + 1 - _sumFills(fills);
        uint256 total = _sumFills(fills);
        uint256 limit = total + _bound(limitSeed, 0, amount);
        // Mostly short tenors; one in four up to 70 days (overdue and/or default beyond the HSS horizon).
        uint64 due = uint64(
            block.timestamp
                + (dueSeed % 4 == 0 ? _bound(dueSeed / 4, 1 days + 1, 70 days) : _bound(dueSeed / 4, 1 days + 1, 14 days))
        );
        bytes32 id = _registerWithGhost(amount, due, adv, limit, total);

        swapRouter.fund(address(usdc), total);
        vm.prank(coordinator);
        if (probe) {
            try facility.openAndFund(id, fills, adv, limit) {
                nProbesAccepted++;
            } catch {
                nProbesRejected++;
                ids.pop();
                delete _ghost[id];
                return;
            }
        } else {
            facility.openAndFund(id, fills, adv, limit);
        }

        _checkFunding(id, fills, total);
        uint256 budgetSeed = uint256(keccak256(abi.encode(limitSeed, amountSeed)));
        if (budgetSeed % 4 != 0) _initialBudgets(id, total, budgetSeed);
        nFunded++;
        nFundedMakers += fills.length;
        _afterAction(bytes32(0));
    }

    /// @notice The seller sets 1-3 workers' budgets within what the facility can still allocate. One call in
    ///         eight is an unguarded probe with an allocation of up to twice `funded`.
    function setBudgets(
        uint256 idSeed,
        uint256 maskSeed,
        uint256[3] calldata allocSeeds,
        uint256[3] calldata txSeeds,
        uint256[3] calldata dailySeeds,
        uint256[3] calldata merchantSeeds,
        uint256 probeSeed
    ) external useTime {
        (bytes32 id, bool found) = _pickActive(idSeed, false);
        if (!found) return;
        IdGhost storage g = _ghost[id];

        uint256 mask = _bound(maskSeed, 1, 7);
        uint256 count;
        for (uint256 i; i < N_WORKERS; ++i) {
            if ((mask >> i) & 1 != 0) count++;
        }
        address[] memory ws = new address[](count);
        uint256[] memory allocs = new uint256[](count);
        ICreditFacility.Limits[] memory limits = new ICreditFacility.Limits[](count);

        // Room left for the chosen workers: funded minus everyone else's allocations, minus what they used.
        uint256 other = facility.allocated(id);
        uint256 used;
        uint256 k;
        for (uint256 i; i < N_WORKERS; ++i) {
            if ((mask >> i) & 1 == 0) continue;
            ICreditFacility.Budget memory b = facility.budget(id, workers[i]);
            other -= b.alloc;
            used += b.spent + b.reserved;
            ws[k++] = workers[i];
        }
        uint256 free = g.funded - other - used;

        k = 0;
        for (uint256 i; i < N_WORKERS; ++i) {
            if ((mask >> i) & 1 == 0) continue;
            ICreditFacility.Budget memory b = facility.budget(id, workers[i]);
            uint256 extra = _bound(allocSeeds[i], 0, free);
            free -= extra;
            allocs[k] = b.spent + b.reserved + extra;
            uint256 maxPerTx = _bound(txSeeds[i], 1, allocs[k] + 1);
            limits[k] = ICreditFacility.Limits({
                maxPerTx: maxPerTx,
                maxDaily: _bound(dailySeeds[i], maxPerTx, 4 * maxPerTx),
                merchants: _merchantList(merchantSeeds[i])
            });
            k++;
        }

        if (probeSeed % 8 == 0) {
            allocs[0] = _bound(allocSeeds[0], 0, 2 * g.funded);
            vm.prank(g.seller);
            try facility.setBudgets(id, ws, allocs, limits) {
                nProbesAccepted++;
            } catch {
                nProbesRejected++;
            }
        } else {
            vm.prank(g.seller);
            facility.setBudgets(id, ws, allocs, limits);
            nBudgets++;
        }
        _afterAction(bytes32(0));
    }

    /// @notice The coordinator reserves spend for a worker through a free spend wallet, within the worker's
    ///         budget, per-tx and daily limits, to an allowed merchant. One call in eight is an unguarded probe
    ///         with an amount of up to `funded + 1`.
    function reserve(
        uint256 idSeed,
        uint256 workerSeed,
        uint256 walletSeed,
        uint256 merchantSeed,
        uint256 amountSeed,
        uint256 expirySeed,
        uint256 probeSeed
    ) external useTime {
        (bytes32 id, bool found) = _pickActive(idSeed, true);
        if (!found) return;
        ICreditFacility.FacilityInfo memory info = facility.facilityInfo(id);

        address wallet;
        for (uint256 i; i < N_WALLETS; ++i) {
            address w = wallets[(walletSeed % N_WALLETS + i) % N_WALLETS];
            if (facility.openReservationOf(w) == bytes32(0)) {
                wallet = w;
                break;
            }
        }
        if (wallet == address(0)) return;

        // First worker from the seed with merchants and headroom (or the seed's worker for a probe).
        address worker = workers[workerSeed % N_WORKERS];
        uint256 cap;
        for (uint256 i; i < N_WORKERS; ++i) {
            address w = workers[(workerSeed % N_WORKERS + i) % N_WORKERS];
            uint256 c = _capOf(id, w);
            if (c != 0 && facility.merchants(id, w).length != 0) {
                (worker, cap) = (w, c);
                break;
            }
        }
        address[] memory allowed = facility.merchants(id, worker);
        if (allowed.length == 0) return;
        address merchant = allowed[merchantSeed % allowed.length];

        uint64 expiry = uint64(block.timestamp + _bound(expirySeed, 1 minutes, 2 days));
        bytes32 spendId = keccak256(abi.encode("inv-spend", ++_spendNonce));

        if (probeSeed % 8 == 0) {
            uint256 amount = _bound(amountSeed, 1, info.funded + 1);
            vm.prank(coordinator);
            try facility.reserve(id, spendId, worker, wallet, merchant, amount, expiry) {
                nProbesAccepted++;
                _recordReservation(spendId, id, wallet, merchant, amount, expiry);
            } catch {
                nProbesRejected++;
            }
        } else {
            if (cap == 0) return;
            uint256 amount = _bound(amountSeed, 1, cap);
            vm.prank(coordinator);
            facility.reserve(id, spendId, worker, wallet, merchant, amount, expiry);
            _recordReservation(spendId, id, wallet, merchant, amount, expiry);
            nReserved++;
        }
        _afterAction(bytes32(0));
    }

    /// @notice The spend wallet pays the merchant, then the coordinator commits the reservation (allowed after
    ///         the expiry and on a Closed facility too).
    function commit(uint256 resSeed, bytes32 txIdHash) external useTime {
        if (_open.length == 0) return;
        uint256 i = resSeed % _open.length;
        OpenRes memory r = _open[i];
        uint8 status = facility.facilityInfo(r.id).status;

        vm.prank(r.wallet);
        assertTrue(usdc.transfer(r.merchant, r.amount));
        vm.prank(coordinator);
        facility.commit(r.spendId, txIdHash);

        IdGhost storage g = _ghost[r.id];
        g.reserved -= r.amount;
        g.committed += r.amount;
        _removeOpen(i);
        nCommitted++;
        if (block.timestamp > r.expiry) nCommittedAfterExpiry++;
        if (status == STATUS_CLOSED) nCommittedOnClosed++;
        _afterAction(bytes32(0));
    }

    /// @notice Releases an open reservation: publicly once `expiry + RELEASE_GRACE` has passed, otherwise by the
    ///         coordinator. A public attempt inside the grace period is a probe that must be rejected.
    function release(uint256 resSeed, uint256 publicSeed) external useTime {
        if (_open.length == 0) return;
        uint256 i = resSeed % _open.length;
        // Half the time prefer a reservation whose facility has Closed (its USDC goes on to the seller).
        if (resSeed / _open.length % 2 == 0) {
            for (uint256 k; k < _open.length; ++k) {
                if (facility.facilityInfo(_open[k].id).status == STATUS_CLOSED) {
                    i = k;
                    break;
                }
            }
        }
        OpenRes memory r = _open[i];
        bool graceOver = block.timestamp > uint256(r.expiry) + facility.RELEASE_GRACE();
        bool wantPublic = publicSeed % 2 == 0;

        if (wantPublic && !graceOver) {
            vm.prank(stranger);
            try facility.release(r.spendId) {
                acceptedBadProbe++;
                _ghost[r.id].reserved -= r.amount;
                _removeOpen(i);
            } catch {
                nProbesRejected++;
            }
            _afterAction(bytes32(0));
            return;
        }

        bool closed = facility.facilityInfo(r.id).status == STATUS_CLOSED;
        vm.prank(wantPublic ? stranger : coordinator);
        facility.release(r.spendId);
        _ghost[r.id].reserved -= r.amount;
        _removeOpen(i);
        if (wantPublic) nReleasedPublic++;
        else nReleasedByCoordinator++;
        if (closed) nReleasedOnClosed++;
        // On a Closed facility the released USDC goes on to that receivable's seller.
        _afterAction(closed ? r.id : bytes32(0));
    }

    function warp(uint256 dtSeed) external {
        // Three steps in four are short (spend activity), one is long (overdue and default thresholds).
        currentTime += dtSeed % 4 == 0 ? _bound(dtSeed / 4, 1 days, 40 days) : _bound(dtSeed / 4, 1 minutes, 1 days);
        vm.warp(currentTime);
        nWarps++;
        _afterAction(bytes32(0));
    }

    /// @notice Overdue check once due, permissionless or through the scheduled call; before the threshold it
    ///         is a probe that must revert.
    function markOverdue(uint256 idSeed, bool viaSchedule) external useTime {
        (bytes32 id, bool found) = _pickCheckable(idSeed, OVERDUE_AFTER, false);
        if (!found) return;
        ICreditFacility.FacilityInfo memory info = facility.facilityInfo(id);

        if (block.timestamp < uint256(info.dueDate) + OVERDUE_AFTER) {
            vm.prank(stranger);
            try facility.markOverdue(id) {
                acceptedBadProbe++;
            } catch {
                nProbesRejected++;
            }
        } else if (viaSchedule && _pending(info.overdueSchedule)) {
            hss.fire(info.overdueSchedule);
            nOverdue++;
            nOverdueScheduled++;
        } else {
            vm.prank(stranger);
            facility.markOverdue(id);
            nOverdue++;
        }
        _afterAction(bytes32(0));
    }

    /// @notice Default check once 30 days past due, permissionless or through the scheduled call; before the
    ///         threshold it is a probe that must revert.
    function markDefaulted(uint256 idSeed, bool viaSchedule) external useTime {
        (bytes32 id, bool found) = _pickCheckable(idSeed, DEFAULT_AFTER, true);
        if (!found) return;
        ICreditFacility.FacilityInfo memory info = facility.facilityInfo(id);

        if (block.timestamp < uint256(info.dueDate) + DEFAULT_AFTER) {
            vm.prank(stranger);
            try facility.markDefaulted(id) {
                acceptedBadProbe++;
            } catch {
                nProbesRejected++;
            }
        } else if (viaSchedule && _pending(info.defaultSchedule)) {
            hss.fire(info.defaultSchedule);
            nDefaulted++;
            nDefaultedScheduled++;
        } else {
            vm.prank(stranger);
            facility.markDefaulted(id);
            nDefaulted++;
        }
        _afterAction(bytes32(0));
    }

    /// @notice Seller, buyer or coordinator freezes an Active facility (one call in eight acts, so most
    ///      facilities stay open for spend).
    function flagDispute(uint256 idSeed, uint256 whoSeed) external useTime {
        if (ids.length == 0 || whoSeed % 8 != 0) return;
        bytes32 id = ids[idSeed % ids.length];
        if (facility.facilityInfo(id).status != STATUS_ACTIVE) return;
        uint256 who = (whoSeed / 8) % 3;
        vm.prank(who == 0 ? _ghost[id].seller : who == 1 ? buyer : coordinator);
        facility.flagDispute(id);
        nDisputes++;
        _afterAction(bytes32(0));
    }

    /// @notice The buyer repays through the real router: partial (below what lenders are owed), exactly what
    ///         they are owed, or more; on a Repaid receivable any amount. Checks the split against the
    ///         waterfall computed beforehand.
    function repay(uint256 idSeed, uint256 amountSeed, uint256 modeSeed) external useTime {
        if (ids.length == 0) return;
        bytes32 id = ids[idSeed % ids.length];
        IdGhost storage g = _ghost[id];
        IReceivableRegistry.State s = registry.state(id);
        if (
            s != IReceivableRegistry.State.Financed && s != IReceivableRegistry.State.Overdue
                && s != IReceivableRegistry.State.Defaulted && s != IReceivableRegistry.State.Repaid
        ) return;

        uint256 due0 = router.lenderDue(id);
        // Half partial, a quarter exact, a quarter overpaying (the surplus goes to the seller).
        uint256 mode = modeSeed % 4;
        uint256 amount;
        if (s == IReceivableRegistry.State.Repaid) amount = _bound(amountSeed, 1, g.amount);
        else if (mode <= 1 && due0 > 1) amount = _bound(amountSeed, 1, due0 - 1);
        else if (mode <= 2) amount = due0;
        else amount = due0 + _bound(amountSeed, 1, g.amount);

        address[] memory ms = facility.makers(id);
        uint256[] memory makerBal0 = new uint256[](ms.length);
        uint256[] memory makerDue0 = new uint256[](ms.length);
        for (uint256 i; i < ms.length; ++i) {
            makerBal0[i] = usdc.balanceOf(ms[i]);
            (uint256 p, uint256 f) = router.dueOf(id, ms[i]);
            makerDue0[i] = p + f;
        }
        ICreditFacility.FacilityInfo memory info0 = facility.facilityInfo(id);
        uint256 sellerBal0 = usdc.balanceOf(g.seller);

        usdc.mint(buyer, amount);
        vm.prank(buyer);
        router.repay(id, amount);

        // Expected split.
        uint256 toLenders = amount < due0 ? amount : due0;
        uint256 paidToLenders;
        for (uint256 i; i < ms.length; ++i) {
            uint256 got = usdc.balanceOf(ms[i]) - makerBal0[i];
            if (got > makerDue0[i]) repayMismatch++;
            paidToLenders += got;
        }
        uint256 sellerGot = usdc.balanceOf(g.seller) - sellerBal0;
        bool repaidNow = registry.state(id) == IReceivableRegistry.State.Repaid;
        if (s == IReceivableRegistry.State.Repaid) {
            if (paidToLenders != 0 || sellerGot != amount) repayMismatch++;
            nRepayAfterRepaid++;
        } else if (amount >= due0) {
            uint256 undrawn = info0.funded - info0.committed - info0.reserved;
            if (paidToLenders != toLenders || sellerGot != amount - due0 + undrawn || !repaidNow) repayMismatch++;
            if (facility.facilityInfo(id).status != STATUS_CLOSED || router.lenderDue(id) != 0) repayMismatch++;
            nRepayFull++;
            if (s != IReceivableRegistry.State.Financed) nRepayWhileOverdueOrDefaulted++;
        } else {
            if (paidToLenders != amount || sellerGot != 0 || repaidNow) repayMismatch++;
            if (router.lenderDue(id) != due0 - amount) repayMismatch++;
            nRepayPartial++;
            if (s != IReceivableRegistry.State.Financed) nRepayWhileOverdueOrDefaulted++;
        }
        if (usdc.balanceOf(address(router)) != 0) repayMismatch++;
        _afterAction(id);
    }

    // ================================================================== views for the invariants

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    function ghost(bytes32 id) external view returns (IdGhost memory) {
        return _ghost[id];
    }

    function openReservations() external view returns (OpenRes[] memory) {
        return _open;
    }

    function walletList() external view returns (address[N_WALLETS] memory) {
        return wallets;
    }

    function workerList() external view returns (address[N_WORKERS] memory) {
        return workers;
    }

    function makerList() external view returns (address[N_MAKERS] memory) {
        return makers;
    }

    /// @notice Registry edges a receivable may take (plus staying put).
    function allowedStateEdge(uint8 from, uint8 to) public pure returns (bool) {
        if (from == to) return true;
        IReceivableRegistry.State f = IReceivableRegistry.State(from);
        IReceivableRegistry.State t = IReceivableRegistry.State(to);
        if (f == IReceivableRegistry.State.None) return t == IReceivableRegistry.State.Confirmed;
        if (f == IReceivableRegistry.State.Confirmed) {
            return t == IReceivableRegistry.State.Financed || t == IReceivableRegistry.State.Cancelled;
        }
        if (f == IReceivableRegistry.State.Financed) {
            return t == IReceivableRegistry.State.Overdue || t == IReceivableRegistry.State.Defaulted
                || t == IReceivableRegistry.State.Repaid;
        }
        if (f == IReceivableRegistry.State.Overdue) {
            return t == IReceivableRegistry.State.Defaulted || t == IReceivableRegistry.State.Repaid;
        }
        if (f == IReceivableRegistry.State.Defaulted) return t == IReceivableRegistry.State.Repaid;
        return false; // Repaid and Cancelled are terminal
    }

    /// @notice Facility status edges: None -> Active -> Frozen -> Closed, Active -> Closed (plus staying put).
    function allowedStatusEdge(uint8 from, uint8 to) public pure returns (bool) {
        if (from == to) return true;
        if (from == 0) return to == STATUS_ACTIVE;
        if (from == STATUS_ACTIVE) return to == STATUS_FROZEN || to == STATUS_CLOSED;
        if (from == STATUS_FROZEN) return to == STATUS_CLOSED;
        return false;
    }

    /// @notice Adds this run's coverage counters to running totals kept in process environment variables
    ///         (`INVCOV_<name>` = total, `INVCOV_RUNS_<name>` = runs in which it was non-zero) and logs them, so
    ///         the last run's log shows totals over every run of the test. Run one invariant at a time with
    ///         `INVARIANT_COVERAGE=true forge test --match-test <invariant> -vv`.
    function reportCoverage() external {
        string[24] memory names = [
            "runs",
            "ids",
            "funded",
            "fundedMakers",
            "budgets",
            "reserved",
            "committed",
            "committedAfterExpiry",
            "committedOnClosed",
            "releasedByCoordinator",
            "releasedPublic",
            "releasedOnClosed",
            "warps",
            "overdue",
            "overdueScheduled",
            "defaulted",
            "defaultedScheduled",
            "disputes",
            "repayPartial",
            "repayFull",
            "repayAfterRepaid",
            "repayWhileOverdueOrDefaulted",
            "probesRejected",
            "probesAccepted"
        ];
        uint256[24] memory values = [
            uint256(1),
            ids.length,
            nFunded,
            nFundedMakers,
            nBudgets,
            nReserved,
            nCommitted,
            nCommittedAfterExpiry,
            nCommittedOnClosed,
            nReleasedByCoordinator,
            nReleasedPublic,
            nReleasedOnClosed,
            nWarps,
            nOverdue,
            nOverdueScheduled,
            nDefaulted,
            nDefaultedScheduled,
            nDisputes,
            nRepayPartial,
            nRepayFull,
            nRepayAfterRepaid,
            nRepayWhileOverdueOrDefaulted,
            nProbesRejected,
            nProbesAccepted
        ];
        for (uint256 i; i < names.length; ++i) {
            string memory key = string.concat("INVCOV_", names[i]);
            string memory runsKey = string.concat("INVCOV_RUNS_", names[i]);
            uint256 total = vm.envOr(key, uint256(0)) + values[i];
            uint256 runs = vm.envOr(runsKey, uint256(0)) + (values[i] != 0 ? 1 : 0);
            // forge-lint: disable-next-line(unsafe-cheatcode)
            vm.setEnv(key, vm.toString(total));
            // forge-lint: disable-next-line(unsafe-cheatcode)
            vm.setEnv(runsKey, vm.toString(runs));
            console.log(string.concat("coverage ", names[i], " total=", vm.toString(total), " runs=", vm.toString(runs)));
        }
    }

    // ================================================================== internal

    /// @dev First Active facility from the seed (and before its due date when `beforeDue`).
    function _pickActive(uint256 seed, bool beforeDue) internal view returns (bytes32 id, bool found) {
        uint256 n = ids.length;
        for (uint256 k; k < n; ++k) {
            id = ids[(seed % n + k) % n];
            ICreditFacility.FacilityInfo memory info = facility.facilityInfo(id);
            if (info.status == STATUS_ACTIVE && (!beforeDue || block.timestamp < info.dueDate)) return (id, true);
        }
        return (bytes32(0), false);
    }

    /// @dev For the overdue (`orOverdue = false`: Financed only) and default (Financed or Overdue) checks: the
    ///      first open facility from the seed whose threshold `dueDate + after` has passed; failing that, the
    ///      first eligible one that is not yet due (the caller probes it).
    function _pickCheckable(uint256 seed, uint256 after_, bool orOverdue) internal view returns (bytes32, bool) {
        uint256 n = ids.length;
        bytes32 early;
        bool haveEarly;
        for (uint256 k; k < n; ++k) {
            bytes32 id = ids[(seed % n + k) % n];
            IReceivableRegistry.State s = registry.state(id);
            if (s != IReceivableRegistry.State.Financed && !(orOverdue && s == IReceivableRegistry.State.Overdue)) {
                continue;
            }
            ICreditFacility.FacilityInfo memory info = facility.facilityInfo(id);
            if (info.status != STATUS_ACTIVE && info.status != STATUS_FROZEN) continue;
            if (block.timestamp >= uint256(info.dueDate) + after_) return (id, true);
            if (!haveEarly) (early, haveEarly) = (id, true);
        }
        return (early, haveEarly);
    }

    /// @dev What `reserve` would accept for `worker` now: min(budget left, per-tx limit, daily room).
    function _capOf(bytes32 id, address worker) internal view returns (uint256 cap) {
        ICreditFacility.Budget memory b = facility.budget(id, worker);
        uint256 dailySpent = block.timestamp >= uint256(b.dayStart) + 1 days ? 0 : b.dailySpent;
        cap = b.alloc - b.spent - b.reserved;
        if (b.maxPerTx < cap) cap = b.maxPerTx;
        uint256 dailyRoom = b.maxDaily > dailySpent ? b.maxDaily - dailySpent : 0;
        if (dailyRoom < cap) cap = dailyRoom;
    }

    /// @dev 1-3 fills against distinct lenders, APRs ascending (cheapest first), amounts summing to a total in
    ///      [n, base] with every fill >= 1. Sets each lender's APR on the mock router.
    function _buildFills(
        uint256 base,
        uint256 nSeed,
        uint256 makerSeed,
        uint256[3] calldata fillSeeds,
        uint16[3] calldata aprSeeds
    ) internal returns (ICreditFacility.Fill[] memory fills) {
        uint256 n = _bound(nSeed, 1, N_MAKERS);
        uint256[] memory amounts = new uint256[](n);
        uint256 remaining = _bound(fillSeeds[0], n, base);
        for (uint256 i; i + 1 < n; ++i) {
            amounts[i] = _bound(fillSeeds[i + 1], 1, remaining - (n - 1 - i));
            remaining -= amounts[i];
        }
        amounts[n - 1] = remaining;

        uint16[] memory aprs = new uint16[](n);
        for (uint256 i; i < n; ++i) {
            aprs[i] = uint16(_bound(aprSeeds[i], 0, 5000));
        }
        for (uint256 i = 1; i < n; ++i) {
            for (uint256 j = i; j > 0 && aprs[j - 1] > aprs[j]; --j) {
                (aprs[j - 1], aprs[j]) = (aprs[j], aprs[j - 1]);
            }
        }

        fills = new ICreditFacility.Fill[](n);
        for (uint256 i; i < n; ++i) {
            address maker = makers[(makerSeed % N_MAKERS + i) % N_MAKERS];
            swapRouter.setAprBps(maker, aprs[i]);
            fills[i] = ICreditFacility.Fill({ order: _order(maker), amount: amounts[i], aprBps: aprs[i] });
        }
    }

    /// @dev Registers the next receivable (own seller) and starts its ghost record.
    function _registerWithGhost(uint256 amount, uint64 due, uint16 adv, uint256 limit, uint256 total)
        internal
        returns (bytes32 id)
    {
        uint256 index = ids.length;
        address seller = vm.addr(sellerPkBase + index);
        id = _register(seller, amount, due, keccak256(abi.encode("inv-PO", ++_poNonce)));
        ids.push(id);
        IdGhost storage g = _ghost[id];
        g.seller = seller;
        g.amount = amount;
        g.advanceBps = adv;
        g.limit = limit;
        g.funded = total;
        g.sellerBal = usdc.balanceOf(seller);
        _syncEdges(id, g);
    }

    function _sumFills(ICreditFacility.Fill[] memory fills) internal pure returns (uint256 total) {
        for (uint256 i; i < fills.length; ++i) {
            total += fills[i].amount;
        }
    }

    /// @dev The seller's opening budgets (three funded receivables in four): every worker gets a random share
    ///      of a quarter of `funded`, per-tx up to its allocation, daily up to twice that, every merchant.
    function _initialBudgets(bytes32 id, uint256 funded, uint256 seed) internal {
        address[] memory ws = new address[](N_WORKERS);
        uint256[] memory allocs = new uint256[](N_WORKERS);
        ICreditFacility.Limits[] memory limits = new ICreditFacility.Limits[](N_WORKERS);
        address[] memory all = new address[](N_MERCHANTS);
        for (uint256 i; i < N_MERCHANTS; ++i) {
            all[i] = merchants[i];
        }
        for (uint256 i; i < N_WORKERS; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            ws[i] = workers[i];
            allocs[i] = _bound(seed, 0, funded / 4);
            uint256 maxPerTx = _bound(seed >> 128, 1, allocs[i] + 1);
            limits[i] = ICreditFacility.Limits({ maxPerTx: maxPerTx, maxDaily: 2 * maxPerTx, merchants: all });
        }
        vm.prank(_ghost[id].seller);
        facility.setBudgets(id, ws, allocs, limits);
        nBudgets++;
    }

    /// @dev Positions match the fills, and `lenderDue` right after funding is principal plus min-term fees.
    function _checkFunding(bytes32 id, ICreditFacility.Fill[] memory fills, uint256 total) internal {
        uint256 principalSum;
        uint256 expected;
        for (uint256 i; i < fills.length; ++i) {
            ICreditFacility.Position memory p = facility.position(id, fills[i].order.maker);
            principalSum += p.principal;
            if (p.principal != fills[i].amount || p.aprBps != fills[i].aprBps || p.start != block.timestamp) {
                fundingMismatch++;
            }
            expected += p.principal + router.feeOf(p.principal, p.aprBps, p.start, p.start);
        }
        if (principalSum != total || facility.facilityInfo(id).funded != total) fundingMismatch++;
        IdGhost storage g = _ghost[id];
        g.dueAtFunding = router.lenderDue(id);
        g.expectedDueAtFunding = expected;
    }

    /// @dev After every action: attribute any seller balance change, and check every receivable's registry
    ///      state and facility status moved only along allowed edges. `payableId` is the one receivable whose
    ///      seller this action may pay (its repayment, or a release on its Closed facility).
    function _afterAction(bytes32 payableId) internal {
        for (uint256 i; i < ids.length; ++i) {
            bytes32 id = ids[i];
            IdGhost storage g = _ghost[id];
            uint256 bal = usdc.balanceOf(g.seller);
            if (bal != g.sellerBal) {
                if (
                    bal < g.sellerBal || id != payableId
                        || registry.state(id) != IReceivableRegistry.State.Repaid
                ) sellerPaidWhileOwed++;
                g.sellerBal = bal;
            }
            _syncEdges(id, g);
        }
    }

    function _syncEdges(bytes32 id, IdGhost storage g) internal {
        uint8 st = uint8(registry.state(id));
        if (st != g.lastState) {
            if (!allowedStateEdge(g.lastState, st)) badStateEdge++;
            g.lastState = st;
        }
        uint8 status = facility.facilityInfo(id).status;
        if (status != g.lastStatus) {
            if (!allowedStatusEdge(g.lastStatus, status)) badStatusEdge++;
            g.lastStatus = status;
        }
    }

    function _recordReservation(
        bytes32 spendId,
        bytes32 id,
        address wallet,
        address merchant,
        uint256 amount,
        uint64 expiry
    ) internal {
        _open.push(
            OpenRes({ spendId: spendId, id: id, wallet: wallet, merchant: merchant, amount: amount, expiry: expiry })
        );
        _ghost[id].reserved += amount;
    }

    function _removeOpen(uint256 i) internal {
        _open[i] = _open[_open.length - 1];
        _open.pop();
    }

    function _pending(address schedule) internal view returns (bool) {
        if (schedule == address(0)) return false;
        MockHSS.Scheduled memory s = hss.getSchedule(schedule);
        return !s.deleted && !s.executed;
    }

    function _merchantList(uint256 seed) internal view returns (address[] memory list) {
        uint256 mask = seed % 8; // 0 (empty allowlist) .. 7
        uint256 count;
        for (uint256 i; i < N_MERCHANTS; ++i) {
            if ((mask >> i) & 1 != 0) count++;
        }
        list = new address[](count);
        uint256 k;
        for (uint256 i; i < N_MERCHANTS; ++i) {
            if ((mask >> i) & 1 != 0) list[k++] = merchants[i];
        }
    }

    function _register(address seller, uint256 amount, uint64 due, bytes32 buyerRef) internal returns (bytes32) {
        IReceivableRegistry.ReceivableConfirmation memory c = IReceivableRegistry.ReceivableConfirmation({
            seller: seller,
            buyer: buyer,
            currency: address(usdc),
            amount: amount,
            dueDate: due,
            buyerRef: buyerRef,
            detailsCommitment: keccak256("inv-doc"),
            payTo: address(router),
            nonce: registry.nonces(buyer),
            deadline: uint64(block.timestamp + 1 hours)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, registry.hashConfirmation(c));
        return registry.register(c, abi.encodePacked(r, s, v));
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
}
