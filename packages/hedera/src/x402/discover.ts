/**
 * Worker-side discovery of x402 merchant services: fetch each merchant's `/catalog`, validate it,
 * and pick the cheapest offer for a service name. Prices are compared as integer token units.
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

const catalogSchema = z.object({ services: z.array(z.unknown()) });

export type Service = z.infer<typeof serviceSchema> & { catalog: string };

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

export async function discoverServices(
  catalogUrls: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveryResult> {
  const services: Service[] = [];
  const warnings: string[] = [];
  for (const catalog of catalogUrls) {
    let body: unknown;
    try {
      const res = await fetchImpl(catalog);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.json();
    } catch (error) {
      warnings.push(`catalog ${catalog} unreachable: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const parsed = catalogSchema.safeParse(body);
    if (!parsed.success) {
      warnings.push(`catalog ${catalog} invalid: expected { services: [...] }`);
      continue;
    }
    parsed.data.services.forEach((entry, i) => {
      const result = serviceSchema.safeParse(entry);
      if (!result.success) {
        warnings.push(`catalog ${catalog} entry ${i} invalid: ${result.error.issues[0]?.message ?? "bad shape"}`);
        return;
      }
      try {
        priceUnits(result.data);
      } catch (error) {
        warnings.push(`catalog ${catalog} entry ${i} invalid: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      services.push({ ...result.data, catalog });
    });
  }
  return { services, warnings };
}

/** Lowest-priced service called `name`; ties go to the earliest catalog (input order). */
export function cheapest(services: Service[], name: string): Service | undefined {
  let best: Service | undefined;
  let bestUnits = 0n;
  for (const s of services) {
    if (s.name !== name) continue;
    const units = priceUnits(s);
    if (best === undefined || units < bestUnits) {
      best = s;
      bestUnits = units;
    }
  }
  return best;
}
