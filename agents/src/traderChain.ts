/** The trader's chain access on Hedera testnet: the operator's wallet, the `CashEthTaker` and the SwapVM router. */
import { BASE_FEE_BPS, buildBaseYieldOrder, type Order } from "@casheth/aqua";
import { CashEthSwapVMRouterAbi, CashEthTakerAbi } from "@casheth/shared";
import {
  erc20Abi,
  keccak256,
  parseEventLogs,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";
import type { BaseStrategy, TraderChain } from "./trader.js";

/** Fixed gas limit: Hedera's gas estimation does not model the HTS calls inside the swap. */
const FILL_GAS = 4_000_000n;

const RECEIPT_TIMEOUT_MS = 600_000;

export interface TraderChainClients {
  public: PublicClient;
  /** The operator, who owns the taker contract. */
  wallet: WalletClient<Transport, Chain, Account>;
}

export interface TraderDeployment {
  orderBuilder: Address;
  swapRouter: Address;
  taker: Address;
  usdc: Address;
  tUsdt: Address;
}

export function createTraderChain(clients: TraderChainClients, deployment: TraderDeployment): TraderChain {
  const { public: reader, wallet } = clients;
  const operator = wallet.account.address;

  async function send(request: Record<string, unknown>): Promise<{ txHash: Hex; receipt: TransactionReceipt }> {
    const txHash = await wallet.writeContract({ account: wallet.account, chain: wallet.chain, ...request } as never);
    // Hashio can take minutes to serve a receipt; a short wait would report a landed transaction as failed.
    const receipt = await reader.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS });
    if (receipt.status !== "success") throw new Error(`transaction ${txHash} reverted`);
    return { txHash, receipt };
  }

  return {
    async orderOf(strategy: BaseStrategy): Promise<Order> {
      const { order, strategy: bytes } = await buildBaseYieldOrder(reader, deployment.orderBuilder, {
        maker: strategy.maker,
        usdc: deployment.usdc,
        tUsdt: deployment.tUsdt,
        feeBps: BASE_FEE_BPS,
        salt: strategy.salt,
      });
      if (keccak256(bytes) !== strategy.strategyHash) {
        throw new Error(`rebuilt order of ${strategy.lender} base has hash ${keccak256(bytes)}, strategies.json records ${strategy.strategyHash}`);
      }
      return order;
    },

    async quoteOut(order, amount, takerData) {
      // `quote` is nonpayable (it runs the strategy's hooks), so it is simulated rather than read.
      const { result } = await reader.simulateContract({
        address: deployment.swapRouter,
        abi: CashEthSwapVMRouterAbi,
        functionName: "quote",
        args: [order, amount, takerData],
        account: deployment.taker,
      });
      return result[1];
    },

    async fund(token, amount) {
      await send({ address: token, abi: erc20Abi, functionName: "transfer", args: [deployment.taker, amount] });
    },

    async fill(order, amount, takerData) {
      const { txHash, receipt } = await send({
        address: deployment.taker,
        abi: CashEthTakerAbi,
        functionName: "fill",
        args: [order, amount, takerData],
        gas: FILL_GAS,
      });
      const [filled] = parseEventLogs({ abi: CashEthTakerAbi, logs: receipt.logs, eventName: "Filled" });
      if (!filled) throw new Error(`fill ${txHash} emitted no Filled event`);
      return { txHash, amountIn: filled.args.amountIn, amountOut: filled.args.amountOut };
    },

    async sweep(token) {
      await send({ address: deployment.taker, abi: CashEthTakerAbi, functionName: "sweep", args: [token, operator] });
    },
  };
}
