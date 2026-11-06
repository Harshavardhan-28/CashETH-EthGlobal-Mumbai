import type { Env } from "@casheth/shared";
import { Client, PrivateKey } from "@hiero-ledger/sdk";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const hederaTestnet: Chain = defineChain({
  id: 296,
  name: "Hedera Testnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet.hashio.io/api"] } },
  blockExplorers: { default: { name: "HashScan", url: "https://hashscan.io/testnet" } },
  testnet: true,
});

/** Hiero SDK client for `env.HEDERA_NETWORK`, paying with the operator (or the given ECDSA account). */
export function hieroClient(
  env: Env,
  operator: { accountId: string; privateKey: string } = {
    accountId: env.HEDERA_OPERATOR_ID,
    privateKey: env.HEDERA_OPERATOR_KEY,
  },
): Client {
  return Client.forName(env.HEDERA_NETWORK).setOperator(
    operator.accountId,
    PrivateKey.fromStringECDSA(operator.privateKey),
  );
}

/** viem clients on chain 296 over `env.HEDERA_JSON_RPC_URL`; a wallet client only when a key is given. */
export function evmClients(
  env: Env,
  privateKey?: Hex,
): { public: PublicClient; wallet?: WalletClient; chain: Chain } {
  const chain = hederaTestnet;
  // Hashio regularly takes longer than viem's 10 s default to answer eth_sendRawTransaction and answers
  // 502 now and then; viem resends the same signed transaction, so retrying never double-sends.
  const transport = http(env.HEDERA_JSON_RPC_URL, { timeout: 60_000, retryCount: 5, retryDelay: 1_000 });
  return {
    public: createPublicClient({ chain, transport }),
    wallet: privateKey
      ? createWalletClient({ account: privateKeyToAccount(privateKey), chain, transport })
      : undefined,
    chain,
  };
}
