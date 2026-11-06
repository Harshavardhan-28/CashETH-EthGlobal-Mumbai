// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Registry of buyer-confirmed receivables. A receivable exists only if the buyer signed an EIP-712
///         `ReceivableConfirmation` (domain `AgentReceivables`, version `1`); its id is
///         `keccak256(abi.encode(buyer, buyerRef))`, so the same obligation can never be registered twice.
interface IReceivableRegistry {
    enum State {
        None,
        Confirmed,
        Financed,
        Repaid,
        Overdue,
        Defaulted,
        Cancelled
    }

    struct ReceivableConfirmation {
        address seller;
        address buyer;
        address currency;
        uint256 amount;
        uint64 dueDate;
        bytes32 buyerRef;
        bytes32 detailsCommitment;
        address payTo;
        uint256 nonce;
        uint64 deadline;
    }

    struct Receivable {
        address seller;
        address buyer;
        address currency;
        uint256 amount;
        uint64 dueDate;
        bytes32 detailsCommitment;
        State state;
        uint64 registeredAt;
    }

    event Registered(
        bytes32 indexed id,
        address indexed seller,
        address indexed buyer,
        uint256 amount,
        uint64 dueDate,
        bytes32 detailsCommitment
    );
    event StateChanged(bytes32 indexed id, State from, State to);

    error DUPLICATE_RECEIVABLE();
    error BAD_BUYER_SIG();
    error WRONG_PAYEE();
    error TERM_INELIGIBLE();
    error BAD_NONCE();
    error KYA_FAIL();
    error SELF_DEALING();
    error BAD_CURRENCY();
    error BAD_STATE();
    error NOT_FACILITY();
    error NOT_ROUTER();
    error ALREADY_WIRED();

    function wire(address facility, address repaymentRouter) external;

    function register(ReceivableConfirmation calldata c, bytes calldata buyerSig) external returns (bytes32 id);

    function markFinanced(bytes32 id) external; // Confirmed -> Financed
    function markRepaid(bytes32 id) external; // Financed | Overdue | Defaulted -> Repaid
    function markOverdue(bytes32 id) external; // Financed -> Overdue
    function markDefaulted(bytes32 id) external; // Financed | Overdue -> Defaulted
    function cancel(bytes32 id, bytes calldata sellerSig, bytes calldata buyerSig) external; // Confirmed -> Cancelled

    function state(bytes32 id) external view returns (State);
    function get(bytes32 id) external view returns (Receivable memory);
    function computeId(address buyer, bytes32 buyerRef) external pure returns (bytes32);
    function hashConfirmation(ReceivableConfirmation calldata c) external view returns (bytes32);
    function hashCancel(bytes32 id) external view returns (bytes32);
    function nonces(address buyer) external view returns (uint256);
}
