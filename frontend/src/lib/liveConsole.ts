import type { AuditEvent, AuditEventType, ReceivableDetails } from "./api";
import type { ConsoleEvent } from "./content";

/** Number of most recent audit events the live console shows. */
export const LIVE_WINDOW = 10;

type Presentation = { role: string; color: string; step: number; err?: boolean };

const SELLER = { role: "SELLER", color: "var(--seller)" };
const BUYER = { role: "BUYER", color: "var(--buyer)" };
const WORKER = { role: "WORKER", color: "var(--worker)" };
const LENDER = { role: "LENDER", color: "var(--lender)" };
const AQUA = { role: "AQUA", color: "var(--lender)" };
const ORCH = { role: "ORCH", color: "var(--ink)" };
const HEDERA = { role: "HEDERA", color: "var(--ink)" };

/** Who acts for each audit event type and which of the eight lifecycle steps it belongs to (0 = outside the lifecycle). */
const PRESENTATION: Record<AuditEventType, Presentation> = {
  AgentRegistered: { ...ORCH, step: 0 },
  ReceivableUploaded: { ...SELLER, step: 1 },
  ReceivableConfirmed: { ...BUYER, step: 2 },
  ReceivableRejected: { ...ORCH, step: 3, err: true },
  NftMinted: { ...HEDERA, step: 4 },
  StrategyShipped: { ...LENDER, step: 5 },
  StrategyDocked: { ...LENDER, step: 5 },
  FacilityFunded: { ...AQUA, step: 6 },
  BudgetsSet: { ...SELLER, step: 6 },
  SpendReserved: { ...WORKER, step: 7 },
  SpendCommitted: { ...WORKER, step: 7 },
  SpendReleased: { ...WORKER, step: 7 },
  SpendRejected: { ...WORKER, step: 7, err: true },
  Repaid: { ...BUYER, step: 8 },
  Overdue: { ...HEDERA, step: 8, err: true },
  Defaulted: { ...HEDERA, step: 8, err: true },
  Disputed: { ...BUYER, step: 8, err: true },
};

const USDC_DECIMALS = 6;

/** USDC base units ("10000000000") as dollars ("$10,000.00"), truncated to cents. Works on the string, so no precision is lost. */
export function formatUnits(units: string): string {
  const padded = units.padStart(USDC_DECIMALS + 1, "0");
  const whole = padded.slice(0, -USDC_DECIMALS).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${whole}.${padded.slice(-USDC_DECIMALS, -USDC_DECIMALS + 2)}`;
}

/** `0x7f3a…c21e` for long ids and hashes. */
export function shorten(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function detail(ev: AuditEvent): string {
  const parts = [
    ev.id && shorten(ev.id),
    ev.amount && formatUnits(ev.amount),
    ev.code,
    ev.merchant && `merchant ${shorten(ev.merchant)}`,
    ev.txHash && `tx ${shorten(ev.txHash)}`,
    ev.hcsError && "HCS publish failed",
  ];
  return parts.filter(Boolean).join(" · ");
}

export function toConsoleEvent(ev: AuditEvent): ConsoleEvent {
  const p = PRESENTATION[ev.type];
  return {
    seq: String(ev.seq).padStart(3, "0"),
    role: p.role,
    color: p.color,
    type: ev.type,
    detail: detail(ev),
    step: p.step,
    ...(p.err || ev.code ? { err: true } : {}),
  };
}

/** The most recent audit events, oldest first, shaped for the console. */
export function toConsoleEvents(events: AuditEvent[]): ConsoleEvent[] {
  return events.slice(-LIVE_WINDOW).map(toConsoleEvent);
}

/** The receivable the console follows: the one on the newest audit event that names one. */
export function latestReceivableId(events: AuditEvent[]): string | undefined {
  return events.findLast((ev) => ev.id)?.id;
}

/** Footer stats from the followed receivable; the borrowing base is not part of the read API. */
export function liveStats(receivable?: ReceivableDetails) {
  return {
    state: receivable?.state ?? "—",
    base: "—",
    funded: receivable ? formatUnits(receivable.funded) : "$0.00",
    owed: receivable ? formatUnits(receivable.debt) : "$0.00",
  };
}
