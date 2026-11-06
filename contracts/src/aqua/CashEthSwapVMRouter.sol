// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Simulator } from "@1inch/solidity-utils/contracts/mixins/Simulator.sol";
import { SwapVM } from "@1inch/swap-vm/contracts/SwapVM.sol";
import { AquaOpcodes } from "@1inch/swap-vm/contracts/opcodes/AquaOpcodes.sol";
import { Context } from "@1inch/swap-vm/contracts/libs/VM.sol";
import { Deadline, Salt } from "@1inch/swap-vm/contracts/instructions/Controls.sol";
import { Jump, JumpIfDirection } from "@1inch/swap-vm/contracts/instructions/Jumps.sol";
import {
    OnlyTakerTokenBalanceNonZero,
    OnlyTakerTokenBalanceGte,
    OnlyTakerTokenSupplyShareGte,
    OnlyTxOriginTokenBalanceNonZero
} from "@1inch/swap-vm/contracts/instructions/TokenValidators.sol";
import { XYCSwap } from "@1inch/swap-vm/contracts/instructions/XYCSwap.sol";
import { DynamicBalances } from "@1inch/swap-vm/contracts/instructions/Balances.sol";
import { RequireMinRate } from "@1inch/swap-vm/contracts/instructions/MinRate.sol";
import { Decay } from "@1inch/swap-vm/contracts/instructions/Decay.sol";
import { FeeFlatIn } from "@1inch/swap-vm/contracts/instructions/FeeFlat.sol";
import { FeeProtocol } from "@1inch/swap-vm/contracts/instructions/FeeProtocol.sol";
import { Extruction } from "@1inch/swap-vm/contracts/instructions/Extruction.sol";
import { PeggedSwap } from "@1inch/swap-vm/contracts/instructions/PeggedSwap.sol";

import { IReceivableRegistry } from "../core/interfaces/IReceivableRegistry.sol";
import { IKYARegistry } from "../core/interfaces/IKYARegistry.sol";
import { ReceivableCredit } from "./ReceivableCredit.sol";

