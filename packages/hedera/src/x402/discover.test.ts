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
  });
});
