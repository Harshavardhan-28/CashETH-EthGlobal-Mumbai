import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HEDERA_IDS_PATH, loadHederaIds } from "./hederaIds.js";

function tempFile(content: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "hedera-ids-")), "hedera.json");
  writeFileSync(path, JSON.stringify(content));
  return path;
}

const valid = {
  network: "testnet",
  hcsAuditTopicId: "0.0.123",
  receivableNftTokenId: "0.0.456",
  createdAt: "2026-11-06T12:00:00.000Z",
};

describe("loadHederaIds", () => {
  it("resolves deployments/testnet/hedera.json from the repo root", () => {
    expect(HEDERA_IDS_PATH).toMatch(/\/deployments\/testnet\/hedera\.json$/);
    expect(HEDERA_IDS_PATH).not.toMatch(/packages\/shared/);
  });

  it("parses a valid file", () => {
    expect(loadHederaIds({ path: tempFile(valid) })).toEqual(valid);
  });

  it("names the missing field when the file is incomplete", () => {
    const { receivableNftTokenId: _omit, ...partial } = valid;
    expect(() => loadHederaIds({ path: tempFile(partial) })).toThrow(/receivableNftTokenId/);
  });

  it("rejects ids that are not entity ids", () => {
    const path = tempFile({ ...valid, hcsAuditTopicId: "topic" });
    expect(() => loadHederaIds({ path })).toThrow(/hcsAuditTopicId/);
  });

  it("throws a clear error when the file does not exist", () => {
    expect(() => loadHederaIds({ path: "/nonexistent/hedera.json" })).toThrow(/c2-topic-and-nft/);
  });
});
