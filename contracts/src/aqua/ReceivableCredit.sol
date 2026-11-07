// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

// Derived from the 1inch SwapVM instruction pattern (© 2025 Degensoft Ltd, LicenseRef-Degensoft-SwapVM-1.1,
// see contracts/lib/swap-vm/LICENSE). New instruction written by CashETH on 2026-11-06.

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { CalldataParse } from "@1inch/solidity-utils/contracts/libraries/CalldataParse.sol";

import { Context } from "@1inch/swap-vm/contracts/libs/VM.sol";
import { Opcode } from "@1inch/swap-vm/contracts/libs/OpcodeList.sol";
import { MemoryPtr, MemoryPtrLib } from "@1inch/swap-vm/contracts/libs/MemoryPtr.sol";
import { InstructionBuilder } from "@1inch/swap-vm/contracts/libs/InstructionBuilder.sol";

import { IReceivableRegistry } from "../core/interfaces/IReceivableRegistry.sol";
import { IKYARegistry } from "../core/interfaces/IKYARegistry.sol";
import { RiskPricing } from "../core/libs/RiskPricing.sol";

/// @notice Minimal view of the credit facility the opcode notifies on every non-static fill.
interface ICreditFillReceiver {
    function onCreditFill(bytes32 id, address maker, uint256 usdcIn, uint16 aprBps) external;
}

