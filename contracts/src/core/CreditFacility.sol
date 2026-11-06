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

    mapping(bytes32 => FacilityInfo) private _info;
    mapping(bytes32 => address[]) private _makers;
    mapping(bytes32 => mapping(address => Position)) private _positions;

    // Task 3.4 (budgets and two-phase spend) storage.
    mapping(bytes32 => mapping(address => Budget)) private _budgets;
    mapping(bytes32 => Reservation) private _reservations;

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
        if (maker != _fillMaker) revert FILL_MISMATCH();
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

    // ------------------------------------------------------------------ Task 3.4 (not implemented yet)

    function setBudgets(bytes32, address[] calldata, uint256[] calldata, Limits[] calldata) external pure {
        revert NOT_IMPLEMENTED();
    }

    function reserve(bytes32, bytes32, address, address, address, uint256, uint64) external pure {
        revert NOT_IMPLEMENTED();
    }

    function commit(bytes32, bytes32) external pure {
        revert NOT_IMPLEMENTED();
    }

    function release(bytes32) external pure {
        revert NOT_IMPLEMENTED();
    }

    function budget(bytes32, address) external pure returns (Budget memory) {
        revert NOT_IMPLEMENTED();
    }

    function isMerchantAllowed(bytes32, address, address) external pure returns (bool) {
        revert NOT_IMPLEMENTED();
    }

    function reservation(bytes32) external pure returns (Reservation memory) {
        revert NOT_IMPLEMENTED();
    }

    // ------------------------------------------------------------------ internal

    /// @dev Sells `fill.amount` freshly minted RCN for exactly `fill.amount` USDC against the lender's order.
    ///      Reconciles both the USDC actually received and the router's `onCreditFill` reports (maker and
    ///      amount) against the fill.
    function _fill(address router, bytes32 id, Fill calldata fill, uint16 advanceBps) private {
        uint256 amount = fill.amount;
        RCN.mint(address(this), amount);
        RCN.approve(router, amount);

        _fillMaker = fill.order.maker;
        _fillReported = 0;
        uint256 usdcBefore = IERC20(USDC).balanceOf(address(this));
        ISwapVM(router).swap(
            fill.order, amount, CashEthTraits.takerData(address(this), address(RCN), USDC, amount, id, advanceBps)
        );
        if (IERC20(USDC).balanceOf(address(this)) != usdcBefore + amount || _fillReported != amount) {
            revert FILL_MISMATCH();
        }
        _fillMaker = address(0);
        _fillReported = 0;
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
