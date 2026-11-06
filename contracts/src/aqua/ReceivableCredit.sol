// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { CalldataParse } from "@1inch/solidity-utils/contracts/libraries/CalldataParse.sol";

import { Context } from "@1inch/swap-vm/contracts/libs/VM.sol";
import { Opcode } from "@1inch/swap-vm/contracts/libs/OpcodeList.sol";
import { MemoryPtr, MemoryPtrLib } from "@1inch/swap-vm/contracts/libs/MemoryPtr.sol";
import { InstructionBuilder } from "@1inch/swap-vm/contracts/libs/InstructionBuilder.sol";

import { IReceivableRegistry } from "../core/interfaces/IReceivableRegistry.sol";
import { IKYARegistry } from "../core/interfaces/IKYARegistry.sol";

/// @notice Minimal view of the credit facility the opcode notifies on every non-static fill.
interface ICreditFillReceiver {
    function onCreditFill(bytes32 id, address maker, uint256 usdcIn, uint16 aprBps) external;
}

/// @title ReceivableCredit
/// @notice SwapVM instruction (opcode 0x21, a free slot in the conditions bank) that turns a lender's Aqua
///         strategy into a credit line: the lender ships USDC (and RCN at 0) and the program
///         `Salt ‖ ReceivableCredit(args)` sells that USDC 1:1 for Receivable Credit Notes, but only to the
///         CashETH credit facility and only against a buyer-confirmed receivable that meets the lender's
///         own risk rules, read live from on-chain state on every fill.
/// @dev Checks, in order (first failure reverts the whole swap):
///        1. `taker == facility`. This replaces a KycNFT-style taker gate: identity checks (KYA levels,
///           owner separation, buyer signature) already ran when the receivable was registered, and the
///           facility is the only contract that can hold freshly minted RCN.
///        2. Taker args carry exactly what the facility vouches for: `[bytes32 id, uint16 advanceBps]`
///           (34 bytes, consumed with `tryChopTakerArgs`).
///        3. `registry.get(id).state == Confirmed` (not yet financed, cancelled, ...).
///        4. Seller filter: if `sellerSet` is non-empty the seller must be in it (score ignored), else the
///           seller's KYA reputation must satisfy `onTime >= minSellerOnTime && defaults <= maxSellerDefaults`.
///        5. Remaining tenor `dueDate - now` is positive and at most `maxTenorDays` days.
///        6. `advanceBps <= maxAdvanceBps`.
///        7. Buyer KYA reputation `onTime >= minBuyerOnTime`.
///        8. `tokenOut` is the receivable's currency (USDC); the swap direction is RCN -> USDC.
///        9. `amount` (the taker-specified side) fits the strategy's Aqua USDC balance, the lender's per-buyer
///           exposure cap across all of its strategies, and leaves at least `minReserve` USDC in the
///           lender's wallet.
///       Pricing is 1:1 (the other register is set to `amount`); the yield is the `aprBps` the facility
///       records for the lender. In a non-static context (`swap`, not `quote`) the opcode adds `amount` to
///       `exposure[maker][buyer]` and calls `facility.onCreditFill(id, maker, amount, aprBps)`.
///
///       Encoding (big-endian, packed; 47 + 20 * n bytes, n in [0, 3] derived from the args length):
///         offset  0  uint16  maxTenorDays
///         offset  2  uint16  maxAdvanceBps
///         offset  4  uint32  minBuyerOnTime
///         offset  8  uint128 maxPerBuyer
///         offset 24  uint16  aprBps
///         offset 26  uint32  minSellerOnTime
///         offset 30  uint8   maxSellerDefaults
///         offset 31  uint128 minReserve
///         offset 47  address sellerSet[n]   (20 bytes each)
///       Taker args: `abi.encodePacked(bytes32 id, uint16 advanceBps)`.
///       Exposure lives in the router's storage at `keccak256("casheth.ReceivableCredit.v1")`.
library ReceivableCredit {
    using CalldataParse for bytes;
    using InstructionBuilder for MemoryPtr;

    // forge-lint: disable-next-line(screaming-snake-case-const)
    Opcode constant opcode = Opcode._21; // name fixed by the SwapVM instruction-library convention

    uint256 internal constant FIXED_ARGS_LENGTH = 47;
    uint256 internal constant MAX_SELLERS = 3;
    uint256 internal constant TAKER_ARGS_LENGTH = 34;
    bytes32 internal constant STORAGE_SLOT = keccak256("casheth.ReceivableCredit.v1");

    struct Args {
        uint16 maxTenorDays;
        uint16 maxAdvanceBps;
        uint32 minBuyerOnTime;
        uint128 maxPerBuyer;
        uint16 aprBps;
        uint32 minSellerOnTime;
        uint8 maxSellerDefaults;
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
    error BuyerReputationTooLow(uint32 onTime, uint32 min);
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

        ptr = ptrStart.pushHeader(opcode);
        ptr = ptr.push(a.maxTenorDays, 2).push(a.maxAdvanceBps, 2).push(a.minBuyerOnTime, 4);
        ptr = ptr.push(a.maxPerBuyer, 16).push(a.aprBps, 2).push(a.minSellerOnTime, 4);
        ptr = ptr.push(a.maxSellerDefaults).push(a.minReserve, 16);
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
        a.minBuyerOnTime = args.at(4).asU32();
        a.maxPerBuyer = args.at(8).asU128();
        a.aprBps = args.at(24).asU16();
        a.minSellerOnTime = args.at(26).asU32();
        a.maxSellerDefaults = args.at(30).asU8();
        a.minReserve = args.at(31).asU128();

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

        _checkSeller(a, kya, r.seller);

        require(r.dueDate > block.timestamp, ReceivablePastDue(id, r.dueDate));
        uint256 tenor = r.dueDate - block.timestamp;
        require(tenor <= uint256(a.maxTenorDays) * 1 days, TenorTooLong((tenor + 1 days - 1) / 1 days, a.maxTenorDays));

        require(advanceBps <= a.maxAdvanceBps, AdvanceTooHigh(advanceBps, a.maxAdvanceBps));

        (uint32 buyerOnTime,,) = kya.reputation(r.buyer);
        require(buyerOnTime >= a.minBuyerOnTime, BuyerReputationTooLow(buyerOnTime, a.minBuyerOnTime));

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
            ICreditFillReceiver(facility).onCreditFill(id, maker, amount, a.aprBps);
        }
    }

    /// @dev A non-empty `sellerSet` is an explicit allow-list that overrides the reputation thresholds.
    function _checkSeller(Args memory a, IKYARegistry kya, address seller) private view {
        uint256 count = a.sellerSet.length;
        if (count > 0) {
            for (uint256 i; i < count; i++) {
                if (a.sellerSet[i] == seller) return;
            }
            revert SELLER_NOT_FUNDED_BY_LENDER();
        }
        (uint32 onTime,, uint32 defaults) = kya.reputation(seller);
        require(onTime >= a.minSellerOnTime && defaults <= a.maxSellerDefaults, SELLER_NOT_FUNDED_BY_LENDER());
    }
}
