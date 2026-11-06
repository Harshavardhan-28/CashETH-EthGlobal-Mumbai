import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Env } from "@casheth/shared";
import { describe, expect, it } from "vitest";
import { LENDER_TIERS, type LenderStrategy } from "@casheth/aqua";
import { keccak256, toHex, type Address } from "viem";
import { computeReceivableId } from "@casheth/shared";
import { checkQuotePlan, expiredReservation, findShippedStrategy, formatTable, formatUsdc, purchaseAttempt, topUpShortfall } from "./demo/checks.js";
import { appendEvidence, formatEvidenceSection, formatStepLine } from "./demo/evidence.js";
import { loadIdentity } from "./demo/identity.js";
import { appendEnvVar, ensureNotesTopic } from "./demo/notesTopic.js";
import {
  ADVANCE_BPS,
  BORROWING_BASE,
  BUDGETS,
  EXPECTED_FILLS,
  EXPECTED_PAYOUTS,
  EXPECTED_SELLER_PAYOUT,
  expectedFills,
  expectedPayouts,
  FRESH_LENDERS,
  INVOICE,
  lenderFee,
  SPEND,
  usdc,
} from "./demo/plan.js";
import { poll } from "./demo/poll.js";
import { findEvent, type AuditEvent } from "./demo/readApi.js";
import { exitCode, failedSteps, runSteps } from "./demo/run.js";
import { createStopper, demoServerEnv, demoServers, startServers, waitForHealth, type ChildLike, type ServerDeps } from "./demo/servers.js";
import { STEPS } from "./demo/steps.js";
import type { DemoContext, LenderKey, Step, StepResult } from "./demo/types.js";
import { ToolCallError } from "./mcpClient.js";
import type { Quotes } from "./seller.js";

const noSleep = async () => {};
const tmp = () => mkdtempSync(join(tmpdir(), "casheth-demo-"));

const ok = (label: string, txId = "0.0.1@1.1"): StepResult => ({ label, txId, link: `https://hashscan.io/testnet/transaction/${txId}` });

describe("runSteps", () => {
  const step = (label: string, run: Step["run"]): Step => ({ label, run });
  const ctx = {} as DemoContext;

  it("runs the steps in order and reports each result as it finishes", async () => {
    const seen: string[] = [];
    const steps = [step("one", async () => ({ txId: "0.0.1@1.1" })), step("two", async () => ({ skipped: true, note: "n/a" })), step("three", async () => ({ readOnly: true }))];
    const results = await runSteps(steps, ctx, (r) => seen.push(r.label));
    expect(results.map((r) => r.label)).toEqual(["one", "two", "three"]);
    expect(seen).toEqual(["one", "two", "three"]);
  });

  it("records a thrown error and does not run the later steps", async () => {
    let reached = false;
    const steps = [
      step("one", async () => ({ txId: "0.0.1@1.1" })),
      step("two", async () => {
        throw new Error("boom");
      }),
      step("three", async () => ((reached = true), {})),
    ];
    const results = await runSteps(steps, ctx);
    expect(results).toEqual([{ label: "one", txId: "0.0.1@1.1" }, { label: "two", error: "boom" }]);
    expect(reached).toBe(false);
  });
});

describe("exit code rule", () => {
  it("is zero when every step has a transaction, was skipped or only reads", () => {
    const results: StepResult[] = [ok("a"), { label: "b", skipped: true }, { label: "c", readOnly: true }];
    expect(exitCode(results)).toBe(0);
    expect(failedSteps(results)).toEqual([]);
  });

  it("is non-zero when a step lacks a Hedera transaction id", () => {
    const results: StepResult[] = [ok("a"), { label: "no proof", note: "something happened" }];
    expect(exitCode(results)).toBe(1);
    expect(failedSteps(results)).toEqual(["no proof"]);
  });

  it("is non-zero when a step failed, even one that carries a transaction", () => {
    expect(exitCode([{ ...ok("a"), error: "later check failed" }])).toBe(1);
  });
});

describe("evidence", () => {
  const results: StepResult[] = [
    { ...ok("2. upload", "0.0.5@2.2"), note: "pending | waits" },
    { label: "6. trader", skipped: true, note: "not in this build" },
    { label: "9. tables", readOnly: true, note: "2 lenders", detail: "lender  tier\nA       low" },
    { label: "8. repay", error: "payouts differ" },
  ];

  it("formats a dated section with one row per step and the tables below", () => {
    const section = formatEvidenceSection(new Date("2026-11-07T10:00:00.000Z"), results);
    expect(section.split("\n").slice(0, 3)).toEqual(["## Demo run 2026-11-07T10:00:00.000Z", "", "| Step | Hedera transaction | Result |"]);
    expect(section).toContain("| 2. upload | [0.0.5@2.2](https://hashscan.io/testnet/transaction/0.0.5@2.2) | pending \\| waits |");
    expect(section).toContain("| 6. trader | - | skipped: not in this build |");
    expect(section).toContain("| 8. repay | - | FAILED: payouts differ |");
    expect(section).toContain("```text\nlender  tier\nA       low\n```");
  });

  it("appends to the file after a blank line and keeps what is there", () => {
    const file = join(tmp(), "EVIDENCE.md");
    writeFileSync(file, "# Evidence\n\nolder text\n");
    appendEvidence(file, "## Demo run X\n");
    appendEvidence(file, "## Demo run Y\n");
    expect(readFileSync(file, "utf8")).toBe("# Evidence\n\nolder text\n\n## Demo run X\n\n## Demo run Y\n");
  });

  it("prints one line per step with its status and proof", () => {
    expect(formatStepLine(ok("a", "0.0.1@1.1"))).toMatch(/^OK {3}a\n\s+https:\/\/hashscan\.io\/testnet\/transaction\/0\.0\.1@1\.1$/);
    expect(formatStepLine({ label: "b", skipped: true })).toBe("SKIP b");
    expect(formatStepLine({ label: "c", error: "boom" })).toMatch(/^FAIL c\n\s+boom$/);
  });
});

