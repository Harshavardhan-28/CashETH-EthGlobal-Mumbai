/**
 * Lender-side writes: exact-amount approvals to Aqua, and `ship` / `dock` calldata from `@1inch/aqua-sdk`
 * (`AquaProtocolContract`) sent with viem.
 */
import { Address as SdkAddress, AquaProtocolContract, HexString, ShippedEvent } from "@1inch/aqua-sdk";
import {
  erc20Abi,
  getAddress,
  publicActions,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type Transport,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { buildBaseYieldOrder, buildLenderOrder } from "./orderBuilder.js";
import type { AquaAddresses, CreditArgs, Order } from "./types.js";

/** A wallet client with an account and a chain (the lender). */
export type LenderWallet = WalletClient<Transport, Chain, Account>;

export type ShipResult = { strategyHash: Hex; txHash: Hex };

async function send(wallet: LenderWallet, tx: { to: Address; data: Hex }): Promise<TransactionReceipt> {
  const client = wallet.extend(publicActions);
  const hash = await wallet.sendTransaction({ account: wallet.account, chain: wallet.chain, to: tx.to, data: tx.data });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
  return receipt;
}

/**
 * Sets the wallet's `token` allowance to Aqua to exactly `amount` (never "max": HTS rejects it). Aqua pulls
 * from the maker's wallet on fills, so the allowance must cover the virtual balances of every open strategy.
 */
export async function approveAquaExact(wallet: LenderWallet, token: Address, aqua: Address, amount: bigint): Promise<Hex> {
  const client = wallet.extend(publicActions);
  const hash = await wallet.writeContract({
    account: wallet.account,
    chain: wallet.chain,
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [aqua, amount],
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`approve ${hash} reverted`);
  return hash;
}

/** Raises the allowance to Aqua by exactly `amount` (current allowance + amount); no-op for 0. */
async function addAquaAllowance(wallet: LenderWallet, token: Address, aqua: Address, amount: bigint): Promise<void> {
  if (amount === 0n) return;
  const current = await wallet.extend(publicActions).readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [wallet.account.address, aqua],
  });
  await approveAquaExact(wallet, token, aqua, current + amount);
}

/** Ships `strategy` to `app` with the given virtual balances; returns the hash from the `Shipped` event. */
export async function shipStrategy(
  wallet: LenderWallet,
  aqua: Address,
  p: { app: Address; strategy: Hex; amountsAndTokens: { token: Address; amount: bigint }[] },
): Promise<ShipResult> {
  const tx = new AquaProtocolContract(new SdkAddress(aqua)).ship({
    app: new SdkAddress(p.app),
    strategy: new HexString(p.strategy),
    amountsAndTokens: p.amountsAndTokens.map(({ token, amount }) => ({ token: new SdkAddress(token), amount })),
  });
  const receipt = await send(wallet, { to: tx.to, data: tx.data });
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(aqua) || log.topics[0] !== ShippedEvent.TOPIC.toString()) continue;
    const ev = ShippedEvent.fromLog({ data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    return { strategyHash: ev.strategyHash.toString(), txHash: receipt.transactionHash };
  }
  throw new Error(`ship ${receipt.transactionHash} emitted no Shipped event`);
}

/** Docks (closes) a strategy: Aqua zeroes its virtual balances for `tokens` (all of the strategy's tokens). */
export async function dockStrategy(
  wallet: LenderWallet,
  aqua: Address,
  p: { app: Address; strategyHash: Hex; tokens: Address[] },
): Promise<{ txHash: Hex }> {
  const tx = new AquaProtocolContract(new SdkAddress(aqua)).dock({
    app: new SdkAddress(p.app),
    strategyHash: new HexString(p.strategyHash),
    tokens: p.tokens.map((t) => new SdkAddress(t)),
  });
  const receipt = await send(wallet, { to: tx.to, data: tx.data });
  return { txHash: receipt.transactionHash };
}

export type ShippedStrategy = ShipResult & { order: Order; strategy: Hex };

/**
 * Builds the wallet's credit-line order on-chain, raises its USDC allowance to Aqua by `usdcAmount` and ships
 * it with tokens `[USDC, RCN]` and amounts `[usdcAmount, 0]` (RCN must be listed for `safeBalances`).
 */
export async function shipLenderStrategy(
  wallet: LenderWallet,
  addrs: Pick<AquaAddresses, "aqua" | "swapRouter" | "orderBuilder" | "usdc" | "rcn">,
  p: { args: CreditArgs; salt: bigint; usdcAmount: bigint },
): Promise<ShippedStrategy> {
  const client = wallet.extend(publicActions);
  const { order, strategy } = await buildLenderOrder(client, addrs.orderBuilder, {
    maker: wallet.account.address,
    rcn: addrs.rcn,
    usdc: addrs.usdc,
    args: p.args,
    salt: p.salt,
  });
  await addAquaAllowance(wallet, addrs.usdc, addrs.aqua, p.usdcAmount);
  const shipped = await shipStrategy(wallet, addrs.aqua, {
    app: addrs.swapRouter,
    strategy,
    amountsAndTokens: [
      { token: addrs.usdc, amount: p.usdcAmount },
      { token: addrs.rcn, amount: 0n },
    ],
  });
  return { ...shipped, order, strategy };
}

/**
 * Builds and ships the wallet's base-yield strategy (constant product on USDC / tUSDT with a flat input fee),
 * raising both allowances to Aqua by exactly the shipped amounts.
 * @param p.feeBps Input fee in basis points (30 = 0.3%).
 */
export async function shipBaseYield(
  wallet: LenderWallet,
  addrs: Pick<AquaAddresses, "aqua" | "swapRouter" | "orderBuilder" | "usdc" | "tUsdt">,
  p: { usdcAmount: bigint; tUsdtAmount: bigint; feeBps: number; salt: bigint },
): Promise<ShippedStrategy> {
  const tUsdt = addrs.tUsdt;
  if (!tUsdt) throw new Error("addresses have no tUsdt: deploy the test stablecoin first");
  const client = wallet.extend(publicActions);
  const { order, strategy } = await buildBaseYieldOrder(client, addrs.orderBuilder, {
    maker: wallet.account.address,
    usdc: addrs.usdc,
    tUsdt,
    feeBps: p.feeBps,
    salt: p.salt,
  });
  await addAquaAllowance(wallet, addrs.usdc, addrs.aqua, p.usdcAmount);
  await addAquaAllowance(wallet, tUsdt, addrs.aqua, p.tUsdtAmount);
  const shipped = await shipStrategy(wallet, addrs.aqua, {
    app: addrs.swapRouter,
    strategy,
    amountsAndTokens: [
      { token: addrs.usdc, amount: p.usdcAmount },
      { token: tUsdt, amount: p.tUsdtAmount },
    ],
  });
  return { ...shipped, order, strategy };
}
