/**
 * `BasicStatsProvider`: the in-process agent and lender statistics behind `GET /agents`, `GET /lenders` and the
 * stats tools, derived from the registries, the facility, the repayment router and Aqua logs. Task 6.5 replaces it
 * with `packages/stats` behind the same `StatsProvider` interface.
 *
 * Definitions (documented in docs/API.md):
 * - score: `scoreReceivable` on the agent's own reputation with a zero-tenor receivable (the base score);
 *   tier: the riskiest-first lender tier whose seller thresholds the agent meets (`LENDER_TIERS`), else `none`.
 * - onTimePct: on-time / (on-time + late + defaults) x 100 from `KYARegistry.reputation`, 0 without history.
 * - receivablesFunded / Repaid / Defaulted: `StateChanged` transitions into Financed / Repaid / Defaulted of
 *   receivables where the agent is seller or buyer; avgDaysToRepay: Financed -> Repaid in days.
 * - spendByMerchant: committed spend (`SpendReserved` joined to `SpendCommitted`) of the worker, or of every
 *   worker on the seller's facilities, by merchant EVM address.
 * - lender capital = wallet USDC + outstanding principal; lent = Σ `PositionOpened.principal` - Σ
 *   `LenderPaid.principal`; idle = wallet USDC; creditFees = Σ `LenderPaid.fee`; baseFees = Σ Aqua `Pushed`
 *   swap inputs into the lender's base strategy (not the ship deposits) x the base fee; baseApr annualises baseFees over the base
 *   strategy's shipped balance since its first swap; boostApr = the credit strategy's aprBps / 100; blendedApr =
 *   (baseApr x idle + boostApr x lent) / capital.
 */
import { CreditFacilityAbi, AquaRouterAbi, ReceivableRegistryAbi, RepaymentRouterAbi } from "@casheth/shared";
import { LENDER_TIERS, type LenderStrategy, type Tier } from "@casheth/aqua";
import { scoreReceivable, type EventStore } from "@casheth/engine";
import { decodeEventLog, getAddress, type Abi, type Address, type Hex } from "viem";
import { ROLE_NAMES, sameAddress, STATE } from "./common.js";
import { tierOfApr } from "./facility.js";
import type {
  AgentDirectoryEntry,
  AgentRoleName,
  AgentStats,
  AquaPort,
  ChainPort,
  LenderYield,
  LogSource,
  RawLog,
  StatsProvider,
} from "./types.js";

const DAY = 86_400;
const YEAR = 365 * DAY;

type Decoded = { name: string; args: Record<string, unknown>; timestamp: number; txHash: Hex };

function decodeAll(abi: Abi, logs: RawLog[]): Decoded[] {
  const out: Decoded[] = [];
  for (const log of logs) {
    try {
      const ev = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      out.push({ name: String(ev.eventName), args: (ev.args ?? {}) as Record<string, unknown>, timestamp: log.timestamp, txHash: log.txHash });
    } catch {
      // not one of this contract's events (or malformed): skip
    }
  }
  return out;
}

/**
 * Input pushed into one strategy by swaps, and the time of the first swap. `Aqua.ship` also emits `Pushed` for the
 * deposits, so the `Pushed` events of the strategy's own `Shipped` transaction are left out: only swap inputs carry fees.
 */
function swapVolume(aqua: Decoded[], maker: Address, strategyHash: Hex): { pushed: bigint; firstSwap: number | undefined } {
  const ofStrategy = (e: Decoded) =>
    sameAddress(String(e.args.maker), maker) && String(e.args.strategyHash).toLowerCase() === strategyHash.toLowerCase();
  const shipTxs = new Set(aqua.filter((e) => e.name === "Shipped" && ofStrategy(e)).map((e) => e.txHash));
  let pushed = 0n;
  let firstSwap: number | undefined;
  for (const e of aqua) {
    if (e.name !== "Pushed" || !ofStrategy(e) || shipTxs.has(e.txHash)) continue;
    pushed += e.args.amount as bigint;
    firstSwap ??= e.timestamp;
  }
  return { pushed, firstSwap };
}

const round =(x: number, digits = 2): number => (Number.isFinite(x) ? Number(x.toFixed(digits)) : 0);

type Snapshot = {
  at: number;
  registry: Decoded[];
  facility: Decoded[];
  router: Decoded[];
  aqua: Decoded[];
  strategies: LenderStrategy[];
};

export type BasicStatsOptions = {
  chain: ChainPort;
  aqua: AquaPort;
  logs: LogSource;
  events: EventStore;
  /** Static agent directory (demo accounts); `AgentRegistered` events from `register_agent` are merged in. */
  directory: () => AgentDirectoryEntry[];
  /** Unix seconds. */
  now: () => number;
  cacheMs?: number;
};

export class BasicStatsProvider implements StatsProvider {
  #latest: Snapshot | undefined;
  #refreshing: Promise<Snapshot> | undefined;
  #snapshotAt = 0;

  constructor(private readonly opts: BasicStatsOptions) {}

