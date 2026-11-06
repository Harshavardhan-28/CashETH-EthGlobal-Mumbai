export interface PollOptions {
  attempts: number;
  delayMs: number;
  /** Replaced in tests so polling does not wait. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Calls `read` until it returns a value (not `undefined`); throws naming `what` once the attempts run out. */
export async function poll<T>(what: string, read: () => Promise<T | undefined>, { attempts, delayMs, sleep = realSleep }: PollOptions): Promise<T> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const value = await read();
    if (value !== undefined) return value;
    if (attempt < attempts) await sleep(delayMs);
  }
  throw new Error(`timed out waiting for ${what} (${attempts} attempts, ${delayMs} ms apart)`);
}
