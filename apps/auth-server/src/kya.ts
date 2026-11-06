/** Read access to `KYARegistry` (on-chain via viem, or in memory for tests) and the KYA gate shared by both grants. */
import { DEMO_ACCOUNTS, type Env } from "@casheth/shared";
import { type Abi, createPublicClient, getAddress, http, isAddress, parseAbi } from "viem";
import { AuthError } from "./assertion.js";

export type AgentRecord = {
  uaidHash: `0x${string}`;
  ownerGroup: `0x${string}`;
  role: number;
  level: number;
  expiresAt: bigint;
  revoked: boolean;
  mandateHash: `0x${string}`;
};

export interface KyaReader {
  /** The raw registry entry, or undefined when the address was never registered. */
  agent(address: `0x${string}`): Promise<AgentRecord | undefined>;
  /** Effective level (0 when revoked or expired), as `KYARegistry.level`. */
  level(address: `0x${string}`): Promise<number>;
  listAgents(): Promise<Array<{ address: `0x${string}`; role: number; level: number }>>;
}

/** The read surface of `KYARegistry` used here; the synced full ABI can be passed instead. */
export const KYA_REGISTRY_READ_ABI = parseAbi([
  "struct Agent { bytes32 uaidHash; bytes32 ownerGroup; uint8 role; uint8 level; uint64 expiresAt; bool revoked; bytes32 mandateHash; }",
  "function agent(address account) view returns (Agent)",
  "function level(address account) view returns (uint8)",
]);

function effectiveLevel(record: AgentRecord | undefined, nowSeconds: number): number {
  if (!record || record.revoked) return 0;
  if (record.expiresAt !== 0n && BigInt(nowSeconds) > record.expiresAt) return 0;
  return record.level;
}

export class InMemoryKyaReader implements KyaReader {
  private readonly agents = new Map<string, { address: `0x${string}`; record: AgentRecord }>();

  set(address: `0x${string}`, record: AgentRecord): void {
    this.agents.set(address.toLowerCase(), { address: getAddress(address), record });
  }

  async agent(address: `0x${string}`): Promise<AgentRecord | undefined> {
    return this.agents.get(address.toLowerCase())?.record;
  }

  async level(address: `0x${string}`): Promise<number> {
    return effectiveLevel(await this.agent(address), Math.floor(Date.now() / 1000));
  }

  async listAgents() {
    const now = Math.floor(Date.now() / 1000);
    return [...this.agents.values()].map(({ address, record }) => ({ address, role: record.role, level: effectiveLevel(record, now) }));
  }
}

export interface ViemKyaReaderOptions {
  /**
   * Addresses `listAgents` probes (the registry has no enumeration). Defaults to the demo
   * accounts' `<PREFIX>_EVM` values from the environment.
   */
  candidates?: `0x${string}`[];
}

export function createViemKyaReader(
  env: Env,
  kyaRegistryAddress: `0x${string}`,
  abi: Abi = KYA_REGISTRY_READ_ABI,
  opts: ViemKyaReaderOptions = {},
): KyaReader {
  const client = createPublicClient({ transport: http(env.HEDERA_JSON_RPC_URL) });
  const candidates =
    opts.candidates ??
    DEMO_ACCOUNTS.map((prefix) => env[`${prefix}_EVM`]).filter((a): a is `0x${string}` => typeof a === "string" && isAddress(a));

  const reader: KyaReader = {
    async agent(address) {
      const record = (await client.readContract({ address: kyaRegistryAddress, abi, functionName: "agent", args: [address] })) as AgentRecord;
      if (record.role === 0 && /^0x0+$/.test(record.uaidHash)) return undefined;
      return {
        uaidHash: record.uaidHash,
        ownerGroup: record.ownerGroup,
        role: Number(record.role),
        level: Number(record.level),
        expiresAt: BigInt(record.expiresAt),
        revoked: record.revoked,
        mandateHash: record.mandateHash,
      };
    },
    async level(address) {
      return Number(await client.readContract({ address: kyaRegistryAddress, abi, functionName: "level", args: [address] }));
    },
    async listAgents() {
      const now = Math.floor(Date.now() / 1000);
      const rows = await Promise.all(
        candidates.map(async (address) => ({ address: getAddress(address), record: await reader.agent(address) })),
      );
      return rows
        .filter((row): row is { address: `0x${string}`; record: AgentRecord } => row.record !== undefined)
        .map(({ address, record }) => ({ address, role: record.role, level: effectiveLevel(record, now) }));
    },
  };
  return reader;
}

/**
 * The KYA gate: unregistered, revoked or expired agents and a mandate mismatch fail with
 * `KYA_FAIL`; a live registration below level 1 fails with `KYA_LEVEL_TOO_LOW`.
 */
export async function requireKyaAgent(
  kya: KyaReader,
  address: `0x${string}`,
  check: { nowSeconds: number; mandateHash?: `0x${string}` },
): Promise<AgentRecord> {
  const record = await kya.agent(address);
  if (!record || record.role === 0) throw new AuthError("KYA_FAIL", `agent ${address} is not registered in KYARegistry`);
  if (record.revoked) throw new AuthError("KYA_FAIL", `agent ${address} is revoked`);
  if (record.expiresAt !== 0n && BigInt(check.nowSeconds) > record.expiresAt) {
    throw new AuthError("KYA_FAIL", `agent ${address} KYA registration expired`);
  }
  if (check.mandateHash !== undefined && check.mandateHash.toLowerCase() !== record.mandateHash.toLowerCase()) {
    throw new AuthError("KYA_FAIL", "mandateHash does not match the registered mandate");
  }
  if (record.level < 1) throw new AuthError("KYA_LEVEL_TOO_LOW", `agent ${address} has KYA level ${record.level}`);
  return record;
}