/// @title CashEthSwapVMRouter
/// @notice The 1inch `AquaSwapVMRouter` (same `Simulator, SwapVM, AquaOpcodes` base, same constructor
///         arguments, same Aqua-mode order hashing) with exactly one added instruction: `ReceivableCredit`
///         at opcode 0x21, a free slot in SwapVM's conditions bank. With it a lender's Aqua strategy
///         `Salt ‖ ReceivableCredit(args)` becomes a credit line that sells shipped USDC 1:1 for Receivable
///         Credit Notes, only to the CashETH credit facility and only against a buyer-confirmed receivable
///         that satisfies the lender's own risk rules, read live from on-chain state on every fill.
/// @dev Changes relative to `AquaSwapVMRouter`:
///        - `_runOpcode` tries `ReceivableCredit` first and otherwise dispatches the Aqua opcode set exactly
///          as `AquaOpcodes._runOpcode` does (same opcodes, same order, `UnknownOpcode` on a miss), so
///          base-yield strategies such as `Salt ‖ FeeFlatIn ‖ XYCSwap` keep working on the same router.
///          One upstream instruction is left out: `XYCConcentrateSwap` (concentrated-liquidity XYC). With it
///          the runtime is 24,650 bytes, 74 over EIP-170; without it 23,759. CashETH ships no concentrated
///          strategies, and such a program reverts `UnknownOpcode` here instead of executing.
///        - Three immutables the instruction reads: `REGISTRY` (receivable state, tenor, buyer, seller,
///          currency), `KYA` (buyer and seller reputation) and `FACILITY` (the only allowed taker and the
///          recipient of the `onCreditFill` callback).
///        - `exposure(maker, buyer)`: the cumulative USDC a lender has advanced against a buyer across all
///          of its strategies on this router. It only grows (repayments do not decrement it), so the
///          lender's `maxPerBuyer` caps lifetime advances to that buyer, not outstanding principal.
///      Only `tokenOut` is pinned to the receivable currency; `tokenIn` is whatever token the lender paired
///      in its order (RCN for orders from `CashEthOrderBuilder`). That is safe because the facility is the
///      only possible taker and controls exactly what it sends.
///      `quote` must be called with `from = FACILITY` (e.g. an `eth_call` with that sender): the instruction
///      checks the taker on quotes as well, and in a static context it neither updates exposure nor calls
///      the facility.
contract CashEthSwapVMRouter is Simulator, SwapVM, AquaOpcodes {
    /// @notice Receivable registry the credit instruction reads.
    IReceivableRegistry public immutable REGISTRY;
    /// @notice Agent registry the credit instruction reads buyer and seller reputation from.
    IKYARegistry public immutable KYA;
    /// @notice The CashETH credit facility: the only taker the credit instruction accepts.
    address public immutable FACILITY;

    error ZeroAddress();

    /// @param aqua Aqua registry holding the strategies' virtual balances
    /// @param weth Wrapped native token (WHBAR on Hedera)
    /// @param owner Router owner (can only rescue funds, as in `AquaSwapVMRouter`)
    /// @param name EIP-712 domain name
    /// @param version EIP-712 domain version
    /// @param registry `ReceivableRegistry`
    /// @param kya `KYARegistry`
    /// @param facility `CreditFacility`
    constructor(
        address aqua,
        address weth,
        address owner,
        string memory name,
        string memory version,
        address registry,
        address kya,
        address facility
    ) SwapVM(aqua, weth, owner, name, version) {
        if (registry == address(0) || kya == address(0) || facility == address(0)) revert ZeroAddress();
        REGISTRY = IReceivableRegistry(registry);
        KYA = IKYARegistry(kya);
        FACILITY = facility;
    }

    /// @notice Cumulative USDC `maker` has advanced against receivables owed by `buyer` through this router.
    /// @dev Never decremented on repayment.
    function exposure(address maker, address buyer) external view returns (uint256) {
        return ReceivableCredit.store().exposure[maker][buyer];
    }

    /// @dev Dispatches an opcode to its handler for VM execution (as in `AquaSwapVMRouter`).
    function _dispatch(Context memory ctx, uint256 opcode, bytes calldata args) internal override {
        _runOpcode(ctx, opcode, args);
    }

    /// @dev `ReceivableCredit` (0x21) first, then `AquaOpcodes._runOpcode`'s chain in its original order minus
    ///      `XYCConcentrateSwap` (see the contract header). Unknown opcodes revert `UnknownOpcode` as upstream.
    function _runOpcode(Context memory ctx, uint256 opcode, bytes calldata args) internal override {
             if (opcode == ReceivableCredit.opcode.asU8()) ReceivableCredit.exec(ctx, args, REGISTRY, KYA, FACILITY);
        else if (opcode == Salt.opcode.asU8()) Salt.exec(ctx, args);
        else if (opcode == Deadline.opcode.asU8()) Deadline.exec(ctx, args);
        else if (opcode == OnlyTxOriginTokenBalanceNonZero.opcode.asU8()) OnlyTxOriginTokenBalanceNonZero.exec(ctx, args);
        else if (opcode == OnlyTakerTokenBalanceNonZero.opcode.asU8()) OnlyTakerTokenBalanceNonZero.exec(ctx, args);
        else if (opcode == OnlyTakerTokenBalanceGte.opcode.asU8()) OnlyTakerTokenBalanceGte.exec(ctx, args);
        else if (opcode == OnlyTakerTokenSupplyShareGte.opcode.asU8()) OnlyTakerTokenSupplyShareGte.exec(ctx, args);
        else if (opcode == Jump.opcode.asU8()) Jump.exec(ctx, args);
        else if (opcode == JumpIfDirection.opcode.asU8()) JumpIfDirection.exec(ctx, args);
        else if (opcode == DynamicBalances.opcode.asU8()) DynamicBalances.exec(ctx, args);
        else if (opcode == PeggedSwap.opcode.asU8()) PeggedSwap.exec(ctx, args);
        else if (opcode == XYCSwap.opcode.asU8()) XYCSwap.exec(ctx, args);
        else if (opcode == FeeFlatIn.opcode.asU8()) FeeFlatIn.exec(ctx, args);
        else if (opcode == FeeProtocol.opcode.asU8()) FeeProtocol.exec(ctx, args);
        else if (opcode == Decay.opcode.asU8()) Decay.exec(ctx, args);
        else if (opcode == RequireMinRate.opcode.asU8()) RequireMinRate.exec(ctx, args);
        else if (opcode == Extruction.opcode.asU8()) Extruction.exec(ctx, args);
        else revert UnknownOpcode(opcode);
    }
}
