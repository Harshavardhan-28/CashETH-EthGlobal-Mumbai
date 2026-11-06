import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Env } from "@casheth/shared";
import { describe, expect, it } from "vitest";
import { keccak256, toHex, type Address } from "viem";
import { checkQuotePlan, formatTable, topUpShortfall } from "./demo/checks.js";
import { appendEvidence, formatEvidenceSection, formatStepLine } from "./demo/evidence.js";
import { loadIdentity } from "./demo/identity.js";
import { appendEnvVar, ensureNotesTopic } from "./demo/notesTopic.js";
import { EXPECTED_PAYOUTS, INVOICE, SPEND, usdc } from "./demo/plan.js";
import { poll } from "./demo/poll.js";
import { findEvent, type AuditEvent } from "./demo/readApi.js";
import { exitCode, failedSteps, runSteps } from "./demo/run.js";
import { demoServerEnv, demoServers, waitForHealth } from "./demo/servers.js";
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
  it("tops up exactly the shortfall", () => {
    expect(topUpShortfall(1_500_000n, usdc("4"))).toBe(2_500_000n);
    expect(topUpShortfall(0n, usdc("2"))).toBe(2_000_000n);
  });

  it("tops up nothing when the balance covers what is shipped", () => {
    expect(topUpShortfall(usdc("4"), usdc("4"))).toBe(0n);
    expect(topUpShortfall(usdc("9"), usdc("4"))).toBe(0n);
  });
});

