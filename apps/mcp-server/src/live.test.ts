import { creditArgs } from "@casheth/aqua";
import { AquaRouterAbi, CreditFacilityAbi, RepaymentRouterAbi, type Env } from "@casheth/shared";
import { BaseError, decodeFunctionData, encodeErrorResult, erc20Abi, getAddress, keccak256, maxUint256, RawContractError, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { merchantOrigins, type AgentKeyRole, type McpConfig } from "./config.js";
import { exactApprovalCall, fundCalldata, inProcessAllowed, mirrorLogSource, toToolError } from "./live.js";
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

  it("always admits the demo merchant on MERCHANT_PORT, and parses accountId=origin pairs on top of it", () => {
    expect(merchantOrigins(env({ MERCHANT_PORT: "3010" }))).toEqual({ "0.0.900": ["http://localhost:3010"] });
    expect(merchantOrigins(env({ MERCHANT_ORIGINS: "0.0.1=https://a.example/x, 0.0.1=https://b.example,0.0.2=http://localhost:3003" }))).toEqual({
      "0.0.900": ["http://localhost:3003"],
      "0.0.1": ["https://a.example", "https://b.example"],
      "0.0.2": ["http://localhost:3003"],
    });
    expect(() => merchantOrigins(env({ MERCHANT_ORIGINS: "https://a.example" }))).toThrow(/accountId=origin/);
  });

  it("admits an external merchant (casheth-paid-apis) beside ours, keyed by its payee account", () => {
    const origins = merchantOrigins(env({ MERCHANT_ORIGINS: "0.0.11333304=https://casheth-paid-apis-177290233934.asia-southeast1.run.app/" }));
    expect(origins).toEqual({
      "0.0.900": ["http://localhost:3003"],
      "0.0.11333304": ["https://casheth-paid-apis-177290233934.asia-southeast1.run.app"],
    });
  });

  it("does not list an origin twice", () => {
    expect(merchantOrigins(env({ MERCHANT_ORIGINS: "0.0.900=http://localhost:3003,0.0.1=https://a.example,0.0.1=https://a.example/" }))).toEqual({
      "0.0.900": ["http://localhost:3003"],
      "0.0.1": ["https://a.example"],
    });
  });

  it("rejects a payee that is not an account id", () => {
    expect(() => merchantOrigins(env({ MERCHANT_ORIGINS: "merchant=https://a.example" }))).toThrow(/account id/);
  });
});

