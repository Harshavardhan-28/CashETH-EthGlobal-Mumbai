import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { StepResult } from "./types.js";

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function txCell(result: StepResult): string {
  if (result.txId) return result.link ? `[${result.txId}](${result.link})` : result.txId;
  return result.link ?? "-";
}

function resultCell(result: StepResult): string {
  if (result.error) return `FAILED: ${result.error}`;
  if (result.skipped) return `skipped${result.note ? `: ${result.note}` : ""}`;
  return result.note ?? "ok";
}

/** The `## Demo run` section of docs/EVIDENCE.md: one row per step with its transaction and result. */
export function formatEvidenceSection(date: Date, results: StepResult[]): string {
  const rows = results.map((r) => `| ${cell(r.label)} | ${cell(txCell(r))} | ${cell(resultCell(r))} |`);
  const details = results.filter((r) => r.detail).flatMap((r) => ["", `**${r.label}**`, "", "```text", r.detail!, "```"]);
  return [`## Demo run ${date.toISOString()}`, "", "| Step | Hedera transaction | Result |", "| --- | --- | --- |", ...rows, ...details, ""].join("\n");
}

/** Appends `section` to the evidence file, separated from what is there by a blank line. */
export function appendEvidence(file: string, section: string): void {
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const separator = existing === "" ? "" : existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  appendFileSync(file, `${separator}${section}`);
}

/** One console line per step as it finishes. */
export function formatStepLine(result: StepResult): string {
  const status = result.error ? "FAIL" : result.skipped ? "SKIP" : "OK  ";
  const proof = result.error ?? result.link ?? result.note ?? "";
  return `${status} ${result.label}${proof ? `\n       ${proof}` : ""}`;
}
