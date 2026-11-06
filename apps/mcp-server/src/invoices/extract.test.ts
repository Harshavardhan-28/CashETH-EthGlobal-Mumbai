import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { INVOICE_PO_1003, INVOICE_PO_1003_PDF } from "../../../../agents/src/fixtures.js";
import { afterEach, describe, expect, it } from "vitest";
import { createInvoiceExtractor, heuristicFields, llmFields, resolveLlm, toIsoDate, usdcUnits } from "./extract.js";

const FIXTURE_FIELDS = {
  amount: "6000000",
  currency: "USDC",
  dueDate: INVOICE_PO_1003.dueDate,
  buyerRef: "PO-1003",
  sellerName: INVOICE_PO_1003.sellerName,
  buyerName: INVOICE_PO_1003.buyerName,
};

describe("field parsing", () => {
  it("usdcUnits converts printed amounts to base units and rejects anything else", () => {
    expect(usdcUnits("6.00")).toBe("6000000");
    expect(usdcUnits("1,234.5")).toBe("1234500000");
    expect(usdcUnits("0.000001")).toBe("1");
    expect(usdcUnits("1.0000001")).toBeUndefined();
    expect(usdcUnits("six")).toBeUndefined();
  });

  it("toIsoDate reads ISO, day-month and month-day dates and rejects impossible ones", () => {
    expect(toIsoDate("2026-12-20")).toBe("2026-12-20");
    expect(toIsoDate("20 Dec 2026")).toBe("2026-12-20");
    expect(toIsoDate("December 20, 2026")).toBe("2026-12-20");
    expect(toIsoDate("2026-02-30")).toBeUndefined();
    expect(toIsoDate("31 Foo 2026")).toBeUndefined();
    expect(toIsoDate("soon")).toBeUndefined();
  });
});

describe("heuristic extractor", () => {
  it("reads every field of the demo invoice PDF", async () => {
    const { extractor, fields } = await createInvoiceExtractor().extract({ bytes: readFileSync(INVOICE_PO_1003_PDF), mime: "application/pdf" });
    expect(extractor).toBe("heuristic");
    expect(fields).toEqual(FIXTURE_FIELDS);
  });

  it("reads a differently worded plain-text invoice", () => {
    const text = ["Tax Invoice", "From: Initech", "Bill To: Hooli", "Purchase Order No: 4500-77/A", "Total Due: $1,250.50", "Payment due 5 January 2027"].join("\n");
    expect(heuristicFields(text)).toEqual({
      amount: "1250500000",
      currency: "USD",
      dueDate: "2027-01-05",
      buyerRef: "4500-77/A",
      sellerName: "Initech",
      buyerName: "Hooli",
    });
  });

  it("leaves out what the document does not print", () => {
    expect(heuristicFields("Just some notes about lunch.")).toEqual({});
  });
});

describe("LLM extractor (Ollama-compatible endpoint)", () => {
  let server: Server | undefined;
  const requests: { url: string; body: Record<string, unknown> | undefined }[] = [];

  async function serve(handler: (url: string, body: Record<string, unknown> | undefined) => { status?: number; json: unknown }): Promise<string> {
    requests.length = 0;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
        requests.push({ url: req.url ?? "", body });
        const { status = 200, json } = handler(req.url ?? "", body);
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  const chat = (content: unknown) => ({ choices: [{ message: { content: JSON.stringify(content) } }] });
  const pdfDoc = () => ({ bytes: readFileSync(INVOICE_PO_1003_PDF), mime: "application/pdf" as const });

  it("posts the document text in JSON mode and converts the reply to base units", async () => {
    const baseUrl = await serve(() => ({ json: chat({ amount: "6.00", currency: "usdc", dueDate: "20 Dec 2026", buyerRef: "PO-1003", sellerName: null, buyerName: "Globex" }) }));
    const fields = await llmFields("Invoice text", { baseUrl, model: "qwen2.5:7b" });
    expect(fields).toEqual({ amount: "6000000", currency: "USDC", dueDate: "2026-12-20", buyerRef: "PO-1003", buyerName: "Globex" });
    expect(requests[0]!.url).toBe("/v1/chat/completions");
    expect(requests[0]!.body).toMatchObject({ model: "qwen2.5:7b", response_format: { type: "json_object" }, stream: false });
  });

  it("labels the result ollama and lets the heuristic fill what the model left out", async () => {
    const baseUrl = await serve(() => ({ json: chat({ amount: 6, currency: "USDC", dueDate: null, buyerRef: null }) }));
    const result = await createInvoiceExtractor({ llm: { baseUrl, model: "m" } }).extract(pdfDoc());
    expect(result).toMatchObject({ extractor: "ollama", model: "m", fields: FIXTURE_FIELDS });
  });

  it("falls back to the heuristic when the endpoint fails or answers nonsense", async () => {
    const logs: string[] = [];
    for (const reply of [{ status: 500, json: {} }, { json: { choices: [{ message: { content: "not json" } }] } }]) {
      const baseUrl = await serve(() => reply);
      const result = await createInvoiceExtractor({ llm: { baseUrl, model: "m" }, log: (m) => logs.push(m) }).extract(pdfDoc());
      expect(result).toEqual({ extractor: "heuristic", fields: FIXTURE_FIELDS });
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    expect(logs).toHaveLength(2);
  });

  it("resolveLlm: provider ollama forces it on, another provider turns it off, unset probes /api/tags", async () => {
    const baseUrl = await serve((url) => (url === "/api/tags" ? { json: { models: [] } } : { status: 404, json: {} }));
    expect(await resolveLlm({ provider: "ollama", baseUrl: "http://127.0.0.1:1", model: "m" })).toMatchObject({ model: "m" });
    expect(await resolveLlm({ provider: "none", baseUrl, model: "m" })).toBeUndefined();
    expect(await resolveLlm({ baseUrl, model: "m" })).toMatchObject({ baseUrl, model: "m" });
    expect(requests.map((r) => r.url)).toEqual(["/api/tags"]);
    expect(await resolveLlm({ baseUrl: "http://127.0.0.1:1", model: "m" })).toBeUndefined();
  });
});
