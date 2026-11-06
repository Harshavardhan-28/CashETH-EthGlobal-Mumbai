/** The graph state: the conversation, what the run established (facts), the calls the guard approved, the audit. */
import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import { emptyFacts, type Facts } from "./facts.js";

export type Outcome = "ok" | "error" | "refused";

export interface AuditEntry {
  step: number;
  tool: string;
  args: Record<string, unknown>;
  outcome: Outcome;
  code?: string;
  /** HashScan links found in the tool result. */
  links: string[];
}

export interface ApprovedCall {
  id: string;
  name: string;
  /** The model's arguments plus what the wrapper fills in (idempotency key, pinned accounts, stored upload). */
  args: Record<string, unknown>;
}

export type RunStatus = "running" | "completed" | "incomplete" | "max_steps";

export const SellerState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }),
  facts: Annotation<Facts>({ reducer: (current, update) => ({ ...current, ...update }), default: emptyFacts }),
  approved: Annotation<ApprovedCall[]>({ reducer: (_, update) => update, default: () => [] }),
  audit: Annotation<AuditEntry[]>({ reducer: (current, update) => current.concat(update), default: () => [] }),
  /** Model turns taken so far. */
  steps: Annotation<number>({ reducer: (_, update) => update, default: () => 0 }),
  status: Annotation<RunStatus>({ reducer: (_, update) => update, default: () => "running" }),
  error: Annotation<string | undefined>({ reducer: (_, update) => update, default: () => undefined }),
  answer: Annotation<string>({ reducer: (_, update) => update, default: () => "" }),
});

export type SellerStateType = typeof SellerState.State;
