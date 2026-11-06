/**
 * Spike S4: a contract schedules a call to itself through the Hedera Schedule Service (HIP-1215,
 * system contract 0x16b) and the network executes it; a second schedule is deleted before it fires.
 *
 *   pnpm -r build && FORGE=/path/to/foundry/forge pnpm tsx scripts/spikes/s4-hss.ts
 *
 * Steps (each skipped when `deployments/testnet/spike-s4.json` shows it done):
 *   1. deploy - contracts/script/02_DeploySpikeS4.s.sol through the relay: AlarmProbe, then 5 HBAR
 *               into its `receive()` (the relay cannot estimate a creation that carries value).
 *   2. ring   - probe.schedule(90); poll the mirror node up to 4 minutes for the `Rang` log, the
 *               schedule entity's `executed_timestamp` and the executed transaction; rings() == 1.
 *   3. cancel - probe.schedule(600), then probe.cancel(schedule); the mirror shows `deleted: true`.
 */
import { existsSync } from "node:fs";
import { mirror } from "@casheth/hedera";
import { hashscan } from "@casheth/shared";
import { decodeEventLog, parseAbi, parseEventLogs, type Address, type Hex } from "viem";
import { env, forgeDeploy, mirrorGet, pub, readJson, ROOT, send, wallet, writeJson, type Deployed, type Gas, type TxRecord } from "./lib.js";

const DEPLOY_FILE = `${ROOT}deployments/testnet/spike-s4.json`;
const HSS: Address = "0x000000000000000000000000000000000000016b";
const FUNDING = 5n * 10n ** 18n; // 5 HBAR in the relay's 18-decimal units
const RING_DELAY = 90n;
const CANCEL_DELAY = 600n;
const RING_GAS_LIMIT = 200_000n; // AlarmProbe.RING_GAS_LIMIT
const SCHEDULE_GAS_FALLBACK = 1_000_000n; // used only if the relay cannot estimate scheduleCall
const POLL_MS = 5_000;
const POLL_TIMEOUT_MS = 4 * 60_000;

const ABI = {
  probe: parseAbi([
    "function schedule(uint256 delaySeconds) returns (address scheduleAddress)",
    "function cancel(address scheduleAddress)",
    "function ring(uint256 n)",
    "function rings() view returns (uint256)",
    "function nonce() view returns (uint256)",
    "event Scheduled(address schedule, uint256 nonce, uint256 at)",
    "event Rang(uint256 nonce, uint256 at)",
  ]),
  hss: parseAbi(["function hasScheduleCapacity(uint256 expirySecond, uint256 gasLimit) view returns (bool)"]),
};

type Step = TxRecord & { gas: Gas };

interface ScheduleRecord {
  scheduleAddress: Address;
  scheduleId: string;
  hashscan: string;
  nonce: string;
  expirySecond: string;
  scheduleTx: Step;
}

interface MirrorSchedule {
  schedule_id: string;
  creator_account_id: string;
  payer_account_id: string;
  deleted: boolean;
  executed_timestamp: string | null;
  expiration_time: string | null;
  wait_for_expiry: boolean;
}

interface S4State {
  network: "testnet";
  chainId: 296;
  deployPath: string;
  operator: Address;
  probe: Deployed;
  funding: Step;
  ring?: ScheduleRecord & {
    executedTimestamp: string;
    executedTx: { transactionId: string; name: string; result: string; scheduled: boolean; hashscan: string };
    rang: { nonce: string; at: string; timestamp: string; transactionHash: Hex | null };
    rings: string;
  };
  cancel?: ScheduleRecord & { cancelTx: Step; deleted: boolean };
}

const scheduleIdOf = (addr: Address): string => `0.0.${BigInt(addr)}`;

async function deploy(): Promise<S4State> {
  console.log("1. deploy: forge script 02_DeploySpikeS4 through the Hashio relay");
  const { created, calls } = await forgeDeploy("02_DeploySpikeS4.s.sol");
  const probe = created.get("AlarmProbe");
  const funding = calls[0];
  if (!probe || !funding) throw new Error("broadcast has no AlarmProbe creation and funding transfer");
  const hbar = await pub.getBalance({ address: probe.address });
  if (hbar !== FUNDING) throw new Error(`probe holds ${hbar} wei, expected ${FUNDING}`);
  console.log(`  funded with 5 HBAR: ${funding.hashscan}`);
  const state: S4State = {
    network: "testnet",
    chainId: 296,
    deployPath: "forge script --broadcast --legacy --slow --skip-simulation via Hashio JSON-RPC relay",
    operator: wallet.account!.address,
    probe,
    funding: { ...funding, label: "fund probe with 5 HBAR via receive()" },
  };
  writeJson(DEPLOY_FILE, state);
  return state;
}

