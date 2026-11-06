// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { CalldataParse } from "@1inch/solidity-utils/contracts/libraries/CalldataParse.sol";
import { ISwapVM } from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";
import { MakerTraits, MakerTraitsLib } from "@1inch/swap-vm/contracts/libs/MakerTraits.sol";
import { Salt } from "@1inch/swap-vm/contracts/instructions/Controls.sol";
import { FeeFlatIn } from "@1inch/swap-vm/contracts/instructions/FeeFlat.sol";
import { XYCSwap } from "@1inch/swap-vm/contracts/instructions/XYCSwap.sol";

import { CashEthTraits } from "../core/libs/CashEthTraits.sol";
import { ReceivableCredit } from "./ReceivableCredit.sol";

/// @title CashEthOrderBuilder
/// @notice Stateless helper that produces CashETH's SwapVM orders and taker data with the pinned SwapVM
///         libraries, so off-chain code gets the bytes from an `eth_call` instead of hand-encoding them.
/// @dev Every order is an Aqua-mode order (`useAquaInsteadOfSignature = true`, receiver 0, no hooks, tokens
///      sorted ascending). `strategy = abi.encode(order)`, so Aqua's `strategyHash = keccak256(strategy)`
///      equals the router's `hash(order)`; ship `strategy` with `aqua.ship(router, strategy, tokens, amounts)`.
///      Programs are `[uint8 opcode][uint8 argsLength][args]` instructions; the decoders accept exactly the
///      instruction sequence the matching builder emits.
contract CashEthOrderBuilder {
    using CalldataParse for bytes;
    using MakerTraitsLib for MakerTraits;

    /// @dev FeeFlatIn's fee denominator.
    uint256 private constant _FEE_DENOMINATOR = 1e7;

    error NotLenderOrder();
    error NotBaseYieldOrder();
    error FeeOutOfRange(uint32 feeBps);

    /// @notice Lender credit-line order: program `Salt(salt) ‖ ReceivableCredit(a)` over (USDC, RCN).
    /// @param salt Distinguishes otherwise identical strategies of the same lender.
    function buildLenderOrder(
        address maker,
        address rcn,
        address usdc,
        ReceivableCredit.Args calldata a,
        uint64 salt
    ) external pure returns (ISwapVM.Order memory order, bytes memory strategy) {
        order = _aquaOrder(maker, rcn, usdc, bytes.concat(Salt.build(salt), ReceivableCredit.build(a)));
        strategy = abi.encode(order);
    }

    /// @notice Inverse of `buildLenderOrder`.
    /// @dev Reverts `NotLenderOrder()` unless the order is Aqua-mode and its program is exactly
    ///      `Salt(uint64) ‖ ReceivableCredit`.
    function decodeLenderOrder(ISwapVM.Order calldata order)
        external
        pure
        returns (ReceivableCredit.Args memory a, uint64 salt, address tokenA, address tokenB)
    {
        bool ok = order.traits.useAquaInsteadOfSignature();
        bytes calldata program = order.traits.program(order.data);
        uint256 pc;
        bytes calldata args;

        (ok, args, pc) = _expect(ok, program, pc, Salt.opcode.asU8());
        ok = ok && args.length == 8;
        if (ok) salt = args.at(0).asU64();

        (ok, args, pc) = _expect(ok, program, pc, ReceivableCredit.opcode.asU8());
        if (!ok || pc != program.length) revert NotLenderOrder();

        a = ReceivableCredit.parse(args);
        (tokenA, tokenB) = order.traits.tokens(order.data);
    }

    /// @notice Base-yield order: constant-product market making on (USDC, tUSDT) with a flat input fee,
    ///         program `Salt(salt) ‖ FeeFlatIn(feeBps) ‖ XYCSwap`.
    /// @param feeBps Fee on the input amount in FeeFlatIn's units (1e7 = 100%, so 30_000 = 0.3%); must be
    ///        below 1e7.
    function buildBaseYieldOrder(address maker, address usdc, address tUsdt, uint32 feeBps, uint64 salt)
        external
        pure
        returns (ISwapVM.Order memory order, bytes memory strategy)
    {
        if (feeBps >= _FEE_DENOMINATOR) revert FeeOutOfRange(feeBps);
        order = _aquaOrder(
            maker,
            usdc,
            tUsdt,
            // forge-lint: disable-next-line(unsafe-typecast)
            bytes.concat(Salt.build(salt), FeeFlatIn.build(uint24(feeBps)), XYCSwap.build())
        );
        strategy = abi.encode(order);
    }

    /// @notice Inverse of `buildBaseYieldOrder`.
    /// @dev Reverts `NotBaseYieldOrder()` unless the order is Aqua-mode and its program is exactly
    ///      `Salt(uint64) ‖ FeeFlatIn ‖ XYCSwap`.
    function decodeBaseYieldOrder(ISwapVM.Order calldata order)
        external
        pure
        returns (uint32 feeBps, uint64 salt, address tokenA, address tokenB)
    {
        bool ok = order.traits.useAquaInsteadOfSignature();
        bytes calldata program = order.traits.program(order.data);
        uint256 pc;
        bytes calldata args;

        (ok, args, pc) = _expect(ok, program, pc, Salt.opcode.asU8());
        ok = ok && args.length == 8;
        if (ok) salt = args.at(0).asU64();

        (ok, args, pc) = _expect(ok, program, pc, FeeFlatIn.opcode.asU8());
        ok = ok && args.length == 3;
        if (ok) feeBps = args.at(0).asU24();

        (ok, args, pc) = _expect(ok, program, pc, XYCSwap.opcode.asU8());
        if (!ok || args.length != 0 || pc != program.length) revert NotBaseYieldOrder();

        (tokenA, tokenB) = order.traits.tokens(order.data);
    }

    /// @notice The taker data the credit facility sends: exact-in RCN -> USDC, strict `amount` threshold,
    ///         transferFrom + Aqua push, output to the facility, instruction args `id ‖ advanceBps`.
    function takerData(address facility, address rcn, address usdc, uint256 amount, bytes32 id, uint16 advanceBps)
        external
        pure
        returns (bytes memory)
    {
        return CashEthTraits.takerData(facility, rcn, usdc, amount, id, advanceBps);
    }

    /// @notice Aqua strategy hash of `order`; equals the router's `hash(order)` for Aqua-mode orders.
    function strategyHash(ISwapVM.Order calldata order) external pure returns (bytes32) {
        // forge-lint: disable-next-line(asm-keccak256)
        return keccak256(abi.encode(order));
    }

    // ------------------------------------------------------------------ internal

    function _aquaOrder(address maker, address x, address y, bytes memory program)
        private
        pure
        returns (ISwapVM.Order memory)
    {
        (address tokenA, address tokenB) = x < y ? (x, y) : (y, x);
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
                program: program
            })
        );
    }

    /// @dev Reads the instruction at `pc` and checks its opcode. Once `ok` is false it stays false and
    ///      nothing is read, so callers can chain expectations and revert once at the end.
    /// @return ok Whether every expectation so far held
    /// @return args The instruction's args (empty if `!ok`)
    /// @return next The offset of the following instruction
    function _expect(bool ok, bytes calldata program, uint256 pc, uint8 opcode)
        private
        pure
        returns (bool, bytes calldata args, uint256 next)
    {
        args = program[0:0];
        if (!ok || pc + 2 > program.length) return (false, args, pc);
        uint256 end = pc + 2 + uint8(program[pc + 1]);
        if (uint8(program[pc]) != opcode || end > program.length) return (false, args, pc);
        return (true, program[pc + 2:end], end);
    }
}
