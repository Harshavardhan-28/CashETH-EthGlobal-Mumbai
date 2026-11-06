import { CreditFacilityAbi, RepaymentRouterAbi, type Env } from "@casheth/shared";
import { BaseError, decodeFunctionData, encodeErrorResult, erc20Abi, getAddress, maxUint256, RawContractError, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { merchantOrigins } from "./config.js";
import { exactApprovalCall, toToolError } from "./live.js";
import { enqueue } from "./orchestrator/queue.js";

const CALL = { to: getAddress("0x00000000000000000000000000000000000000a3"), data: "0x" as Hex, description: "CreditFacility.reserve(...)" };

/** A failed `eth_call` as viem reports it: the revert data sits on a nested `RawContractError`. */
function simulatedRevert(data: Hex): BaseError {
  return new BaseError("Execution reverted", { cause: new RawContractError({ data }) });
}

describe("toToolError (revert decoding)", () => {
  it("names a shared-code custom error by its code", () => {
    const err = toToolError(simulatedRevert(encodeErrorResult({ abi: CreditFacilityAbi, errorName: "AGENT_BUDGET_EXCEEDED" })), CALL);
    expect(err.toJSON()).toMatchObject({ code: "AGENT_BUDGET_EXCEEDED", message: "CreditFacility.reserve(...) reverted AGENT_BUDGET_EXCEEDED" });
  });

  it("maps any other custom error to CONTRACT_REVERTED with its name and arguments", () => {
    const data = encodeErrorResult({ abi: RepaymentRouterAbi, errorName: "ASSOCIATION_FAILED", args: [167n] });
    expect(toToolError(simulatedRevert(data), CALL).toJSON()).toMatchObject({ code: "CONTRACT_REVERTED", error: "ASSOCIATION_FAILED", args: ["167"] });
  });

  it("falls back to CHAIN_ERROR for unknown selectors and transport failures", () => {
    expect(toToolError(simulatedRevert("0xdeadbeef"), CALL).code).toBe("CHAIN_ERROR");
    expect(toToolError(new Error("fetch failed"), CALL).toJSON()).toMatchObject({ code: "CHAIN_ERROR", message: "CreditFacility.reserve(...) failed: fetch failed" });
  });
});

describe("exactApprovalCall", () => {
  it("approves the current allowance plus the new amount, never max", async () => {
    const token = getAddress("0x0000000000000000000000000000000000068cda");
    const owner = getAddress("0x00000000000000000000000000000000000000a9");
    const spender = getAddress("0x00000000000000000000000000000000000000b1");
    const reader = { readContract: async () => 1_000_000n } as unknown as Parameters<typeof exactApprovalCall>[0];
    const call = await exactApprovalCall(reader, { token, owner, spender, add: 2_000_000n, label: "USDC" });
    const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: call.data });
    expect(call.to).toBe(token);
    expect(functionName).toBe("approve");
    expect(args).toEqual([spender, 3_000_000n]);
    expect(args[1]).not.toBe(maxUint256);
  });
});

describe("enqueue (per-signer send serialisation)", () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it("runs two concurrent sends from one signer one after the other, and other signers alongside", async () => {
    const queues = new Map<string, Promise<unknown>>();
    const trace: string[] = [];
    const fakeSend = (name: string, fails = false) => async () => {
      trace.push(`${name}:start`);
      await tick();
      trace.push(`${name}:end`);
      if (fails) throw new Error(`${name} reverted`);
      return name;
    };
    const results = await Promise.allSettled([
      enqueue(queues, "coordinator", fakeSend("a", true)),
      enqueue(queues, "coordinator", fakeSend("b")),
      enqueue(queues, "issuer", fakeSend("c")),
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
    // a failed send does not block the next one; the other signer did not wait for the coordinator
    expect(trace.indexOf("b:start")).toBeGreaterThan(trace.indexOf("a:end"));
    expect(trace.indexOf("c:start")).toBeLessThan(trace.indexOf("a:end"));
  });
});

describe("merchantOrigins", () => {
  const env = (extra: Record<string, string>) => ({ MERCHANT_ACCOUNT_ID: "0.0.900", ...extra }) as unknown as Env;

  it("defaults to the demo merchant on MERCHANT_PORT and parses accountId=origin pairs", () => {
    expect(merchantOrigins(env({ MERCHANT_PORT: "3010" }))).toEqual({ "0.0.900": ["http://localhost:3010"] });
    expect(merchantOrigins(env({ MERCHANT_ORIGINS: "0.0.1=https://a.example/x, 0.0.1=https://b.example,0.0.2=http://localhost:3003" }))).toEqual({
      "0.0.1": ["https://a.example", "https://b.example"],
      "0.0.2": ["http://localhost:3003"],
    });
    expect(() => merchantOrigins(env({ MERCHANT_ORIGINS: "https://a.example" }))).toThrow(/accountId=origin/);
  });
});
