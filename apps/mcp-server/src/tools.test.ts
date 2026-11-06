import { receivableConfirmationTypedData, type ReceivableConfirmation } from "@casheth/shared";
import request from "supertest";
import { getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { ADDRS, budget, fakeOrchestrator, kyaAgent, NOW, testApp, type TestOrchestrator } from "./test/fakes.js";
import { callTool, rpc } from "./test/rpc.js";

const DAY = 86_400n;
const SELLER_SCOPES = "receivable:write receivable:read credit:read facility:open budget:write spend:reserve stats:read";
const BUYER_SCOPES = "receivable:confirm receivable:read credit:read repay:write stats:read";
const WORKER_SCOPES = "receivable:read credit:read spend:reserve spend:pay spend:commit stats:read";

const seller = privateKeyToAccount(generatePrivateKey());
const buyer = privateKeyToAccount(generatePrivateKey());
const worker = getAddress("0x00000000000000000000000000000000000000d1");
const spendWallet = getAddress("0x0000000000000000000000000000000000ad06dc");
const merchant = getAddress("0x00000000000000000000000000000000000000e1");

async function setup() {
  const o = fakeOrchestrator();
  o.chain.agents.set(seller.address.toLowerCase(), kyaAgent(2, 1, "seller-co"));
  o.chain.agents.set(buyer.address.toLowerCase(), kyaAgent(3, 2, "buyer-co"));
  o.chain.reps.set(buyer.address.toLowerCase(), { onTime: 2, late: 0, defaults: 0 });
  const t = await testApp(o);
  const tokens = {
    seller: await t.issuer.mint({ agent: seller.address, role: 1, level: 2, scope: SELLER_SCOPES }),
    buyer: await t.issuer.mint({ agent: buyer.address, role: 2, level: 3, scope: BUYER_SCOPES }),
    buyerLevel1: await t.issuer.mint({ agent: buyer.address, role: 2, level: 1, scope: "receivable:read credit:read stats:read" }),
    worker: await t.issuer.mint({ agent: worker, role: 3, level: 2, scope: WORKER_SCOPES }),
  };
  return { ...t, o: o as TestOrchestrator, tokens };
}

const uploadArgs = (key = "upload-key-1") => ({
  buyer: buyer.address,
  amount: "10000000000",
  dueDate: Number(NOW + 30n * DAY),
  buyerRef: "PO-1003",
  detailsCommitment: keccak256(toHex("invoice-doc")),
  idempotencyKey: key,
});

/** Signs the typed data `upload_receivable` returned (uint fields come back as decimal strings). */
async function signConfirmation(typed: { domain: Record<string, unknown>; message: Record<string, string> }): Promise<Hex> {
  const m = typed.message;
  const message: ReceivableConfirmation = {
    seller: m.seller as Address,
    buyer: m.buyer as Address,
    currency: m.currency as Address,
    amount: BigInt(m.amount!),
    dueDate: BigInt(m.dueDate!),
    buyerRef: m.buyerRef as Hex,
    detailsCommitment: m.detailsCommitment as Hex,
    payTo: m.payTo as Address,
    nonce: BigInt(m.nonce!),
    deadline: BigInt(m.deadline!),
  };
  const domain = { ...typed.domain, chainId: Number(typed.domain.chainId) } as Parameters<typeof receivableConfirmationTypedData>[0];
  return buyer.signTypedData(receivableConfirmationTypedData(domain, message));
}

describe("tool registry", () => {
  it("tools/list returns all 17 tools", async () => {
    const { app, tokens } = await setup();
    const body = await rpc(app, tokens.seller, "tools/list");
    const names = (body.result!.tools as { name: string }[]).map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "close_strategy",
        "commit_spend",
        "confirm_receivable",
        "explain_decision",
        "fund_agents",
        "get_agent_stats",
        "get_lender_yield",
        "get_quotes",
        "get_receivable_status",
        "list_agents",
        "open_facility",
        "pay_x402",
        "register_agent",
        "repay_receivable",
        "reserve_spend",
        "set_budgets",
        "upload_receivable",
      ].sort(),
    );
    const upload = (body.result!.tools as { name: string; inputSchema: { required?: string[] } }[]).find((t) => t.name === "upload_receivable")!;
    expect(upload.inputSchema.required).toContain("idempotencyKey");
  });
});