/** Calls probe.schedule(delay) and returns the schedule from the `Scheduled` event. */
async function schedule(s: S4State, delay: bigint): Promise<ScheduleRecord> {
  const block = await pub.getBlock();
  const roughExpiry = block.timestamp + delay;
  const capacity = await pub
    .readContract({ address: HSS, abi: ABI.hss, functionName: "hasScheduleCapacity", args: [roughExpiry, RING_GAS_LIMIT] })
    .catch((e: Error) => `eth_call failed: ${e.message.split("\n")[0]}`);
  console.log(`  hasScheduleCapacity(~${roughExpiry}, ${RING_GAS_LIMIT}) = ${capacity}`);

  const request = { address: s.probe.address, abi: ABI.probe, functionName: "schedule", args: [delay] } as const;
  const gas = await pub
    .estimateContractGas({ ...request, account: wallet.account! })
    .then((g) => (g * 13n) / 10n)
    .catch((e: Error) => {
      console.log(`  relay could not estimate schedule(): ${e.message.split("\n")[0]}; using ${SCHEDULE_GAS_FALLBACK}`);
      return SCHEDULE_GAS_FALLBACK;
    });
  const scheduleTx = await send(`probe.schedule(${delay})`, { ...request, gas });
  const receipt = await pub.getTransactionReceipt({ hash: scheduleTx.hash });
  const [event] = parseEventLogs({ abi: ABI.probe, eventName: "Scheduled", logs: receipt.logs });
  if (!event) throw new Error(`no Scheduled event in ${scheduleTx.hash}`);
  const scheduleAddress = event.args.schedule;
  const scheduleId = scheduleIdOf(scheduleAddress);
  console.log(`  schedule ${scheduleId} (${scheduleAddress}) nonce ${event.args.nonce} at ${event.args.at}: ${hashscan.schedule(scheduleId)}`);
  return {
    scheduleAddress,
    scheduleId,
    hashscan: hashscan.schedule(scheduleId),
    nonce: `${event.args.nonce}`,
    expirySecond: `${event.args.at}`,
    scheduleTx,
  };
}

interface MirrorLog {
  data: Hex;
  topics: Hex[];
  timestamp: string;
  transaction_hash: Hex | null;
}

