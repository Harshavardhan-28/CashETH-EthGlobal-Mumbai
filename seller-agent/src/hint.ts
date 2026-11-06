/** The deterministic next step the plan node shows the model, derived from the facts the run has established. */
import type { Facts } from "./facts.js";
import type { PromptContext } from "./prompt.js";

export type HintContext = Pick<PromptContext, "account" | "invoice" | "paidApiUrl">;

export function nextStepHint(_facts: Facts, _context: HintContext): string {
  return "continue with the plan";
}
