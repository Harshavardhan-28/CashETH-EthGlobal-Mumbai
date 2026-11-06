import { describe, expect, it } from "vitest";
import type { AgentStats, AuditEvent } from "./api";
import { narrate, narrateAll, resolveActor } from "./narrate";

const SELLER = "0xAaaa00000000000000000000000000000000Aaaa";
const BUYER = "0xBbbb00000000000000000000000000000000Bbbb";
const WORKER = "0xCccc00000000000000000000000000000000Cccc";
const LENDER = "0xDddd00000000000000000000000000000000Dddd";
const MERCHANT = "0xEeee00000000000000000000000000000000Eeee";

function agent(address: string, role: AgentStats["role"], label: string, uaid = `uaid:${label}`): AgentStats {
  return {
    address: address.toLowerCase(),
    uaid,
    role,
    label,
    level: 2,
    score: 0,
    tier: "none",
    onTimePct: 0,
    receivablesFunded: 0,
    receivablesRepaid: 0,
    receivablesDefaulted: 0,
    avgDaysToRepay: 0,
    spendByMerchant: {},
    lenderReturnPct: 0,
  };
}

const AGENTS: AgentStats[] = [
  agent(SELLER, "seller", "Acme Seller"),
  agent(BUYER, "buyer", "Bolt Buyer"),
  agent(WORKER, "worker", "Research Worker"),
  agent(LENDER, "lender", "Prime Lender"),
];

let seq = 0;
function ev(type: string, fields: Record<string, unknown> = {}): AuditEvent {
  seq += 1;
  return { v: 1, type, seq, prevSeq: seq - 1, ts: "2026-11-07T10:00:00.000Z", ...fields };
}

const TOPIC = "0.0.1";
const run = (e: AuditEvent) => narrate(e, AGENTS, TOPIC);