describe("scopes and roles", () => {
  it("level-1 token calling confirm_receivable returns INSUFFICIENT_SCOPE", async () => {
    const { app, tokens, o } = await setup();
    const { result, json } = await callTool(app, tokens.buyerLevel1, "confirm_receivable", {
      pendingId: keccak256(toHex("x")),
      signature: "0x00",
      idempotencyKey: "confirm-key-1",
    });
    expect(result.isError).toBe(true);
    expect(json).toMatchObject({ code: "INSUFFICIENT_SCOPE", required: "receivable:confirm" });
    expect(o.chain.sent).toHaveLength(0);
  });

  it("a seller token cannot call a worker-only tool even with the scope", async () => {
    const { app, issuer } = await setup();
    const token = await issuer.mint({ agent: seller.address, role: 1, scope: `${SELLER_SCOPES} spend:pay` });
    const { json } = await callTool(app, token, "pay_x402", { spendId: keccak256(toHex("s")), url: "https://m.example/r", idempotencyKey: "pay-key-01" });
    expect(json).toMatchObject({ code: "INSUFFICIENT_SCOPE", required: "spend:pay", reason: "role" });
  });
});

describe("receivable intake", () => {
  it("idempotent replay returns the first result", async () => {
    const { app, tokens, o } = await setup();
    const first = await callTool(app, tokens.seller, "upload_receivable", uploadArgs());
    expect(first.result.isError).toBeUndefined();
    expect(first.json).toMatchObject({ pendingId: expect.stringMatching(/^0x[0-9a-f]{64}$/) });

    const again = await callTool(app, tokens.seller, "upload_receivable", uploadArgs());
    expect(again.json).toEqual(first.json);
    expect(again.result._meta).toMatchObject({ replayed: true });
    expect(o.events.list().filter((e) => e.type === "ReceivableUploaded")).toHaveLength(1);

    const reused = await callTool(app, tokens.seller, "upload_receivable", { ...uploadArgs(), amount: "1" });
    expect(reused.json).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("upload returns typed data naming the router as payee; confirm registers, mints the NFT and records the decision", async () => {
    const { app, tokens, o } = await setup();
    const up = await callTool(app, tokens.seller, "upload_receivable", uploadArgs());
    const typed = (up.json.confirmationRequest as { typedData: { domain: Record<string, unknown>; message: Record<string, string> } }).typedData;
    expect(typed.message.payTo).toBe(ADDRS.repaymentRouter);
    expect(typed.domain).toMatchObject({ name: "AgentReceivables", version: "1", chainId: 296, verifyingContract: ADDRS.receivableRegistry });

    const signature = await signConfirmation(typed);
    const { result, json } = await callTool(app, tokens.buyer, "confirm_receivable", {
      pendingId: up.json.pendingId,
      signature,
      idempotencyKey: "confirm-key-1",
    });
    expect(result.isError).toBeUndefined();
    expect(json).toMatchObject({
      id: up.json.id,
      txHash: expect.stringMatching(/^0x/),
      nftSerial: 1,
      hcsSeq: 2,
      decision: { approved: true, score: 630, advanceBps: 7500, limit: "1000000000", reasons: [] },
    });
    expect(o.chain.sent.map((s) => [s.from, s.call.to])).toEqual([["coordinator", ADDRS.receivableRegistry]]);
    expect(o.minted).toEqual([{ id: up.json.id, hcsSeq: 2 }]);
    expect(o.events.list().map((e) => e.type)).toEqual(["ReceivableUploaded", "ReceivableConfirmed", "NftMinted"]);
    // HCS carries the same JSON as the local store, seq and prevSeq included, amounts as strings.
    expect(o.hcsPublished[1]).toMatchObject({ v: 1, type: "ReceivableConfirmed", seq: 2, prevSeq: 1, amount: "10000000000" });
  });

  it("the HCS copy of ReceivableConfirmed fits one 1024-byte message with a real-length UAID; the local event keeps every field", async () => {
    const { app, tokens, o, issuer } = await setup();
    const uaid = "uaid:aid:6n8CxWdsJmRjGgDobg5kTRrgVo84isyzALyeFCZw2oRDASckSXrpa9pa2bkuPQ2o3f;uid=0.0.11337988;registry=casheth;proto=mcp;nativeId=hedera:testnet:0.0.11337988";
    const buyerToken = await issuer.mint({ agent: buyer.address, role: 2, level: 3, scope: BUYER_SCOPES, sub: uaid });
    const up = await callTool(app, tokens.seller, "upload_receivable", uploadArgs());
    const typed = (up.json.confirmationRequest as { typedData: { domain: Record<string, unknown>; message: Record<string, string> } }).typedData;
    const { json } = await callTool(app, buyerToken, "confirm_receivable", { pendingId: up.json.pendingId, signature: await signConfirmation(typed), idempotencyKey: "confirm-key-9" });
    expect(json.hcsSeq).toBe(2);
    const onHcs = o.hcsPublished[1]!;
    expect(Buffer.byteLength(JSON.stringify(onHcs), "utf8")).toBeLessThanOrEqual(1024);
    expect(onHcs).toMatchObject({ type: "ReceivableConfirmed", id: up.json.id, txHash: json.txHash, decision: { score: 630 } });
    expect(o.events.list()[1]).toMatchObject({ agentUaid: uaid, hashscan: expect.any(String), decisionInputs: expect.any(Object) });
  });

  it("confirm rejects a signature from someone other than the buyer with BAD_BUYER_SIG", async () => {
    const { app, tokens, o } = await setup();
    const up = await callTool(app, tokens.seller, "upload_receivable", uploadArgs());
    const typed = (up.json.confirmationRequest as { typedData: { message: Record<string, string> } }).typedData;
    const forged = await privateKeyToAccount(generatePrivateKey()).signMessage({ message: JSON.stringify(typed.message) });
    const { json } = await callTool(app, tokens.buyer, "confirm_receivable", { pendingId: up.json.pendingId, signature: forged, idempotencyKey: "confirm-key-2" });
    expect(json).toMatchObject({ code: "BAD_BUYER_SIG" });
    expect(o.chain.sent).toHaveLength(0);
    expect(o.events.list().at(-1)).toMatchObject({ type: "ReceivableRejected", code: "BAD_BUYER_SIG" });
  });

  it("an HCS failure is recorded as hcsError and never fails the tool", async () => {
    const { app, tokens, o } = await setup();
    o.hcsFail.on = true;
    const { result } = await callTool(app, tokens.seller, "upload_receivable", uploadArgs());
    expect(result.isError).toBeUndefined();
    expect(o.events.list()[0]).toMatchObject({ type: "ReceivableUploaded", hcsError: "mirror hiccup" });
  });

  it("explain_decision falls back to a templated explanation without a model", async () => {
    const { app, tokens } = await setup();
    const up = await callTool(app, tokens.seller, "upload_receivable", uploadArgs());
    const typed = (up.json.confirmationRequest as { typedData: { domain: Record<string, unknown>; message: Record<string, string> } }).typedData;
    await callTool(app, tokens.buyer, "confirm_receivable", { pendingId: up.json.pendingId, signature: await signConfirmation(typed), idempotencyKey: "confirm-key-3" });
    const { json } = await callTool(app, tokens.seller, "explain_decision", { id: up.json.id });
    expect(json).toMatchObject({ source: "template", decision: { score: 630 } });
    expect(json.explanation).toContain("Score 630");
    expect(json.explanation).toContain("does not change the decision");
  });
});

describe("spending", () => {
  const id = keccak256(toHex("receivable-1"));

  function fundedFacility(o: TestOrchestrator) {
    o.chain.facilities.set(id.toLowerCase(), {
      seller: seller.address,
      buyer: buyer.address,
      receivableAmount: 10_000_000_000n,
      dueDate: NOW + 30n * DAY,
      funded: 6_000_000_000n,
      committed: 0n,
      reserved: 0n,
      status: 1,
    });
    o.chain.available_ = 6_000_000_000n;
    o.chain.merchantLists.set(`${id}:${worker}`.toLowerCase(), [merchant]);
  }

  it("reserve_spend maps AGENT_BUDGET_EXCEEDED from the engine", async () => {
    const { app, tokens, o } = await setup();
    fundedFacility(o);
    o.chain.budgets.set(`${id}:${worker}`.toLowerCase(), budget({ alloc: 3_000_000n, maxPerTx: 10_000_000n, maxDaily: 10_000_000n }));
    const { result, json } = await callTool(app, tokens.worker, "reserve_spend", {
      id,
      worker,
      spendWallet,
      merchant,
      amount: "5500000",
      idempotencyKey: "reserve-key-1",
    });
    expect(result.isError).toBe(true);
    expect(json).toMatchObject({ code: "AGENT_BUDGET_EXCEEDED", stage: "engine" });
    expect(o.chain.sent).toHaveLength(0);
    expect(o.events.list().at(-1)).toMatchObject({ type: "SpendRejected", code: "AGENT_BUDGET_EXCEEDED", amount: "5500000" });
  });

  it("reserve_spend rejects 0.6 against maxPerTx 0.5 with TX_LIMIT_EXCEEDED (Ruling R24)", async () => {
    const { app, tokens, o } = await setup();
    fundedFacility(o);
    o.chain.budgets.set(`${id}:${worker}`.toLowerCase(), budget({ alloc: 1_000_000n, maxPerTx: 500_000n, maxDaily: 2_000_000n }));
    const { json } = await callTool(app, tokens.worker, "reserve_spend", { id, worker, spendWallet, merchant, amount: "600000", idempotencyKey: "reserve-key-2" });
    expect(json).toMatchObject({ code: "TX_LIMIT_EXCEEDED" });
  });

  it("reserve_spend within budget sends facility.reserve with the coordinator key", async () => {
    const { app, tokens, o } = await setup();
    fundedFacility(o);
    o.chain.budgets.set(`${id}:${worker}`.toLowerCase(), budget({ alloc: 1_000_000n, maxPerTx: 500_000n, maxDaily: 2_000_000n }));
    const { result, json } = await callTool(app, tokens.worker, "reserve_spend", { id, worker, spendWallet, merchant, amount: "250000", ttlSeconds: 300, idempotencyKey: "reserve-key-3" });
    expect(result.isError).toBeUndefined();
    expect(json).toMatchObject({ spendId: expect.stringMatching(/^0x[0-9a-f]{64}$/), expiry: Number(NOW) + 300 });
    expect(o.chain.sent.map((s) => [s.from, s.call.to])).toEqual([["coordinator", ADDRS.creditFacility]]);
    expect(o.events.list().at(-1)).toMatchObject({ type: "SpendReserved", amount: "250000", asset: "0.0.429274" });
  });

  function openReservation(o: TestOrchestrator) {
    const spendId = keccak256(toHex("spend-1"));
    o.chain.reservations.set(spendId.toLowerCase(), {
      id,
      worker,
      spendWallet,
      merchant,
      amount: 250_000n,
      expiry: NOW + 300n,
      status: 1,
      txIdHash: `0x${"0".repeat(64)}`,
    });
    o.x402.accounts.set(spendWallet.toLowerCase(), "0.0.11339484");
    o.x402.accounts.set(merchant.toLowerCase(), "0.0.9001");
    return spendId;
  }

  it("pay_x402 co-signer refuses a mismatched payTo", async () => {
    const { app, tokens, o } = await setup();
    const spendId = openReservation(o);
    o.x402.requirements = { ...o.x402.requirements, payTo: "0.0.6666" };
    const { result, json } = await callTool(app, tokens.worker, "pay_x402", { spendId, url: "https://merchant.example/research?topic=x", idempotencyKey: "pay-key-1" });
    expect(result.isError).toBe(true);
    expect(json).toMatchObject({ code: "COSIGNER_REFUSED", reason: "wrong_payee" });
    expect(o.x402.cosigned).toHaveLength(0);
    expect(o.events.list().at(-1)).toMatchObject({ type: "SpendRejected", code: "COSIGNER_REFUSED", reason: "wrong_payee" });
  });

  it("pay_x402 co-signs a payment matching the reservation and returns the transaction id", async () => {
    const { app, tokens, o } = await setup();
    const spendId = openReservation(o);
    const { result, json } = await callTool(app, tokens.worker, "pay_x402", { spendId, url: "https://merchant.example/research?topic=x", idempotencyKey: "pay-key-2" });
    expect(result.isError).toBeUndefined();
    expect(json).toMatchObject({ transactionId: "0.0.5005@1800000000.000000001" });
    expect(o.x402.cosigned).toHaveLength(1);
  });

  it("commit_spend records the Hedera transaction id hash with the coordinator", async () => {
    const { app, tokens, o } = await setup();
    const spendId = openReservation(o);
    const { json } = await callTool(app, tokens.worker, "commit_spend", { spendId, hederaTxId: "0.0.5005@1800000000.000000001", idempotencyKey: "commit-key-1" });
    expect(json).toMatchObject({ txIdHash: keccak256(toHex("0.0.5005@1800000000.000000001")) });
    expect(o.events.list().at(-1)).toMatchObject({ type: "SpendCommitted", merchant: "0.0.9001", txId: "0.0.5005@1800000000.000000001" });
  });
});

describe("funding and lender tools", () => {
  const id = keccak256(toHex("confirmed-1"));
  const lender = getAddress("0x00000000000000000000000000000000000000a9");

  function confirmed(o: TestOrchestrator) {
    o.chain.receivables.set(id.toLowerCase(), {
      seller: seller.address,
      buyer: buyer.address,
      currency: ADDRS.usdc,
      amount: 8_000_000n,
      dueDate: NOW + 30n * DAY,
      detailsCommitment: keccak256(toHex("doc")),
      state: 1,
      registeredAt: NOW,
    });
  }

  it("open_facility funds the solver's fills with the coordinator, and refuses an empty plan", async () => {
    const { app, tokens, o } = await setup();
    confirmed(o);
    const empty = await callTool(app, tokens.seller, "open_facility", { id, idempotencyKey: "open-key-01" });
    expect(empty.json).toMatchObject({ code: "NO_ELIGIBLE_LIQUIDITY" });

    const order = { maker: lender, traits: 1n, data: "0x01" as Hex };
    o.aqua.plan = { fills: [{ order, amount: 6_000_000n, aprBps: 700 }], total: 6_000_000n, skipped: [] };
    const { result, json } = await callTool(app, tokens.seller, "open_facility", { id, idempotencyKey: "open-key-02" });
    expect(result.isError).toBeUndefined();
    expect(json).toMatchObject({ funded: "6000000", borrowingBase: "6000000", partial: false, fills: [{ maker: lender, amount: "6000000", aprBps: 700 }] });
    expect(o.chain.sent.map((s) => [s.from, s.call.to])).toEqual([["coordinator", ADDRS.creditFacility]]);
    expect(o.events.list().at(-1)).toMatchObject({ type: "FacilityFunded", id, amount: "6000000", makers: [lender] });
  });

  it("open_facility is the receivable seller's only", async () => {
    const { app, issuer, o } = await setup();
    confirmed(o);
    const other = await issuer.mint({ agent: getAddress("0x00000000000000000000000000000000000000c9"), role: 1, scope: SELLER_SCOPES });
    expect((await callTool(app, other, "open_facility", { id, idempotencyKey: "open-key-03" })).json).toMatchObject({ code: "NOT_PARTY" });
  });

  it("fund_agents returns calldatas without the lender key and ships (recording StrategyShipped) with it", async () => {
    const { app, issuer, o } = await setup();
    const token = await issuer.mint({ agent: lender, role: 4, scope: "receivable:read credit:read stats:read lend:write" });
    const args = { tier: "medium", sellerSet: [seller.address], creditUsdc: "2000000", base: { usdc: "1000000", tUsdt: "1000000" }, idempotencyKey: "fund-key-01" };

    const calldata = await callTool(app, token, "fund_agents", args);
    expect(calldata.json).toMatchObject({ mode: "calldata", tier: "medium", aprBps: 850 });
    expect(o.events.list()).toHaveLength(0);

    o.chain.held.add(lender.toLowerCase());
    const plans: unknown[] = [];
    o.aqua.fund = async (_l, plan, inProcess) => {
      plans.push({ plan, inProcess });
      return {
        mode: "shipped",
        credit: { strategyHash: keccak256(toHex("c")), txHash: keccak256(toHex("t1")) },
        base: { strategyHash: keccak256(toHex("b")), txHash: keccak256(toHex("t2")) },
      };
    };
    const shipped = await callTool(app, token, "fund_agents", { ...args, idempotencyKey: "fund-key-02" });
    expect(shipped.json).toMatchObject({ mode: "shipped", credit: { strategyHash: keccak256(toHex("c")) }, base: { strategyHash: keccak256(toHex("b")) } });
    expect(plans[0]).toMatchObject({ inProcess: true, plan: { creditUsdc: 2_000_000n, base: { usdc: 1_000_000n, tUsdt: 1_000_000n, feeBps: 30 }, args: { aprBps: 850, sellerSet: [seller.address] } } });
    expect(o.events.list().map((e) => [e.type, e.kind])).toEqual([
      ["StrategyShipped", "credit"],
      ["StrategyShipped", "base"],
    ]);
  });

  it("fund_agents and close_strategy are lender-only", async () => {
    const { app, tokens } = await setup();
    const { json } = await callTool(app, tokens.seller, "fund_agents", { tier: "low", creditUsdc: "1", idempotencyKey: "fund-key-03" });
    expect(json).toMatchObject({ code: "INSUFFICIENT_SCOPE", required: "lend:write" });
  });
});

describe("read API", () => {
  it("GET /events returns the event store", async () => {
    const { app, tokens, o } = await setup();
    await callTool(app, tokens.seller, "upload_receivable", uploadArgs());
    const res = await request(app).get("/events").set("Origin", "http://localhost:3000").expect(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(res.body).toEqual(o.events.list());
    expect(res.body[0]).toMatchObject({ v: 1, seq: 1, prevSeq: 0, type: "ReceivableUploaded", hcsSeq: 1 });
  });

  it("GET /receivables/:id shape", async () => {
    const { app, o } = await setup();
    const id = keccak256(toHex("financed"));
    o.chain.receivables.set(id.toLowerCase(), {
      seller: seller.address,
      buyer: buyer.address,
      currency: ADDRS.usdc,
      amount: 10_000_000_000n,
      dueDate: NOW + 30n * DAY,
      detailsCommitment: keccak256(toHex("doc")),
      state: 2,
      registeredAt: NOW,
    });
    o.chain.facilities.set(id.toLowerCase(), { ...(await o.chain.facilityInfo(id)), seller: seller.address, buyer: buyer.address, funded: 6_000_000_000n, status: 1 });
    await o.events.append({ type: "FacilityFunded", id, hashscan: "https://hashscan.io/testnet/transaction/0xabc" });

    const res = await request(app).get(`/receivables/${id}`).expect(200);
    expect(res.body).toEqual({
      id,
      state: "Financed",
      seller: seller.address,
      buyer: buyer.address,
      amount: "10000000000",
      dueDate: Number(NOW + 30n * DAY),
      funded: "6000000000",
      debt: "0",
      positions: [],
      evidence: [{ label: "FacilityFunded", url: "https://hashscan.io/testnet/transaction/0xabc" }],
    });
    await request(app).get(`/receivables/${keccak256(toHex("unknown"))}`).expect(404);
    await request(app).get("/receivables/not-an-id").expect(400);
  });

  it("GET /agents, GET /lenders and GET /health", async () => {
    const { app, o } = await setup();
    o.stats.agents = [
      {
        address: seller.address,
        uaid: "uaid:aid:s",
        role: "seller",
        label: "seller",
        level: 2,
        score: 600,
        tier: "high",
        onTimePct: 0,
        receivablesFunded: 0,
        receivablesRepaid: 0,
        receivablesDefaulted: 0,
        avgDaysToRepay: 0,
        spendByMerchant: {},
        lenderReturnPct: 0,
      },
    ];
    await request(app).get("/agents").expect(200, o.stats.agents);
    await request(app).get("/lenders").expect(200, []);
    const health = await request(app).get("/health").expect(200);
    expect(health.body).toMatchObject({ ok: true, resource: "http://localhost:4030/mcp" });
  });

  it("does not grant CORS to an unknown origin", async () => {
    const { app } = await setup();
    const res = await request(app).get("/events").set("Origin", "https://evil.example").expect(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

