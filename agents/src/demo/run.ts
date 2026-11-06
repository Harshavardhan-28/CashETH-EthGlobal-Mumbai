import type { DemoContext, Step, StepResult } from "./types.js";

/**
 * Runs the steps in order. A step that throws is recorded with its error and ends the run: every later step
 * builds on the earlier ones, so carrying on would only report noise.
 */
export async function runSteps(steps: Step[], ctx: DemoContext, onResult: (result: StepResult) => void = () => {}): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const step of steps) {
    let result: StepResult;
    try {
      result = { label: step.label, ...(await step.run(ctx)) };
    } catch (error) {
      result = { label: step.label, error: error instanceof Error ? error.message : String(error) };
    }
    results.push(result);
    onResult(result);
    if (result.error) break;
  }
  return results;
}

/** A step must show a Hedera transaction unless it was skipped or only reads. */
function lacksTransaction(result: StepResult): boolean {
  return !result.skipped && !result.readOnly && !result.txId;
}

/** The labels of the steps that break the run's promise: a failure, or no Hedera transaction id. */
export function failedSteps(results: StepResult[]): string[] {
  return results.filter((r) => r.error || lacksTransaction(r)).map((r) => r.label);
}

/** Non-zero when any step failed or lacks a Hedera transaction id. */
export function exitCode(results: StepResult[]): number {
  return failedSteps(results).length === 0 ? 0 : 1;
}
