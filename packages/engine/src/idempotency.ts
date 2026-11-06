import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const BIGINT_TAG = "$bigint";

function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? { [BIGINT_TAG]: value.toString() } : value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    const tagged = (value as Record<string, unknown>)[BIGINT_TAG];
    if (keys.length === 1 && typeof tagged === "string") return BigInt(tagged);
  }
  return value;
}

/** Key -> stored result map, persisted as JSON on every put; bigints survive the round trip. */
export class IdempotencyLedger {
  readonly #filePath: string;
  readonly #entries: Record<string, unknown>;

  constructor(filePath: string) {
    this.#filePath = filePath;
    this.#entries = existsSync(filePath)
      ? (JSON.parse(readFileSync(filePath, "utf8"), reviver) as Record<string, unknown>)
      : {};
  }

  get<T>(key: string): T | undefined {
    return this.has(key) ? (this.#entries[key] as T) : undefined;
  }

  put<T>(key: string, result: T): void {
    this.#entries[key] = result;
    this.#save();
  }

  delete(key: string): void {
    delete this.#entries[key];
    this.#save();
  }

  #save(): void {
    mkdirSync(dirname(this.#filePath), { recursive: true });
    writeFileSync(this.#filePath, JSON.stringify(this.#entries, replacer, 2));
  }

  has(key: string): boolean {
    return Object.hasOwn(this.#entries, key);
  }
}