async function findRang(s: S4State, nonce: bigint): Promise<{ log: MirrorLog; at: bigint } | undefined> {
  const body = await mirrorGet<{ logs: MirrorLog[] }>(`/contracts/${s.probe.contractId}/results/logs?order=desc&limit=25`);
  for (const log of body?.logs ?? []) {
    try {
      const decoded = decodeEventLog({ abi: ABI.probe, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (decoded.eventName === "Rang" && decoded.args.nonce === nonce) return { log, at: decoded.args.at };
    } catch {
      // other events (Scheduled)
    }
  }
  return undefined;
}

async function ring(s: S4State): Promise<S4State> {
  if (s.ring) {
    console.log(`2. ring: already executed (${s.ring.executedTx.hashscan})`);
    return s;
  }
  console.log("2. ring");
  const ringsBefore = await pub.readContract({ address: s.probe.address, abi: ABI.probe, functionName: "rings" });
  const rec = await schedule(s, RING_DELAY);
  const nonce = BigInt(rec.nonce);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let found: Awaited<ReturnType<typeof findRang>>;
  let sched: MirrorSchedule | undefined;
  while (Date.now() < deadline) {
    sched = await mirrorGet<MirrorSchedule>(`/schedules/${rec.scheduleId}`).catch(() => undefined);
    found = await findRang(s, nonce).catch(() => undefined);
    const left = Math.round((deadline - Date.now()) / 1000);
    console.log(`  waiting: executed_timestamp=${sched?.executed_timestamp ?? "-"} rang=${found ? "yes" : "no"} (${left}s left)`);
    if (found && sched?.executed_timestamp) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  if (!found || !sched?.executed_timestamp) {
    const balance = await pub.getBalance({ address: s.probe.address });
    throw new Error(
      `BLOCKED: no Rang within 4 minutes; schedule ${rec.scheduleId} = ${JSON.stringify(sched)}; probe balance ${balance} wei`,
    );
  }

  const { transactions } = (await mirror.waitFor(() =>
    mirrorGet<{ transactions: { transaction_id: string; name: string; result: string; scheduled: boolean }[] }>(
      `/transactions?timestamp=${sched!.executed_timestamp}`,
    ),
  ))!;
  const tx = transactions[0];
  if (!tx) throw new Error(`no transaction at ${sched.executed_timestamp}`);
  const [acct, secs, nanos] = tx.transaction_id.split("-");
  const transactionId = `${acct}@${secs}.${nanos}`;
  const executedTx = {
    transactionId,
    name: tx.name,
    result: tx.result,
    scheduled: tx.scheduled,
    // A scheduled transaction shares its transaction id with the ScheduleCreate; link by timestamp.
    hashscan: hashscan.tx(sched.executed_timestamp),
  };
  console.log(`  executed ${tx.name} ${tx.result} scheduled=${tx.scheduled} at ${sched.executed_timestamp}: ${executedTx.hashscan}`);
  console.log(`  Rang(nonce ${nonce}, at ${found.at}) at consensus ${found.log.timestamp}`);

  const rings = await pub.readContract({ address: s.probe.address, abi: ABI.probe, functionName: "rings" });
  if (rings !== ringsBefore + 1n) throw new Error(`rings() = ${rings}, expected ${ringsBefore + 1n}`);
  console.log(`  rings() = ${rings}`);

  s.ring = {
    ...rec,
    executedTimestamp: sched.executed_timestamp,
    executedTx,
    rang: { nonce: `${nonce}`, at: `${found.at}`, timestamp: found.log.timestamp, transactionHash: found.log.transaction_hash },
    rings: `${rings}`,
  };
  writeJson(DEPLOY_FILE, s);
  return s;
}

async function cancel(s: S4State): Promise<S4State> {
  if (s.cancel) {
    console.log(`3. cancel: already deleted (${s.cancel.hashscan})`);
    return s;
  }
  console.log("3. cancel");
  const rec = await schedule(s, CANCEL_DELAY);
  const cancelTx = await send(`probe.cancel(${rec.scheduleId})`, {
    address: s.probe.address, abi: ABI.probe, functionName: "cancel", args: [rec.scheduleAddress],
  });
  const sched = await mirror.waitFor(async () => {
    const m = await mirrorGet<MirrorSchedule>(`/schedules/${rec.scheduleId}`);
    return m?.deleted ? m : undefined;
  });
  console.log(`  mirror /schedules/${rec.scheduleId}: deleted=${sched.deleted} executed_timestamp=${sched.executed_timestamp}`);
  s.cancel = { ...rec, cancelTx, deleted: sched.deleted };
  writeJson(DEPLOY_FILE, s);
  return s;
}

let state: S4State;
if (existsSync(DEPLOY_FILE)) {
  console.log(`1. deploy: using ${DEPLOY_FILE}`);
  state = readJson<S4State>(DEPLOY_FILE);
} else {
  state = await deploy();
}
state = await ring(state);
state = await cancel(state);

console.log(`\nAlarmProbe ${state.probe.address} ${state.probe.contractId} ${hashscan.contract(state.probe.contractId)}`);
console.log(`  deploy: ${state.probe.tx.hashscan} (gas used ${state.probe.gas.used})`);
console.log(`  fund 5 HBAR: ${state.funding.hashscan} (gas used ${state.funding.gas.used})`);
for (const r of [state.ring, state.cancel]) {
  if (!r) continue;
  console.log(`  schedule(${r === state.ring ? RING_DELAY : CANCEL_DELAY}) ${r.scheduleTx.hashscan} (gas used ${r.scheduleTx.gas.used}) -> ${r.hashscan}`);
}
if (state.ring) console.log(`  executed scheduled call: ${state.ring.executedTx.hashscan}`);
if (state.cancel) console.log(`  cancel: ${state.cancel.cancelTx.hashscan} (gas used ${state.cancel.cancelTx.gas.used})`);
