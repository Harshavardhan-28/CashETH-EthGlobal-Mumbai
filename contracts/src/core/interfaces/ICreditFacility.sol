// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ISwapVM } from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";

/// @notice Credit facility for one Confirmed receivable: funds it atomically through lender SwapVM fills
///         (RCN for USDC), records lender positions, self-schedules the overdue and default checks through
///         the Hedera Schedule Service, and (Task 3.4) meters spending through per-worker budgets.
/// @dev Facility status: 0 None, 1 Active, 2 Frozen, 3 Closed. Reservation status: 0 None, 1 Open,
///      2 Committed, 3 Released.
interface ICreditFacility {
    struct Fill {
        ISwapVM.Order order;
        uint256 amount;
        uint16 aprBps;
    }

    struct Position {
        uint256 principal;
        uint16 aprBps;
        uint64 start;
        uint256 paidPrincipal;
        uint256 paidFee;
    }

    struct FacilityInfo {
        address seller;
        address buyer;
        uint256 receivableAmount;
        uint64 dueDate;
        uint256 funded;
        uint256 committed;
        uint256 reserved;
        uint8 status;
        address overdueSchedule;
        address defaultSchedule;
    }

    // ---- Task 3.4: budgets and two-phase spend ----

    struct Limits {
        uint256 maxPerTx;
        uint256 maxDaily;
        address[] merchants;
    }

    struct Budget {
        uint256 alloc;
        uint256 spent;
        uint256 reserved;
        uint256 maxPerTx;
        uint256 maxDaily;
        uint256 dailySpent;
        uint64 dayStart;
    }

    struct Reservation {
        bytes32 id;
        address worker;
        address spendWallet;
        address merchant;
        uint256 amount;
        uint64 expiry;
        uint8 status;
        bytes32 txIdHash;
    }

    event FacilityFunded(bytes32 indexed id, uint256 funded, uint16 advanceBps, address[] makers);
    event PositionOpened(bytes32 indexed id, address indexed maker, uint256 principal, uint16 aprBps);
    event Overdue(bytes32 indexed id);
    event Defaulted(bytes32 indexed id);
    event Disputed(bytes32 indexed id);
    event FacilityClosed(bytes32 indexed id, uint256 undrawnToSeller);
    event Scheduled(bytes32 indexed id, address overdueSchedule, address defaultSchedule);
    /// @notice The default check `markOverdue` tried to schedule was refused with HSS response `code`
    ///         (-1 if the call reverted); the overdue transition still happened.
    event ScheduleSkipped(bytes32 indexed id, int64 code);

    event BudgetsSet(bytes32 indexed id, address[] workers, uint256[] alloc);
    event SpendReserved(
        bytes32 indexed id, bytes32 indexed spendId, address worker, address merchant, uint256 amount, uint64 expiry
    );
    event SpendCommitted(bytes32 indexed spendId, bytes32 hederaTxIdHash);
    event SpendReleased(bytes32 indexed spendId, uint256 returned);

    error NOT_CONFIRMED();
    error NOT_CHEAPEST_FIRST();
    error BORROWING_BASE_EXCEEDED();
    error FILL_MISMATCH();
    error SCHEDULE_FAILED();
    error NOT_COORDINATOR();
    error NOT_SWAP_ROUTER();
    error NOT_REPAYMENT_ROUTER();
    error NOT_ACTIVE_ID();
    error NOT_DUE();
    error NOT_PARTY();
    error FACILITY_NOT_ACTIVE();
    error ALREADY_WIRED();
    error ZERO_ADDRESS();
    error ASSOCIATION_FAILED(uint256 responseCode);
    error PAUSED();

    error NOT_SELLER();
    error LENGTH_MISMATCH();
    error BUDGETS_EXCEED_FUNDED();
    error AGENT_BUDGET_EXCEEDED();
    error TX_LIMIT_EXCEEDED();
    error DAILY_LIMIT_EXCEEDED();
    error MERCHANT_NOT_ALLOWED();
    error GLOBAL_CREDIT_LIMIT_EXCEEDED();
    error RESERVATION_EXPIRED();
    error RESERVATION_EXISTS();
    error RESERVATION_NOT_OPEN();
    error BUDGET_BELOW_USED();
    error WALLET_BUSY();

    /// @notice One-time wiring of the SwapVM router and the repayment router; both must be non-zero.
    function wire(address swapRouter, address repaymentRouter) external;

    /// @notice Funds the Confirmed receivable `id` by selling RCN for USDC through `fills`, cheapest first, in
    ///         one transaction; any failed fill reverts everything. Marks the receivable Financed and schedules
    ///         the overdue and default checks.
    function openAndFund(bytes32 id, Fill[] calldata fills, uint16 advanceBps, uint256 limit) external;

    /// @notice Credit callback from the SwapVM router while `openAndFund(id, ...)` is executing.
    function onCreditFill(bytes32 id, address maker, uint256 usdcIn, uint16 aprBps) external;

    /// @notice Permissionless from `dueDate + 7 days`: Financed -> Overdue, facility Frozen.
    function markOverdue(bytes32 id) external;

    /// @notice Permissionless from `dueDate + 30 days`: Financed | Overdue -> Defaulted, facility Frozen,
    ///         default recorded against the buyer.
    function markDefaulted(bytes32 id) external;

    /// @notice Seller, buyer or coordinator freezes the facility.
    function flagDispute(bytes32 id) external;

    function recordRepayment(bytes32 id, address maker, uint256 principalPaid, uint256 feePaid) external;

    /// @notice Closes the facility, deletes its pending schedules and returns undrawn USDC to the seller.
    function closeFacility(bytes32 id) external;

    function pause() external;
    function unpause() external;

    function facilityInfo(bytes32 id) external view returns (FacilityInfo memory);
    function makers(bytes32 id) external view returns (address[] memory);
    function position(bytes32 id, address maker) external view returns (Position memory);

    /// @return `funded - committed - reserved`.
    function available(bytes32 id) external view returns (uint256);

    // ---- Task 3.4: budgets and two-phase spend ----

    function setBudgets(bytes32 id, address[] calldata workers, uint256[] calldata alloc, Limits[] calldata limits)
        external;
    function reserve(
        bytes32 id,
        bytes32 spendId,
        address worker,
        address spendWallet,
        address merchant,
        uint256 amount,
        uint64 expiry
    ) external;
    function commit(bytes32 spendId, bytes32 hederaTxIdHash) external;
    function release(bytes32 spendId) external;
    function budget(bytes32 id, address worker) external view returns (Budget memory);
    function isMerchantAllowed(bytes32 id, address worker, address merchant) external view returns (bool);
    function merchants(bytes32 id, address worker) external view returns (address[] memory);
    function reservation(bytes32 spendId) external view returns (Reservation memory);
    function allocated(bytes32 id) external view returns (uint256);
    function openReservationOf(address spendWallet) external view returns (bytes32);
}
