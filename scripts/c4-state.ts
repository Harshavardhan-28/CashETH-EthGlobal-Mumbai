/**
 * The C4 record, `deployments/testnet/c4.json`, shared by scripts/c4-deploy-and-wire.ts (deploy, wiring,
 * tUSDT mints, verification) and scripts/c4-register.ts (lender D, first registration, HCS events, NFT,
 * duplicate rejection). Each step is skipped on a re-run when its section is present.
 */
import { existsSync } from "node:fs";
import { TestStablecoinAbi } from "@casheth/shared";
import type { Address, Hex } from "viem";
import { pub, readJson, ROOT, send, writeJson, type Deployed, type Gas, type TxRecord } from "./spikes/lib.js";

export const C4_FILE = `${ROOT}deployments/testnet/c4.json`;

export type Step = TxRecord & { gas: Gas };
export type DeployedAt = Deployed & { block: number };

export interface Mint {
  label: string;
  to: Address;
  units: string;
  tx?: Step; // absent when the recipient already held the target
}

export interface Rejection {
  expected: string;
  tx: Step;
  status: string;
  errorMessage: Hex;
  selector: Hex;
  decoded: string;
}

export interface C4State {
  network: "testnet";
  chainId: 296;
  operator: Address;
  deploy?: {
    aqua: DeployedAt;
    swapRouter: DeployedAt;
    orderBuilder: DeployedAt;
    tUsdt: DeployedAt;
    taker: DeployedAt;
  };
  wiring?: { rcn: Step; facility: Step };
  tUsdtMints?: Mint[];
  verified?: Record<string, string>;
  lenderD?: {
    accountId: string;
    evm: Address;
    created?: string; // Hedera transaction id
    usdcAssociation?: string;
    usdcFunding?: string;
    kya?: Step;
    tUsdtMint?: Mint;
  };
  registration?: {
    confirmation: Record<string, string>;
    signature: Hex;
    digest: Hex;
    receivableId: Hex;
    submitter: Address;
    tx?: Step;
    onChain?: Record<string, string>;
  };
  audit?: {
    receivableConfirmed?: { seq: number; txId: string; hashscan: string; prevSeq: number };
    nftMinted?: { seq: number; txId: string; hashscan: string; prevSeq: number };
  };
  nft?: { tokenId: string; serial: number; metadata: string; txId: string; hashscan: string };
  duplicate?: {
    confirmation: Record<string, string>;
    simulation: { duplicate: string; freshRefControl: string };
    rejection: Rejection;
  };
}

export function readC4(operator: Address): C4State {
  return existsSync(C4_FILE) ? readJson<C4State>(C4_FILE) : { network: "testnet", chainId: 296, operator };
}

export function writeC4(state: C4State): void {
  writeJson(C4_FILE, state);
}

/** One tUSDT (6 decimals). */
export const TUSDT_UNIT = 1_000_000n;

/** Mints tUSDT to `to` up to `target` (nothing when it already holds that much); returns the record. */
export async function mintTo(tUsdt: Address, label: string, to: Address, target: bigint): Promise<Mint> {
  const balance = await pub.readContract({ address: tUsdt, abi: TestStablecoinAbi, functionName: "balanceOf", args: [to] });
  if (balance >= target) {
    console.log(`  ${label}: already holds ${balance} tUSDT units`);
    return { label, to, units: "0" };
  }
  const units = target - balance;
  const tx = await send(`TestStablecoin.mint(${label}, ${units})`, {
    address: tUsdt,
    abi: TestStablecoinAbi,
    functionName: "mint",
    args: [to, units],
  });
  return { label, to, units: units.toString(), tx };
}