describe("lender top-up arithmetic", () => {
  const required = FRESH_LENDERS.A.creditUsdc;

  it("tops up exactly the shortfall", () => {
    expect(topUpShortfall(required - 500_000n, required)).toBe(500_000n);
    expect(topUpShortfall(0n, required)).toBe(required);
  });

  it("tops up nothing when the balance covers what is shipped", () => {
    expect(topUpShortfall(required, required)).toBe(0n);
    expect(topUpShortfall(required * 2n, required)).toBe(0n);
  });
});

describe("plan", () => {
  it("charges lenders at least 30 days of fee, rounded down", () => {
    const day = 86_400n;
    const principal = usdc("4");
    expect(lenderFee(principal, 700)).toBe((principal * 700n * 30n) / (365n * 10_000n));
    expect(lenderFee(principal, 700, 10n * day)).toBe(lenderFee(principal, 700));
    expect(lenderFee(principal, 700, 60n * day)).toBe((principal * 700n * 60n) / (365n * 10_000n));
  });

  it("fills the cheapest lender first and the next one only for what is left", () => {
    const lenders = { A: { tier: "low", creditUsdc: usdc("3") }, B: { tier: "medium", creditUsdc: usdc("4") } } as const;
    expect(expectedFills(usdc("5"), lenders)).toEqual([{ lender: "A", amount: usdc("3") }, { lender: "B", amount: usdc("2") }]);
    expect(expectedFills(usdc("2"), lenders)).toEqual([{ lender: "A", amount: usdc("2") }]);
  });

  it("derives fills and payouts that add up to the invoice and fit the budgets", () => {
    expect(EXPECTED_FILLS.reduce((sum, f) => sum + f.amount, 0n)).toBe(BORROWING_BASE);
    expect(EXPECTED_PAYOUTS.A + EXPECTED_PAYOUTS.B + EXPECTED_SELLER_PAYOUT).toBe(INVOICE.amount);
    expect(EXPECTED_SELLER_PAYOUT).toBeGreaterThan(0n);
    expect(expectedPayouts(EXPECTED_FILLS)).toEqual(EXPECTED_PAYOUTS);
    expect(BUDGETS.research.alloc + BUDGETS.compute.alloc).toBeLessThanOrEqual(BORROWING_BASE);
    expect(SPEND.computeOverBudget).toBeGreaterThan(BUDGETS.compute.alloc);
    expect(SPEND.researchOverLimit).toBeGreaterThan(BUDGETS.research.maxPerTx);
    expect(SPEND.researchOverLimit).toBeLessThanOrEqual(BUDGETS.research.alloc);
  });
});

const makers: Record<LenderKey, Address> = {
  A: "0x00000000000000000000000000000000000000a1",
  B: "0x00000000000000000000000000000000000000b1",
  C: "0x00000000000000000000000000000000000000c1",
  D: "0x00000000000000000000000000000000000000d1",
};
const hash = (name: string) => keccak256(toHex(name));

function quotes(overrides: Partial<Quotes["plan"]> = {}): Quotes {
  const strategy = (lender: LenderKey) => ({ maker: makers[lender], strategyHash: hash(`credit-${lender}`), kind: "credit" as const, virtualUsdc: "1", realUsdc: "1" });
  return {
    id: hash("PO-1003"),
    decision: { approved: true, score: 80, advanceBps: ADVANCE_BPS, limit: BORROWING_BASE.toString(), reasons: [] },
    borrowingBase: BORROWING_BASE.toString(),
    strategies: [strategy("A"), strategy("B"), strategy("C"), strategy("D")],
    plan: {
      fills: EXPECTED_FILLS.map((f) => ({
        maker: makers[f.lender],
        strategyHash: hash(`credit-${f.lender}`),
        amount: f.amount.toString(),
        aprBps: LENDER_TIERS[FRESH_LENDERS[f.lender].tier].aprBps,
      })),
      total: BORROWING_BASE.toString(),
      skipped: [
        { strategyHash: hash("credit-C"), reason: "PRICE_ABOVE_CHEAPEST" },
        { strategyHash: hash("credit-D"), reason: "SELLER_NOT_FUNDED_BY_LENDER" },
      ],
      ...overrides,
    },
  };
}

