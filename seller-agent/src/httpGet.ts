/**
 * `http_get`: the agent's only window onto the web. It fetches GET URLs on an allowlisted origin, never follows a
 * redirect (a 3xx comes back as is, so an allowed origin cannot bounce the agent elsewhere) and caps the body.
 * The x402 requirements of a 402 travel base64-encoded in `PAYMENT-REQUIRED`; they are decoded for the model.
 */

export interface HttpGetResult {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  truncated?: boolean;
  paymentRequired?: unknown;
  code?: string;
  message?: string;
}

export interface HttpGetOptions {
  allowedOrigins: string[];
  fetch?: typeof fetch;
  /** Body bytes kept for the model (default 16 KiB). */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 16 * 1024;

function decodePaymentRequired(header: string | null): unknown {
  if (!header) return undefined;
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

export function createHttpGet({ allowedOrigins, fetch: fetchImpl = fetch, maxBytes = DEFAULT_MAX_BYTES }: HttpGetOptions) {
  const allowed = new Set(allowedOrigins.map((origin) => new URL(origin).origin));
  return async ({ url }: { url: string }): Promise<HttpGetResult> => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return { code: "BAD_INPUT", message: `not a URL: ${url}` };
    }
    if (!allowed.has(target.origin)) {
      return { code: "ORIGIN_NOT_ALLOWED", message: `http_get only fetches ${[...allowed].join(", ")}` };
    }
    const res = await fetchImpl(target, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(20_000) });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const truncated = bytes.length > maxBytes;
    const paymentRequired = decodePaymentRequired(res.headers.get("payment-required"));
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: new TextDecoder().decode(truncated ? bytes.slice(0, maxBytes) : bytes),
      ...(truncated ? { truncated } : {}),
      ...(paymentRequired === undefined ? {} : { paymentRequired }),
    };
  };
}
