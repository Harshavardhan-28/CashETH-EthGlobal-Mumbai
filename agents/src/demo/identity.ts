/** The demo agents' identities, as `scripts/c2-register-demo.ts` registered them and the MCP server lists them. */
import type { DemoAccount, Env } from "@casheth/shared";
import { buildUaid } from "@casheth/hedera";
import { getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AgentRole } from "../mcpClient.js";

/** Env prefix, the label the agent was registered under, and its role. */
const AGENTS = {
  SELLER: { label: "seller", role: "seller" },
  BUYER: { label: "buyer", role: "buyer" },
  WORKER_RESEARCH: { label: "workerResearch", role: "worker" },
  WORKER_COMPUTE: { label: "workerCompute", role: "worker" },
  LENDER_A: { label: "lenderA", role: "lender" },
  LENDER_B: { label: "lenderB", role: "lender" },
} as const satisfies Partial<Record<DemoAccount, { label: string; role: AgentRole }>>;

export type AgentPrefix = keyof typeof AGENTS;

export interface AgentIdentity {
  address: Address;
  accountId: string;
  key: Hex;
  uaid: string;
  role: AgentRole;
  /** The hash `register_agent` stored: `keccak256("mandate-v1-<label>")`. */
  mandateHash: Hex;
}

function required(env: Env, key: string): string {
  const value = env[key];
  if (typeof value !== "string" || value === "") throw new Error(`${key} is not set (run pnpm setup:accounts)`);
  return value;
}

export const asHex = (key: string): Hex => (key.startsWith("0x") ? key : `0x${key}`) as Hex;

/** An agent's address from `<PREFIX>_EVM` (any demo account, key not needed). */
export const addressOf = (env: Env, prefix: DemoAccount): Address => getAddress(required(env, `${prefix}_EVM`));

export async function loadIdentity(env: Env, prefix: AgentPrefix): Promise<AgentIdentity> {
  const { label, role } = AGENTS[prefix];
  const key = asHex(required(env, `${prefix}_KEY`));
  const accountId = required(env, `${prefix}_ID`);
  const address = privateKeyToAccount(key).address;
  const known = env[`${prefix}_UAID`];
  const uaid =
    typeof known === "string" && known !== ""
      ? known
      : (await buildUaid({ evmAddress: address, accountId, name: label, role, network: "hedera:testnet" })).uaid;
  return { address, accountId, key, uaid, role, mandateHash: keccak256(toHex(`mandate-v1-${label}`)) };
}
