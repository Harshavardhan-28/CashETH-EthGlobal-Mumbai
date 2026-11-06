// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import { ICreditFacility } from "./interfaces/ICreditFacility.sol";
import { IKYARegistry } from "./interfaces/IKYARegistry.sol";
import { IReceivableRegistry } from "./interfaces/IReceivableRegistry.sol";
import { IReceivableCreditNote } from "./interfaces/IReceivableCreditNote.sol";
import { IHRC719 } from "../hedera/IHRC719.sol";
import { HederaResponseCodes } from "../hedera/HederaResponseCodes.sol";

/// @title RepaymentRouter
/// @notice The receivable's `payTo`: takes the buyer's USDC and runs the waterfall. Lenders are paid first,
///         pro rata of what each is owed (principal plus fee), and within each lender's share the fee goes
///         first; the RCN backing the principal repaid is burned. Once every lender is whole the receivable
///         is marked Repaid, the repayment goes on the buyer's and seller's reputation, the facility closes
///         (undrawn USDC to the seller) and the rest of the payment goes to the seller. A payment for an
///         already Repaid receivable goes entirely to the seller.
/// @dev Fee: `principal * aprBps * max(elapsed, MIN_TERM) / (365 days * 10_000)`, floored, on the original
///      principal from the position's start. The router holds no USDC between calls.
contract RepaymentRouter is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 public constant MIN_TERM = 30 days;
    uint256 private constant _YEAR = 365 days;
    uint256 private constant _BPS = 10_000;
    uint256 private constant _TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT = 194;

    IReceivableRegistry public immutable REGISTRY;
    IKYARegistry public immutable KYA;
    ICreditFacility public immutable FACILITY;
    IReceivableCreditNote public immutable RCN;
    IERC20 public immutable USDC;

    event Repaid(bytes32 indexed id, address indexed payer, uint256 amount, uint256 toLenders, uint256 toSeller);
    event LenderPaid(bytes32 indexed id, address indexed maker, uint256 principal, uint256 fee);

    error ZERO_AMOUNT();
    error NOT_FINANCED();
    error ASSOCIATION_FAILED(uint256 responseCode);

    constructor(
        IReceivableRegistry registry_,
        IKYARegistry kya_,
        ICreditFacility facility_,
        IReceivableCreditNote rcn_,
        address usdc_
    ) {
        REGISTRY = registry_;
        KYA = kya_;
        FACILITY = facility_;
        RCN = rcn_;
        USDC = IERC20(usdc_);

        uint256 rc = IHRC719(usdc_).associate();
        if (rc != uint256(uint64(HederaResponseCodes.SUCCESS)) && rc != _TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT) {
            revert ASSOCIATION_FAILED(rc);
        }
    }

    /// @notice Pays `amount` USDC from the caller against receivable `id`: lenders first, the seller the rest.
    /// @dev Bookkeeping (positions, RCN burns, registry, reputation, facility close) happens before any USDC
    ///      leaves the router.
    function repay(bytes32 id, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZERO_AMOUNT();
        IReceivableRegistry.State s = REGISTRY.state(id);

        if (s == IReceivableRegistry.State.Repaid) {
            USDC.safeTransferFrom(msg.sender, address(this), amount);
            USDC.safeTransfer(REGISTRY.get(id).seller, amount);
            emit Repaid(id, msg.sender, amount, 0, amount);
            return;
        }
        if (
            s != IReceivableRegistry.State.Financed && s != IReceivableRegistry.State.Overdue
                && s != IReceivableRegistry.State.Defaulted
        ) revert NOT_FINANCED();

        USDC.safeTransferFrom(msg.sender, address(this), amount);

        address[] memory makers = FACILITY.makers(id);
        uint256 n = makers.length;
        uint256[] memory due = new uint256[](n);
        uint256[] memory feeDue = new uint256[](n);
        uint256 totalDue;
        for (uint256 i; i < n; ++i) {
            (uint256 principalDue, uint256 fee) = _dueOf(id, makers[i]);
            due[i] = principalDue + fee;
            feeDue[i] = fee;
            totalDue += principalDue + fee;
        }
        uint256 toLenders = amount < totalDue ? amount : totalDue;
        uint256[] memory shares = _shares(due, totalDue, toLenders);

        for (uint256 i; i < n; ++i) {
            uint256 share = shares[i];
            if (share == 0) continue;
            uint256 fee = share < feeDue[i] ? share : feeDue[i];
            uint256 principal = share - fee;
            FACILITY.recordRepayment(id, makers[i], principal, fee);
            if (principal != 0) RCN.burn(makers[i], principal);
            emit LenderPaid(id, makers[i], principal, fee);
        }

        ICreditFacility.FacilityInfo memory info = FACILITY.facilityInfo(id);
        if (toLenders == totalDue) {
            REGISTRY.markRepaid(id);
            KYA.recordRepayment(info.buyer, info.seller, block.timestamp <= info.dueDate);
            FACILITY.closeFacility(id);
        }

        for (uint256 i; i < n; ++i) {
            if (shares[i] != 0) USDC.safeTransfer(makers[i], shares[i]);
        }
        uint256 toSeller = amount - toLenders;
        if (toSeller != 0) USDC.safeTransfer(info.seller, toSeller);
        emit Repaid(id, msg.sender, amount, toLenders, toSeller);
    }

    /// @return The fee on `principal` at `aprBps` from `start` to `at`, charging at least `MIN_TERM` (a timestamp
    ///         before `start` also charges `MIN_TERM`), floored.
    function feeOf(uint256 principal, uint16 aprBps, uint64 start, uint64 at) public pure returns (uint256) {
        uint256 elapsed = at > start ? at - start : 0;
        if (elapsed < MIN_TERM) elapsed = MIN_TERM;
        return principal * aprBps * elapsed / (_YEAR * _BPS);
    }

    /// @return principalDue Unpaid principal of `maker`'s position.
    /// @return feeDue Fee accrued to now minus fee already paid, never negative.
    /// @dev Both zero once the receivable is Repaid.
    function dueOf(bytes32 id, address maker) public view returns (uint256 principalDue, uint256 feeDue) {
        if (REGISTRY.state(id) == IReceivableRegistry.State.Repaid) return (0, 0);
        return _dueOf(id, maker);
    }

    /// @return total What all lenders are owed now (principal plus fee); zero once the receivable is Repaid.
    function lenderDue(bytes32 id) public view returns (uint256 total) {
        if (REGISTRY.state(id) == IReceivableRegistry.State.Repaid) return 0;
        address[] memory makers = FACILITY.makers(id);
        for (uint256 i; i < makers.length; ++i) {
            (uint256 principalDue, uint256 feeDue) = _dueOf(id, makers[i]);
            total += principalDue + feeDue;
        }
    }

    function _dueOf(bytes32 id, address maker) private view returns (uint256 principalDue, uint256 feeDue) {
        ICreditFacility.Position memory p = FACILITY.position(id, maker);
        principalDue = p.principal - p.paidPrincipal;
        uint256 fee = feeOf(p.principal, p.aprBps, p.start, uint64(block.timestamp));
        feeDue = fee > p.paidFee ? fee - p.paidFee : 0;
    }

    /// @dev Splits `toLenders <= totalDue` pro rata of `due`: every maker but the last gets the floor of its
    ///      share and the last takes the remainder, so exactly `toLenders` is distributed. With three or more
    ///      makers that remainder can exceed the last maker's due by a few units of dust; the excess then goes
    ///      to the earlier makers in order, up to what each is owed, so no maker is ever paid past its due.
    function _shares(uint256[] memory due, uint256 totalDue, uint256 toLenders)
        private
        pure
        returns (uint256[] memory shares)
    {
        uint256 n = due.length;
        shares = new uint256[](n);
        if (toLenders == 0) return shares;

        uint256 last = n - 1;
        uint256 distributed;
        for (uint256 i; i < last; ++i) {
            shares[i] = toLenders * due[i] / totalDue;
            distributed += shares[i];
        }
        uint256 remainder = toLenders - distributed;
        if (remainder > due[last]) {
            uint256 excess = remainder - due[last];
            remainder = due[last];
            for (uint256 i; excess != 0; ++i) {
                uint256 room = due[i] - shares[i];
                uint256 add = excess < room ? excess : room;
                shares[i] += add;
                excess -= add;
            }
        }
        shares[last] = remainder;
    }
}
