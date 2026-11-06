/**
 * Worker-side discovery of x402 merchant services: fetch each merchant's catalogue, validate it, normalize it
 * to one `Service` shape and pick the cheapest offer for a service name. Prices are compared as integer token units.
 *
 * Two catalogue shapes are understood:
 * - ours (`apps/merchant`, `GET /catalog`): `{ services: [{ name, url, method, price, asset, decimals, network, payTo }] }`
 * - external (`casheth-paid-apis`, `GET /`): `{ network, asset: { id, decimals }, services: [{ method, path, price: "$0.50", payTo, example }] }`
 * An entry with a `url` is ours; one with a `path` is external.
 */
import { z } from "zod";

const serviceSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  url: z.string().min(1),
  method: z.string().min(1),
  price: z.string().regex(/^\d+(\.\d+)?$/, "price must be a non-negative decimal string"),
  asset: z.string().min(1),
  decimals: z.number().int().min(0).max(18),
  network: z.string().min(1),
  payTo: z.string().min(1),
});

const externalHeaderSchema = z.object({
  network: z.string().min(1),
  asset: z.object({ id: z.string().min(1), decimals: z.number().int().min(0).max(18) }),
});

const externalEntrySchema = z.object({
  method: z.string().min(1),
  path: z.string().startsWith("/"),
  price: z.string().regex(/^\$?\d+(\.\d+)?$/, "price must be a decimal amount, optionally prefixed with $"),
  payTo: z.string().min(1),
  description: z.string().optional(),
  example: z.string().optional(),
});

const catalogSchema = z.object({ services: z.array(z.unknown()) });

/** A merchant offer, whichever catalogue it came from. `url` is the full URL, ending in `?param=` when the service takes one value. */
export type Service = z.infer<typeof serviceSchema> & { catalog: string; path: string; priceUnits: bigint };

export interface DiscoveryResult {
  services: Service[];
  /** One message per unreachable/invalid catalog or invalid entry; never thrown. */
  warnings: string[];
}

/** Decimal price string to integer units (`"0.25"`, 6 decimals => 250000n). No floats. */
export function priceUnits(service: Pick<Service, "price" | "decimals">): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(service.price);
  if (!match) throw new Error(`invalid price "${service.price}"`);
  const whole = match[1] ?? "0";
  const frac = match[2] ?? "";
  if (frac.length > service.decimals) {
    throw new Error(`price "${service.price}" has more than ${service.decimals} decimals`);
  }
  return BigInt(whole + frac.padEnd(service.decimals, "0"));
}

type Offer = z.infer<typeof serviceSchema>;

const isExternalEntry = (entry: unknown): boolean =>
  typeof entry === "object" && entry !== null && !("url" in entry) && "path" in entry;

/** The service URL, left open on the query parameter the entry's `example` names (`/price-feed?symbols=A,B` => `...?symbols=`). */
function externalUrl(origin: string, path: string, example: string | undefined): string {
  const examplePath = example?.split(/\s+/).find((token) => token.startsWith("/"));
  const param = examplePath ? new URL(examplePath, origin).searchParams.keys().next().value : undefined;
  return `${origin}${path}${param ? `?${param}=` : ""}`;
}

function normalizeExternal(entry: unknown, header: z.infer<typeof externalHeaderSchema>, catalog: string): Offer {
  const parsed = externalEntrySchema.parse(entry);
  return {
    name: parsed.path.slice(1),
    ...(parsed.description ? { description: parsed.description } : {}),
    url: externalUrl(new URL(catalog).origin, parsed.path, parsed.example),
    method: parsed.method,
    price: parsed.price.replace(/^\$/, ""),
    asset: header.asset.id,
    decimals: header.asset.decimals,
    network: header.network,
    payTo: parsed.payTo,
  };
}

async function fetchJson(catalog: string, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(catalog);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function discoverServices(
  catalogUrls: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveryResult> {
  const services: Service[] = [];
  const warnings: string[] = [];
  for (const catalog of catalogUrls) {
    let body: unknown;
    try {
      body = await fetchJson(catalog, fetchImpl);
    } catch (error) {
      warnings.push(`catalog ${catalog} unreachable: ${messageOf(error)}`);
      continue;
    }
    const parsed = catalogSchema.safeParse(body);
    if (!parsed.success) {
      warnings.push(`catalog ${catalog} invalid: expected { services: [...] }`);
      continue;
    }
    const header = externalHeaderSchema.safeParse(body);
    let headerWarned = false;
    parsed.data.services.forEach((entry, i) => {
      try {
        if (isExternalEntry(entry) && !header.success) {
          if (!headerWarned) warnings.push(`catalog ${catalog} invalid: an external catalogue needs a top-level network and asset { id, decimals }`);
          headerWarned = true;
          return;
        }
        const offer = isExternalEntry(entry) && header.success ? normalizeExternal(entry, header.data, catalog) : serviceSchema.parse(entry);
        services.push({ ...offer, catalog, path: new URL(offer.url).pathname, priceUnits: priceUnits(offer) });
      } catch (error) {
        const reason = error instanceof z.ZodError ? (error.issues[0]?.message ?? "bad shape") : messageOf(error);
        warnings.push(`catalog ${catalog} entry ${i} invalid: ${reason}`);
      }
    });
  }
  return { services, warnings };
}

/** Lowest-priced service called `name`; ties go to the earliest catalog (input order). */
export function cheapest(services: Service[], name: string): Service | undefined {
  let best: Service | undefined;
  for (const s of services) {
    if (s.name === name && (best === undefined || s.priceUnits < best.priceUnits)) best = s;
  }
  return best;
}
