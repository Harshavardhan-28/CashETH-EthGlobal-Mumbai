/**
 * The Hashio JSON-RPC relay now and then answers a healthy request with a generic HTTP error ("RPC Request
 * failed", "Failed to save transaction to pool", "Error invoking RPC") or a 5xx/429. Those are retried with
 * exponential backoff. A response that came back OK is never retried, so a send whose transaction hash was
 * already returned is never sent again; resending a failed `eth_sendRawTransaction` replays the same signed bytes.
 */

const TRANSIENT_STATUSES = new Set([400, 429, 500, 502, 503, 504]);
const TRANSIENT_BODY = /RPC Request failed|Failed to save transaction to pool|Error invoking RPC|upstream failure|Missing or invalid parameters/i;
/** Plain gateway and rate-limit failures carry no message worth reading: the status alone is transient. */
const TRANSIENT_WITHOUT_BODY = new Set([429, 502, 503, 504]);

/** Whether an HTTP failure from the relay is worth retrying. */
export function isTransientRelayFailure(status: number, body: string): boolean {
  if (!TRANSIENT_STATUSES.has(status)) return false;
  return TRANSIENT_WITHOUT_BODY.has(status) || TRANSIENT_BODY.test(body);
}

export interface RetryOptions {
  /** Attempts in total, the first included. */
  tries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** `fetch` that retries the relay's transient failures: 1 s, 2 s, 4 s, 8 s between five tries by default. */
export function retryingFetch(fetchImpl: typeof fetch = fetch, { tries = 5, baseDelayMs = 1000, sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)) }: RetryOptions = {}): typeof fetch {
  return async (input, init) => {
    for (let attempt = 1; ; attempt++) {
      const response = await fetchImpl(input, init);
      if (response.ok || attempt >= tries) return response;
      const body = await response.clone().text();
      if (!isTransientRelayFailure(response.status, body)) return response;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  };
}
