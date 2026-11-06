// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ISwapVM } from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";
import { ICreditFacility } from "./interfaces/ICreditFacility.sol";
import { IKYARegistry } from "./interfaces/IKYARegistry.sol";
import { IReceivableRegistry } from "./interfaces/IReceivableRegistry.sol";
import { IReceivableCreditNote } from "./interfaces/IReceivableCreditNote.sol";
import { CashEthTraits } from "./libs/CashEthTraits.sol";
import { IHRC719 } from "../hedera/IHRC719.sol";
import { IHederaScheduleService } from "../hedera/IHederaScheduleService.sol";
import { HederaResponseCodes } from "../hedera/HederaResponseCodes.sol";

/// @title CreditFacility
/// @notice Funds a buyer-confirmed receivable in one transaction: for each lender fill (cheapest first) it
///         mints RCN to itself, lets the SwapVM router pull it into the lender's Aqua order and receives the
///         same amount of USDC; the router reports each fill through `onCreditFill`, which records the lender
///         position. Any failed fill reverts the whole funding. After funding it schedules its own overdue
///         and default checks through the Hedera Schedule Service; both checks are also permissionless.
/// @dev The facility pays for its schedules in HBAR, so it is funded through `receive()` after deployment.
contract CreditFacility is ICreditFacility, Ownable, Pausable {
    using SafeERC20 for IERC20;

    address private constant _HSS = address(0x16b);
    uint256 private constant _SCHEDULE_GAS = 400_000;
    /// @dev Gas for a scheduled `markOverdue` that must itself schedule the default check (Ruling R17):
    ///      a nested `scheduleCall` costs about 1.45M gas on testnet.
    uint256 private constant _SCHEDULE_GAS_WITH_NESTED = 1_800_000;
    /// @dev HSS refuses expiries more than 62 days out; keep an hour of margin.
    uint256 private constant _SCHEDULE_HORIZON = 62 days - 1 hours;
    /// @dev A scheduled call executes at `expiry - 1 s` (Ruling R5), so schedules sit past the thresholds.
    uint256 private constant _SCHEDULE_SLACK = 5 minutes;
    uint256 private constant _OVERDUE_AFTER = 7 days;
    uint256 private constant _DEFAULT_AFTER = 30 days;
    uint256 private constant _BPS = 10_000;
    uint256 private constant _TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT = 194;

    uint8 public constant STATUS_NONE = 0;
    uint8 public constant STATUS_ACTIVE = 1;
    uint8 public constant STATUS_FROZEN = 2;
    uint8 public constant STATUS_CLOSED = 3;

    uint8 private constant _RES_OPEN = 1;
    uint8 private constant _RES_COMMITTED = 2;
    uint8 private constant _RES_RELEASED = 3;

    IReceivableRegistry public immutable REGISTRY;
    IKYARegistry public immutable KYA;
    IReceivableCreditNote public immutable RCN;
    address public immutable USDC;
    address public immutable COORDINATOR;

    address public swapRouter;
    address public repaymentRouter;
    bool private _wired;

    /// @dev The receivable being funded; set only for the duration of `openAndFund`'s fills.
    bytes32 private transient _activeId;
    /// @dev Maker of the fill in flight and the USDC the router reported for it through `onCreditFill`.
    address private transient _fillMaker;
    uint256 private transient _fillReported;
    /// @dev APR of the fill in flight; `onCreditFill` must report the same (Ruling R21).
    uint16 private transient _fillAprBps;

    mapping(bytes32 => FacilityInfo) private _info;
    mapping(bytes32 => address[]) private _makers;
    mapping(bytes32 => mapping(address => Position)) private _positions;

    mapping(bytes32 => mapping(address => Budget)) private _budgets;
    mapping(bytes32 => Reservation) private _reservations;
    /// @dev Per (facility, worker) merchant allowlist: the enumerable list and its membership mapping.
    mapping(bytes32 => mapping(address => address[])) private _merchantList;
    mapping(bytes32 => mapping(address => mapping(address => bool))) private _merchantAllowed;

    modifier onlyCoordinator() {
        _checkCoordinator();
        _;
    }

    modifier onlyRepaymentRouter() {
        _checkRepaymentRouter();
        _;
    }

    constructor(
        IReceivableRegistry registry_,
        IKYARegistry kya_,
        IReceivableCreditNote rcn_,
        address usdc_,
        address coordinator_,
        address owner_
    ) Ownable(owner_) {
        if (
            address(registry_) == address(0) || address(kya_) == address(0) || address(rcn_) == address(0)
                || usdc_ == address(0) || coordinator_ == address(0)
        ) revert ZERO_ADDRESS();
        REGISTRY = registry_;
        KYA = kya_;
        RCN = rcn_;
        USDC = usdc_;
        COORDINATOR = coordinator_;

        uint256 rc = IHRC719(usdc_).associate();
        if (rc != uint256(uint64(HederaResponseCodes.SUCCESS)) && rc != _TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT) {
            revert ASSOCIATION_FAILED(rc);
        }
    }

    /// @notice HBAR that pays for the facility's scheduled calls.
    receive() external payable { }

    /// @notice One-time wiring of the circular addresses.
    function wire(address swapRouter_, address repaymentRouter_) external onlyOwner {
        if (_wired) revert ALREADY_WIRED();
        if (swapRouter_ == address(0) || repaymentRouter_ == address(0)) revert ZERO_ADDRESS();
        _wired = true;
        swapRouter = swapRouter_;
        repaymentRouter = repaymentRouter_;
    }

    // ------------------------------------------------------------------ funding

    /// @notice Check order: Confirmed, cheapest first (an empty fill also reverts `NOT_CHEAPEST_FIRST`),
    ///         borrowing base (including `advanceBps <= 10_000`); then fills, Financed, schedules.
    function openAndFund(bytes32 id, Fill[] calldata fills, uint16 advanceBps, uint256 limit)
        external
        onlyCoordinator
        whenNotPaused
    {
        if (REGISTRY.state(id) != IReceivableRegistry.State.Confirmed) revert NOT_CONFIRMED();

        uint256 n = fills.length;
        if (n == 0) revert NOT_CHEAPEST_FIRST();
        uint256 total;
        for (uint256 i; i < n; ++i) {
            uint256 amount = fills[i].amount;
            if (amount == 0 || (i != 0 && fills[i].aprBps < fills[i - 1].aprBps)) revert NOT_CHEAPEST_FIRST();
            total += amount;
        }

        IReceivableRegistry.Receivable memory r = REGISTRY.get(id);
        if (advanceBps > _BPS || total > r.amount * advanceBps / _BPS || total > limit) {
            revert BORROWING_BASE_EXCEEDED();
        }

        _activeId = id;
        address router = swapRouter;
        for (uint256 i; i < n; ++i) {
            _fill(router, id, fills[i], advanceBps);
        }
        _activeId = bytes32(0);

        FacilityInfo storage info = _info[id];
        info.seller = r.seller;
        info.buyer = r.buyer;
        info.receivableAmount = r.amount;
        info.dueDate = r.dueDate;
        info.funded = total;
        info.status = STATUS_ACTIVE;

        REGISTRY.markFinanced(id);

        uint256 defaultExpiry = _defaultExpiry(r.dueDate);
        bool defaultInHorizon = defaultExpiry <= block.timestamp + _SCHEDULE_HORIZON;
        address overdueSchedule = _schedule(
            uint256(r.dueDate) + _OVERDUE_AFTER + _SCHEDULE_SLACK,
            defaultInHorizon ? _SCHEDULE_GAS : _SCHEDULE_GAS_WITH_NESTED,
            abi.encodeCall(ICreditFacility.markOverdue, (id))
        );
        address defaultSchedule =
            _schedule(defaultExpiry, _SCHEDULE_GAS, abi.encodeCall(ICreditFacility.markDefaulted, (id)));
        info.overdueSchedule = overdueSchedule;
        info.defaultSchedule = defaultSchedule;

        emit FacilityFunded(id, total, advanceBps, _makers[id]);
        emit Scheduled(id, overdueSchedule, defaultSchedule);
    }

    /// @notice Records the lender position for a fill of the receivable currently being funded.
    function onCreditFill(bytes32 id, address maker, uint256 usdcIn, uint16 aprBps) external {
        if (msg.sender != swapRouter) revert NOT_SWAP_ROUTER();
        if (id == bytes32(0) || id != _activeId) revert NOT_ACTIVE_ID();
        if (maker != _fillMaker || aprBps != _fillAprBps) revert FILL_MISMATCH();
        _fillReported += usdcIn;

        Position storage p = _positions[id][maker];
        if (p.start == 0) {
            p.aprBps = aprBps;
            p.start = uint64(block.timestamp);
            _makers[id].push(maker);
        }
        p.principal += usdcIn;
        emit PositionOpened(id, maker, usdcIn, aprBps);
    }

    // ------------------------------------------------------------------ overdue, default, dispute

    /// @notice From `dueDate + 7 days`, anyone: Financed -> Overdue and the facility freezes. Schedules the
    ///         default check if it was beyond the horizon at funding, best-effort (Ruling R18): skipped when
    ///         its expiry is already past or beyond the horizon, and a failed schedule emits `ScheduleSkipped`
    ///         instead of reverting, so the overdue transition can never be blocked.
    function markOverdue(bytes32 id) external {
        FacilityInfo storage info = _info[id];
        _checkOpen(info);
        if (block.timestamp < uint256(info.dueDate) + _OVERDUE_AFTER) revert NOT_DUE();

        info.status = STATUS_FROZEN;
        REGISTRY.markOverdue(id);
        emit Overdue(id);

        if (info.defaultSchedule == address(0)) {
            address defaultSchedule = _tryScheduleDefault(id, info.dueDate);
            if (defaultSchedule != address(0)) {
                info.defaultSchedule = defaultSchedule;
                emit Scheduled(id, info.overdueSchedule, defaultSchedule);
            }
        }
    }

    /// @notice From `dueDate + 30 days`, anyone: Financed | Overdue -> Defaulted, the facility freezes and
    ///         the default is recorded against the buyer.
    function markDefaulted(bytes32 id) external {
        FacilityInfo storage info = _info[id];
        _checkOpen(info);
        if (block.timestamp < uint256(info.dueDate) + _DEFAULT_AFTER) revert NOT_DUE();

        info.status = STATUS_FROZEN;
        REGISTRY.markDefaulted(id);
        KYA.recordDefault(info.buyer, info.seller);
        emit Defaulted(id);
    }

    function flagDispute(bytes32 id) external {
        FacilityInfo storage info = _info[id];
        _checkOpen(info);
        if (msg.sender != info.seller && msg.sender != info.buyer && msg.sender != COORDINATOR) revert NOT_PARTY();

        info.status = STATUS_FROZEN;
        emit Disputed(id);
    }

    // ------------------------------------------------------------------ repayment

    function recordRepayment(bytes32 id, address maker, uint256 principalPaid, uint256 feePaid)
        external
        onlyRepaymentRouter
    {
        Position storage p = _positions[id][maker];
        p.paidPrincipal += principalPaid;
        p.paidFee += feePaid;
    }

    /// @notice Closes the facility, deletes its schedules and returns the undrawn USDC to the seller.
    /// @dev Schedule deletion is best-effort: a schedule that already executed cannot be deleted, and that
    ///      must never block the repayment that closes the facility.
    function closeFacility(bytes32 id) external onlyRepaymentRouter {
        FacilityInfo storage info = _info[id];
        _checkOpen(info);

        info.status = STATUS_CLOSED;
        _deleteSchedule(info.overdueSchedule);
        _deleteSchedule(info.defaultSchedule);

        uint256 undrawn = info.funded - info.committed - info.reserved;
        if (undrawn != 0) IERC20(USDC).safeTransfer(info.seller, undrawn);
        emit FacilityClosed(id, undrawn);
    }

    // ------------------------------------------------------------------ budgets and two-phase spend

    /// @notice Seller sets each worker's allocation, per-tx and daily limits, and replaces its merchant
    ///         allowlist. The allocations of one call sum to at most `funded`, and no allocation drops below
    ///         what the worker already spent plus holds in open reservations.
    function setBudgets(bytes32 id, address[] calldata workers, uint256[] calldata alloc, Limits[] calldata limits)
        external
    {
        FacilityInfo storage info = _info[id];
        if (msg.sender != info.seller) revert NOT_SELLER();
        uint256 n = workers.length;
        if (alloc.length != n || limits.length != n) revert LENGTH_MISMATCH();
        if (info.status != STATUS_ACTIVE) revert FACILITY_NOT_ACTIVE();

        uint256 sum;
        for (uint256 i; i < n; ++i) {
            sum += alloc[i];
            address worker = workers[i];
            Budget storage b = _budgets[id][worker];
            if (alloc[i] < b.spent + b.reserved) revert BUDGETS_EXCEED_FUNDED();
            b.alloc = alloc[i];
            b.maxPerTx = limits[i].maxPerTx;
            b.maxDaily = limits[i].maxDaily;
            _setMerchants(id, worker, limits[i].merchants);
        }
        if (sum > info.funded) revert BUDGETS_EXCEED_FUNDED();
        emit BudgetsSet(id, workers, alloc);
    }

    /// @notice Moves `amount` USDC to the worker's spend wallet against an open reservation that the
    ///         coordinator later commits (spent on Hedera) or releases (pulled back).
    /// @dev Check order: spend id unused, facility Active before its due date, expiry in the future; then
    ///      worker budget, per-tx limit, daily limit, merchant allowlist, facility availability.
    function reserve(
        bytes32 id,
        bytes32 spendId,
        address worker,
        address spendWallet,
        address merchant,
        uint256 amount,
        uint64 expiry
    ) external onlyCoordinator whenNotPaused {
        Reservation storage r = _reservations[spendId];
        if (r.status != 0) revert RESERVATION_EXISTS();
        FacilityInfo storage info = _info[id];
        if (info.status != STATUS_ACTIVE || block.timestamp >= info.dueDate) revert FACILITY_NOT_ACTIVE();
        if (expiry <= block.timestamp) revert RESERVATION_EXPIRED();

        Budget storage b = _budgets[id][worker];
        if (amount > b.alloc - b.spent - b.reserved) revert AGENT_BUDGET_EXCEEDED();
        if (amount == 0 || amount > b.maxPerTx) revert TX_LIMIT_EXCEEDED();
        (uint256 dailySpent, uint64 dayStart) = _currentDay(b);
        if (dailySpent + amount > b.maxDaily) revert DAILY_LIMIT_EXCEEDED();
        if (!_merchantAllowed[id][worker][merchant]) revert MERCHANT_NOT_ALLOWED();
        if (amount > available(id)) revert GLOBAL_CREDIT_LIMIT_EXCEEDED();

        b.dailySpent = dailySpent;
        b.dayStart = dayStart;
        b.reserved += amount;
        info.reserved += amount;
        r.id = id;
        r.worker = worker;
        r.spendWallet = spendWallet;
        r.merchant = merchant;
        r.amount = amount;
        r.expiry = expiry;
        r.status = _RES_OPEN;

        IERC20(USDC).safeTransfer(spendWallet, amount);
        emit SpendReserved(id, spendId, worker, merchant, amount, expiry);
    }

    /// @notice Records the Hedera payment for an open, unexpired reservation: reserved becomes spent.
    function commit(bytes32 spendId, bytes32 hederaTxIdHash) external onlyCoordinator {
        Reservation storage r = _reservations[spendId];
        if (r.status != _RES_OPEN) revert RESERVATION_NOT_OPEN();
        if (block.timestamp > r.expiry) revert RESERVATION_EXPIRED();

        uint256 amount = r.amount;
        Budget storage b = _budgets[r.id][r.worker];
        (uint256 dailySpent, uint64 dayStart) = _currentDay(b);
        b.dailySpent = dailySpent + amount;
        b.dayStart = dayStart;
        b.reserved -= amount;
        b.spent += amount;
        FacilityInfo storage info = _info[r.id];
        info.reserved -= amount;
        info.committed += amount;
        r.status = _RES_COMMITTED;
        r.txIdHash = hederaTxIdHash;
        emit SpendCommitted(spendId, hederaTxIdHash);
    }

    /// @notice Pulls an open reservation's USDC back from the spend wallet (standing allowance). The
    ///         coordinator may release at any time, anyone once the reservation has expired.
    function release(bytes32 spendId) external {
        Reservation storage r = _reservations[spendId];
        if (r.status != _RES_OPEN) revert RESERVATION_NOT_OPEN();
        if (msg.sender != COORDINATOR && block.timestamp <= r.expiry) revert NOT_COORDINATOR();

        uint256 amount = r.amount;
        _budgets[r.id][r.worker].reserved -= amount;
        _info[r.id].reserved -= amount;
        r.status = _RES_RELEASED;

        IERC20(USDC).safeTransferFrom(r.spendWallet, address(this), amount);
        emit SpendReleased(spendId, amount);
    }

    // ------------------------------------------------------------------ admin

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ------------------------------------------------------------------ views

    function facilityInfo(bytes32 id) external view returns (FacilityInfo memory) {
        return _info[id];
    }

    function makers(bytes32 id) external view returns (address[] memory) {
        return _makers[id];
    }

    function position(bytes32 id, address maker) external view returns (Position memory) {
        return _positions[id][maker];
    }

    /// @return `funded - committed - reserved`, or 0 once the facility is Closed (the undrawn USDC has gone to
    ///         the seller).
    function available(bytes32 id) public view returns (uint256) {
        FacilityInfo storage info = _info[id];
        if (info.status == STATUS_CLOSED) return 0;
        return info.funded - info.committed - info.reserved;
    }

    /// @return The stored budget, without applying the rolling daily reset.
    function budget(bytes32 id, address worker) external view returns (Budget memory) {
        return _budgets[id][worker];
    }

    function isMerchantAllowed(bytes32 id, address worker, address merchant) external view returns (bool) {
        return _merchantAllowed[id][worker][merchant];
    }

    function merchants(bytes32 id, address worker) external view returns (address[] memory) {
        return _merchantList[id][worker];
    }

    function reservation(bytes32 spendId) external view returns (Reservation memory) {
        return _reservations[spendId];
    }

    // ------------------------------------------------------------------ internal

    /// @dev Sells `fill.amount` freshly minted RCN for exactly `fill.amount` USDC against the lender's order.
    ///      Reconciles both the USDC actually received and the router's `onCreditFill` reports (maker, APR and
    ///      amount) against the fill.
    function _fill(address router, bytes32 id, Fill calldata fill, uint16 advanceBps) private {
        uint256 amount = fill.amount;
        RCN.mint(address(this), amount);
        RCN.approve(router, amount);

        _fillMaker = fill.order.maker;
        _fillAprBps = fill.aprBps;
        _fillReported = 0;
        uint256 usdcBefore = IERC20(USDC).balanceOf(address(this));
        ISwapVM(router).swap(
            fill.order, amount, CashEthTraits.takerData(address(this), address(RCN), USDC, amount, id, advanceBps)
        );
        if (IERC20(USDC).balanceOf(address(this)) != usdcBefore + amount || _fillReported != amount) {
            revert FILL_MISMATCH();
        }
        _fillMaker = address(0);
        _fillAprBps = 0;
        _fillReported = 0;
    }

    /// @dev The worker's daily total and window start, reset to (0, now) once a day has passed since the start.
    function _currentDay(Budget storage b) private view returns (uint256 dailySpent, uint64 dayStart) {
        dayStart = b.dayStart;
        if (block.timestamp >= uint256(dayStart) + 1 days) return (0, uint64(block.timestamp));
        return (b.dailySpent, dayStart);
    }

    /// @dev Replaces the worker's merchant allowlist: clears the old set, then records `list` (duplicates once).
    function _setMerchants(bytes32 id, address worker, address[] calldata list) private {
        address[] storage current = _merchantList[id][worker];
        mapping(address => bool) storage allowed = _merchantAllowed[id][worker];
        for (uint256 i = current.length; i != 0; --i) {
            allowed[current[i - 1]] = false;
            current.pop();
        }
        for (uint256 i; i < list.length; ++i) {
            address m = list[i];
            if (!allowed[m]) {
                allowed[m] = true;
                current.push(m);
            }
        }
    }

    function _defaultExpiry(uint64 dueDate) private pure returns (uint256) {
        return uint256(dueDate) + _DEFAULT_AFTER + _SCHEDULE_SLACK;
    }

    /// @dev Funding-time schedule: skipped (`address(0)`) beyond the HSS horizon; a non-SUCCESS response
    ///      reverts `SCHEDULE_FAILED`.
    function _schedule(uint256 expiry, uint256 gasLimit, bytes memory callData) private returns (address schedule) {
        if (expiry > block.timestamp + _SCHEDULE_HORIZON) return address(0);
        int64 rc;
        (rc, schedule) = IHederaScheduleService(_HSS).scheduleCall(address(this), expiry, gasLimit, 0, callData);
        if (rc != HederaResponseCodes.SUCCESS) revert SCHEDULE_FAILED();
    }

    /// @dev Best-effort default schedule from `markOverdue` (Ruling R18). Returns `address(0)` when the expiry is
    ///      already past or beyond the horizon, or when the HSS refuses; a refusal emits `ScheduleSkipped`
    ///      with its response code (-1 if the call itself reverted, e.g. out of gas).
    function _tryScheduleDefault(bytes32 id, uint64 dueDate) private returns (address) {
        uint256 expiry = _defaultExpiry(dueDate);
        if (expiry <= block.timestamp || expiry > block.timestamp + _SCHEDULE_HORIZON) return address(0);
        try IHederaScheduleService(_HSS)
            .scheduleCall(
                address(this), expiry, _SCHEDULE_GAS, 0, abi.encodeCall(ICreditFacility.markDefaulted, (id))
            ) returns (
            int64 rc, address schedule
        ) {
            if (rc == HederaResponseCodes.SUCCESS) return schedule;
            emit ScheduleSkipped(id, rc);
        } catch {
            emit ScheduleSkipped(id, -1);
        }
        return address(0);
    }

    function _deleteSchedule(address schedule) private {
        if (schedule == address(0)) return;
        try IHederaScheduleService(_HSS).deleteSchedule(schedule) returns (int64) { } catch { }
    }

    function _checkOpen(FacilityInfo storage info) private view {
        if (info.status != STATUS_ACTIVE && info.status != STATUS_FROZEN) revert FACILITY_NOT_ACTIVE();
    }

    function _checkCoordinator() internal view {
        if (msg.sender != COORDINATOR) revert NOT_COORDINATOR();
    }

    function _checkRepaymentRouter() internal view {
        if (msg.sender != repaymentRouter) revert NOT_REPAYMENT_ROUTER();
    }

    /// @dev Pause reverts with the shared `PAUSED` error instead of OZ's `EnforcedPause`.
    function _requireNotPaused() internal view override {
        if (paused()) revert PAUSED();
    }
}
