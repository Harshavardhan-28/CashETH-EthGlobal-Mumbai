/** Idempotency keys are the wrapper's job, never the model's: one per (run, plan step, call index). */
import { idempotencyKey } from "@casheth/agents";

export function stepKey(runId: string, step: number, index: number, tool: string): string {
  return idempotencyKey(`seller-agent-${tool}`, runId, String(step), String(index));
}