describe("checkQuotePlan", () => {
  it("accepts the planned fills with C skipped by price and D skipped for its seller set", () => {
    const fills = EXPECTED_FILLS.map((f) => `${f.lender} ${formatUsdc(f.amount)}`).join(" + ");
    expect(checkQuotePlan(quotes(), makers)).toBe(
      `fills ${fills} = ${formatUsdc(BORROWING_BASE)}; C skipped (PRICE_ABOVE_CHEAPEST); D skipped (SELLER_NOT_FUNDED_BY_LENDER)`,
    );
  });

  it("adds up a lender's fills over several strategies", () => {
    const [first, last] = [quotes().plan.fills[0]!, quotes().plan.fills.at(-1)!];
    const half = BigInt(last.amount) / 2n;
    const split = [first, { ...last, amount: half.toString() }, { ...last, strategyHash: hash("older-strategy"), amount: (BigInt(last.amount) - half).toString() }];
    expect(() => checkQuotePlan(quotes({ fills: split }), makers)).not.toThrow();
  });

  it("rejects a plan that fills in another order or amount", () => {
    const [a, b] = quotes().plan.fills;
    expect(() => checkQuotePlan(quotes({ fills: [b!, a!] }), makers)).toThrow(/expected fills/);
    expect(() => checkQuotePlan(quotes({ fills: [a!, { ...b!, amount: (BigInt(b!.amount) + 1n).toString() }] }), makers)).toThrow(/expected fills/);
  });

  it("rejects a plan where lender C was not skipped or D was skipped for another reason", () => {
    const skipped = quotes().plan.skipped;
    expect(() => checkQuotePlan(quotes({ skipped: [skipped[1]!] }), makers)).toThrow(/lender C's strategy .* was not skipped/);
    expect(() => checkQuotePlan(quotes({ skipped: [skipped[0]!, { ...skipped[1]!, reason: "NO_CAPACITY" }] }), makers)).toThrow(/SELLER_NOT_FUNDED_BY_LENDER/);
  });
});

/** An open credit strategy of lender `key` exactly as the demo plans to ship it for `seller`. */
function openStrategy(key: "A" | "B", seller: Address, overrides: Partial<LenderStrategy> = {}): LenderStrategy {
  const usdcToken: Address = "0x0000000000000000000000000000000000000c0a";
  const { tier, creditUsdc } = FRESH_LENDERS[key];
  return {
    kind: "credit",
    maker: makers[key],
    strategyHash: hash(`open-${key}`),
    args: { ...LENDER_TIERS[tier], maxPerBuyer: FRESH_LENDERS[key].maxPerBuyer ?? usdc("5"), minReserve: 0n, sellerSet: [seller] },
    tokens: [usdcToken, "0x0000000000000000000000000000000000000c0b"],
    virtual: { [usdcToken]: creditUsdc },
    realUsdc: creditUsdc,
    allowance: creditUsdc,
    salt: 1n,
    order: { maker: makers[key], traits: 0n, data: "0x" },
    ...overrides,
  };
}

describe("findShippedStrategy", () => {
  const seller: Address = "0x00000000000000000000000000000000000000f1";
  const planned = { maker: makers.A, seller, creditUsdc: FRESH_LENDERS.A.creditUsdc, aprBps: LENDER_TIERS[FRESH_LENDERS.A.tier].aprBps };

  it("finds the lender's unspent strategy of the planned size, APR and seller set", () => {
    const strategy = openStrategy("A", seller);
    expect(findShippedStrategy([openStrategy("B", seller), strategy], planned)).toBe(strategy);
  });

  it("ignores strategies that are spent, for another seller, another APR or another kind", () => {
    const [usdcToken] = openStrategy("A", seller).tokens;
    const other: Address = "0x00000000000000000000000000000000000000f2";
    expect(findShippedStrategy([openStrategy("A", seller, { virtual: { [usdcToken]: 1n } })], planned)).toBeUndefined();
    expect(findShippedStrategy([openStrategy("A", other)], planned)).toBeUndefined();
    expect(findShippedStrategy([openStrategy("A", seller)], { ...planned, aprBps: planned.aprBps + 1 })).toBeUndefined();
    expect(findShippedStrategy([openStrategy("A", seller, { kind: "base" })], planned)).toBeUndefined();
    const smallerCap = openStrategy("A", seller);
    expect(findShippedStrategy([{ ...smallerCap, args: { ...smallerCap.args!, maxPerBuyer: smallerCap.args!.maxPerBuyer - 1n } }], { ...planned, maxPerBuyer: smallerCap.args!.maxPerBuyer })).toBeUndefined();
  });
});

describe("expiredReservation", () => {
  const worker = "0x00000000000000000000000000000000000000E1";
  const reserved = (spendId: string, expiry: string): AuditEvent => ({ type: "SpendReserved", seq: 1, worker: worker.toLowerCase(), spendId, expiry });

  it("finds the worker's latest reservation when it expired without being committed or released", () => {
    expect(expiredReservation([reserved("0x1", "100"), reserved("0x2", "200")], worker, 300)?.spendId).toBe("0x2");
  });

  it("ignores reservations that are still payable, committed, released or another worker's", () => {
    expect(expiredReservation([reserved("0x1", "400")], worker, 300)).toBeUndefined();
    expect(expiredReservation([reserved("0x1", "100"), { type: "SpendCommitted", seq: 2, spendId: "0x1" }], worker, 300)).toBeUndefined();
    expect(expiredReservation([reserved("0x1", "100"), { type: "SpendReleased", seq: 2, spendId: "0x1" }], worker, 300)).toBeUndefined();
    expect(expiredReservation([reserved("0x1", "100")], "0x00000000000000000000000000000000000000e2", 300)).toBeUndefined();
    expect(expiredReservation([], worker, 300)).toBeUndefined();
  });
});

describe("formatTable", () => {
  it("aligns columns under the headers", () => {
    expect(formatTable(["lender", "tier"], [["lenderA", "low"], ["B", "medium"]])).toBe(["lender   tier", "-------  ------", "lenderA  low", "B        medium"].join("\n"));
  });
});

describe("findEvent", () => {
  const events: AuditEvent[] = [
    { type: "SpendRejected", seq: 1, id: "0xAA", code: "TX_LIMIT_EXCEEDED", worker: "0xW1", hcsTxId: "first" },
    { type: "SpendRejected", seq: 2, id: "0xaa", code: "TX_LIMIT_EXCEEDED", worker: "0xw2", hcsTxId: "second" },
    { type: "SpendRejected", seq: 3, id: "0xaa", code: "AGENT_BUDGET_EXCEEDED", worker: "0xw2", hcsTxId: "third" },
  ];

  it("returns the latest event matching every field, comparing ids and addresses case-insensitively", () => {
    expect(findEvent(events, { type: "SpendRejected", id: "0xAA", code: "TX_LIMIT_EXCEEDED" })?.hcsTxId).toBe("second");
    expect(findEvent(events, { type: "SpendRejected", code: "TX_LIMIT_EXCEEDED", worker: "0xW1" })?.hcsTxId).toBe("first");
    expect(findEvent(events, { type: "Repaid" })).toBeUndefined();
  });
});

describe("poll and waitForHealth", () => {
  it("polls until a value arrives", async () => {
    let calls = 0;
    const value = await poll("a value", async () => (++calls === 3 ? "done" : undefined), { attempts: 5, delayMs: 1, sleep: noSleep });
    expect(value).toBe("done");
    expect(calls).toBe(3);
  });

  it("gives up after the attempts and names what it waited for", async () => {
    await expect(poll("the payouts", async () => undefined, { attempts: 2, delayMs: 1, sleep: noSleep })).rejects.toThrow(/timed out waiting for the payouts/);
  });

  it("waits for a 200 from /health, tolerating refused connections", async () => {
    const answers = [new Error("ECONNREFUSED"), new Response("", { status: 503 }), new Response("{}", { status: 200 })];
    const fetchImpl: typeof fetch = async () => {
      const next = answers.shift()!;
      if (next instanceof Error) throw next;
      return next;
    };
    await expect(waitForHealth("http://localhost:1/health", { attempts: 5, delayMs: 1, sleep: noSleep }, fetchImpl)).resolves.toBeUndefined();
    expect(answers).toEqual([]);
  });
});

const baseEnv = {
  HEDERA_NETWORK: "testnet",
  HEDERA_CHAIN_ID: 296,
  HEDERA_JSON_RPC_URL: "https://testnet.hashio.io/api",
  HEDERA_MIRROR_NODE_URL: "https://testnet.mirrornode.hedera.com",
  HEDERA_OPERATOR_ID: "0.0.1",
  HEDERA_OPERATOR_KEY: "0x01",
  MERCHANT_ACCOUNT_ID: "0.0.2",
  MERCHANT_KEY: "0x02",
  USDC_TOKEN_ID: "0.0.429274",
  USDC_EVM_ADDRESS: "0x0000000000000000000000000000000000068cDa",
  X402_FACILITATOR_URL: "https://x402.org/facilitator",
  X402_NETWORK: "hedera-testnet",
} as unknown as Env;

describe("servers", () => {
  it("derives each health URL from the variables the servers read, with their defaults", () => {
    expect(Object.values(demoServers(baseEnv)).map((s) => s.healthUrl)).toEqual([
      "http://localhost:3003/health",
      "http://localhost:4020/health",
      "http://localhost:4030/health",
    ]);
    const custom = { ...baseEnv, MERCHANT_PORT: "5000", AUTH_ISSUER: "http://localhost:5001", MCP_RESOURCE_URL: "http://localhost:5002/mcp" } as Env;
    expect(Object.values(demoServers(custom)).map((s) => s.healthUrl)).toEqual(["http://localhost:5000/health", "http://localhost:5001/health", "http://localhost:5002/health"]);
  });

  it("runs the servers with in-process demo keys and the merchant on the port the MCP server expects", () => {
    expect(demoServerEnv(baseEnv)).toEqual({ AGENT_KEYS_IN_PROCESS: "true", LENDER_KEYS_IN_PROCESS: "true", MERCHANT_PORT: "3003" });
  });
});

describe("server shutdown", () => {
  const fakeChild = (pid: number): ChildLike => ({ pid, exitCode: null, signalCode: null });

  /** Fake processes, signals and clock: records what `startServers` launches, kills and exits with. */
  function harness(overrides: Partial<ServerDeps> = {}) {
    const children: ChildLike[] = [];
    const killed: number[] = [];
    const exits: number[] = [];
    const handlers = new Map<string, () => void>();
    const deps: Partial<ServerDeps> = {
      launch: () => {
        const child = fakeChild(100 + children.length);
        children.push(child);
        return child;
      },
      kill: (pid) => void killed.push(pid),
      onSignal: (signal, handler) => void handlers.set(signal, handler),
      exit: (code) => void exits.push(code),
      fetch: async () => new Response("{}"),
      wait: { attempts: 1, delayMs: 0, sleep: noSleep },
      settleMs: 0,
      sleep: noSleep,
      log: () => {},
      ...overrides,
    };
    return { deps, children, killed, exits, handlers };
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("stops every child's process group on SIGINT, waits, then exits 130; a later SIGTERM does not kill again", async () => {
    const { deps, killed, exits, handlers } = harness();
    await startServers(baseEnv, "/repo", deps);
    expect(handlers.has("SIGINT") && handlers.has("SIGTERM")).toBe(true);

    handlers.get("SIGINT")!();
    await flush();
    expect(killed).toEqual([100, 101, 102]);
    expect(exits).toEqual([130]);

    handlers.get("SIGTERM")!();
    await flush();
    expect(killed).toEqual([100, 101, 102]);
    expect(exits).toEqual([130, 143]);
  });

  it("handles a signal that arrives while the servers are still starting", async () => {
    const { deps, killed, exits, handlers } = harness({ fetch: () => new Promise<Response>(() => {}) });
    void startServers(baseEnv, "/repo", deps).catch(() => {});
    await flush();
    handlers.get("SIGTERM")!();
    await flush();
    expect(killed).toEqual([100, 101]);
    expect(exits).toEqual([143]);
  });

  it("stops the children once, and again does nothing", async () => {
    const { deps, killed } = harness();
    const servers = await startServers(baseEnv, "/repo", deps);
    servers.stop();
    servers.stop();
    expect(killed).toEqual([100, 101, 102]);
  });

  it("stops the children and rethrows when a server never becomes healthy", async () => {
    const { deps, killed } = harness({ fetch: async () => new Response("", { status: 503 }) });
    await expect(startServers(baseEnv, "/repo", deps)).rejects.toThrow(/timed out waiting for/);
    expect(killed).toEqual([100, 101]);
  });

  it("skips children that already exited and survives a group that vanished", () => {
    const [running, exited, killedBySignal, vanished] = [fakeChild(1), { ...fakeChild(2), exitCode: 1 }, { ...fakeChild(3), signalCode: "SIGKILL" as const }, fakeChild(4)];
    const killed: number[] = [];
    createStopper([running, exited, killedBySignal, vanished], (pid) => {
      killed.push(pid);
      if (pid === 1) throw new Error("ESRCH");
    })();
    expect(killed).toEqual([1, 4]);
  });
});

describe("agent-notes topic", () => {
  it("appends the variable on its own line", () => {
    const file = join(tmp(), ".env.accounts");
    writeFileSync(file, "SELLER_ID=0.0.1");
    appendEnvVar(file, "AGENT_NOTES_TOPIC_ID", "0.0.7");
    expect(readFileSync(file, "utf8")).toBe("SELLER_ID=0.0.1\nAGENT_NOTES_TOPIC_ID=0.0.7\n");
  });

  it("creates the topic once, remembers it in the env file and returns the transaction as proof", async () => {
    const envFile = join(tmp(), ".env.accounts");
    const { env, result } = await ensureNotesTopic(baseEnv, { envFile, create: async () => ({ topicId: "0.0.7", txId: "0.0.1@9.9" }) });
    expect(env.AGENT_NOTES_TOPIC_ID).toBe("0.0.7");
    expect(result).toMatchObject({ txId: "0.0.1@9.9", link: "https://hashscan.io/testnet/transaction/0.0.1@9.9" });
    expect(readFileSync(envFile, "utf8")).toBe("AGENT_NOTES_TOPIC_ID=0.0.7\n");
  });

  it("reuses the configured topic without creating one", async () => {
    const envFile = join(tmp(), ".env.accounts");
    const configured = { ...baseEnv, AGENT_NOTES_TOPIC_ID: "0.0.8" } as Env;
    const { env, result } = await ensureNotesTopic(configured, { envFile, create: async () => Promise.reject(new Error("must not create")) });
    expect(env.AGENT_NOTES_TOPIC_ID).toBe("0.0.8");
    expect(result).toMatchObject({ skipped: true, link: "https://hashscan.io/testnet/topic/0.0.8" });
    expect(exitCode([result])).toBe(0);
  });
});

describe("loadIdentity", () => {
  it("builds the identity the agent was registered with, from its key", async () => {
    const key = hash("seller-key");
    const env = { ...baseEnv, SELLER_KEY: key.slice(2), SELLER_ID: "0.0.11337987" } as Env;
    const identity = await loadIdentity(env, "SELLER");
    expect(identity).toMatchObject({ accountId: "0.0.11337987", key, role: "seller", mandateHash: keccak256(toHex("mandate-v1-seller")) });
    expect(identity.uaid).toMatch(/^uaid:aid:.*;uid=0\.0\.11337987;registry=casheth;proto=mcp;/);
    expect((await loadIdentity({ ...env, WORKER_RESEARCH_KEY: key, WORKER_RESEARCH_ID: "0.0.1" } as Env, "WORKER_RESEARCH")).mandateHash).toBe(keccak256(toHex("mandate-v1-workerResearch")));
  });

  it("names the missing variable", async () => {
    await expect(loadIdentity(baseEnv, "BUYER")).rejects.toThrow(/BUYER_KEY is not set/);
  });
});

/** Fake agents that keep the books the way the control plane would, to run all the steps without a network. */
function fakeContext() {
  const buyerAddress: Address = "0x00000000000000000000000000000000000000b0";
  // The same id the runner derives on a rerun (buyer + keccak(buyerRef)), so event lookups match on both paths.
  const id = computeReceivableId(buyerAddress, keccak256(toHex(INVOICE.buyerRef)));
  const researchAddress: Address = "0x00000000000000000000000000000000000000e1";
  const computeAddress: Address = "0x00000000000000000000000000000000000000e2";
  const sellerAddress: Address = "0x00000000000000000000000000000000000000f1";
  const document = { keccak256: hash("invoice-pdf"), verification: { ok: true, mismatches: [] }, hashscan: "https://hashscan.io/testnet/transaction/0.0.7@9.9" };
  const events: AuditEvent[] = [];
  const shipKeys: string[] = [];
  const open: LenderStrategy[] = [];
  const calls: string[] = [];
  // Lender A holds half of what it ships (so it is topped up); lender B holds exactly what it ships.
  const balances = new Map<Address, bigint>([[makers.A, FRESH_LENDERS.A.creditUsdc / 2n], [makers.B, FRESH_LENDERS.B.creditUsdc], [sellerAddress, 0n], [buyerAddress, INVOICE.amount]]);
  let repaid = false;
  const record = (event: { type: string; [field: string]: unknown }) => events.push({ ...event, seq: events.length + 1 });
  const note = async () => (calls.push("note"), "0.0.9@5.5");
  const rejects = (worker: Address) => async ({ amount }: { amount?: bigint }) => {
    const code = amount === SPEND.researchOverLimit ? "TX_LIMIT_EXCEEDED" : "AGENT_BUDGET_EXCEEDED";
    record({ type: "SpendRejected", id, code, worker, hcsTxId: `0.0.7@6.${code.length}` });
    return { status: "rejected", stage: "reserve", code };
  };

  const ctx = {
    log: () => {},
    invoice: { buyer: buyerAddress, amount: INVOICE.amount, dueDate: INVOICE.dueDate, buyerRef: INVOICE.buyerRef },
    invoiceFile: INVOICE.file,
    seller: {
      address: sellerAddress,
      accountId: "0.0.11",
      kit: { note },
      agent: {
        run: async ({ submission }: { submission?: string }) => {
          calls.push(submission ? "upload-duplicate" : "upload");
          if (submission) {
            record({ type: "ReceivableRejected", id, code: "DUPLICATE_RECEIVABLE", hcsTxId: "0.0.7@4.4" });
            throw new ToolCallError("upload_receivable", { code: "DUPLICATE_RECEIVABLE" });
          }
          record({ type: "ReceivableUploaded", id, hcsTxId: "0.0.7@1.1" });
          return { pendingId: hash("pending"), id, confirmationRequest: {}, document };
        },
        status: async () => ({ id, state: "Confirmed", document: { keccak: document.keccak256, verified: true } }),
        quotes: async () => quotes(),
        openFacility: async () => (calls.push("open"), { txHash: "0xfund", total: BORROWING_BASE.toString() }),
        setBudgets: async () => (calls.push("budgets"), { txHash: "0xbudgets" }),
      },
    },
    buyer: {
      address: buyerAddress,
      accountId: "0.0.12",
      agent: {
        confirm: async () => {
          record({ type: "ReceivableConfirmed", id, hcsSeq: 30, hcsTxId: "0.0.7@2.2" });
          record({ type: "NftMinted", id, serial: 1, tokenId: "0.0.50", txId: "0.0.7@3.3" });
          return { txHash: "0xregister", decision: { approved: true, score: 80, advanceBps: ADVANCE_BPS, limit: BORROWING_BASE.toString(), reasons: [] } };
        },
        repay: async () => {
          calls.push("repay");
          repaid = true;
          balances.set(makers.A, balances.get(makers.A)! + EXPECTED_PAYOUTS.A);
          balances.set(makers.B, balances.get(makers.B)! + EXPECTED_PAYOUTS.B);
          balances.set(sellerAddress, EXPECTED_SELLER_PAYOUT);
          return { id, mode: "sent", txHash: "0xrepay" };
        },
      },
    },
    research: {
      address: researchAddress,
      spendWallet: researchAddress,
      kit: { note },
      agent: {
        release: async (spendId: string) => (calls.push(`release ${spendId}`), { txHash: "0xrelease" }),
        buy: async (request: { amount?: bigint }) => {
          if (request.amount) return rejects(researchAddress)(request);
          calls.push("buy-research");
          return { status: "committed", spendId: hash("spend"), transactionId: "0.0.8@7.7", price: SPEND.researchPrice, merchant: "0.0.2" };
        },
      },
    },
    compute: { address: computeAddress, spendWallet: computeAddress, kit: { note }, agent: { buy: rejects(computeAddress) } },
    lenders: ["A", "B"].reduce(
      (acc, key) => ({
        ...acc,
        [key]: {
          address: makers[key as "A" | "B"],
          accountId: `0.0.${key.charCodeAt(0)}`,
          agent: { ship: async (params: { tier: string; idempotencyKey?: string }) => (calls.push(`ship-${key}`), shipKeys.push(String(params.idempotencyKey)), { mode: "shipped", tier: params.tier, aprBps: key === "A" ? 700 : 850, credit: { txHash: `0xship${key}` } }) },
        },
      }),
      {},
    ),
    makers,
    merchant: "0x0000000000000000000000000000000000000a01",
    read: {
      events: async () => events,
      agents: async () => [{ address: buyerAddress, label: "buyer", role: "buyer", level: 3, score: 70, tier: "none", onTimePct: 100, receivablesFunded: 1, receivablesRepaid: repaid ? 1 : 0, receivablesDefaulted: 0, avgDaysToRepay: 0, lenderReturnPct: 0 }],
      lenders: async () => [{ address: makers.A, label: "lenderA", tier: "low", capital: "1", lent: "0", idle: "1", baseFees: "0", creditFees: "0", baseApr: 0, boostApr: 7, blendedApr: 7 }],
      receivable: async () => !calls.includes("open") ? undefined : ({ id, state: "Repaid", amount: INVOICE.amount.toString(), funded: BORROWING_BASE.toString(), debt: "0", positions: [] }),
    },
    usdcBalance: async (address: Address) => balances.get(address) ?? 0n,
    openStrategies: async () => open,
    topUpFromOperator: async (accountId: string, units: bigint) => {
      calls.push(`top-up ${accountId} ${units}`);
      return "0.0.1@8.8";
    },
    resolveTx: async (ref: string) => `0.0.1@${ref}`,
    nowSeconds: () => 2_000_000_000,
    verifyInvoiceDocument: async () => `receivable x\nVERIFIED: the file is exactly what the buyer signed\n`,
    poll: { attempts: 2, delayMs: 0, sleep: noSleep },
    state: {},
  } as unknown as DemoContext;
  return { ctx, calls, balances, shipKeys, open, events, sellerAddress };
}

describe("the eight lifecycle steps against fake agents", () => {
  it("runs every step in the order of BUILD.md section 16 and every step has proof", async () => {
    const { ctx, calls } = fakeContext();
    const results = await runSteps(STEPS, ctx);

    expect(results.map((r) => r.label.split(".")[0])).toEqual(["1", "1", "1", "1", "2", "2", "2", "2", "2", "2", "3", "4", "5", "6", "7", "7", "7", "7", "7", "8", "8", "9", "10"]);
    expect(results.filter((r) => r.error)).toEqual([]);
    expect(exitCode(results)).toBe(0);
    expect(calls.filter((c) => !c.startsWith("top-up") && c !== "note")).toEqual(["ship-A", "ship-B", "upload", "upload-duplicate", "open", "budgets", "buy-research", "repay"]);
  });

  it("tops up only the lender that is short, by exactly the shortfall", async () => {
    const { ctx, calls } = fakeContext();
    const results = await runSteps(STEPS, ctx);
    expect(calls.filter((c) => c.startsWith("top-up"))).toEqual([`top-up 0.0.65 ${FRESH_LENDERS.A.creditUsdc - FRESH_LENDERS.A.creditUsdc / 2n}`]);
    expect(results[0]).toMatchObject({ txId: "0.0.1@8.8" });
    expect(results[2]).toMatchObject({ skipped: true });
  });

  it("tops up the buyer by the repayment it is short of", async () => {
    const { ctx, calls, balances } = fakeContext();
    balances.set(ctx.buyer.address, INVOICE.amount - 1n);
    const results = await runSteps(STEPS, ctx);
    expect(calls).toContain("top-up 0.0.12 1");
    expect(results.find((r) => r.label.startsWith("8. buyer: top up"))).toMatchObject({ txId: "0.0.1@8.8" });
  });

  it("takes the rejections' proof from the HCS events the server recorded", async () => {
    const { ctx } = fakeContext();
    const results = await runSteps(STEPS, ctx);
    const byLabel = (needle: string) => results.find((r) => r.label.includes(needle))!;
    expect(byLabel("duplicate").txId).toBe("0.0.7@4.4");
    expect(byLabel("TX_LIMIT_EXCEEDED").txId).toBe("0.0.7@6.17");
    expect(byLabel("AGENT_BUDGET_EXCEEDED").txId).toBe("0.0.7@6.21");
    expect(byLabel("buyer confirms").txId).toBe("0.0.1@0xregister");
    expect(byLabel("research worker buys").txId).toBe("0.0.8@7.7");
  });

  it("stops at a repayment whose payouts differ from the script", async () => {
    const { ctx, balances } = fakeContext();
    const real = ctx.buyer.agent.repay.bind(ctx.buyer.agent);
    ctx.buyer.agent.repay = async (...args) => {
      const result = await real(...args);
      balances.set(makers.A, balances.get(makers.A)! - 1n);
      return result;
    };
    const results = await runSteps(STEPS, ctx);
    const last = results[results.length - 1]!;
    expect(last.label).toContain("8. buyer repays");
    expect(last.error).toMatch(new RegExp(`payouts differ from lender A ${EXPECTED_PAYOUTS.A}`));
    expect(exitCode(results)).toBe(1);
  });

  it("ships with a key that is the same on every run, so a rerun replays a ship that landed", async () => {
    const first = fakeContext();
    await runSteps(STEPS, first.ctx);
    const second = fakeContext();
    await runSteps(STEPS, second.ctx);
    expect(first.shipKeys).toHaveLength(2);
    expect(new Set(first.shipKeys).size).toBe(2);
    expect(second.shipKeys).toEqual(first.shipKeys);
  });

  it("does not ship again when the lender's strategy is already open, and shows the earlier ship's transaction", async () => {
    const { ctx, calls, open, events, sellerAddress } = fakeContext();
    open.push(openStrategy("A", sellerAddress));
    events.push({ type: "StrategyShipped", seq: 99, strategyHash: hash("open-A"), txHash: "0xearlier" });
    const results = await runSteps(STEPS, ctx);

    expect(calls).not.toContain("ship-A");
    expect(calls).toContain("ship-B");
    expect(results.find((r) => r.label.startsWith("1. lender A ships"))).toMatchObject({ txId: "0.0.1@0xearlier", note: expect.stringContaining("already open") });
    expect(exitCode(results)).toBe(0);
  });

  it("skips an already-open strategy whose ship the server did not record, without failing the run", async () => {
    const { ctx, open, sellerAddress } = fakeContext();
    open.push(openStrategy("A", sellerAddress));
    const results = await runSteps(STEPS, ctx);
    expect(results.find((r) => r.label.startsWith("1. lender A ships"))).toMatchObject({ skipped: true });
    expect(exitCode(results)).toBe(0);
  });

  it("skips the lender steps on a rerun once the facility is funded, whatever the lenders now hold", async () => {
    const { ctx, calls, balances } = fakeContext();
    calls.push("open");
    balances.set(makers.A, 0n);
    balances.set(makers.B, 0n);
    const results = await runSteps(STEPS, ctx);
    expect(results.slice(0, 4).every((r) => r.skipped)).toBe(true);
    expect(calls.filter((c) => c.startsWith("top-up") || c.startsWith("ship-"))).toEqual([]);
  });

  it("on a rerun past step 4 replays the facility instead of asking for quotes", async () => {
    const { ctx, calls, events } = fakeContext();
    calls.push("open");
    // The registry already holds the receivable, so the registration steps are skipped; the duplicate step still
    // asks the server, which records a fresh rejection on HCS (seeded here as the fake server would).
    const rerunId = computeReceivableId(ctx.invoice.buyer, keccak256(toHex(ctx.invoice.buyerRef)));
    events.push({ type: "ReceivableRejected", id: rerunId, code: "DUPLICATE_RECEIVABLE", seq: 77, hcsTxId: "0.0.1@dup" });
    ctx.seller.agent.quotes = (async () => {
      throw new ToolCallError("get_quotes", { code: "NOT_CONFIRMED" });
    }) as never;
    const results = await runSteps(STEPS, ctx);
    expect(results.find((r) => r.label.startsWith("4."))).toMatchObject({ txId: "0.0.1@0xfund", note: expect.stringContaining("earlier run") });
    expect(exitCode(results)).toBe(0);
  });

  it("releases the research worker's expired, unpaid reservation before buying, and skips when there is none", async () => {
    const clean = fakeContext();
    const cleanResults = await runSteps(STEPS, clean.ctx);
    expect(cleanResults.find((r) => r.label.includes("releases an expired"))).toMatchObject({ skipped: true });

    const { ctx, calls, events } = fakeContext();
    events.push({ type: "SpendReserved", seq: 50, worker: ctx.research.address, spendId: "0xstale", expiry: "1000" });
    const results = await runSteps(STEPS, ctx);
    expect(calls.filter((c) => c.startsWith("release"))).toEqual(["release 0xstale"]);
    expect(results.find((r) => r.label.includes("releases an expired"))).toMatchObject({ txId: "0.0.1@0xrelease" });
    expect(exitCode(results)).toBe(0);
  });

  it("proves the invoice document with the HCS anchor and the verifier's VERIFIED line", async () => {
    const { ctx } = fakeContext();
    const results = await runSteps(STEPS, ctx);
    expect(results.find((r) => r.label.startsWith("2. invoice document"))).toMatchObject({ txId: "0.0.7@9.9", note: expect.stringContaining("document.verified: true") });
    expect(results.find((r) => r.label.startsWith("10."))).toMatchObject({ readOnly: true, note: "VERIFIED: the file is exactly what the buyer signed" });
  });

  it("stops when the document is not verified or the verifier reports a mismatch", async () => {
    const unverified = fakeContext().ctx;
    unverified.seller.agent.status = (async () => ({ state: "Confirmed", document: { keccak: hash("x"), verified: false } })) as never;
    expect((await runSteps(STEPS, unverified)).at(-1)?.error).toMatch(/expected document.verified true/);

    const mismatch = fakeContext().ctx;
    mismatch.verifyInvoiceDocument = async () => "MISMATCH: the served file does not hash to the on-chain commitment\n";
    const results = await runSteps(STEPS, mismatch);
    expect(results.at(-1)?.label).toMatch(/^10\./);
    expect(results.at(-1)?.error).toMatch(/did not verify/);
  });

  it("fails the duplicate step when the second upload is accepted", async () => {
    const { ctx } = fakeContext();
    const real = ctx.seller.agent.run.bind(ctx.seller.agent);
    ctx.seller.agent.run = (async (args: Parameters<typeof real>[0]) => real({ invoice: args.invoice, invoiceFile: args.invoiceFile })) as typeof real;
    const results = await runSteps(STEPS, ctx);
    expect(results.find((r) => r.label.includes("duplicate"))?.error).toBe("the duplicate submission was accepted");
  });
});

describe("purchaseAttempt", () => {
  const worker = "0xBeAD36C554746b00eb2a3B87cE38aDc926Ddf62F";
  const released = (who: string) => ({ type: "SpendReleased", spendId: "0xs", worker: who }) as never;

  it("is the base when the worker has had nothing released", () => {
    expect(purchaseAttempt([], worker, 2)).toBe("2");
  });

  it("advances by one for each reservation released for this worker, ignoring other workers and event types", () => {
    const events = [released(worker), released(worker.toLowerCase()), released("0xother"), { type: "SpendCommitted", worker } as never];
    expect(purchaseAttempt(events, worker, 2)).toBe("4");
  });

  it("is stable across reruns that release nothing, so a committed purchase is replayed rather than repeated", () => {
    const events = [released(worker)];
    expect(purchaseAttempt(events, worker, 2)).toBe(purchaseAttempt(events, worker, 2));
  });
});
