/**
 * Helpers for reads through the Hedera JSON-RPC relay (Hashio). Under load the relay sometimes answers an
 * `eth_call` with empty data (`0x`) instead of the contract's result; viem surfaces that as
 * `ContractFunctionZeroDataError`. The contract did answer on a retry, so such reads are retried, while reverts
 * (a real answer) are not. Concurrency is capped so a discovery does not flood the relay.
 */
import { BaseError, ContractFunctionZeroDataError } from "viem";

/** Strategies inspected or dry-run at once: enough to overlap relay latency without flooding Hashio. */
export const RELAY_CONCURRENCY = 4;

function isEmptyResult(err: unknown): boolean {
  return err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionZeroDataError) !== null;
}

/** Runs `read`, retrying with a growing delay while the relay answers with empty data. */
export async function retryEmptyResult<T>(read: () => Promise<T>, { attempts = 4, delayMs = 500 } = {}): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (err) {
      if (attempt >= attempts || !isEmptyResult(err)) throw err;
      await new Promise((r) => setTimeout(r, delayMs * attempt));
    }
  }
}

/** `items.map(task)` with at most `limit` tasks running at once; results keep the input order. */
export async function limitConcurrency<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await task(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
