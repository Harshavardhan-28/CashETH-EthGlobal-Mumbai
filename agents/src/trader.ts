/**
 * Trader agent: scripted swap volume through each lender's base-yield strategy, so the fee income the lenders earn
 * is real and measurable on Hedera testnet. It is labelled "scripted volume" wherever it is shown: the base yield
 * is variable, never guaranteed.
 *
 * Per strategy it does `roundTrips` round trips: sell `amount` USDC for tUSDT, then sell exactly what that bought
 * back for USDC. Each leg funds the `CashEthTaker` from the operator, fills the strategy exact-in, and sweeps the
 * proceeds back to the operator. A leg's minimum output is its own quote, so a price move between quote and fill
 * reverts instead of trading at a worse price.
 */
import { baseTakerData, type Order } from "@casheth/aqua";
import { hashscan } from "@casheth/shared";
import type { Address, Hex } from "viem";
import { consoleLog, type Log } from "./log.js";

export type Direction = "usdc->tusdt" | "tusdt->usdc";

export interface TradeRecord {
  /** Lender whose base-yield strategy was filled: A, B or C. */
  lender: string;
  strategyHash: Hex;
  direction: Direction;
  /** Token base units sold and bought (both tokens have 6 decimals). */
  amountIn: bigint;
  amountOut: bigint;
  txHash: Hex;
  link: string;
}

/** A base-yield strategy as `deployments/testnet/strategies.json` records it. */
export interface BaseStrategy {
  lender: string;
  strategyHash: Hex;
  maker: Address;
  salt: bigint;
}

/** What the trader needs from the chain; `createTraderChain` is the testnet implementation. */
export interface TraderChain {
  /** The strategy's order, rebuilt from its maker and salt and checked against its recorded hash. */
  orderOf(strategy: BaseStrategy): Promise<Order>;
  /** The output of an exact-in fill of `amount`, quoted from the taker contract. */
  quoteOut(order: Order, amount: bigint, takerData: Hex): Promise<bigint>;
  /** Moves `amount` of `token` from the operator to the taker contract. */
  fund(token: Address, amount: bigint): Promise<void>;
  fill(order: Order, amount: bigint, takerData: Hex): Promise<{ txHash: Hex; amountIn: bigint; amountOut: bigint }>;
  /** Returns the taker contract's whole balance of `token` to the operator. */
  sweep(token: Address): Promise<void>;
}

export interface TraderOptions {
  chain: TraderChain;
  strategies: BaseStrategy[];
  tokens: { usdc: Address; tUsdt: Address };
  /** USDC base units sold in the first leg of each round trip; default 0.2 USDC. */
  amount?: bigint;
  /** Round trips per strategy; default 3. */
  roundTrips?: number;
  log?: Log;
  /** Called with each swap as soon as its fill is confirmed. */
  onTrade?: (record: TradeRecord) => void;
}

const DEFAULT_AMOUNT = 200_000n;
const DEFAULT_ROUND_TRIPS = 3;

type StrategiesFile = { strategies?: { lender?: string; kind?: string; strategyHash?: Hex; maker?: Address; salt?: string }[] };

/** The base-yield strategies of a `strategies.json`, in file order. */
export function baseStrategies(file: StrategiesFile): BaseStrategy[] {
  if (!Array.isArray(file.strategies)) throw new Error("strategies.json has no strategies list");
  return file.strategies
    .filter((s) => s.kind === "base")
    .map(({ lender, strategyHash, maker, salt }) => {
      if (!lender || !strategyHash) throw new Error("a base strategy needs a lender and a strategyHash");
      if (!maker) throw new Error(`base strategy ${strategyHash} has no maker`);
      if (salt === undefined) throw new Error(`base strategy ${strategyHash} has no salt`);
      return { lender, strategyHash, maker, salt: BigInt(salt) };
    });
}

/** The tokens of an Aqua pair are sorted by address; the lower one is token A. */
const isAToB = (tokenIn: Address, tokenOut: Address): boolean => BigInt(tokenIn) < BigInt(tokenOut);

interface Leg {
  strategy: BaseStrategy;
  order: Order;
  direction: Direction;
  tokenIn: Address;
  tokenOut: Address;
  amount: bigint;
}

/** The leg that failed: which lender's strategy, which way, and how much was being sold. */
export type FailedLeg = Pick<TradeRecord, "lender" | "strategyHash" | "direction" | "amountIn">;

/** One-line reason: viem's `shortMessage` when there is one (its `message` carries the whole request and response body). */
function briefReason(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const short = (error as { shortMessage?: unknown }).shortMessage;
  return typeof short === "string" ? short : error.message;
}

/** A leg did not complete. `cause` is the underlying error; `sweepError` is set when returning the input also failed. */
export class TradeError extends Error {
  readonly lender: string;
  readonly strategyHash: Hex;
  readonly direction: Direction;
  readonly amountIn: bigint;
  readonly sweepError?: unknown;