  /** Directory entries plus agents registered through `register_agent`, deduplicated by address. */
  agents(): AgentDirectoryEntry[] {
    const byAddress = new Map<string, AgentDirectoryEntry>();
    for (const a of this.opts.directory()) byAddress.set(a.address.toLowerCase(), a);
    for (const e of this.opts.events.list()) {
      if (e.type !== "AgentRegistered" || typeof e.evmAddress !== "string" || typeof e.agentUaid !== "string") continue;
      const role = e.role as AgentRoleName;
      if (!["seller", "buyer", "worker", "lender"].includes(role)) continue;
      byAddress.set(e.evmAddress.toLowerCase(), {
        address: getAddress(e.evmAddress),
        label: typeof e.name === "string" ? e.name : e.evmAddress,
        role,
        uaid: e.agentUaid,
      });
    }
    return [...byAddress.values()];
  }

  /**
   * The current snapshot. A fresh one is reused; a stale one is answered at once while a single background refresh
   * replaces it, so read-API callers never wait on the chain scan except the very first time.
   */
  async #load(): Promise<Snapshot> {
    const cacheMs = this.opts.cacheMs ?? 10_000;
    const stale = Date.now() - this.#snapshotAt >= cacheMs;
    if (!this.#latest) return (this.#refreshing ??= this.#refresh());
    if (stale) this.#refreshing ??= this.#refresh();
    return this.#latest;
  }

