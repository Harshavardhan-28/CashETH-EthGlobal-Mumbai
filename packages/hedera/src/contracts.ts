import { KYARegistryAbi, ReceivableRegistryAbi, type Addresses, type Env } from "@casheth/shared";
import {
  getContract,
  type Address,
  type Chain,
  type GetContractReturnType,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { evmClients } from "./client.js";

export interface ContractsOptions {
  addresses: Addresses;
  /** Signs writes when given; otherwise the instances are read-only. */
  walletKey?: Hex;
}

export type ReadClient = { public: PublicClient };
export type WriteClient = { public: PublicClient; wallet: WalletClient };

export interface CoreContracts<C extends ReadClient | WriteClient> {
  clients: C & { chain: Chain };
  kya: GetContractReturnType<typeof KYARegistryAbi, C>;
  registry: GetContractReturnType<typeof ReceivableRegistryAbi, C>;
}

function required(addresses: Addresses, key: "kyaRegistry" | "receivableRegistry"): Address {
  const value = addresses[key];
  if (!value) throw new Error(`addresses.json has no ${key}: deploy it first`);
  return value;
}

/** Typed viem instances of the core contracts, bound to the public client and (with `walletKey`) a wallet. */
export function contracts(env: Env, options: ContractsOptions & { walletKey: Hex }): CoreContracts<WriteClient>;
export function contracts(env: Env, options: ContractsOptions): CoreContracts<ReadClient>;
export function contracts(env: Env, { addresses, walletKey }: ContractsOptions): CoreContracts<ReadClient | WriteClient> {
  const { public: pub, wallet, chain } = evmClients(env, walletKey);
  const client: ReadClient | WriteClient = wallet ? { public: pub, wallet } : { public: pub };
  return {
    clients: { ...client, chain },
    kya: getContract({ address: required(addresses, "kyaRegistry"), abi: KYARegistryAbi, client }),
    registry: getContract({ address: required(addresses, "receivableRegistry"), abi: ReceivableRegistryAbi, client }),
  } as CoreContracts<ReadClient | WriteClient>;
}