  constructor(leg: FailedLeg, cause: unknown, sweepError?: unknown) {
    const stuck = sweepError === undefined ? "" : ` (returning the input to the operator also failed: ${briefReason(sweepError)})`;
    super(`lender ${leg.lender} ${leg.direction} ${leg.amountIn} (strategy ${leg.strategyHash}) failed: ${briefReason(cause)}${stuck}`, { cause });
    this.name = "TradeError";
    this.lender = leg.lender;
    this.strategyHash = leg.strategyHash;
    this.direction = leg.direction;
    this.amountIn = leg.amountIn;
    this.sweepError = sweepError;
  }
}

/** Sends the taker's `token` back to the operator; resolves with the error instead of throwing it. */
async function returnToOperator(chain: TraderChain, token: Address): Promise<unknown> {
  try {
    await chain.sweep(token);
    return undefined;
  } catch (error) {
    return error;
  }
}

/** One swap. Reports the record as soon as the fill is confirmed, before the output is swept back. */
async function trade(chain: TraderChain, leg: Leg, report: (record: TradeRecord) => void): Promise<TradeRecord> {
  const aToB = isAToB(leg.tokenIn, leg.tokenOut);
  let funded = false;
  let filled;
  try {
    const quoted = await chain.quoteOut(leg.order, leg.amount, baseTakerData({ isAToB: aToB }));
    await chain.fund(leg.tokenIn, leg.amount);
    funded = true;
    filled = await chain.fill(leg.order, leg.amount, baseTakerData({ isAToB: aToB, threshold: quoted }));
  } catch (error) {
    const sweepError = funded ? await returnToOperator(chain, leg.tokenIn) : undefined;
    const { strategy, direction, amount } = leg;
    throw new TradeError({ lender: strategy.lender, strategyHash: strategy.strategyHash, direction, amountIn: amount }, error, sweepError);
  }
  const record: TradeRecord = {
    lender: leg.strategy.lender,
    strategyHash: leg.strategy.strategyHash,
    direction: leg.direction,
    amountIn: filled.amountIn,
    amountOut: filled.amountOut,
    txHash: filled.txHash,
    link: hashscan.tx(filled.txHash),
  };
  report(record);
  await chain.sweep(leg.tokenOut);
  return record;
}

function describeTrade(r: TradeRecord): string {
  return `${r.lender} ${r.direction} ${r.amountIn} -> ${r.amountOut} ${r.link}`;
}

/**
 * Runs the scripted volume against every strategy in turn and returns one record per swap. Stops at the first
 * failed leg with a `TradeError`; the legs confirmed before it were already passed to `onTrade`.
 */
export async function runTrader(opts: TraderOptions): Promise<TradeRecord[]> {
  const { chain, strategies, tokens, amount = DEFAULT_AMOUNT, roundTrips = DEFAULT_ROUND_TRIPS, log = consoleLog, onTrade } = opts;
  if (amount <= 0n) throw new Error(`amount must be positive, got ${amount}`);
  if (!Number.isInteger(roundTrips) || roundTrips <= 0) throw new Error(`roundTrips must be a positive integer, got ${roundTrips}`);

  const records: TradeRecord[] = [];
  const report = (record: TradeRecord) => {
    log(describeTrade(record));
    records.push(record);
    onTrade?.(record);
  };
  for (const strategy of strategies) {
    const order = await chain.orderOf(strategy);
    for (let i = 0; i < roundTrips; i++) {
      const sell = await trade(chain, { strategy, order, direction: "usdc->tusdt", tokenIn: tokens.usdc, tokenOut: tokens.tUsdt, amount }, report);
      await trade(chain, { strategy, order, direction: "tusdt->usdc", tokenIn: tokens.tUsdt, tokenOut: tokens.usdc, amount: sell.amountOut }, report);
    }
  }
  return records;
}

/** Like `runTrader`, but a failure does not discard the swaps confirmed before it: they come back with the error. */
export async function collectTrades(opts: Omit<TraderOptions, "onTrade">): Promise<{ records: TradeRecord[]; failure?: unknown }> {
  const records: TradeRecord[] = [];
  try {
    await runTrader({ ...opts, onTrade: (record) => records.push(record) });
    return { records };
  } catch (failure) {
    return { records, failure };
  }
}

/** The content of `deployments/testnet/trades.json`: amounts as decimal strings, plus the failed leg of an aborted run. */
export type TradesFile = ReturnType<typeof serializeTrades>;

export function serializeTrades(records: TradeRecord[], failure?: TradeError) {
  return {
    network: "testnet",
    chainId: 296,
    label: "scripted volume",
    trades: records.map((r) => ({ ...r, amountIn: r.amountIn.toString(), amountOut: r.amountOut.toString() })),
    ...(failure
      ? {
          failure: {
            lender: failure.lender,
            strategyHash: failure.strategyHash,
            direction: failure.direction,
            amountIn: failure.amountIn.toString(),
            error: briefReason(failure.cause),
          },
        }
      : {}),
  };
}
