import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileTranscript } from "./transcript.js";

describe("fileTranscript", () => {
  it("creates <dir>/<runId>.jsonl and appends one JSON object per line", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "seller-agent-")), "runs");
    const transcript = fileTranscript(dir, "2026-11-07T01-00-00-000Z");

    transcript.write({ type: "node", node: "plan" });
    transcript.write({ type: "node", node: "guard" });

    expect(transcript.path).toBe(join(dir, "2026-11-07T01-00-00-000Z.jsonl"));
    const lines = readFileSync(transcript.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([{ type: "node", node: "plan" }, { type: "node", node: "guard" }]);
  });

  it("writes bigints as decimal strings instead of failing", () => {
    const dir = mkdtempSync(join(tmpdir(), "seller-agent-"));
    const transcript = fileTranscript(dir, "r");
    transcript.write({ spent: 500000n });
    expect(JSON.parse(readFileSync(transcript.path, "utf8"))).toEqual({ spent: "500000" });
  });
});
