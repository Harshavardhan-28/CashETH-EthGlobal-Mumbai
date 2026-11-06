import { describe, expect, it } from "vitest";
import { createHttpGet } from "./httpGet.js";

const PAID = "https://paid.example";
const requirements = {
  x402Version: 2,
  accepts: [{ scheme: "exact", network: "hedera:testnet", amount: "500000", asset: "0.0.429274", payTo: "0.0.11333304" }],
};

function fakeFetch(respond: (url: string) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond(String(input));
  }) as typeof fetch;
  return { calls, impl };
}

describe("http_get", () => {
  it("returns the status, headers and body, with the x402 requirements decoded from PAYMENT-REQUIRED", async () => {
    const header = Buffer.from(JSON.stringify(requirements)).toString("base64");
    const { impl } = fakeFetch(() => new Response("{}", { status: 402, headers: { "payment-required": header, "content-type": "application/json" } }));
    const get = createHttpGet({ allowedOrigins: [PAID], fetch: impl });

    const result = await get({ url: `${PAID}/price-feed?symbols=HBAR` });

    expect(result).toMatchObject({ status: 402, body: "{}", paymentRequired: requirements });
    expect(result.headers?.["content-type"]).toBe("application/json");
  });

  it("refuses a URL on another origin without fetching it", async () => {
    const { calls, impl } = fakeFetch(() => new Response("secret"));
    const get = createHttpGet({ allowedOrigins: [PAID], fetch: impl });

    await expect(get({ url: "https://evil.example/price-feed" })).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
    expect(calls).toHaveLength(0);
  });

  it("does not follow a redirect: the 3xx and its Location come back and nothing else is fetched", async () => {
    const { calls, impl } = fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }));
    const get = createHttpGet({ allowedOrigins: [PAID], fetch: impl });

    const result = await get({ url: `${PAID}/` });

    expect(result).toMatchObject({ status: 302, headers: { location: "https://evil.example/" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.redirect).toBe("manual");
  });

  it("caps the body at maxBytes and says it was truncated", async () => {
    const { impl } = fakeFetch(() => new Response("x".repeat(100)));
    const get = createHttpGet({ allowedOrigins: [PAID], fetch: impl, maxBytes: 10 });

    const result = await get({ url: `${PAID}/` });

    expect(result.body).toBe("x".repeat(10));
    expect(result.truncated).toBe(true);
  });
});
