import type { AgentStats, AuditEvent, LenderYield, ReceivableDetails } from "./api";

/** Read-API-shaped sample data (docs/API.md section 4), used by the tests in place of a running backend. */

const RECEIVABLE_ID = "0x7f3a9c5d1e2b4a60987654321fedcba0123456789abcdef0123456789abcc21e";
const SELLER = "0x1111111111111111111111111111111111111111";
const BUYER = "0x2222222222222222222222222222222222222222";
const LENDER = "0x3333333333333333333333333333333333333333";
const WORKER = "0x4444444444444444444444444444444444444444";
const MERCHANT = "0x5555555555555555555555555555555555555555";

const base = { v: 1 as const, asset: "0.0.429274" };

export const EVENTS_FIXTURE: AuditEvent[] = [
  { ...base, type: "ReceivableUploaded", seq: 1, prevSeq: 0, ts: "2026-11-06T10:00:00.000Z", id: RECEIVABLE_ID, agent: SELLER, amount: "10000000000" },
  { ...base, type: "ReceivableConfirmed", seq: 2, prevSeq: 1, ts: "2026-11-06T10:00:05.000Z", id: RECEIVABLE_ID, agent: BUYER, amount: "10000000000", txHash: "0xa1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90", hcsSeq: 12 },
  { ...base, type: "FacilityFunded", seq: 3, prevSeq: 2, ts: "2026-11-06T10:01:00.000Z", id: RECEIVABLE_ID, agent: SELLER, amount: "6000000000", hcsSeq: 13 },
  { ...base, type: "SpendCommitted", seq: 4, prevSeq: 3, ts: "2026-11-06T10:02:00.000Z", id: RECEIVABLE_ID, spendId: "0xspend", agent: WORKER, amount: "250000", merchant: MERCHANT, hcsSeq: 14 },
  { ...base, type: "SpendRejected", seq: 5, prevSeq: 4, ts: "2026-11-06T10:02:30.000Z", id: RECEIVABLE_ID, agent: WORKER, amount: "5500000000", code: "AGENT_BUDGET_EXCEEDED", hcsError: "TOPIC_UNREACHABLE" },
];

export const RECEIVABLE_FIXTURE: ReceivableDetails = {
  id: RECEIVABLE_ID,
  state: "Financed",
  seller: SELLER,
  buyer: BUYER,
  amount: "10000000000",
  dueDate: 1_796_000_000,
  funded: "6000000000",
  debt: "6036990000",
  positions: [{ maker: LENDER, principal: "6000000000", aprBps: 700, fee: "36990000" }],
  evidence: [{ label: "FacilityFunded", url: "https://hashscan.io/testnet/transaction/0.0.1@1.2" }],
};

export const AGENTS_FIXTURE: AgentStats[] = [
  {
    address: SELLER,
    uaid: "uaid:aid:seller",
    role: "seller",
    label: "Seller",
    level: 2,
    score: 71,
    tier: "medium",
    onTimePct: 100,
    receivablesFunded: 1,
    receivablesRepaid: 0,
    receivablesDefaulted: 0,
    avgDaysToRepay: 0,
    spendByMerchant: { [MERCHANT]: "250000" },
    lenderReturnPct: 0,
  },
];

export const LENDERS_FIXTURE: LenderYield[] = [
  {
    address: LENDER,
    label: "Lender A",
    tier: "low",
    capital: "10000000000",
    lent: "6000000000",
    idle: "4000000000",
    baseFees: "12000000",
    creditFees: "36990000",
    baseApr: 3.2,
    boostApr: 7,
    blendedApr: 5.4,
    strategies: { credit: "0xcredit", base: "0xbase" },
  },
];
