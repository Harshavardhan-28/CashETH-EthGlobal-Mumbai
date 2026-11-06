import { describe, expect, it } from "vitest";
import { formatUpdate, linksTable } from "./console.js";
import type { AuditEntry } from "./state.js";

describe("formatUpdate", () => {
  it("shows the tool the model asked for, with its arguments", () => {
    const lines = formatUpdate("plan", { steps: 3, messages: [{ type: "ai", content: "", tool_calls: [{ name: "get_quotes", args: { id: "0x1" } }] }] });
    expect(lines).toEqual(['[plan #3] -> get_quotes {"id":"0x1"}']);
  });

  it("shows the model's text when it calls no tool", () => {
    expect(formatUpdate("plan", { steps: 9, messages: [{ type: "ai", content: "All done." }] })).toEqual(["[plan #9] says: All done."]);
  });

  it("shows each guard refusal with its code and what was approved", () => {
    const update = { approved: ["reserve_spend"], audit: [{ step: 2, tool: "pay_x402", args: {}, outcome: "refused", code: "UNKNOWN_SPEND", links: [] }] };
    expect(formatUpdate("guard", update)).toEqual(["[guard] refused pay_x402: UNKNOWN_SPEND", "[guard] approved reserve_spend"]);
  });

  it("shows each tool outcome with its HashScan links", () => {
    const update = { audit: [{ step: 4, tool: "open_facility", args: {}, outcome: "ok", links: ["https://hashscan.io/testnet/transaction/0xf0"] }] };
    expect(formatUpdate("tools", update)).toEqual(["[tools] open_facility ok https://hashscan.io/testnet/transaction/0xf0"]);
  });
});

describe("linksTable", () => {
  it("lists every HashScan link once, labelled by the tool that produced it", () => {
    const audit: AuditEntry[] = [
      { step: 1, tool: "open_facility", args: {}, outcome: "ok", links: ["https://hashscan.io/a"] },
      { step: 2, tool: "pay_x402", args: {}, outcome: "ok", links: ["https://hashscan.io/b"] },
      { step: 3, tool: "commit_spend", args: {}, outcome: "ok", links: ["https://hashscan.io/c", "https://hashscan.io/b"] },
    ];
    expect(linksTable(audit)).toEqual([
      "| step | tool | HashScan |",
      "|---|---|---|",
      "| 1 | open_facility | https://hashscan.io/a |",
      "| 2 | pay_x402 | https://hashscan.io/b |",
      "| 3 | commit_spend | https://hashscan.io/c |",
    ]);
  });
});
