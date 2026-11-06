import { hashscan, type Env } from "@casheth/shared";

export interface MirrorAccount {
  account: string;
  evm_address: string;
  key: { _type: string; key: string } | null;
  created_timestamp?: string;
  balance: {
    balance: number;
    timestamp: string;
    tokens: { token_id: string; balance: number }[];
  };
}

export interface MirrorTokenRelationship {
  token_id: string;
  balance: number;
  created_timestamp: string;
  automatic_association: boolean;
}

export interface MirrorTopicMessage {
  consensus_timestamp: string;
  message: string;
  sequence_number: number;
  topic_id: string;
  chunk_info?: {
    initial_transaction_id?: { account_id: string; transaction_valid_start: string } | null;
  } | null;
}

export interface WaitForOptions {
  attempts?: number;
  delayMs?: number;
}

/** Accepts the mirror URL with or without the `/api/v1` suffix. */
function apiBase(env: Env): string {
  return `${env.HEDERA_MIRROR_NODE_URL.replace(/\/+$/, "").replace(/\/api\/v1$/, "")}/api/v1`;
}

async function get<T>(env: Env, path: string): Promise<T> {
  const url = `${apiBase(env)}${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Mirror node ${res.status} for ${url}`);
  return (await res.json()) as T;
}

/** Mirror-node ids look like `0.0.x-seconds-nanos`; the SDK and HashScan use `0.0.x@seconds.nanos`. */
function toSdkTransactionId(mirrorId: string): string {
  const [account, seconds, nanos] = mirrorId.split("-");
  return `${account}@${seconds}.${nanos}`;
}

export const mirror = {
  account(env: Env, idOrEvm: string): Promise<MirrorAccount> {
    return get<MirrorAccount>(env, `/accounts/${idOrEvm}`);
  },

  /** Balance in the token's smallest unit; 0n when the account holds none or is not associated. */
  async tokenBalance(env: Env, accountId: string, tokenId: string): Promise<bigint> {
    const body = await get<{ tokens: { token_id: string; balance: number }[] }>(
      env,
      `/accounts/${accountId}/tokens?token.id=${tokenId}`,
    );
    const entry = body.tokens.find((t) => t.token_id === tokenId);
    return BigInt(entry?.balance ?? 0);
  },

  /** The account's relationship with `tokenId` (present once associated), or undefined. */
  async tokenRelationship(
    env: Env,
    accountId: string,
    tokenId: string,
  ): Promise<MirrorTokenRelationship | undefined> {
    const body = await get<{ tokens: MirrorTokenRelationship[] }>(
      env,
      `/accounts/${accountId}/tokens?token.id=${tokenId}`,
    );
    return body.tokens.find((t) => t.token_id === tokenId);
  },

  /** SDK-form id (`0.0.x@s.n`) of the transaction that reached consensus at `timestamp`. */
  async transactionIdAt(env: Env, timestamp: string): Promise<string> {
    const { transactions } = await get<{ transactions: { transaction_id: string }[] }>(
      env,
      `/transactions?timestamp=${timestamp}`,
    );
    const tx = transactions[0];
    if (!tx) throw new Error(`No transaction at consensus timestamp ${timestamp}`);
    return toSdkTransactionId(tx.transaction_id);
  },

  /** The block the contract was created in (0 when the mirror does not report its creation time): where log scans start. */
  async creationBlock(env: Env, idOrEvm: string): Promise<bigint> {
    const { created_timestamp } = await get<{ created_timestamp?: string }>(env, `/contracts/${idOrEvm}`);
    if (!created_timestamp) return 0n;
    const { blocks } = await get<{ blocks: { number: number }[] }>(env, `/blocks?timestamp=lte:${created_timestamp}&order=desc&limit=1`);
    return BigInt(blocks[0]?.number ?? 0);
  },

  /** Contract entity id (`0.0.x`) and EVM address for a contract id or EVM address. */
  contract(env: Env, idOrEvm: string): Promise<{ contract_id?: string; evm_address?: string }> {
    return get(env, `/contracts/${idOrEvm}`);
  },

  /**
   * Resolves an EVM transaction hash to its Hedera transaction id. `/contracts/results/{hash}`
   * does not expose the transaction id, so its consensus timestamp is looked up in `/transactions`.
   */
  async txByHash(
    env: Env,
    evmHash: string,
  ): Promise<{ transactionId: string; status: string; hashscanUrl: string }> {
    const result = await get<{ result: string; timestamp: string }>(
      env,
      `/contracts/results/${evmHash}`,
    );
    const transactionId = await mirror.transactionIdAt(env, result.timestamp);
    return { transactionId, status: result.result, hashscanUrl: hashscan.tx(transactionId) };
  },

  /** Messages on an HCS topic (`message` is base64), newest first by default. */
  async topicMessages(
    env: Env,
    topicId: string,
    { limit = 25, order = "desc" }: { limit?: number; order?: "asc" | "desc" } = {},
  ): Promise<MirrorTopicMessage[]> {
    const body = await get<{ messages: MirrorTopicMessage[] }>(
      env,
      `/topics/${topicId}/messages?limit=${limit}&order=${order}`,
    );
    return body.messages;
  },

  /**
   * Mirror data lags consensus by a few seconds. Calls `fn` until it returns a value other than
   * undefined/null/false (errors also count as "not yet"); throws after `attempts` tries.
   */
  async waitFor<T>(
    fn: () => Promise<T | undefined | null | false>,
    { attempts = 10, delayMs = 2000 }: WaitForOptions = {},
  ): Promise<T> {
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const value = await fn();
        if (value !== undefined && value !== null && value !== false) return value;
      } catch (error) {
        lastError = error;
      }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error(`mirror.waitFor gave up after ${attempts} attempts`, { cause: lastError });
  },
};
