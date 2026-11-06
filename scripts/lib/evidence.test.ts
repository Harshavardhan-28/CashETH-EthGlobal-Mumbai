import { describe, expect, it } from "vitest";
import { dedupeLinks, mirrorPath, normalizeTransactionId, parseEvidence } from "./evidence.js";

const TX_AT = "https://hashscan.io/testnet/transaction/0.0.7314364@1793963078.419965153";
const TX_DASH = "https://hashscan.io/testnet/transaction/0.0.9185802-1793964900-434830214";
const CONTRACT = "https://hashscan.io/testnet/contract/0xc65A0788a9AE598aEAB5DbC529B7649a1383d54c";

describe("normalizeTransactionId", () => {
  it("converts the @ form to the mirror-node dashed form and leaves dashed ids alone", () => {
    expect(normalizeTransactionId("0.0.7314364@1793963078.419965153")).toBe("0.0.7314364-1793963078-419965153");
    expect(normalizeTransactionId("0.0.9185802-1793964900-434830214")).toBe("0.0.9185802-1793964900-434830214");
  });
});

describe("parseEvidence", () => {
  it("finds every link kind with its line number and ignores other networks", () => {
    const md = [
      `fill [tx](${TX_AT}).`,
      `| a | [c](${CONTRACT}) | [d](${TX_DASH}) |`,
      "[t](https://hashscan.io/testnet/topic/0.0.11338927) [k](https://hashscan.io/testnet/token/0.0.429274)",
      "[s](https://hashscan.io/testnet/schedule/0.0.11338268) [a](https://hashscan.io/testnet/account/0.0.11333304)",
      "[other](https://hashscan.io/mainnet/transaction/0.0.1@1.2) is ignored",
    ].join("\n");
    const { links } = parseEvidence(md, "x.md");
    expect(links.map((l) => [l.kind, l.line, l.id])).toEqual([
      ["transaction", 1, "0.0.7314364-1793963078-419965153"],
      ["contract", 2, "0xc65A0788a9AE598aEAB5DbC529B7649a1383d54c"],
      ["transaction", 2, "0.0.9185802-1793964900-434830214"],
      ["topic", 3, "0.0.11338927"],
      ["token", 3, "0.0.429274"],
      ["schedule", 4, "0.0.11338268"],
      ["account", 4, "0.0.11333304"],
    ]);
    expect(links[0].url).toBe(TX_AT);
  });

  it("expects SUCCESS by default, a named failure status, or a generic failure on revert wording", () => {
    const md = [
      `plain [tx](${TX_AT})`,
      `| proof | [tx](${TX_DASH}) | CONTRACT_REVERT_EXECUTED | WRONG_PAYEE() |`,
      `Same obligation again: reverts DUPLICATE_RECEIVABLE() [tx](${TX_AT}1)`,
      `failed with NO_SCHEDULING_ALLOWED_AFTER_SCHEDULED_RECURSION [tx](${TX_AT}2)`,
      `[c](${CONTRACT}) reverts nothing, but is not a transaction`,
    ].join("\n");
    const { links } = parseEvidence(md, "x.md");
    expect(links[0].expect).toEqual({ type: "success" });
    expect(links[1].expect).toEqual({ type: "failure", status: "CONTRACT_REVERT_EXECUTED" });
    expect(links[2].expect).toEqual({ type: "failure" });
    expect(links[3].expect).toEqual({ type: "failure", status: "NO_SCHEDULING_ALLOWED_AFTER_SCHEDULED_RECURSION" });
    expect(links[4].expect).toEqual({ type: "success" });
  });

  it("classifies each link of a multi-link line by the text around it, and reads error signatures", () => {
    const md = [
      `setup: wire ([tx](${TX_AT}1)), register ([tx](${TX_AT}2)). Rejections: [\`WRONG_PAYEE()\`](${TX_DASH}) and [\`BAD_BUYER_SIG()\`](${TX_DASH}9)`,
      `| call | \`NOT_CONFIRMED()\` | [tx](${TX_AT}3) |`,
    ].join("\n");
    const { links } = parseEvidence(md, "x.md");
    expect(links.map((l) => l.expect.type)).toEqual(["success", "success", "failure", "failure", "failure"]);
  });

  it("keeps a bare consensus timestamp and queries it by timestamp", () => {
    const { links } = parseEvidence("[t](https://hashscan.io/testnet/transaction/1793964046.045736810)", "x.md");
    expect(links[0].id).toBe("1793964046.045736810");
    expect(mirrorPath(links[0])).toBe("/transactions?timestamp=1793964046.045736810");
  });

  it("marks a section archived from its leading blockquote until the next ## heading", () => {
    const md = [
      "## Live",
      `[a](${CONTRACT})`,
      "## First",
      "> This section describes the first deployment (archived in `x.json`).",
      `[b](${TX_AT})`,
      "### Sub",
      `[c](${TX_DASH})`,
      "## Live again",
      `[d](${CONTRACT}1)`,
    ].join("\n");
    const { links } = parseEvidence(md, "x.md");
    expect(links.map((l) => l.archived)).toEqual([false, true, true, false]);
  });

  it("marks README details blocks and lines that say archived or first deployment", () => {
    const md = [
      `[live](${TX_AT})`,
      "<details>",
      "<summary>Archived first deployment, and why</summary>",
      `[old](${TX_DASH})`,
      "</details>",
      `| KYARegistry | First deployment (archived) | [c](${CONTRACT}) |`,
      `[after](${CONTRACT}9)`,
    ].join("\n");
    const { links } = parseEvidence(md, "x.md");
    expect(links.map((l) => l.archived)).toEqual([false, true, true, false]);
  });

  it("collects TODO and pending demo run markers", () => {
    const md = ["| Settled x402 payment | TODO (see section 2) |", "fine", "<!-- TODO(8.2-final): add links -->", "pending demo run"].join("\n");
    const { pending } = parseEvidence(md, "x.md");
    expect(pending.map((p) => p.line)).toEqual([1, 3, 4]);
  });
});

describe("dedupeLinks", () => {
  it("merges the two transaction id spellings and keeps the strictest classification", () => {
    const a = parseEvidence(`[x](${TX_AT})`, "a.md").links;
    const b = parseEvidence(
      "## S\n> archived\nreverts [x](https://hashscan.io/testnet/transaction/0.0.7314364-1793963078-419965153)",
      "b.md",
    ).links;
    const [row, ...rest] = dedupeLinks([...a, ...b]);
    expect(rest).toEqual([]);
    expect(row.occurrences).toEqual(["a.md:1", "b.md:3"]);
    expect(row.archived).toBe(false);
    expect(row.expect).toEqual({ type: "failure" });
  });
});

describe("mirrorPath", () => {
  it("maps each kind to a mirror REST path", () => {
    expect(mirrorPath({ kind: "transaction", id: "0.0.1-2-3" })).toBe("/transactions/0.0.1-2-3");
    expect(mirrorPath({ kind: "contract", id: "0xabc" })).toBe("/contracts/0xabc");
    expect(mirrorPath({ kind: "topic", id: "0.0.5" })).toBe("/topics/0.0.5/messages?limit=1");
  });
});
