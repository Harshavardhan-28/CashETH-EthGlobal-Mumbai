/**
 * What the wallet agrees to sign. Claude Code drives this wallet, so every request is checked against the live
 * CashETH deployment (`deployments/testnet/addresses.json`) before a key is touched:
 *
 * - a receivable confirmation only for the ReceivableRegistry's EIP-712 domain, as the buyer it names, paying the
 *   RepaymentRouter in USDC;
 * - calldata only to USDC / tUSDT (exact `approve` to the RepaymentRouter or Aqua, never unlimited, at most the
 *   per-call cap), the RepaymentRouter (`repay`) and Aqua (`ship`, `dock`).
 */
import { ABI } from "@1inch/aqua-sdk";
import type { Calldata, WireTypedData } from "@casheth/agents";
import { RECEIVABLE_DOMAIN_NAME, RECEIVABLE_DOMAIN_VERSION, RepaymentRouterAbi, type Addresses } from "@casheth/shared";
import { decodeFunctionData, erc20Abi, isAddressEqual, maxUint256, type Abi, type Address } from "viem";

export type RefusalCode =
  | "BAD_INPUT"
  | "UNKNOWN_ACCOUNT"
  | "NOT_DEPLOYED"
  | "WRONG_DOMAIN"
  | "SIGNER_NOT_BUYER"
  | "WRONG_PAYEE"
  | "WRONG_CURRENCY"
  | "TARGET_NOT_ALLOWED"
  | "FUNCTION_NOT_ALLOWED"
  | "SPENDER_NOT_ALLOWED"
  | "APPROVE_UNLIMITED"
  | "APPROVE_ABOVE_CAP";

/** The wallet refused a request; nothing was signed or sent. */
export class WalletRefusal extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "WalletRefusal";
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...this.details };
  }
}

function deployed(addresses: Addresses, key: "receivableRegistry" | "repaymentRouter" | "usdc" | "aqua"): Address {
  const value = addresses[key];
  if (!value) throw new WalletRefusal("NOT_DEPLOYED", `deployments/testnet/addresses.json has no ${key}`);
  return value;
}

export function checkConfirmation(typedData: WireTypedData, ctx: { addresses: Addresses; signer: Address }): void {
  const { domain, message } = typedData;
  const registry = deployed(ctx.addresses, "receivableRegistry");
  if (
    domain.name !== RECEIVABLE_DOMAIN_NAME ||
    domain.version !== RECEIVABLE_DOMAIN_VERSION ||
    Number(domain.chainId) !== ctx.addresses.chainId ||
    !isAddressEqual(domain.verifyingContract, registry)
  ) {
    throw new WalletRefusal("WRONG_DOMAIN", `the typed data is not a ReceivableRegistry confirmation (expected ${RECEIVABLE_DOMAIN_NAME} v${RECEIVABLE_DOMAIN_VERSION}, chain ${ctx.addresses.chainId}, ${registry})`, { domain });
  }
  if (!isAddressEqual(message.buyer, ctx.signer)) {
    throw new WalletRefusal("SIGNER_NOT_BUYER", `the confirmation names buyer ${message.buyer}, not this account (${ctx.signer})`);
  }
  const router = deployed(ctx.addresses, "repaymentRouter");
  if (!isAddressEqual(message.payTo, router)) throw new WalletRefusal("WRONG_PAYEE", `payTo ${message.payTo} is not the RepaymentRouter ${router}`);
  const usdc = deployed(ctx.addresses, "usdc");
  if (!isAddressEqual(message.currency, usdc)) throw new WalletRefusal("WRONG_CURRENCY", `currency ${message.currency} is not USDC ${usdc}`);
}

type Target = { name: string; abi: Abi; functions: readonly string[] };

function targets(addresses: Addresses): Map<string, Target> {
  const token = (name: string): Target => ({ name, abi: erc20Abi, functions: ["approve"] });
  const entries: [Address | undefined, Target][] = [
    [addresses.usdc, token("USDC")],
    [addresses.tUsdt, token("tUSDT")],
    [addresses.repaymentRouter, { name: "RepaymentRouter", abi: RepaymentRouterAbi as Abi, functions: ["repay"] }],
    [addresses.aqua, { name: "Aqua", abi: ABI.AQUA_ABI as unknown as Abi, functions: ["ship", "dock"] }],
  ];
  return new Map(entries.filter((e): e is [Address, Target] => e[0] !== undefined).map(([address, target]) => [address.toLowerCase(), target]));
}

function checkApproval(args: readonly unknown[], index: number, ctx: { addresses: Addresses; approveCap: bigint }): void {
  const [spender, amount] = args as [Address, bigint];
  const spenders = [ctx.addresses.repaymentRouter, ctx.addresses.aqua].filter((a): a is Address => a !== undefined);
  if (!spenders.some((s) => isAddressEqual(s, spender))) {
    throw new WalletRefusal("SPENDER_NOT_ALLOWED", `call ${index + 1}: approvals go to the RepaymentRouter or Aqua only, not ${spender}`, { index, spender });
  }
  if (amount === maxUint256) {
    throw new WalletRefusal("APPROVE_UNLIMITED", `call ${index + 1}: unlimited approvals are refused (HTS rejects them too); approve the exact amount`, { index });
  }
  if (amount > ctx.approveCap) {
    throw new WalletRefusal("APPROVE_ABOVE_CAP", `call ${index + 1}: approval of ${amount} units is above the wallet's per-call cap of ${ctx.approveCap}`, {
      index,
      amount: amount.toString(),
      cap: ctx.approveCap.toString(),
    });
  }
}

/** Checks the whole batch before anything is sent; the first refused call refuses the batch. */
export function checkCalls(calls: Calldata[], ctx: { addresses: Addresses; approveCap: bigint }): void {
  if (calls.length === 0) throw new WalletRefusal("BAD_INPUT", "no calls to send");
  const allowed = targets(ctx.addresses);
  calls.forEach((call, index) => {
    const target = allowed.get(call.to.toLowerCase());
    if (!target) {
      throw new WalletRefusal("TARGET_NOT_ALLOWED", `call ${index + 1}: ${call.to} is not USDC, tUSDT, the RepaymentRouter or Aqua`, { index, to: call.to });
    }
    let decoded: { functionName: string; args?: readonly unknown[] };
    try {
      decoded = decodeFunctionData({ abi: target.abi, data: call.data });
    } catch {
      throw new WalletRefusal("FUNCTION_NOT_ALLOWED", `call ${index + 1}: the calldata is not a ${target.name} function the wallet knows`, { index, to: call.to });
    }
    if (!target.functions.includes(decoded.functionName)) {
      throw new WalletRefusal("FUNCTION_NOT_ALLOWED", `call ${index + 1}: ${target.name}.${decoded.functionName} is not allowed (only ${target.functions.join(", ")})`, {
        index,
        to: call.to,
        function: decoded.functionName,
      });
    }
    if (decoded.functionName === "approve") checkApproval(decoded.args ?? [], index, ctx);
  });
}