describe("narrate: one row per event type", () => {
  const cases: Array<{ name: string; event: AuditEvent; sentence: string; actor: string; tone: string; detail?: string }> = [
    {
      name: "AgentRegistered",
      event: ev("AgentRegistered", { name: "New Seller", role: "seller", evmAddress: "0xFfff00000000000000000000000000000000Ffff", level: 2 }),
      sentence: "joined CashETH",
      actor: "New Seller",
      tone: "info",
      detail: "Identity registered on Hedera · trust level 2",
    },
    { name: "InvoiceDocumentStored", event: ev("InvoiceDocumentStored", { agent: SELLER }), sentence: "stored an invoice document", actor: "Acme Seller", tone: "info", detail: "Only its fingerprint goes on Hedera" },
    {
      name: "ReceivableUploaded",
      event: ev("ReceivableUploaded", { agent: SELLER, id: "INV-1", amount: "800000000" }),
      sentence: "uploaded invoice INV-1 for $800.00",
      actor: "Acme Seller",
      tone: "ok",
      detail: "Waiting for the buyer to confirm",
    },
    {
      name: "ReceivableConfirmed",
      event: ev("ReceivableConfirmed", { agent: BUYER, id: "INV-1", amount: "800000000" }),
      sentence: "confirmed it owes $800.00 on invoice INV-1",
      actor: "Bolt Buyer",
      tone: "ok",
      detail: "Signed by the buyer's agent",
    },
    {
      name: "ReceivableRejected",
      event: ev("ReceivableRejected", { agent: BUYER, id: "INV-1", code: "KYA_LEVEL_TOO_LOW" }),
      sentence: "was refused for invoice INV-1",
      actor: "Bolt Buyer",
      tone: "blocked",
      detail: "Agent trust level too low · the guardrail worked",
    },
    { name: "NftMinted", event: ev("NftMinted", { agent: BUYER, id: "INV-1" }), sentence: "turned invoice INV-1 into an on-chain asset", actor: "Bolt Buyer", tone: "ok", detail: "Receivable NFT minted on Hedera" },
    { name: "StrategyShipped", event: ev("StrategyShipped", { agent: LENDER }), sentence: "offered capital to lend", actor: "Prime Lender", tone: "info", detail: "Lending strategy published on 1inch Aqua" },
    { name: "StrategyDocked", event: ev("StrategyDocked", { agent: LENDER }), sentence: "withdrew its lending offer", actor: "Prime Lender", tone: "info", detail: "Capital returned to the lender" },
    {
      name: "FacilityFunded",
      event: ev("FacilityFunded", { agent: LENDER, id: "INV-1", amount: "640000000" }),
      sentence: "lent $640.00 against invoice INV-1",
      actor: "Prime Lender",
      tone: "ok",
      detail: "Cheapest offers filled first",
    },
    { name: "BudgetsSet", event: ev("BudgetsSet", { agent: SELLER }), sentence: "set spending budgets for its workers", actor: "Acme Seller", tone: "info", detail: "Each worker gets a hard limit" },
    {
      name: "SpendReserved",
      event: ev("SpendReserved", { agent: WORKER, amount: "250000", merchant: MERCHANT }),
      sentence: "set aside $0.25 to pay 0xEeee…Eeee",
      actor: "Research Worker",
      tone: "info",
      detail: "Reserved inside its budget",
    },
    {
      name: "SpendCommitted",
      event: ev("SpendCommitted", { agent: WORKER, amount: "250000", merchant: "0.0.5005" }),
      sentence: "paid $0.25 to 0.0.5005",
      actor: "Research Worker",
      tone: "ok",
      detail: "x402 payment settled on Hedera",
    },
    { name: "SpendReleased", event: ev("SpendReleased", { agent: WORKER, amount: "250000" }), sentence: "cancelled a $0.25 reservation", actor: "Research Worker", tone: "info", detail: "Unused money went back to the budget" },
    {
      name: "SpendRejected",
      event: ev("SpendRejected", { agent: WORKER, amount: "9000000", code: "MERCHANT_NOT_ALLOWED" }),
      sentence: "was blocked from spending $9.00",
      actor: "Research Worker",
      tone: "blocked",
      detail: "Merchant not on its allow-list · the guardrail worked",
    },
    { name: "Repaid", event: ev("Repaid", { agent: BUYER, id: "INV-1", amount: "800000000" }), sentence: "repaid $800.00 on invoice INV-1", actor: "Bolt Buyer", tone: "ok", detail: "Lenders were paid back first" },
    { name: "Overdue", event: ev("Overdue", { id: "INV-1" }), sentence: "flagged invoice INV-1 as overdue", actor: "CashETH MCP", tone: "warn", detail: "Set on time by Hedera's schedule service" },
    { name: "Defaulted", event: ev("Defaulted", { id: "INV-1" }), sentence: "flagged invoice INV-1 as defaulted", actor: "CashETH MCP", tone: "blocked", detail: "Lenders' losses are now recorded" },
    { name: "Disputed", event: ev("Disputed", { id: "INV-1" }), sentence: "marked invoice INV-1 as disputed", actor: "CashETH MCP", tone: "warn", detail: "Financing paused while it is resolved" },
    {
      name: "LlmToolCall ok",
      event: ev("LlmToolCall", { agentUaid: "uaid:Research Worker", tool: "reserve_spend", outcome: "ok" }),
      sentence: "asked the MCP server to reserve_spend",
      actor: "Research Worker",
      tone: "info",
      detail: "Outcome: ok",
    },
    {
      name: "LlmToolCall refused",
      event: ev("LlmToolCall", { agentUaid: "uaid:Research Worker", tool: "reserve_spend", outcome: "refused", code: "TX_LIMIT_EXCEEDED" }),
      sentence: "asked the MCP server to reserve_spend",
      actor: "Research Worker",
      tone: "blocked",
      detail: "Outcome: refused",
    },
    { name: "LlmRunFinished", event: ev("LlmRunFinished", { agentUaid: "uaid:Research Worker", status: "completed" }), sentence: "finished its task", actor: "Research Worker", tone: "info", detail: "Status: completed" },
    { name: "unknown type", event: ev("SomethingNew"), sentence: "recorded SomethingNew", actor: "CashETH MCP", tone: "info", detail: "" },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const n = run(c.event);
      expect(n.sentence).toBe(c.sentence);
      expect(n.tone).toBe(c.tone);
      expect(n.actor.name).toBe(c.actor);
      if (c.detail !== undefined) expect(n.detail).toBe(c.detail);
      expect(n.seq).toBe(c.event.seq);
      expect(n.type).toBe(c.event.type);
    });
  }
});

