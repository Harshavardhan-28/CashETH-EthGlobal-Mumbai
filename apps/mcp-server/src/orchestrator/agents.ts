/** `register_agent` (owner/admin): KYA registration with the issuer key plus the HCS-14 profile on the audit topic. */
import { KYARegistryAbi } from "@casheth/shared";
import { encodeFunctionData, keccak256, toHex } from "viem";
import { record } from "./audit.js";
import { actor, addr, bytes32, bytes32OrHash, ROLE_NUMBERS, txLink, ZERO_HASH } from "./common.js";
import { fail } from "./errors.js";
import type { AgentRoleName, Caller, Orchestrator } from "./types.js";

export type RegisterAgentInput = {
  account: string;
  accountId: string;
  name: string;
  role: AgentRoleName;
  level: number;
  /** An owner-group label (hashed) or a 32-byte hash. */
  ownerGroup: string;
  mandateHash?: string;
  /** Unix seconds; 0 = never. */
  expiresAt?: number;
};

export async function registerAgent(o: Orchestrator, caller: Caller, input: RegisterAgentInput) {
  const account = addr(input.account, "account");
  if (!/^\d+\.\d+\.\d+$/.test(input.accountId)) fail("BAD_INPUT", "accountId must look like 0.0.x");
  if (!Number.isInteger(input.level) || input.level < 0 || input.level > 3) fail("BAD_INPUT", "level must be 0..3");
  const role = ROLE_NUMBERS[input.role];
  const uaid = await o.identity.uaid({ evmAddress: account, accountId: input.accountId, name: input.name, role: input.role });
  const agent = {
    uaidHash: keccak256(toHex(uaid)),
    ownerGroup: bytes32OrHash(input.ownerGroup),
    role,
    level: input.level,
    expiresAt: BigInt(input.expiresAt ?? 0),
    revoked: false,
    mandateHash: input.mandateHash ? bytes32(input.mandateHash, "mandateHash") : ZERO_HASH,
  };
  const { txHash } = await o.chain.send("issuer", {
    to: o.chain.addresses().kyaRegistry,
    data: encodeFunctionData({ abi: KYARegistryAbi, functionName: "register", args: [account, agent] }),
    description: "KYARegistry.register(account, agent) by the KYA issuer",
  });
  // The HCS-14 profile is published as the AgentRegistered audit message (same shape as `publishProfile`).
  const event = await record(o, {
    type: "AgentRegistered",
    agentUaid: uaid,
    name: input.name,
    role: input.role,
    accountId: input.accountId,
    evmAddress: account,
    network: o.config.x402Network,
    profileVersion: 1,
    level: input.level,
    txHash,
    hashscan: txLink(txHash),
    registeredBy: actor(caller).agent,
    jti: caller.jti,
  });
  return {
    uaid,
    account,
    role: input.role,
    level: input.level,
    txHash,
    hashscan: txLink(txHash),
    hcsSeq: typeof event.hcsSeq === "number" ? event.hcsSeq : null,
  };
}
