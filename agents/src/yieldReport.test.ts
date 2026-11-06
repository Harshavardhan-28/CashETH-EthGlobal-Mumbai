import { describe, expect, it } from "vitest";
import { fetchLenders, formatYieldSection, lenderYieldTable, type LenderYieldRow } from "./yieldReport.js";
import type { TradesFile } from "./trader.js";

const lender = (label: string, over: Partial<LenderYieldRow> = {}): LenderYieldRow => ({
  address: "0xc502fe381481aBD2E56921Dc58DFC3ca3776a096",
  label,
  tier: "low",
  capital: "6000000",
  lent: "4000000",
  idle: "2000000",
  baseFees: "1200",
  creditFees: "0",
  baseApr: 3.65,
  boostApr: 7,
  blendedApr: 4.5,
  strategies: {},
  ...over,
});

const trades: TradesFile = {
  network: "testnet",
  chainId: 296,
  label: "scripted volume",
  trades: [
    {
      lender: "A",
      strategyHash: "0xbb",
      direction: "usdc->tusdt",
      amountIn: "200000",
      amountOut: "199400",
      txHash: "0x01",
      link: "https://hashscan.io/testnet/transaction/0x01",
    },
  ],
};

describe("lenderYieldTable", () => {
  it("lists lenders in label order with USDC as decimals and APRs as percentages", () => {
    const table = lenderYieldTable([lender("lenderB", { tier: "medium" }), lender("lenderA", { baseFees: "1234" })]);
    const rows = table.split("\n");
    expect(rows[0]).toBe("| Lender | Tier | Capital (USDC) | Lent | Idle | Base fees | Credit fees | Base APR | Boost APR | Blended APR |");
    expect(rows[1]).toBe("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    expect(rows[2]).toBe("| lenderA | low | 6 | 4 | 2 | 0.001234 | 0 | 3.65% | 7% | 4.5% |");
    expect(rows[3]).toMatch(/^\| lenderB \| medium /);
  });
});

describe("formatYieldSection", () => {
  const section = formatYieldSection({ date: new Date("2026-11-07T10:00:00Z"), lenders: [lender("lenderA")], trades });

  it("is headed C4 base yield (scripted volume) and says the base yield is variable, not guaranteed", () => {
    expect(section).toMatch(/^## C4 base yield \(scripted volume\)\n/);
    expect(section).toMatch(/variable/);
    expect(section).toMatch(/not guaranteed/);
  });

  it("lists every swap with its HashScan link and the amounts as decimals", () => {
    expect(section).toContain("| A | USDC -> tUSDT | 0.2 | 0.1994 | [0x01](https://hashscan.io/testnet/transaction/0x01) |");
  });

  it("carries the date and the yield table", () => {
    expect(section).toContain("2026-11-07");
    expect(section).toContain("| lenderA | low | 6 | 4 | 2 |");
  });
});

describe("fetchLenders", () => {
  it("reads GET /lenders from the read API", async () => {
    const seen: string[] = [];
    const fakeFetch = (async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify([lender("lenderA")]), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(fetchLenders("http://localhost:4030/", fakeFetch)).resolves.toEqual([lender("lenderA")]);
    expect(seen).toEqual(["http://localhost:4030/lenders"]);
  });

  const answering = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

  it("rejects a response that is not a list of lender yields, naming the offending field", async () => {
    await expect(fetchLenders("http://x", answering({ lenders: [] }))).rejects.toThrow(/array/);
    await expect(fetchLenders("http://x", answering([{ ...lender("lenderA"), capital: 6_000_000 }]))).rejects.toThrow(/capital/);
    await expect(fetchLenders("http://x", answering([{ ...lender("lenderA"), baseApr: "3.65" }]))).rejects.toThrow(/baseApr/);
    const { label: _label, ...noLabel } = lender("lenderA");
    await expect(fetchLenders("http://x", answering([noLabel]))).rejects.toThrow(/label/);
  });

  it("fails with the status when the API answers an error", async () => {
    const fakeFetch = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await expect(fetchLenders("http://localhost:4030", fakeFetch)).rejects.toThrow(/503/);
  });
});
