import { describe, expect, it } from "vitest";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { createLenderAgent } from "./lender.js";
import type { ToolCaller } from "./mcpClient.js";
import type { Calldata } from "./sendCalls.js";

const lenderCalls: Calldata[] = [
  { to: "0x00000000000000000000000000000000000000f1", data: "0x01", description: "USDC.approve(aqua, 9)" },
  { to: "0x00000000000000000000000000000000000000f2", data: "0x02", description: "Aqua.ship(credit)" },
];
const strategies = { credit: keccak256(toHex("credit")) };
const seller: Address = "0x00000000000000000000000000000000000000c1";

function setup(toolResult: unknown, failOn?: string) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const client: ToolCaller = { call: async (tool, args) => (calls.push({ tool, args }), toolResult as never) };
  const sent: Calldata[] = [];
  const send = async (call: Calldata) => {
    if (call.description === failOn) throw new Error("execution reverted");
    sent.push(call);
    return keccak256(toHex(`tx${sent.length}`)) as Hex;
  };
  return { agent: createLenderAgent({ client, send }), calls, sent };
}

describe("lenderAgent.ship", () => {
  it("asks fund_agents for the tier and amounts as base-unit strings", async () => {
    const { agent, calls } = setup({ mode: "shipped", tier: "medium", aprBps: 850, credit: { strategyHash: strategies.credit } });
    await agent.ship({ tier: "medium", sellerSet: [seller], creditUsdc: 6_000_000n, baseUsdc: 2_000_000n, baseTusdt: 2_000_000n });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      tool: "fund_agents",
      args: { tier: "medium", sellerSet: [seller], creditUsdc: "6000000", base: { usdc: "2000000", tUsdt: "2000000" } },
    });
    expect(calls[0]!.args.idempotencyKey).toEqual(expect.any(String));
  });

  it("derives the idempotency key from the strategy it ships, so a retried ship replays instead of shipping twice", async () => {
    const { agent, calls } = setup({ mode: "shipped", tier: "low", aprBps: 700, credit: { strategyHash: strategies.credit } });
    await agent.ship({ tier: "low", creditUsdc: 1_000_000n });
    await agent.ship({ tier: "low", creditUsdc: 1_000_000n });
    await agent.ship({ tier: "low", creditUsdc: 2_000_000n });
    await agent.ship({ tier: "medium", creditUsdc: 1_000_000n });
    await agent.ship({ tier: "low", creditUsdc: 1_000_000n, sellerSet: [seller] });
    await agent.ship({ tier: "low", creditUsdc: 1_000_000n, baseUsdc: 1n, baseTusdt: 1n });
    await agent.ship({ tier: "low", creditUsdc: 1_000_000n, attempt: "second-strategy" });
    await agent.ship({ tier: "low", creditUsdc: 1_000_000n, idempotencyKey: "explicit-key-1" });
    const keys = calls.map((c) => c.args.idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[7]).toBe("explicit-key-1");
    expect(new Set(keys).size).toBe(7);
  });

  it("omits the base strategy and the seller set when not asked for", async () => {
    const { agent, calls } = setup({ mode: "shipped", tier: "low", aprBps: 700, credit: { strategyHash: strategies.credit } });
    await agent.ship({ tier: "low", creditUsdc: 1_000_000n });
    expect(calls[0]!.args).not.toHaveProperty("base");
    expect(calls[0]!.args).not.toHaveProperty("sellerSet");
    expect(calls[0]!.args).not.toHaveProperty("maxPerBuyer");
  });

  it("sends a per-buyer cap as a unit string when asked for", async () => {
    const { agent, calls } = setup({ mode: "shipped", tier: "low", aprBps: 700, credit: { strategyHash: strategies.credit } });
    await agent.ship({ tier: "low", creditUsdc: 1_000_000n, maxPerBuyer: 10_000_000n });
    expect(calls[0]!.args).toMatchObject({ maxPerBuyer: "10000000" });
  });

  it("returns the server's result and sends nothing when the server shipped with the lender key", async () => {
    const shipped = { mode: "shipped", tier: "low", aprBps: 700, credit: { strategyHash: strategies.credit, txHash: "0xab" } };
    const { agent, sent } = setup(shipped);
    expect(await agent.ship({ tier: "low", creditUsdc: 1_000_000n })).toEqual(shipped);
    expect(sent).toEqual([]);
  });

  it("signs and sends the returned calldatas in order when the server does not hold the lender key", async () => {
    const { agent, sent } = setup({ mode: "calldata", tier: "low", aprBps: 700, calls: lenderCalls, strategies });
    const outcome = await agent.ship({ tier: "low", creditUsdc: 1_000_000n });
    expect(sent).toEqual(lenderCalls);
    expect(outcome).toMatchObject({ mode: "sent", tier: "low", strategies, txHashes: [keccak256(toHex("tx1")), keccak256(toHex("tx2"))] });
  });

  it("stops at the first failing call and reports which call failed and what was already sent", async () => {
    const baseShip: Calldata = { to: "0x00000000000000000000000000000000000000f3", data: "0x03", description: "Aqua.ship(base)" };
    const calldataResult = { mode: "calldata", tier: "low", aprBps: 700, calls: [...lenderCalls, baseShip], strategies };
    const { agent, sent } = setup(calldataResult, "Aqua.ship(credit)");
    const error = await agent.ship({ tier: "low", creditUsdc: 1_000_000n }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/^call 2 of 3 \(Aqua\.ship\(credit\)\) failed, already sent: 0x[0-9a-f]{64}: execution reverted$/);
    expect(sent).toEqual([lenderCalls[0]]);
  });

  it("rejects a base strategy given with only one of its two amounts", async () => {
    const { agent, calls } = setup({});
    await expect(agent.ship({ tier: "low", creditUsdc: 1n, baseUsdc: 1n })).rejects.toThrow(/baseUsdc and baseTusdt/);
    expect(calls).toEqual([]);
  });
});
