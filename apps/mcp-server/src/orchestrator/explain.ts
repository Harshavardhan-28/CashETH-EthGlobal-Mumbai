/**
 * `explain_decision`: a plain-language explanation of the deterministic credit decision. The model (when
 * configured) only explains; the decision it is given is final and never changes.
 */
import Anthropic from "@anthropic-ai/sdk";
import { bytes32 } from "./common.js";
import { decisionFor, type DecisionInputs, type StoredDecision } from "./receivables.js";
import type { Caller, Explanation, ExplainerPort, Orchestrator } from "./types.js";

/** The scoring rules of `@casheth/engine` `scoreReceivable`, given to the model verbatim. */
export const DECISION_RULES: readonly string[] = [
  "Score starts at 600.",
  "+15 points per on-time repayment by the buyer, counting at most 10.",
  "-40 points per late repayment by the buyer.",
  "-200 points per default by the buyer.",
  "-50 points when the receivable is due more than 60 days out.",
  "Advance rate: score >= 700 -> 80%, >= 600 -> 75%, >= 500 -> 60%, below 500 -> declined.",
  "The buyer must be KYA level 3 and the seller KYA level 2, otherwise declined.",
  "Limit = amount x advance rate, capped at 10,000 USDC for a level-3 seller and 1,000 USDC otherwise.",
  "Lenders' own on-chain rules (tier, seller set, per-buyer cap) are applied by the credit opcode at funding, not here.",
];

export const EXPLAIN_MODEL = "claude-haiku-5-5";

export const EXPLAIN_SYSTEM_PROMPT =
  "You explain a credit decision that a deterministic rule engine already made. Explain, never change: do not " +
  "approve, decline, re-score or suggest a different limit. Use only the decision JSON and the rules given. " +
  "Answer in at most five short sentences for a business reader; amounts are USDC base units (6 decimals).";

function usdc(units: string): string {
  const n = BigInt(units);
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Deterministic explanation used when no model is configured (or the model call fails). */
export function templateExplanation(decision: StoredDecision, inputs?: DecisionInputs): string {
  const parts: string[] = [];
  if (inputs) {
    const r = inputs.buyerReputation;
    const terms = [`base 600`, `+15 x ${Math.min(r.onTime, 10)} on-time repayments`];
    if (r.late) terms.push(`-40 x ${r.late} late`);
    if (r.defaults) terms.push(`-200 x ${r.defaults} defaults`);
    if (inputs.tenorDays > 60) terms.push(`-50 for a ${inputs.tenorDays}-day tenor`);
    parts.push(`Score ${decision.score} (${terms.join(", ")}).`);
    parts.push(`KYA levels: buyer ${inputs.buyerLevel}, seller ${inputs.sellerLevel}.`);
  } else {
    parts.push(`Score ${decision.score}.`);
  }
  if (decision.approved) {
    parts.push(`Approved at a ${decision.advanceBps / 100}% advance, so the facility may draw up to ${usdc(decision.limit)} USDC.`);
  } else {
    parts.push(`Declined: ${decision.reasons.join("; ")}.`);
  }
  parts.push("This explanation does not change the decision.");
  return parts.join(" ");
}

export async function explainDecision(o: Orchestrator, _caller: Caller, input: { id: string }) {
  const id = bytes32(input.id, "id");
  const { decision, inputs, source: decisionSource } = await decisionFor(o, id);
  let explanation: Explanation | undefined;
  try {
    explanation = await o.explainer.explain({ decision: { ...decision, ...(inputs ? { inputs } : {}) }, rules: [...DECISION_RULES] });
  } catch (err) {
    o.log("explainer failed, using the template", { id, error: err instanceof Error ? err.message : String(err) });
  }
  explanation ??= { text: templateExplanation(decision, inputs), source: "template" };
  return { id, decision, decisionSource, explanation: explanation.text, source: explanation.source, ...(explanation.model ? { model: explanation.model } : {}) };
}

/** Claude explainer (`ANTHROPIC_API_KEY` set). Returns `undefined` on a refusal so the template is used. */
export function createAnthropicExplainer(apiKey: string, client: Anthropic = new Anthropic({ apiKey })): ExplainerPort {
  return {
    async explain({ decision, rules }) {
      const response = await client.messages.create({
        model: EXPLAIN_MODEL,
        max_tokens: 1024,
        system: EXPLAIN_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Decision JSON (final, do not change it):\n${JSON.stringify(decision)}\n\nRules the engine applied:\n${rules.map((r) => `- ${r}`).join("\n")}\n\nExplain this decision.`,
          },
        ],
      });
      if (response.stop_reason === "refusal") return undefined;
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return text ? { text, source: "anthropic", model: EXPLAIN_MODEL } : undefined;
    },
  };
}
