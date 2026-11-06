import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type AuditType =
  | "AgentRegistered"
  | "ReceivableUploaded"
  | "ReceivableConfirmed"
  | "ReceivableRejected"
  | "NftMinted"
  | "StrategyShipped"
  | "StrategyDocked"
  | "FacilityFunded"
  | "BudgetsSet"
  | "SpendReserved"
  | "SpendCommitted"
  | "SpendReleased"
  | "SpendRejected"
  | "Repaid"
  | "Overdue"
  | "Defaulted"
  | "Disputed";

export type AuditEvent = {
  v: 1;
  type: AuditType;
  id?: string;
  spendId?: string;
  agentUaid?: string;
  amount?: string;
  asset?: string;
  merchant?: string;
  txId?: string;
  code?: string;
  seq: number;
  prevSeq: number;
  ts: string;
  [k: string]: unknown;
};

/**
 * What callers pass to `append`: an AuditEvent without `v`/`seq`/`prevSeq`, `ts` optional.
 * Spelled out because `Omit` over a type with an index signature drops every named key
 * (it would leave `type` optional and `unknown`).
 */
export type AuditEventInput = {
  type: AuditType;
  id?: string;
  spendId?: string;
  agentUaid?: string;
  amount?: string;
  asset?: string;
  merchant?: string;
  txId?: string;
  code?: string;
  ts?: string;
  [k: string]: unknown;
};

/**
 * Append-only JSONL audit log. Sequence numbers are 1-based line indexes;
 * each event records its own `seq` and the previous event's `prevSeq` (0 for the first).
 */
export class EventStore {
  readonly #filePath: string;
  readonly #events: AuditEvent[];

  constructor(filePath: string) {
    this.#filePath = filePath;
    this.#events = existsSync(filePath)
      ? readFileSync(filePath, "utf8")
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as AuditEvent)
      : [];
  }

  append(event: AuditEventInput): AuditEvent {
    const prevSeq = this.#events.length;
    const stored: AuditEvent = {
      ...event,
      type: event.type,
      v: 1,
      seq: prevSeq + 1,
      prevSeq,
      ts: event.ts ?? new Date().toISOString(),
    };
    mkdirSync(dirname(this.#filePath), { recursive: true });
    appendFileSync(this.#filePath, `${JSON.stringify(stored)}\n`);
    this.#events.push(stored);
    return stored;
  }

  list(): AuditEvent[] {
    return [...this.#events];
  }

  byId(id: string): AuditEvent[] {
    return this.#events.filter((e) => e.id === id);
  }

  last(): AuditEvent | undefined {
    return this.#events.at(-1);
  }
}