describe("resolveActor", () => {
  it("matches agent addresses case-insensitively", () => {
    const upper = `0x${SELLER.slice(2).toUpperCase()}`;
    const actor = resolveActor(ev("ReceivableUploaded", { agent: upper }), AGENTS);
    expect(actor.name).toBe("Acme Seller");
    expect(actor.role).toBe("seller");
    expect(actor.address).toBe(SELLER.toLowerCase());
    expect(actor.key).toBe(SELLER.toLowerCase());
    expect(actor.initials).toBe("AS");
  });

  it("matches a checksummed event address to a lowercase /agents entry", () => {
    expect(resolveActor(ev("Repaid", { agent: "0xABCDEF0000000000000000000000000000000001" }), [agent("0xabcdef0000000000000000000000000000000001", "buyer", "Case Buyer")]).name).toBe("Case Buyer");
  });

  it("falls back to agentUaid", () => {
    expect(resolveActor(ev("SpendCommitted", { agentUaid: "uaid:Prime Lender" }), AGENTS).name).toBe("Prime Lender");
  });

  it("uses the registered agent's own fields for AgentRegistered", () => {
    const actor = resolveActor(ev("AgentRegistered", { name: "Fresh Worker", role: "worker", evmAddress: "0xAbC0000000000000000000000000000000000001" }), []);
    expect(actor).toMatchObject({ name: "Fresh Worker", role: "worker", address: "0xabc0000000000000000000000000000000000001", key: "0xabc0000000000000000000000000000000000001" });
  });

  it("infers a generic actor from the event type, keyed role:name", () => {
    expect(resolveActor(ev("ReceivableUploaded"), [])).toMatchObject({ name: "Seller", role: "seller", key: "seller:Seller" });
    expect(resolveActor(ev("Repaid"), [])).toMatchObject({ name: "Buyer", role: "buyer" });
    expect(resolveActor(ev("SpendRejected"), [])).toMatchObject({ name: "Worker", role: "worker" });
    expect(resolveActor(ev("FacilityFunded"), [])).toMatchObject({ name: "Lenders", role: "lender" });
  });

  it("falls back to CashETH MCP for unknown events with no agent", () => {
    expect(resolveActor(ev("SomethingNew"), [])).toMatchObject({ name: "CashETH MCP", role: "mcp", key: "mcp:CashETH MCP" });
  });

  it("falls back to the generic type actor for an unknown agent address", () => {
    const actor = resolveActor(ev("SpendCommitted", { agent: "0x9999000000000000000000000000000000009999" }), AGENTS);
    expect(actor.name).toBe("Worker");
    expect(actor.address).toBe("0x9999000000000000000000000000000000009999");
  });

  it("uses CashETH MCP for Overdue even when the agent is unknown", () => {
    expect(resolveActor(ev("Overdue", { agent: "0x9999000000000000000000000000000000009999" }), AGENTS).name).toBe("CashETH MCP");
  });
});

