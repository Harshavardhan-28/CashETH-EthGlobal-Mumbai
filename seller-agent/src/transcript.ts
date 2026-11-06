/** The run transcript: one JSON object per line in `seller-agent/runs/<runId>.jsonl` (gitignored). */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TranscriptSink } from "./run.js";

export function fileTranscript(dir: string, runId: string): TranscriptSink & { path: string } {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${runId}.jsonl`);
  return {
    path,
    write(entry) {
      appendFileSync(path, `${JSON.stringify(entry, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value))}\n`);
    },
  };
}
