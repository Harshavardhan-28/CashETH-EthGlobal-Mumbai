/** x402 buyer side: a payment-aware fetch for a Hedera signer and a GET that reports the settlement. */
import { x402Client } from "@x402/core/client";
import { decodePaymentResponseHeader } from "@x402/core/http";
import type { SettleResponse } from "@x402/core/types";
import { wrapFetchWithPayment } from "@x402/fetch";
import type { ClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";

export type FetchLike = (...args: Parameters<typeof fetch>) => Promise<Response>;

export interface X402Result {
  status: number;
  body: unknown;
  /** Hedera transaction id of the settlement (`0.0.feePayer@seconds.nanos`), when it settled. */
  transactionId?: string;
  /** Decoded `PAYMENT-RESPONSE` header. */
  settlement?: SettleResponse;
}

/** `fetch` that answers a 402 by paying with `signer` on any `hedera:*` network and retrying. */
export function createX402Fetch(signer: ClientHederaSigner, fetchImpl: FetchLike = fetch): FetchLike {
  const client = new x402Client().register("hedera:*", new ExactHederaScheme(signer));
  return wrapFetchWithPayment(fetchImpl, client);
}

/** GET `url` through a payment-aware fetch; the transaction id comes from the settlement header, else the body. */
export async function payX402(fetchImpl: FetchLike, url: string): Promise<X402Result> {
  const res = await fetchImpl(url);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // non-JSON body is returned as text
  }
  const header = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
  const settlement = header ? decodePaymentResponseHeader(header) : undefined;
  const fromBody = (body as { paidWith?: { transactionId?: unknown } } | null)?.paidWith?.transactionId;
  const transactionId =
    settlement?.transaction || (typeof fromBody === "string" && fromBody ? fromBody : undefined);
  return { status: res.status, body, ...(transactionId ? { transactionId } : {}), ...(settlement ? { settlement } : {}) };
}