describe("demo numbers", () => {
  it("lets the lenders' payouts leave the seller the remainder of the 8 USDC", () => {
    expect(INVOICE.amount - EXPECTED_PAYOUTS.A - EXPECTED_PAYOUTS.B).toBe(1_963_015n);
    expect(SPEND.researchPrice).toBe(250_000n);
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
    decision: { approved: true, score: 80, advanceBps: 7500, limit: "6000000", reasons: [] },
    borrowingBase: "6000000",
    strategies: [strategy("A"), strategy("B"), strategy("C"), strategy("D")],
    plan: {
      fills: [
        { maker: makers.A, strategyHash: hash("credit-A"), amount: "4000000", aprBps: 700 },
        { maker: makers.B, strategyHash: hash("credit-B"), amount: "2000000", aprBps: 850 },
      ],
      total: "6000000",
      skipped: [
        { strategyHash: hash("credit-C"), reason: "PRICE_ABOVE_CHEAPEST" },
        { strategyHash: hash("credit-D"), reason: "SELLER_NOT_FUNDED_BY_LENDER" },
      ],
      ...overrides,
    },
  };
}

describe("checkQuotePlan", () => {
  it("accepts A 4 + B 2 with C skipped by price and D skipped for its seller set", () => {
    expect(checkQuotePlan(quotes(), makers)).toBe(
      "fills A 4 + B 2 = 6; C skipped (PRICE_ABOVE_CHEAPEST); D skipped (SELLER_NOT_FUNDED_BY_LENDER)",
    );
  });

  it("rejects a plan that fills in another order or amount", () => {
    const [a, b] = quotes().plan.fills;
    expect(() => checkQuotePlan(quotes({ fills: [b!, a!] }), makers)).toThrow(/expected fills A 4 \+ B 2/);
    expect(() => checkQuotePlan(quotes({ fills: [a!, { ...b!, amount: "1000000" }] }), makers)).toThrow(/expected fills/);
  });

  it("rejects a plan where lender C was not skipped or D was skipped for another reason", () => {
    const skipped = quotes().plan.skipped;
    expect(() => checkQuotePlan(quotes({ skipped: [skipped[1]!] }), makers)).toThrow(/lender C's strategy .* was not skipped/);
    expect(() => checkQuotePlan(quotes({ skipped: [skipped[0]!, { ...skipped[1]!, reason: "NO_CAPACITY" }] }), makers)).toThrow(/SELLER_NOT_FUNDED_BY_LENDER/);
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
  const id = hash("PO-1003");
  const buyerAddress: Address = "0x00000000000000000000000000000000000000b0";
  const researchAddress: Address = "0x00000000000000000000000000000000000000e1";
  const computeAddress: Address = "0x00000000000000000000000000000000000000e2";
  const sellerAddress: Address = "0x00000000000000000000000000000000000000f1";
  const events: AuditEvent[] = [];
  const calls: string[] = [];
  const balances = new Map<Address, bigint>([[makers.A, usdc("1")], [makers.B, usdc("2")], [sellerAddress, 0n]]);
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
    invoice: { buyer: buyerAddress, amount: INVOICE.amount, dueDate: 1_800_000_000n, buyerRef: INVOICE.buyerRef, detailsCommitment: hash("details") },
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
          return { pendingId: hash("pending"), id, confirmationRequest: {} };
        },
        quotes: async () => quotes(),
        openFacility: async () => (calls.push("open"), { txHash: "0xfund", total: "6000000" }),
        setBudgets: async () => (calls.push("budgets"), { txHash: "0xbudgets" }),
      },
    },
    buyer: {
      address: buyerAddress,
      agent: {
        confirm: async () => {
          record({ type: "ReceivableConfirmed", id, hcsSeq: 30, hcsTxId: "0.0.7@2.2" });
          record({ type: "NftMinted", id, serial: 1, tokenId: "0.0.50", txId: "0.0.7@3.3" });
          return { txHash: "0xregister", decision: { approved: true, score: 80, advanceBps: 7500, limit: "6000000", reasons: [] } };
        },
        repay: async () => {
          calls.push("repay");
          repaid = true;
          balances.set(makers.A, balances.get(makers.A)! + EXPECTED_PAYOUTS.A);
          balances.set(makers.B, balances.get(makers.B)! + EXPECTED_PAYOUTS.B);
          balances.set(sellerAddress, INVOICE.amount - EXPECTED_PAYOUTS.A - EXPECTED_PAYOUTS.B);
          return { id, mode: "sent", txHash: "0xrepay" };
        },
      },
    },
    research: {
      address: researchAddress,
      spendWallet: researchAddress,
      kit: { note },
      agent: {
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
          agent: { ship: async (params: { tier: string }) => (calls.push(`ship-${key}`), { mode: "shipped", tier: params.tier, aprBps: key === "A" ? 700 : 850, credit: { txHash: `0xship${key}` } }) },
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
      receivable: async () => ({ id, state: "Repaid", amount: "8000000", funded: "6000000", debt: "0", positions: [] }),
    },
    usdcBalance: async (address: Address) => balances.get(address) ?? 0n,
    topUpFromOperator: async (accountId: string, units: bigint) => {
      calls.push(`top-up ${accountId} ${units}`);
      return "0.0.1@8.8";
    },
    resolveTx: async (ref: string) => `0.0.1@${ref}`,
    poll: { attempts: 2, delayMs: 0, sleep: noSleep },
    state: {},
  } as unknown as DemoContext;
  return { ctx, calls, balances };
}

describe("the eight lifecycle steps against fake agents", () => {
  it("runs every step in the order of BUILD.md section 16 and every step has proof", async () => {
    const { ctx, calls } = fakeContext();
    const results = await runSteps(STEPS, ctx);

    expect(results.map((r) => r.label.split(".")[0])).toEqual(["1", "1", "1", "1", "2", "2", "2", "2", "2", "3", "4", "5", "6", "7", "7", "7", "7", "8", "9"]);
    expect(results.filter((r) => r.error)).toEqual([]);
    expect(exitCode(results)).toBe(0);
    expect(calls.filter((c) => !c.startsWith("top-up") && c !== "note")).toEqual(["ship-A", "ship-B", "upload", "upload-duplicate", "open", "budgets", "buy-research", "repay"]);
  });

  it("tops up only the lender that is short, by exactly the shortfall", async () => {
    const { ctx, calls } = fakeContext();
    const results = await runSteps(STEPS, ctx);
    expect(calls.filter((c) => c.startsWith("top-up"))).toEqual([`top-up 0.0.65 ${usdc("3")}`]);
    expect(results[0]).toMatchObject({ txId: "0.0.1@8.8" });
    expect(results[2]).toMatchObject({ skipped: true });
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
    expect(last.error).toMatch(/payouts differ from lender A 4023013/);
    expect(exitCode(results)).toBe(1);
  });

  it("fails the duplicate step when the second upload is accepted", async () => {
    const { ctx } = fakeContext();
    const real = ctx.seller.agent.run.bind(ctx.seller.agent);
    ctx.seller.agent.run = (async (args: Parameters<typeof real>[0]) => real({ invoice: args.invoice })) as typeof real;
    const results = await runSteps(STEPS, ctx);
    expect(results.find((r) => r.label.includes("duplicate"))?.error).toBe("the duplicate submission was accepted");
  });
});