  #refresh(): Promise<Snapshot> {
    const started = Date.now();
    return this.#build()
      .then((snapshot) => {
        this.#latest = snapshot;
        this.#snapshotAt = started;
        return snapshot;
      })
      .finally(() => {
        this.#refreshing = undefined;
      });
  }

  async #build(): Promise<Snapshot> {
    const a = this.opts.chain.addresses();
    let aquaAddr: Address | undefined;
    try {
      aquaAddr = this.opts.aqua.addresses().aqua;
    } catch {
      aquaAddr = undefined; // Aqua not deployed yet: no strategies, no base fees
    }
    const [registry, facility, router, aqua, strategies] = await Promise.all([
      this.opts.logs.logs(a.receivableRegistry).then((l) => decodeAll(ReceivableRegistryAbi as Abi, l)),
      this.opts.logs.logs(a.creditFacility).then((l) => decodeAll(CreditFacilityAbi as Abi, l)),
      this.opts.logs.logs(a.repaymentRouter).then((l) => decodeAll(RepaymentRouterAbi as Abi, l)),
      aquaAddr ? this.opts.logs.logs(aquaAddr).then((l) => decodeAll(AquaRouterAbi as Abi, l)) : Promise.resolve([]),
      aquaAddr ? this.opts.aqua.discover().then((d) => d.strategies) : Promise.resolve([] as LenderStrategy[]),
    ]);
    return { at: this.opts.now(), registry, facility, router, aqua, strategies };
  }

  async listAgents(): Promise<AgentStats[]> {
    return Promise.all(this.agents().map((a) => this.agentStats(a.address)));
  }

  async agentStats(address: Address): Promise<AgentStats> {
    const s = await this.#load();
    const entry = this.agents().find((a) => sameAddress(a.address, address));
    const [kya, rep] = await Promise.all([this.opts.chain.kyaAgent(address), this.opts.chain.reputation(address)]);
    const role: AgentRoleName = entry?.role ?? ROLE_NAMES[kya.role as 1 | 2 | 3 | 4] ?? "seller";
    const now = BigInt(s.at);
    const score = scoreReceivable({
      amount: 0n,
      dueDate: now,
      now,
      buyerReputation: rep,
      sellerLevel: kya.level,
      buyerLevel: kya.level,
    }).score;
    const tier =
      (["low", "medium", "high"] as Tier[]).find(
        (t) => rep.onTime >= LENDER_TIERS[t].minSellerOnTime && rep.defaults <= LENDER_TIERS[t].maxSellerDefaults,
      ) ?? "none";
    const history = rep.onTime + rep.late + rep.defaults;

    // Receivables where the agent is a party, and their state transitions.
    const parties = new Map<string, { seller: string; buyer: string }>();
    for (const e of s.registry) {
      if (e.name === "Registered") parties.set(String(e.args.id).toLowerCase(), { seller: String(e.args.seller), buyer: String(e.args.buyer) });
    }
    const mine = new Set(
      [...parties.entries()].filter(([, p]) => sameAddress(p.seller, address) || sameAddress(p.buyer, address)).map(([id]) => id),
    );
    const transitions = new Map<string, Map<number, number>>();
    for (const e of s.registry) {
      if (e.name !== "StateChanged") continue;
      const id = String(e.args.id).toLowerCase();
      if (!mine.has(id)) continue;
      const m = transitions.get(id) ?? new Map<number, number>();
      m.set(Number(e.args.to), e.timestamp);
      transitions.set(id, m);
    }
    const count = (state: number) => [...transitions.values()].filter((m) => m.has(state)).length;
    const repayDays = [...transitions.values()]
      .filter((m) => m.has(STATE.Financed) && m.has(STATE.Repaid))
      .map((m) => (m.get(STATE.Repaid)! - m.get(STATE.Financed)!) / DAY);

    // Committed spend by merchant: the worker's own, or every worker's on the seller's facilities.
    const reserved = new Map<string, { id: string; worker: string; merchant: string; amount: bigint }>();
    for (const e of s.facility) {
      if (e.name === "SpendReserved") {
        reserved.set(String(e.args.spendId).toLowerCase(), {
          id: String(e.args.id).toLowerCase(),
          worker: String(e.args.worker),
          merchant: String(e.args.merchant),
          amount: e.args.amount as bigint,
        });
      }
    }
    const spend = new Map<string, bigint>();
    for (const e of s.facility) {
      if (e.name !== "SpendCommitted") continue;
      const r = reserved.get(String(e.args.spendId).toLowerCase());
      if (!r) continue;
      const seller = parties.get(r.id)?.seller;
      if (!sameAddress(r.worker, address) && !(seller && sameAddress(seller, address))) continue;
      const key = getAddress(r.merchant);
      spend.set(key, (spend.get(key) ?? 0n) + r.amount);
    }

    let lenderReturnPct = 0;
    if (role === "lender") {
      const y = await this.#lenderYield(address, s);
      const capital = Number(y.capital);
      lenderReturnPct = capital > 0 ? round(((Number(y.creditFees) + Number(y.baseFees)) / capital) * 100) : 0;
    }

    return {
      address: getAddress(address),
      uaid: entry?.uaid ?? "",
      role,
      label: entry?.label ?? getAddress(address),
      level: kya.level,
      score,
      tier,
      onTimePct: history > 0 ? round((rep.onTime / history) * 100, 1) : 0,
      receivablesFunded: count(STATE.Financed),
      receivablesRepaid: count(STATE.Repaid),
      receivablesDefaulted: count(STATE.Defaulted),
      avgDaysToRepay: repayDays.length ? round(repayDays.reduce((x, y) => x + y, 0) / repayDays.length, 1) : 0,
      spendByMerchant: Object.fromEntries([...spend.entries()].map(([k, v]) => [k, v.toString()])),
      lenderReturnPct,
    };
  }

  async listLenders(): Promise<LenderYield[]> {
    const s = await this.#load();
    const makers = new Map<string, Address>();
    for (const a of this.agents()) if (a.role === "lender") makers.set(a.address.toLowerCase(), a.address);
    for (const st of s.strategies) makers.set(st.maker.toLowerCase(), st.maker);
    return Promise.all([...makers.values()].map((m) => this.#lenderYield(m, s)));
  }

  async lenderYield(address: Address): Promise<LenderYield> {
    return this.#lenderYield(address, await this.#load());
  }

  async #lenderYield(address: Address, s: Snapshot): Promise<LenderYield> {
    const label = this.agents().find((a) => sameAddress(a.address, address))?.label ?? getAddress(address);
    const own = s.strategies.filter((x) => sameAddress(x.maker, address));
    const credit = own.filter((x) => x.kind === "credit" && x.args).sort((a, b) => a.args!.aprBps - b.args!.aprBps)[0];
    const base = own.find((x) => x.kind === "base");

    let opened = 0n;
    for (const e of s.facility) if (e.name === "PositionOpened" && sameAddress(String(e.args.maker), address)) opened += e.args.principal as bigint;
    let repaidPrincipal = 0n;
    let creditFees = 0n;
    for (const e of s.router) {
      if (e.name !== "LenderPaid" || !sameAddress(String(e.args.maker), address)) continue;
      repaidPrincipal += e.args.principal as bigint;
      creditFees += e.args.fee as bigint;
    }
    const lent = opened > repaidPrincipal ? opened - repaidPrincipal : 0n;

    const feeBps = base?.feeBps ?? 30;
    const { pushed, firstSwap } = base ? swapVolume(s.aqua, address, base.strategyHash) : { pushed: 0n, firstSwap: undefined };
    const baseFees = (pushed * BigInt(Math.round(feeBps * 100))) / 1_000_000n;

    const idle = await this.opts.chain.usdcBalance(address).catch(() => 0n);
    const capital = idle + lent;
    const baseCapital = base ? Object.values(base.virtual).reduce((x, y) => x + y, 0n) : 0n;
    const elapsed = firstSwap !== undefined ? s.at - firstSwap : 0;
    const baseApr = baseCapital > 0n && elapsed > 0 ? round((Number(baseFees) / Number(baseCapital)) * (YEAR / elapsed) * 100) : 0;
    const boostApr = credit ? credit.args!.aprBps / 100 : 0;
    const blendedApr = capital > 0n ? round((baseApr * Number(idle) + boostApr * Number(lent)) / Number(capital)) : 0;
    const tier = credit ? tierOfApr(credit.args!.aprBps) : "none";

    return {
      address: getAddress(address),
      label,
      tier,
      capital: capital.toString(),
      lent: lent.toString(),
      idle: idle.toString(),
      baseFees: baseFees.toString(),
      creditFees: creditFees.toString(),
      baseApr,
      boostApr,
      blendedApr,
      strategies: { ...(credit ? { credit: credit.strategyHash } : {}), ...(base ? { base: base.strategyHash } : {}) },
    };
  }
}