describe("narrate: degrading gracefully", () => {
  it("SpendCommitted without amount or merchant has no undefined/NaN", () => {
    const n = run(ev("SpendCommitted", { agent: WORKER }));
    expect(n.sentence).toBe("paid money to a merchant");
    expect(n.sentence + n.detail).not.toMatch(/undefined|NaN/);
    expect(n.amount).toBeUndefined();
  });

  it("drops the amount and uses a generic invoice when fields are missing", () => {
    expect(run(ev("ReceivableUploaded", { agent: SELLER })).sentence).toBe("uploaded an invoice");
    expect(run(ev("ReceivableConfirmed", { agent: BUYER })).sentence).toBe("confirmed it owes money on an invoice");
    expect(run(ev("FacilityFunded", { agent: LENDER })).sentence).toBe("lent money against an invoice");
    expect(run(ev("Overdue")).sentence).toBe("flagged an invoice as overdue");
    expect(run(ev("SpendReleased", { agent: WORKER })).sentence).toBe("cancelled a reservation");
    expect(run(ev("SpendRejected", { agent: WORKER })).sentence).toBe("was blocked from spending money");
    expect(run(ev("SpendReserved", { agent: WORKER })).sentence).toBe("set aside money to pay a merchant");
  });

  it("treats a garbage amount as missing", () => {
    const n = run(ev("Repaid", { agent: BUYER, id: "INV-1", amount: "abc" }));
    expect(n.sentence).toBe("repaid money on invoice INV-1");
    expect(n.amount).toBeUndefined();
  });

  it("handles missing rejection code, tool, outcome and status", () => {
    expect(run(ev("SpendRejected", { agent: WORKER, amount: "1000000" })).detail).toBe("Rejected · the guardrail worked");
    const call = run(ev("LlmToolCall", {}));
    const done = run(ev("LlmRunFinished", {}));
    for (const n of [call, done]) expect(n.sentence + n.detail).not.toMatch(/undefined|NaN/);
  });

  it("never throws on an AgentRegistered with no fields", () => {
    const n = run(ev("AgentRegistered"));
    expect(n.sentence).toBe("joined CashETH");
    expect(n.detail).not.toMatch(/undefined|NaN/);
  });
});

describe("narrate: amount", () => {
  it("is set (base units) for money-moving events", () => {
    for (const type of ["FacilityFunded", "SpendCommitted", "Repaid", "ReceivableUploaded", "ReceivableConfirmed", "SpendReserved", "SpendRejected"]) {
      expect(run(ev(type, { amount: "123" })).amount).toBe("123");
    }
  });
  it("is not set for other events", () => {
    expect(run(ev("SpendReleased", { amount: "123" })).amount).toBeUndefined();
    expect(run(ev("StrategyShipped", { amount: "123" })).amount).toBeUndefined();
  });
});

describe("narrate: proof url", () => {
  it("prefers hashscan over hcsSeq", () => {
    expect(run(ev("Repaid", { hashscan: "https://hashscan.io/testnet/transaction/0xabc", hcsSeq: 12 })).proofUrl).toBe("https://hashscan.io/testnet/transaction/0xabc");
  });
  it("builds the HCS message url from hcsSeq", () => {
    expect(run(ev("Repaid", { hcsSeq: 12 })).proofUrl).toBe("https://hashscan.io/testnet/topic/0.0.1/message/12");
  });
  it("is undefined with neither", () => {
    expect(run(ev("Repaid")).proofUrl).toBeUndefined();
    expect(run(ev("Repaid", { hcsError: "boom" })).proofUrl).toBeUndefined();
  });
});

describe("narrate: ids", () => {
  it("passes id and spendId through", () => {
    const n = run(ev("SpendCommitted", { agent: WORKER, id: "0xabc", spendId: "0xdef" }));
    expect(n.id).toBe("0xabc");
    expect(n.spendId).toBe("0xdef");
  });
  it("shortens a long on-chain invoice id in the sentence", () => {
    const id = `0x${"ab".repeat(32)}`;
    expect(run(ev("Repaid", { agent: BUYER, id, amount: "1000000" })).sentence).toBe("repaid $1.00 on invoice 0xabab…abab");
  });
});

describe("narrateAll", () => {
  it("returns newest first (seq descending) without mutating the input", () => {
    const events = [ev("Repaid", { seq: 3 }), ev("Repaid", { seq: 9 }), ev("Repaid", { seq: 5 })];
    const out = narrateAll(events, AGENTS, TOPIC);
    expect(out.map((n) => n.seq)).toEqual([9, 5, 3]);
    expect(events.map((e) => e.seq)).toEqual([3, 9, 5]);
  });
  it("handles an empty list", () => {
    expect(narrateAll([], [], TOPIC)).toEqual([]);
  });
});

