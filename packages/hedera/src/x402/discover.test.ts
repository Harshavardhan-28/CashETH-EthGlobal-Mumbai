import { describe, expect, it } from "vitest";
import { cheapest, discoverServices, priceUnits } from "./discover.js";

const svc = (price: string, payTo: string) => ({
  name: "research",
  description: "Topic research summary with sources",
  url: "https://m/research?topic=",
  method: "GET",
  price,
  asset: "0.0.429274",
  decimals: 6,
  network: "hedera:testnet",
  payTo,
});

const A = "https://a.example/catalog";
const B = "https://b.example/catalog";
const C = "https://c.example/catalog";

function stub(map: Record<string, unknown>): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    if (!(url in map)) throw new Error("ECONNREFUSED");
    return new Response(JSON.stringify(map[url]), { status: 200 });
  }) as typeof fetch;
}

describe("discoverServices", () => {
  const fetchImpl = stub({
    [A]: { services: [svc("0.25", "0.0.1")] },
    [B]: { services: [svc("0.20", "0.0.2"), { name: "bad", price: 5 }] },
  });

  it("cheapest picks the lower price", async () => {
    const { services } = await discoverServices([A, B], fetchImpl);
    expect(services).toHaveLength(2);
    expect(services.map((s) => s.catalog)).toEqual([A, B]);
    expect(cheapest(services, "research")?.payTo).toBe("0.0.2");
    expect(cheapest(services, "nope")).toBeUndefined();
  });

  it("breaks price ties by catalog order", async () => {
    const f = stub({ [A]: { services: [svc("0.20", "0.0.1")] }, [B]: { services: [svc("0.2", "0.0.2")] } });
    const { services } = await discoverServices([A, B], f);
    expect(cheapest(services, "research")?.payTo).toBe("0.0.1");
  });

  it("invalid entries are skipped and reported", async () => {
    const { services, warnings } = await discoverServices([A, B], fetchImpl);
    expect(services).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/b\.example/);
  });

  it("unreachable catalog is reported, others still returned", async () => {
    const { services, warnings } = await discoverServices([C, A], fetchImpl);
    expect(services.map((s) => s.payTo)).toEqual(["0.0.1"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/c\.example/);
  });
});

describe("priceUnits", () => {
  it("parses decimal prices into integer units", () => {
    expect(priceUnits({ ...svc("0.25", "x"), catalog: A })).toBe(250000n);
    expect(priceUnits({ ...svc("1", "x"), catalog: A })).toBe(1000000n);
    expect(priceUnits({ ...svc("0.2", "x"), catalog: A })).toBe(200000n);
    expect(priceUnits({ ...svc("0.250000", "x"), catalog: A })).toBe(250000n);
    expect(priceUnits({ price: "7", decimals: 0 })).toBe(7n);
  });

  it.each(["0.1234567", "0.2500000", "abc", ".5", "1.", "", "-1", "1.5e3", "1,5"])(
    "rejects %j at 6 decimals",
    (price) => {
      expect(() => priceUnits({ price, decimals: 6 })).toThrow();
    },
  );

  it("rejects any fractional digit when decimals is 0", () => {
    expect(() => priceUnits({ price: "1.0", decimals: 0 })).toThrow();
  });
});

const PAID_APIS = "https://paid.example.run.app/";

/** The `GET /` of `casheth-paid-apis` (a teammate's merchant), trimmed to the fields that matter. */
const paidApisCatalogue = {
  name: "CashETH demo paid APIs",
  protocol: "x402 v2",
  network: "hedera:testnet",
  asset: { id: "0.0.429274", symbol: "USDC", decimals: 6 },
  services: [
    { method: "GET", path: "/price-feed", price: "$0.50", payTo: "0.0.11333304", description: "Prices", example: "/price-feed?symbols=HBAR,ETH,BTC" },
    { method: "GET", path: "/web-scrape", price: "$1.00", payTo: "0.0.11333304", description: "Scrape", example: "/web-scrape?url=https://hedera.com" },
    { method: "POST", path: "/llm-summary", price: "$2.00", payTo: "0.0.11333304", description: "Summary", example: 'POST /llm-summary {"text": "..."}' },
    { method: "GET", path: "/premium-data", price: "$5.00", payTo: "0.0.6666", description: "Rogue", example: "/premium-data" },
  ],
};

describe("discoverServices: both catalogue shapes", () => {
  it("normalizes casheth-paid-apis' GET / into the same Service shape as our /catalog", async () => {
    const { services, warnings } = await discoverServices([PAID_APIS], stub({ [PAID_APIS]: paidApisCatalogue }));
    expect(warnings).toEqual([]);
    expect(services.map((s) => [s.name, s.method, s.path, s.priceUnits, s.payTo])).toEqual([
      ["price-feed", "GET", "/price-feed", 500_000n, "0.0.11333304"],
      ["web-scrape", "GET", "/web-scrape", 1_000_000n, "0.0.11333304"],
      ["llm-summary", "POST", "/llm-summary", 2_000_000n, "0.0.11333304"],
      ["premium-data", "GET", "/premium-data", 5_000_000n, "0.0.6666"],
    ]);
    expect(services[0]).toMatchObject({
      price: "0.50",
      asset: "0.0.429274",
      decimals: 6,
      network: "hedera:testnet",
      catalog: PAID_APIS,
      // the query parameter named by `example` is left open, like our `?topic=`
      url: "https://paid.example.run.app/price-feed?symbols=",
    });
    expect(services[3]!.url).toBe("https://paid.example.run.app/premium-data");
  });

  it("gives our /catalog entries the same path and priceUnits", async () => {
    const { services } = await discoverServices([A], stub({ [A]: { services: [svc("0.25", "0.0.1")] } }));
    expect(services[0]).toMatchObject({ name: "research", path: "/research", priceUnits: 250_000n, url: "https://m/research?topic=" });
  });

  it("compares offers from both shapes in integer units", async () => {
    const mixed = { [A]: { services: [{ ...svc("0.60", "0.0.1"), name: "price-feed" }] }, [PAID_APIS]: paidApisCatalogue };
    const { services } = await discoverServices([A, PAID_APIS], stub(mixed));
    expect(cheapest(services, "price-feed")).toMatchObject({ payTo: "0.0.11333304", priceUnits: 500_000n });
  });

  it("skips an entry whose price is not a dollar amount and reports it", async () => {
    const bad = { ...paidApisCatalogue, services: [{ ...paidApisCatalogue.services[0]!, price: "free" }, paidApisCatalogue.services[1]!] };
    const { services, warnings } = await discoverServices([PAID_APIS], stub({ [PAID_APIS]: bad }));
    expect(services.map((s) => s.name)).toEqual(["web-scrape"]);
    expect(warnings).toHaveLength(1);
  });

  it("rejects a catalogue that is neither shape", async () => {
    const { services, warnings } = await discoverServices([PAID_APIS], stub({ [PAID_APIS]: { services: [{ name: "x" }] } }));
    expect(services).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it("an external catalogue without a top-level asset is invalid: the token and decimals are needed to price it", async () => {
    const { asset: _asset, ...noAsset } = paidApisCatalogue;
    const { services, warnings } = await discoverServices([PAID_APIS], stub({ [PAID_APIS]: noAsset }));
    expect(services).toEqual([]);
    expect(warnings[0]).toMatch(/asset/);
  });
});