describe("fundCalldata (fund_agents without the lender key)", () => {
  const addrs = {
    aqua: getAddress("0x00000000000000000000000000000000000000b1"),
    swapRouter: getAddress("0x00000000000000000000000000000000000000b2"),
    orderBuilder: getAddress("0x00000000000000000000000000000000000000b3"),
    usdc: getAddress("0x0000000000000000000000000000000000068cda"),
    rcn: getAddress("0x00000000000000000000000000000000000000b4"),
    tUsdt: getAddress("0x00000000000000000000000000000000000000b5"),
  };
  const lender = getAddress("0x00000000000000000000000000000000000000a9");
  const order = { maker: lender, traits: 0n, data: "0x01" as Hex };
  const creditStrategy = "0xc1" as Hex;
  const baseStrategy = "0xba" as Hex;

  /** eth_call fake: the lender already has open strategies, so Aqua holds an allowance of X USDC and Y tUSDT. */
  const reader = (allowances: Record<string, bigint>) =>
    ({
      readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
        if (functionName === "allowance") return allowances[getAddress(address)] ?? 0n;
        if (functionName === "buildLenderOrder") return [order, creditStrategy];
        if (functionName === "buildBaseYieldOrder") return [order, baseStrategy];
        throw new Error(`unexpected eth_call ${functionName}`);
      },
    }) as unknown as Parameters<typeof fundCalldata>[0];

  it("raises the existing USDC and tUSDT allowances by the shipped amounts, then ships both strategies", async () => {
    const plan = { args: creditArgs(["medium"]), creditUsdc: 2_000_000n, base: { usdc: 1_000_000n, tUsdt: 1_500_000n, feeBps: 30 }, salt: 7n };
    const result = await fundCalldata(reader({ [addrs.usdc]: 4_000_000n, [addrs.tUsdt]: 500_000n }), addrs, lender, plan);

    const [usdcApprove, tUsdtApprove, shipCredit, shipBase] = result.calls;
    expect(usdcApprove!.to).toBe(addrs.usdc);
    expect(decodeFunctionData({ abi: erc20Abi, data: usdcApprove!.data }).args).toEqual([addrs.aqua, 4_000_000n + 2_000_000n + 1_000_000n]);
    expect(tUsdtApprove!.to).toBe(addrs.tUsdt);
    expect(decodeFunctionData({ abi: erc20Abi, data: tUsdtApprove!.data }).args).toEqual([addrs.aqua, 500_000n + 1_500_000n]);
    expect(decodeFunctionData({ abi: AquaRouterAbi, data: shipCredit!.data })).toMatchObject({
      functionName: "ship",
      args: [addrs.swapRouter, creditStrategy, [addrs.usdc, addrs.rcn], [2_000_000n, 0n]],
    });
    expect(decodeFunctionData({ abi: AquaRouterAbi, data: shipBase!.data })).toMatchObject({
      functionName: "ship",
      args: [addrs.swapRouter, baseStrategy, [addrs.usdc, addrs.tUsdt], [1_000_000n, 1_500_000n]],
    });
    expect(result.credit.strategyHash).toBe(keccak256(creditStrategy));
    expect(result.base?.strategyHash).toBe(keccak256(baseStrategy));
  });

  it("approves only the credit amount on top of the current allowance when no base strategy is shipped", async () => {
    const plan = { args: creditArgs(["low"]), creditUsdc: 3_000_000n, salt: 1n };
    const result = await fundCalldata(reader({ [addrs.usdc]: 2_000_000n }), addrs, lender, plan);
    expect(result.calls).toHaveLength(2);
    expect(decodeFunctionData({ abi: erc20Abi, data: result.calls[0]!.data }).args).toEqual([addrs.aqua, 5_000_000n]);
    expect(result.base).toBeUndefined();
  });
});

describe("inProcessAllowed (which demo keys the server signs with)", () => {
  const cfg = (agentKeyRoles: AgentKeyRole[], lenderKeysInProcess = false) => ({ agentKeyRoles, lenderKeysInProcess }) as unknown as McpConfig;

  it("signs for a role only when AGENT_KEYS_IN_PROCESS names it", () => {
    const sellerAndWorker = cfg(["seller", "worker"]);
    expect(inProcessAllowed("SELLER", sellerAndWorker)).toBe(true);
    expect(inProcessAllowed("WORKER_RESEARCH", sellerAndWorker)).toBe(true);
    expect(inProcessAllowed("BUYER", sellerAndWorker)).toBe(false);
  });

  it("keeps lenders behind LENDER_KEYS_IN_PROCESS and never signs as server accounts", () => {
    expect(inProcessAllowed("LENDER_A", cfg(["seller", "buyer", "worker"]))).toBe(false);
    expect(inProcessAllowed("LENDER_A", cfg([], true))).toBe(true);
    expect(inProcessAllowed("COORDINATOR", cfg(["seller", "buyer", "worker"], true))).toBe(false);
  });
});

describe("mirrorLogSource", () => {
  it("reads a contract's whole log history once, then only logs newer than the last one seen", async () => {
    const urls: string[] = [];
    const page = (ts: string) => ({ address: "0x00000000000000000000000000000000000000a2", data: "0x", topics: [], timestamp: ts, transaction_hash: `0x${"1".repeat(64)}` });
    const responses = [
      { logs: [page("1800000000.000000001"), page("1800000001.000000002")], links: { next: null } },
      { logs: [page("1800000005.000000003")], links: { next: null } },
    ];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify(responses.shift() ?? { logs: [], links: { next: null } }), { status: 200 });
    }) as typeof fetch;
    try {
      const source = mirrorLogSource({ HEDERA_MIRROR_NODE_URL: "https://mirror.example" } as unknown as Env);
      const address = getAddress("0x00000000000000000000000000000000000000a2");
      expect(await source.logs(address)).toHaveLength(2);
      const again = await source.logs(address);
      expect(again).toHaveLength(3);
      expect(urls[1]).toContain("timestamp=gt:1800000001.000000002");
    } finally {
      globalThis.fetch = original;
    }
  });
});
