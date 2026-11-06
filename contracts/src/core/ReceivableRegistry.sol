// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { IKYARegistry } from "./interfaces/IKYARegistry.sol";
import { IReceivableRegistry } from "./interfaces/IReceivableRegistry.sol";

/// @title ReceivableRegistry
/// @notice Registers a receivable only from a buyer-signed EIP-712 `ReceivableConfirmation` and tracks its
///         lifecycle: Confirmed -> Financed -> (Overdue) -> (Defaulted) -> Repaid, or Confirmed -> Cancelled.
/// @dev `register` may be submitted by anyone (the orchestrator); authority comes from the buyer's signature.
contract ReceivableRegistry is IReceivableRegistry, EIP712, Ownable {
    bytes32 public constant CONFIRMATION_TYPEHASH = keccak256(
        "ReceivableConfirmation(address seller,address buyer,address currency,uint256 amount,uint64 dueDate,bytes32 buyerRef,bytes32 detailsCommitment,address payTo,uint256 nonce,uint64 deadline)"
    );
    bytes32 public constant CANCEL_TYPEHASH = keccak256("CancelReceivable(bytes32 id)");

    uint256 private constant _MIN_TERM = 1 days;
    uint256 private constant _MAX_TERM = 120 days;
    uint8 private constant _MIN_BUYER_LEVEL = 3;
    uint8 private constant _MIN_SELLER_LEVEL = 2;

    IKYARegistry public immutable KYA;
    address public immutable USDC;

    address public facility;
    address public repaymentRouter;
    bool private _wired;

    mapping(address => uint256) public nonces;
    mapping(bytes32 => Receivable) private _receivables;

    modifier onlyFacility() {
        _checkFacility();
        _;
    }

    modifier onlyRouter() {
        _checkRouter();
        _;
    }

    constructor(IKYARegistry kya_, address usdc_, address owner_) EIP712("AgentReceivables", "1") Ownable(owner_) {
        KYA = kya_;
        USDC = usdc_;
    }

    /// @notice One-time wiring of the circular addresses.
    function wire(address facility_, address repaymentRouter_) external onlyOwner {
        if (_wired) revert ALREADY_WIRED();
        _wired = true;
        facility = facility_;
        repaymentRouter = repaymentRouter_;
    }

    /// @notice Registers the buyer-confirmed receivable. Check order: duplicate, signature, payee, term, nonce,
    ///         currency, KYA levels, owner separation.
    function register(ReceivableConfirmation calldata c, bytes calldata buyerSig) external returns (bytes32 id) {
        id = _computeId(c.buyer, c.buyerRef);
        if (_receivables[id].state != State.None) revert DUPLICATE_RECEIVABLE();

        if (!_signedBy(_hashConfirmation(c), buyerSig, c.buyer)) revert BAD_BUYER_SIG();

        // Until wired there is no repayment router, so no payTo (not even address(0)) can match.
        if (repaymentRouter == address(0) || c.payTo != repaymentRouter) revert WRONG_PAYEE();

        if (
            block.timestamp > c.deadline || c.dueDate < block.timestamp + _MIN_TERM
                || c.dueDate > block.timestamp + _MAX_TERM
        ) revert TERM_INELIGIBLE();

        if (c.nonce != nonces[c.buyer]) revert BAD_NONCE();

        if (c.currency != USDC) revert BAD_CURRENCY();

        if (KYA.level(c.buyer) < _MIN_BUYER_LEVEL || KYA.level(c.seller) < _MIN_SELLER_LEVEL) revert KYA_FAIL();

        if (KYA.ownerGroup(c.buyer) == KYA.ownerGroup(c.seller)) revert SELF_DEALING();

        nonces[c.buyer] = c.nonce + 1;
        _receivables[id] = Receivable({
            seller: c.seller,
            buyer: c.buyer,
            currency: c.currency,
            amount: c.amount,
            dueDate: c.dueDate,
            detailsCommitment: c.detailsCommitment,
            state: State.Confirmed,
            registeredAt: uint64(block.timestamp)
        });

        emit Registered(id, c.seller, c.buyer, c.amount, c.dueDate, c.detailsCommitment);
        emit StateChanged(id, State.None, State.Confirmed);
    }

    function markFinanced(bytes32 id) external onlyFacility {
        State from = _receivables[id].state;
        if (from != State.Confirmed) revert BAD_STATE();
        _transition(id, from, State.Financed);
    }

    function markRepaid(bytes32 id) external onlyRouter {
        State from = _receivables[id].state;
        if (from != State.Financed && from != State.Overdue && from != State.Defaulted) revert BAD_STATE();
        _transition(id, from, State.Repaid);
    }

    function markOverdue(bytes32 id) external onlyFacility {
        State from = _receivables[id].state;
        if (from != State.Financed) revert BAD_STATE();
        _transition(id, from, State.Overdue);
    }

    function markDefaulted(bytes32 id) external onlyFacility {
        State from = _receivables[id].state;
        if (from != State.Financed && from != State.Overdue) revert BAD_STATE();
        _transition(id, from, State.Defaulted);
    }

    /// @notice Cancels a not-yet-financed receivable with both the seller's and the buyer's signature over
    ///         `CancelReceivable(id)`. Either signature failing reverts `BAD_BUYER_SIG`.
    function cancel(bytes32 id, bytes calldata sellerSig, bytes calldata buyerSig) external {
        Receivable storage r = _receivables[id];
        State from = r.state;
        if (from != State.Confirmed) revert BAD_STATE();
        bytes32 digest = _hashCancel(id);
        if (!_signedBy(digest, sellerSig, r.seller) || !_signedBy(digest, buyerSig, r.buyer)) {
            revert BAD_BUYER_SIG();
        }
        _transition(id, from, State.Cancelled);
    }

    function state(bytes32 id) external view returns (State) {
        return _receivables[id].state;
    }

    function get(bytes32 id) external view returns (Receivable memory) {
        return _receivables[id];
    }

    function computeId(address buyer, bytes32 buyerRef) external pure returns (bytes32) {
        return _computeId(buyer, buyerRef);
    }

    function hashConfirmation(ReceivableConfirmation calldata c) external view returns (bytes32) {
        return _hashConfirmation(c);
    }

    function hashCancel(bytes32 id) external view returns (bytes32) {
        return _hashCancel(id);
    }

    // ------------------------------------------------------------------ internal

    function _checkFacility() internal view {
        if (msg.sender != facility) revert NOT_FACILITY();
    }

    function _checkRouter() internal view {
        if (msg.sender != repaymentRouter) revert NOT_ROUTER();
    }

    function _transition(bytes32 id, State from, State to) internal {
        _receivables[id].state = to;
        emit StateChanged(id, from, to);
    }

    function _computeId(address buyer, bytes32 buyerRef) internal pure returns (bytes32) {
        // forge-lint: disable-next-line(asm-keccak256)
        return keccak256(abi.encode(buyer, buyerRef));
    }

    function _hashConfirmation(ReceivableConfirmation calldata c) internal view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    CONFIRMATION_TYPEHASH,
                    c.seller,
                    c.buyer,
                    c.currency,
                    c.amount,
                    c.dueDate,
                    c.buyerRef,
                    c.detailsCommitment,
                    c.payTo,
                    c.nonce,
                    c.deadline
                )
            )
        );
    }

    function _hashCancel(bytes32 id) internal view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CANCEL_TYPEHASH, id)));
    }

    /// @dev Malformed or non-canonical signatures count as "not signed by" rather than bubbling OZ errors,
    ///      so callers always see the shared error name.
    function _signedBy(bytes32 digest, bytes calldata sig, address signer) internal pure returns (bool) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(digest, sig);
        return err == ECDSA.RecoverError.NoError && recovered == signer && signer != address(0);
    }
}