describe("narrateAll: PO labels from invoice documents", () => {
  const ID = `0x${"12".repeat(31)}cd`;
  const KECCAK = `0x${"ab".repeat(32)}`;
  const upload = (extra: Record<string, unknown> = {}) => ev("ReceivableUploaded", { agent: SELLER, id: ID, amount: "800000000", documentKeccak: KECCAK, ...extra });
  const stored = (extra: Record<string, unknown> = {}) => ev("InvoiceDocumentStored", { agent: SELLER, receivableRef: "PO-1003", keccak256: KECCAK, ...extra });

  it("joins an Uploaded + DocumentStored pair via the document hash", () => {
    const out = narrateAll([stored(), upload(), ev("FacilityFunded", { agent: LENDER, id: ID, amount: "640000000" })], AGENTS, TOPIC);
    const up = out.find((n) => n.type === "ReceivableUploaded")!;
    const doc = out.find((n) => n.type === "InvoiceDocumentStored")!;
    const funded = out.find((n) => n.type === "FacilityFunded")!;
    expect(up.sentence).toBe("uploaded invoice PO-1003 for $800.00");
    expect(funded.sentence).toBe("lent $640.00 against invoice PO-1003");
    expect(up.ref).toBe("PO-1003");
    expect(doc.ref).toBe("PO-1003");
    expect(funded.ref).toBe("PO-1003");
    expect(doc.id).toBe(ID);
    expect(up.id).toBe(ID);
    expect(doc.sentence).toBe("stored an invoice document");
  });

  it("matches the document hash case-insensitively and regardless of event order", () => {
    const out = narrateAll([upload({ documentKeccak: KECCAK.toUpperCase().replace("0X", "0x") }), stored()], AGENTS, TOPIC);
    expect(out.every((n) => n.ref === "PO-1003" && n.id === ID)).toBe(true);
  });

  it("falls back to the short hash without a document", () => {
    const out = narrateAll([upload({ documentKeccak: undefined })], AGENTS, TOPIC);
    expect(out[0].sentence).toBe("uploaded invoice 0x1212…12cd for $800.00");
    expect(out[0].ref).toBeUndefined();
  });

  it("an unlinked document keeps its own PO ref but gets no id", () => {
    const [doc] = narrateAll([stored({ keccak256: `0x${"ee".repeat(32)}` })], AGENTS, TOPIC);
    expect(doc.ref).toBe("PO-1003");
    expect(doc.id).toBeUndefined();
  });

  it("never uses a hash receivableRef as a label, but uses it as the link when it is a known receivable id", () => {
    const out = narrateAll([upload({ documentKeccak: undefined }), stored({ receivableRef: ID.toUpperCase().replace("0X", "0x"), keccak256: undefined })], AGENTS, TOPIC);
    const doc = out.find((n) => n.type === "InvoiceDocumentStored")!;
    const up = out.find((n) => n.type === "ReceivableUploaded")!;
    expect(doc.id).toBe(ID);
    expect(doc.ref).toBeUndefined();
    expect(up.ref).toBeUndefined();
    expect(up.sentence).toBe("uploaded invoice 0x1212…12cd for $800.00");
  });

  it("ignores a hash receivableRef that is not a known id", () => {
    const [doc] = narrateAll([stored({ receivableRef: `0x${"cc".repeat(32)}`, keccak256: undefined })], AGENTS, TOPIC);
    expect(doc.ref).toBeUndefined();
    expect(doc.id).toBeUndefined();
  });

  it("narrate() takes an optional refs map (lowercase id -> ref) and keeps working without it", () => {
    const e = ev("Repaid", { agent: BUYER, id: ID, amount: "1000000" });
    expect(narrate(e, AGENTS, TOPIC).sentence).toBe("repaid $1.00 on invoice 0x1212…12cd");
    const n = narrate(e, AGENTS, TOPIC, new Map([[ID.toLowerCase(), "PO-7"]]));
    expect(n.sentence).toBe("repaid $1.00 on invoice PO-7");
    expect(n.ref).toBe("PO-7");
  });
});
