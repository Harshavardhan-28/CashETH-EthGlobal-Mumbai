/** Audit trail of an LLM run: every tool call with its outcome, and how the run ended. */
import type { EventStore } from "@casheth/engine";

export type ToolOutcome = "ok" | "error" | "refused";

export type AuditEntry =
  | { kind: "tool_call"; runId: string; step: number; tool: string; input: Record<string, unknown>; outcome: ToolOutcome; result: unknown }
  | { kind: "run_finished"; runId: string; status: string; steps: number; spent: string; answer: string };

export interface AuditSink {
  record(entry: AuditEntry): void;
}

export interface AuditContext {
  role: string;
  /** `provider:model`, so the trail shows which model decided. */
  model: string;
  agentUaid?: string;
  /** The receivable the run works on, when known. */
  id?: string;
}

const codeOf = (result: unknown): string | undefined =>
  typeof result === "object" && result !== null && typeof (result as { code?: unknown }).code === "string" ? (result as { code: string }).code : undefined;

/** Writes entries to an engine `EventStore` (append-only JSONL) as `LlmToolCall` / `LlmRunFinished` events. */
export function eventStoreSink(store: EventStore, { id, agentUaid, ...context }: AuditContext): AuditSink {
  const common = { ...(id ? { id } : {}), ...(agentUaid ? { agentUaid } : {}), ...context };
  return {
    record(entry) {
      if (entry.kind === "tool_call") {
        const { kind: _kind, ...fields } = entry;
        const code = entry.outcome === "ok" ? undefined : codeOf(entry.result);
        store.append({ type: "LlmToolCall", ...common, ...fields, ...(code ? { code } : {}) });
      } else {
        const { kind: _kind, ...fields } = entry;
        store.append({ type: "LlmRunFinished", ...common, ...fields });
      }
    },
  };
}
