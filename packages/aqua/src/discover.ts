/**
 * Open-strategy discovery from Aqua's `Shipped` / `Docked` logs (decoded with `@1inch/aqua-sdk`), enriched with
 * the live Aqua virtual balances and the maker's real USDC balance and allowance.
 */
import { DockedEvent, ShippedEvent } from "@1inch/aqua-sdk";
import { AquaRouterAbi } from "@casheth/shared";
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeAbiParameters,
  erc20Abi,
  getAddress,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import { decodeBaseYieldOrder, decodeLenderOrder } from "./orderBuilder.js";
import { revertReason } from "./solver.js";
import type { AquaAddresses, LenderStrategy, Order } from "./types.js";

/** Hashio (Hedera JSON-RPC relay) rejects `eth_getLogs` ranges wider than this. */
export const LOG_CHUNK_BLOCKS = 1_000n;

const ORDER_PARAMS = [
  {
    type: "tuple",
    components: [
      { name: "maker", type: "address" },
      { name: "traits", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
  },
] as const;

/** `strategy = abi.encode(order)` (see `CashEthOrderBuilder`). */
export function decodeStrategy(strategy: Hex): Order {
  const [o] = decodeAbiParameters(ORDER_PARAMS, strategy);
  return { maker: getAddress(o.maker), traits: o.traits, data: o.data };
}

const LIFECYCLE_EVENTS = AquaRouterAbi.filter(
  (e): e is Extract<(typeof AquaRouterAbi)[number], { type: "event" }> =>
    e.type === "event" && (e.name === "Shipped" || e.name === "Docked"),
);

const SHIPPED = ShippedEvent.TOPIC.toString().toLowerCase();
const DOCKED = DockedEvent.TOPIC.toString().toLowerCase();

type Reader = Pick<PublicClient, "getBlockNumber" | "getLogs" | "readContract">;

/** Aqua logs in `[from, to]`, fetched in ranges of at most `LOG_CHUNK_BLOCKS` blocks, in chain order. */
async function aquaLogs(client: Reader, aqua: Address, from: bigint, to: bigint): Promise<Log[]> {
  const out: Log[] = [];
  for (let start = from; start <= to; start += LOG_CHUNK_BLOCKS) {
    const end = start + LOG_CHUNK_BLOCKS - 1n < to ? start + LOG_CHUNK_BLOCKS - 1n : to;
    const logs = await client.getLogs({ address: aqua, events: LIFECYCLE_EVENTS, fromBlock: start, toBlock: end });
    out.push(...logs);
  }
  return out;
}

type Shipped = { maker: Address; strategyHash: Hex; strategy: Hex };

/** Strategies shipped to `app` and not docked since, keyed by `maker:hash`, in shipping order. */
function openFromLogs(logs: Log[], app: Address): Shipped[] {
  const open = new Map<string, Shipped>();
  const key = (maker: Address, hash: Hex) => `${maker}:${hash.toLowerCase()}`;
  for (const log of logs) {
    const topic = log.topics[0]?.toLowerCase();
    if (topic !== SHIPPED && topic !== DOCKED) continue;
    const raw = { data: log.data, topics: log.topics as [Hex, ...Hex[]] };
    if (topic === SHIPPED) {
      const ev = ShippedEvent.fromLog(raw);
      if (getAddress(ev.app.toString()) !== app) continue;
      const maker = getAddress(ev.maker.toString());
      const strategyHash = ev.strategyHash.toString();
      open.set(key(maker, strategyHash), { maker, strategyHash, strategy: ev.strategy.toString() });
    } else {
      const ev = DockedEvent.fromLog(raw);
      if (getAddress(ev.app.toString()) !== app) continue;
      open.delete(key(getAddress(ev.maker.toString()), ev.strategyHash.toString()));
    }
  }
  return [...open.values()];
}

/** Whether a failed eth_call reverted (as opposed to a transport or RPC failure). */
function isRevert(err: unknown): boolean {
  return err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError) !== null;
}

async function classify(
  client: Reader,
  addrs: Pick<AquaAddresses, "orderBuilder" | "usdc" | "rcn" | "tUsdt">,
  order: Order,
): Promise<Pick<LenderStrategy, "kind" | "args" | "feeBps" | "salt" | "tokens"> | undefined> {
  const pair = (a: Address, b: Address) => new Set([getAddress(a), getAddress(b)]);
  const same = (x: Set<Address>, y: Set<Address>) => x.size === y.size && [...x].every((v) => y.has(v));
  try {
    const d = await decodeLenderOrder(client, addrs.orderBuilder, order);
    if (!same(pair(d.tokenA, d.tokenB), pair(addrs.usdc, addrs.rcn))) return undefined;
    return { kind: "credit", args: d.args, salt: d.salt, tokens: [addrs.usdc, addrs.rcn] };
  } catch (err) {
    if (!isRevert(err)) throw err; // NotLenderOrder: try base yield
  }
  if (!addrs.tUsdt) return undefined;
  try {
    const d = await decodeBaseYieldOrder(client, addrs.orderBuilder, order);
    if (!same(pair(d.tokenA, d.tokenB), pair(addrs.usdc, addrs.tUsdt))) return undefined;
    return { kind: "base", feeBps: d.feeBps, salt: d.salt, tokens: [addrs.usdc, addrs.tUsdt] };
  } catch (err) {
    if (!isRevert(err)) throw err; // NotBaseYieldOrder: not ours
    return undefined;
  }
}

/** A shipped strategy discovery left out, and why. */
export type DiscoverySkip = { maker: Address; strategyHash: Hex; reason: string };

/** Reasons `discoverStrategies` leaves a `Shipped` strategy out. */
export const DISCOVERY_SKIP = {
  /** The strategy bytes are not `abi.encode(Order)`. */
  MALFORMED_STRATEGY: "MALFORMED_STRATEGY",
  /** The order's maker is not the account that shipped it (someone re-shipped another maker's order). */
  MAKER_MISMATCH: "MAKER_MISMATCH",
  /** Neither a CashETH credit order over (USDC, RCN) nor a base-yield order over (USDC, tUSDT). */
  NOT_CASHETH_ORDER: "NOT_CASHETH_ORDER",
  /** `aqua.safeBalances` reverted (e.g. shipped without both tokens); suffixed with `:<error name>`. */
  BALANCES_REVERTED: "BALANCES_REVERTED",
} as const;

/**
 * Like `listOpenStrategies`, but also returns the shipped strategies it left out. Aqua's `ship` is
 * permissionless and takes arbitrary bytes, so every `Shipped` event is untrusted: malformed strategy bytes,
 * orders whose maker is not the shipper, foreign programs and strategies whose balances cannot be read are
 * skipped and reported per strategy. Transport and RPC failures still throw.
 */
export async function discoverStrategies(
  client: Reader,
  addrs: Pick<AquaAddresses, "aqua" | "swapRouter" | "orderBuilder" | "usdc" | "rcn" | "tUsdt">,
  opts: { fromBlock?: bigint; toBlock?: bigint } = {},
): Promise<{ strategies: LenderStrategy[]; skipped: DiscoverySkip[] }> {
  const to = opts.toBlock ?? (await client.getBlockNumber({ cacheTime: 0 }));
  const logs = await aquaLogs(client, addrs.aqua, opts.fromBlock ?? 0n, to);
  const app = getAddress(addrs.swapRouter);

  const out: LenderStrategy[] = [];
  const skipped: DiscoverySkip[] = [];
  for (const s of openFromLogs(logs, app)) {
    const skip = (reason: string) => skipped.push({ maker: s.maker, strategyHash: s.strategyHash, reason });
    let order: Order;
    try {
      order = decodeStrategy(s.strategy);
    } catch {
      skip(DISCOVERY_SKIP.MALFORMED_STRATEGY);
      continue;
    }
    // Aqua keys balances by the shipper while the router pulls from `order.maker`: they must be the same
    // account, or a copy of a lender's order shipped by someone else would count as that lender's liquidity.
    if (order.maker !== s.maker) {
      skip(DISCOVERY_SKIP.MAKER_MISMATCH);
      continue;
    }
    const kind = await classify(client, addrs, order);
    if (!kind) {
      skip(DISCOVERY_SKIP.NOT_CASHETH_ORDER);
      continue;
    }
    let b0: bigint;
    let b1: bigint;
    try {
      [b0, b1] = await client.readContract({
        address: addrs.aqua,
        abi: AquaRouterAbi,
        functionName: "safeBalances",
        args: [s.maker, app, s.strategyHash, kind.tokens[0], kind.tokens[1]],
      });
    } catch (err) {
      // revertReason rethrows anything that is not a contract revert.
      skip(`${DISCOVERY_SKIP.BALANCES_REVERTED}:${revertReason(err)}`);
      continue;
    }
    const [realUsdc, allowance] = await Promise.all([
      client.readContract({ address: addrs.usdc, abi: erc20Abi, functionName: "balanceOf", args: [s.maker] }),
      client.readContract({ address: addrs.usdc, abi: erc20Abi, functionName: "allowance", args: [s.maker, addrs.aqua] }),
    ]);
    out.push({
      ...kind,
      maker: s.maker,
      strategyHash: s.strategyHash,
      order,
      virtual: { [kind.tokens[0]]: b0, [kind.tokens[1]]: b1 },
      realUsdc,
      allowance,
    });
  }

  const credit = out
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.kind === "credit")
    .sort((x, y) => x.s.args!.aprBps - y.s.args!.aprBps || x.i - y.i)
    .map(({ s }) => s);
  return { strategies: [...credit, ...out.filter((s) => s.kind === "base")], skipped };
}

/**
 * Open CashETH strategies on `addrs.swapRouter`: credit strategies sorted by `aprBps` ascending (ties in
 * shipping order), then base-yield strategies in shipping order. Untrusted or foreign `Shipped` data is
 * skipped; use `discoverStrategies` to also see what was skipped and why.
 * @param opts.fromBlock First block to scan (default 0; pass the deployment block on long chains).
 */
export async function listOpenStrategies(
  client: Reader,
  addrs: Pick<AquaAddresses, "aqua" | "swapRouter" | "orderBuilder" | "usdc" | "rcn" | "tUsdt">,
  opts: { fromBlock?: bigint; toBlock?: bigint } = {},
): Promise<LenderStrategy[]> {
  return (await discoverStrategies(client, addrs, opts)).strategies;
}
