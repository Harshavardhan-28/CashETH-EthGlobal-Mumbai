/** `list_catalog`: the worker's window onto the merchants' catalogues (ours and external ones). Only the configured catalog URLs are fetched, never one the model names. */
import { discoverServices, longZeroEvmAddress } from "@casheth/hedera";
import type { LocalTool } from "./tools.js";

export function catalogTool(catalogUrls: string[], fetchImpl: typeof fetch = fetch): LocalTool {
  return {
    def: {
      name: "list_catalog",
      description:
        "List the services merchants sell over x402, with prices. Each offer has: name, price (decimal USDC), priceUnits (base units, use as the reserve amount), merchant (EVM address to reserve for), url (append the url-encoded query to call it) and catalog.",
      inputSchema: { type: "object", properties: { service: { type: "string", description: "only offers with this service name" } } },
    },
    async run({ service }) {
      const { services, warnings } = await discoverServices(catalogUrls, fetchImpl);
      const offers = services
        .filter((s) => typeof service !== "string" || s.name === service)
        .map((s) => ({
          name: s.name,
          description: s.description,
          price: s.price,
          priceUnits: s.priceUnits.toString(),
          merchant: longZeroEvmAddress(s.payTo),
          url: s.url,
          catalog: s.catalog,
        }));
      return { offers, warnings };
    },
  };
}