/// @title ReceivableCredit
/// @notice SwapVM instruction (opcode 0x21, a free slot in the conditions bank) that turns a lender's Aqua
///         strategy into a credit line: the lender ships USDC (and RCN at 0) and the program
///         `Salt ‖ ReceivableCredit(args)` sells that USDC 1:1 for Receivable Credit Notes, but only to the
///         CashETH credit facility and only against a buyer-confirmed receivable that meets the lender's
///         own rules, read live from on-chain state on every fill. The price is not the lender's: the opcode scores
///         the seller from its on-chain record (`RiskPricing`) and every fill pays the seller's own APR.
/// @dev Checks, in order (first failure reverts the whole swap):
///        1. `taker == facility`. This replaces a KycNFT-style taker gate: identity checks (KYA levels,
///           owner separation, buyer signature) already ran when the receivable was registered, and the
///           facility is the only contract that can hold freshly minted RCN.
///        2. Taker args carry exactly what the facility vouches for: `[bytes32 id, uint16 advanceBps]`
///           (34 bytes, consumed with `tryChopTakerArgs`).
///        3. `registry.get(id).state == Confirmed` (not yet financed, cancelled, ...).
///        4. Seller list: if `sellerSet` is non-empty the seller must be in it (it narrows; the score still applies).
///        5. Remaining tenor `dueDate - now` is positive and at most `maxTenorDays` days.
///        6. `advanceBps <= maxAdvanceBps`.
///        7. The seller's score (its KYA reputation and the tenor) is financeable (500 or more) and its risk slab
///           is one the lender funds (`slabMask`: bit 0 low, bit 1 medium, bit 2 high).
///        8. `tokenOut` is the receivable's currency (USDC); the swap direction is RCN -> USDC.
///        9. `amount` (the taker-specified side) fits the strategy's Aqua USDC balance, the lender's per-buyer
///           exposure cap across all of its strategies, and leaves at least `minReserve` USDC in the
///           lender's wallet.
///       Pricing is 1:1 (the other register is set to `amount`); the yield is the seller's `RiskPricing.aprBps`,
///       which the facility records for the lender. In a non-static context (`swap`, not `quote`) the opcode adds
///       `amount` to `exposure[maker][buyer]` and calls `facility.onCreditFill(id, maker, amount, aprBps)`.
///
///       Encoding (big-endian, packed; 37 + 20 * n bytes, n in [0, 3] derived from the args length):
///         offset  0  uint16  maxTenorDays
///         offset  2  uint16  maxAdvanceBps
///         offset  4  uint128 maxPerBuyer
///         offset 20  uint8   slabMask       (1..7)
///         offset 21  uint128 minReserve
///         offset 37  address sellerSet[n]   (20 bytes each)
///       Taker args: `abi.encodePacked(bytes32 id, uint16 advanceBps)`.
///       Exposure lives in the router's storage at `keccak256("casheth.ReceivableCredit.v1")`.
library ReceivableCredit {
    using CalldataParse for bytes;
    using InstructionBuilder for MemoryPtr;

    // forge-lint: disable-next-line(screaming-snake-case-const)
    Opcode constant opcode = Opcode._21; // name fixed by the SwapVM instruction-library convention

    uint256 internal constant FIXED_ARGS_LENGTH = 37;
    uint8 internal constant ALL_SLABS = 7;
    uint256 internal constant MAX_SELLERS = 3;
    uint256 internal constant TAKER_ARGS_LENGTH = 34;
    bytes32 internal constant STORAGE_SLOT = keccak256("casheth.ReceivableCredit.v1");

    struct Args {
        uint16 maxTenorDays;
        uint16 maxAdvanceBps;
        uint128 maxPerBuyer;
        uint8 slabMask;
        uint128 minReserve;
        address[] sellerSet;
    }

    struct Storage {
        mapping(address maker => mapping(address buyer => uint256)) exposure;
    }

    error NotFacilityTaker(address taker);
    error ReceivableNotConfirmed(bytes32 id);
    error TenorTooLong(uint256 tenorDays, uint16 max);
    error AdvanceTooHigh(uint16 req, uint16 max);
    error SlabNotFunded(RiskPricing.Slab slab, uint8 slabMask);
    error InvalidSlabMask(uint8 slabMask);
    error WrongTokenOut(address tokenOut);
    error InsufficientLiquidity(uint256 need, uint256 have);
    error BuyerExposureExceeded(uint256 would, uint128 max);
    error SELLER_NOT_FUNDED_BY_LENDER();
    error LENDER_RESERVE_TOO_LOW();
    error TakerArgsTooShort(uint256 length);
    error ReceivablePastDue(bytes32 id, uint64 dueDate);
    error TooManySellers(uint256 count);
    error InvalidArgsLength(uint256 length);

    function sizeOf(uint256 sellerCount) internal pure returns (uint256) {
        return InstructionBuilder.sizeOf() + FIXED_ARGS_LENGTH + sellerCount * 20;
    }

    function build(Args memory a) internal pure returns (bytes memory) {
        return build(MemoryPtrLib.alloc(sizeOf(a.sellerSet.length)), a).resolve();
    }

    function build(MemoryPtr ptrStart, Args memory a) internal pure returns (MemoryPtr ptr) {
        require(a.sellerSet.length <= MAX_SELLERS, TooManySellers(a.sellerSet.length));
        require(_validMask(a.slabMask), InvalidSlabMask(a.slabMask));

        ptr = ptrStart.pushHeader(opcode);
        ptr = ptr.push(a.maxTenorDays, 2).push(a.maxAdvanceBps, 2).push(a.maxPerBuyer, 16);
        ptr = ptr.push(a.slabMask).push(a.minReserve, 16);
        for (uint256 i; i < a.sellerSet.length; i++) {
            ptr = ptr.push(a.sellerSet[i]);
        }
        ptrStart.patchLength(ptr);
    }

    function parse(bytes calldata args) internal pure returns (Args memory a) {
        uint256 length = args.length;
        require(
            length >= FIXED_ARGS_LENGTH && (length - FIXED_ARGS_LENGTH) % 20 == 0
                && (length - FIXED_ARGS_LENGTH) / 20 <= MAX_SELLERS,
            InvalidArgsLength(length)
        );

        a.maxTenorDays = args.at(0).asU16();
        a.maxAdvanceBps = args.at(2).asU16();
        a.maxPerBuyer = args.at(4).asU128();
        a.slabMask = args.at(20).asU8();
        a.minReserve = args.at(21).asU128();
        require(_validMask(a.slabMask), InvalidSlabMask(a.slabMask));

        uint256 count = (length - FIXED_ARGS_LENGTH) / 20;
        a.sellerSet = new address[](count);
        for (uint256 i; i < count; i++) {
            a.sellerSet[i] = args.at(FIXED_ARGS_LENGTH + i * 20).asAddress();
        }
    }

    function store() internal pure returns (Storage storage s) {
        bytes32 slot = STORAGE_SLOT;
        assembly ("memory-safe") {
            s.slot := slot
        }
    }

    function exec(
        Context memory ctx,
        bytes calldata args,
        IReceivableRegistry registry,
        IKYARegistry kya,
        address facility
    ) internal {
        require(ctx.query.taker == facility, NotFacilityTaker(ctx.query.taker));

        bytes calldata takerArgs = ctx.tryChopTakerArgs(TAKER_ARGS_LENGTH);
        require(takerArgs.length == TAKER_ARGS_LENGTH, TakerArgsTooShort(takerArgs.length));
        bytes32 id = takerArgs.at(0).asBytes32();
        uint16 advanceBps = takerArgs.at(32).asU16();

        Args memory a = parse(args);
        IReceivableRegistry.Receivable memory r = registry.get(id);
        require(r.state == IReceivableRegistry.State.Confirmed, ReceivableNotConfirmed(id));

        _checkSellerListed(a, r.seller);

        require(r.dueDate > block.timestamp, ReceivablePastDue(id, r.dueDate));
        uint256 tenor = r.dueDate - block.timestamp;
        require(tenor <= uint256(a.maxTenorDays) * 1 days, TenorTooLong((tenor + 1 days - 1) / 1 days, a.maxTenorDays));

        require(advanceBps <= a.maxAdvanceBps, AdvanceTooHigh(advanceBps, a.maxAdvanceBps));

        uint16 aprBps = _sellerPrice(a, kya, r.seller, tenor);

        address usdc = ctx.query.tokenOut;
        require(usdc == r.currency, WrongTokenOut(usdc));

        uint256 amount = ctx.query.isExactIn ? ctx.swap.amountIn : ctx.swap.amountOut;
        require(amount <= ctx.swap.balanceOut, InsufficientLiquidity(amount, ctx.swap.balanceOut));

        address maker = ctx.query.maker;
        Storage storage s = store();
        uint256 wouldBe = s.exposure[maker][r.buyer] + amount;
        require(wouldBe <= a.maxPerBuyer, BuyerExposureExceeded(wouldBe, a.maxPerBuyer));

        uint256 walletBalance = IERC20(usdc).balanceOf(maker);
        require(walletBalance >= amount && walletBalance - amount >= a.minReserve, LENDER_RESERVE_TOO_LOW());

        if (ctx.query.isExactIn) ctx.swap.amountOut = amount;
        else ctx.swap.amountIn = amount;

        if (!ctx.vm.isStaticContext) {
            s.exposure[maker][r.buyer] = wouldBe;
            ICreditFillReceiver(facility).onCreditFill(id, maker, amount, aprBps);
        }
    }

    /// @dev A non-empty `sellerSet` limits the strategy to those sellers; it never overrides the price or the slab.
    function _checkSellerListed(Args memory a, address seller) private pure {
        uint256 count = a.sellerSet.length;
        if (count == 0) return;
        for (uint256 i; i < count; i++) {
            if (a.sellerSet[i] == seller) return;
        }
        revert SELLER_NOT_FUNDED_BY_LENDER();
    }

    /// @return The seller's APR, after checking its score is financeable and its slab is one the lender funds.
    function _sellerPrice(Args memory a, IKYARegistry kya, address seller, uint256 tenor) private view returns (uint16) {
        (uint32 onTime, uint32 late, uint32 defaults) = kya.reputation(seller);
        int256 score = RiskPricing.score(onTime, late, defaults, tenor);
        uint16 aprBps = RiskPricing.aprBps(score); // reverts NotFinanceable below 500
        RiskPricing.Slab slab = RiskPricing.slabOf(score);
        require(a.slabMask & (uint8(1) << (uint8(slab) - 1)) != 0, SlabNotFunded(slab, a.slabMask));
        return aprBps;
    }

    function _validMask(uint8 mask) private pure returns (bool) {
        return mask != 0 && mask <= ALL_SLABS;
    }
}
