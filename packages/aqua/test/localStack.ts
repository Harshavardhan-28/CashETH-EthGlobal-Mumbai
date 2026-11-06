/** Shared by the anvil global setup and the anvil-backed tests. */
import { defineChain, type Address, type Chain, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";

export const ANVIL_PORT = 8547;
export const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`;

export const anvilChain: Chain = defineChain({
  id: 31337,
  name: "Anvil (CashETH local stack)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_RPC] } },
  testnet: true,
});

const MNEMONIC = "test test test test test test test test test test test junk";

/** anvil's default funded accounts, by role. */
export const ROLE_INDEX = {
  deployer: 0,
  coordinator: 1,
  seller: 2,
  buyer: 3,
  lenderA: 4,
  lenderB: 5,
  lenderC: 6,
  lenderD: 7,
  workerResearch: 8,
} as const;

export type Role = keyof typeof ROLE_INDEX;

export function account(role: Role) {
  return mnemonicToAccount(MNEMONIC, { addressIndex: ROLE_INDEX[role] });
}

/** What the global setup deployed, as JSON-safe strings. */
export type LocalStack = {
  rpc: string;
  chainId: number;
  aqua: Address;
  usdc: Address;
  tUsdt: Address;
  kyaRegistry: Address;
  receivableRegistry: Address;
  rcn: Address;
  creditFacility: Address;
  repaymentRouter: Address;
  swapRouter: Address;
  orderBuilder: Address;
  mockHss: Address;
  /** First block after the deployment (strategies are shipped later). */
  deployedBlock: string;
  receivable: { id: Hex; seller: Address; buyer: Address; amount: string; dueDate: string };
  /** Where the setup wrote this object as JSON. */
  path: string;
};

declare module "vitest" {
  export interface ProvidedContext {
    localStack: LocalStack;
  }
}
