import type { Client } from "@hiero-ledger/sdk";
import { publishAudit } from "./hcs.js";
import { createUaid, toHederaCaip10 } from "./standardsSdk.js";

export type AgentRole = "seller" | "buyer" | "worker" | "lender" | "coordinator" | "cosigner" | "issuer";

export interface BuildUaidInput {
  evmAddress: `0x${string}`;
  accountId: string;
  name: string;
  role: AgentRole;
  network: "hedera:testnet";
}

/** Public identity published to HCS; nothing in it is sensitive. */
export type AgentProfile = {
  uaid: string;
  name: string;
  role: AgentRole;
  accountId: string;
  evmAddress: `0x${string}`;
  network: "hedera:testnet";
  version: 1;
};

/** HCS-14 registry namespace for our agents (lower-cased by the SDK's canonicalisation). */
export const UAID_REGISTRY = "casheth";
/** Our agents are MCP clients (BUILD.md §2); they do not speak HCS-10. */
export const UAID_PROTOCOL = "mcp";

/**
 * Builds the agent's HCS-14 UAID with the standards SDK's AID generator: `createUaid` hashes the
 * canonical agent data (registry, name, version, protocol, nativeId, skills) with SHA-384, base58
 * encodes it, and appends routing params, giving
 * `uaid:aid:<base58>;uid=<account>;registry=casheth;proto=mcp;nativeId=hedera:testnet:<account>`.
 * Offline and deterministic. Async only because the SDK's hasher is async.
 */
export async function buildUaid(input: BuildUaidInput): Promise<{ uaid: string; profile: AgentProfile }> {
  const network = input.network.slice("hedera:".length) as "testnet";
  const nativeId = toHederaCaip10(network, input.accountId);
  const uaid = await createUaid(
    {
      registry: UAID_REGISTRY,
      name: input.name,
      version: "1",
      protocol: UAID_PROTOCOL,
      nativeId,
      skills: [],
    },
    // uid = the account id, as the SDK's HCS14Client.createDidWithUaid derives it for a Hedera
    // account without an HCS-10 inbound topic.
    { uid: input.accountId, proto: UAID_PROTOCOL },
  );
  return {
    uaid,
    profile: {
      uaid,
      name: input.name,
      role: input.role,
      accountId: input.accountId,
      evmAddress: input.evmAddress,
      network: input.network,
      version: 1,
    },
  };
}

/** Publishes the profile as an `AgentRegistered` audit event (`agentUaid` + the profile fields). */
export function publishProfile(
  client: Client,
  topicId: string,
  profile: AgentProfile,
  prevSeq = 0,
): Promise<{ sequenceNumber: number; txId: string }> {
  const { uaid, version: profileVersion, ...fields } = profile;
  return publishAudit(client, topicId, {
    v: 1,
    type: "AgentRegistered",
    agentUaid: uaid,
    ...fields,
    profileVersion,
    prevSeq,
    ts: new Date().toISOString(),
  });
}
