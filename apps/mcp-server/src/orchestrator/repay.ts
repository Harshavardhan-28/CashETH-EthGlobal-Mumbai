/**
 * Buyer repayment: approve exactly `amount` USDC to the RepaymentRouter, then `repay(id, amount)`. Both
 * transactions are the buyer's; the server sends them only when it holds the buyer key (`AGENT_KEYS_IN_PROCESS`
 * `true` or naming `buyer`, demo), otherwise it returns the two calldatas in order for the buyer's wallet.
 */
import { RepaymentRouterAbi } from "@casheth/shared";
import { encodeFunctionData, erc20Abi } from "viem";
import { record } from "./audit.js";
import { actor, bytes32, requireParty, STATE, STATE_NAMES, txLink, units } from "./common.js";
import { fail } from "./errors.js";
import type { Calldata, Caller, Orchestrator } from "./types.js";

/**
 * Not `Repaid`: the router would send a further payment entirely to the seller, and a retry after a repayment whose
 * receipt was lost must not pay twice.
 */
const REPAYABLE: readonly number[] = [STATE.Financed, STATE.Overdue, STATE.Defaulted];

export async function repayReceivable(o: Orchestrator, caller: Caller, input: { id: string; amount: string }) {
  const id = bytes32(input.id, "id");
  const amount = units(input.amount, "amount");
  const r = await o.chain.receivable(id);
  if (r.state === STATE.None) fail("NOT_FOUND", `receivable ${id} is not registered`);
  requireParty(caller, r.buyer, "buyer");
  if (r.state === STATE.Repaid) {
    const last = o.events.list().filter((e) => e.type === "Repaid" && e.id === id).at(-1);
    const tx = typeof last?.txHash === "string" ? { txHash: last.txHash, hashscan: txLink(last.txHash) } : {};
    fail("ALREADY_REPAID", `receivable ${id} is already repaid`, { id, ...tx });
  }
  if (!REPAYABLE.includes(r.state)) fail("NOT_FINANCED", `receivable is ${STATE_NAMES[r.state]}`, { state: STATE_NAMES[r.state] });

  const a = o.chain.addresses();
  const calls: Calldata[] = [
    {
      to: a.usdc,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [a.repaymentRouter, amount] }),
      description: "USDC.approve(RepaymentRouter, amount) (exact amount: HTS rejects unlimited approvals)",
    },
    {
      to: a.repaymentRouter,
      data: encodeFunctionData({ abi: RepaymentRouterAbi, functionName: "repay", args: [id, amount] }),
      description: "RepaymentRouter.repay(id, amount): lenders first, the seller the rest",
    },
  ];
  if (!o.chain.holdsKey(r.buyer)) return { id, mode: "calldata" as const, calls };

  const lenderDue = await o.chain.lenderDue(id);
  const approve = await o.chain.send({ agent: r.buyer }, calls[0]!);
  const { txHash } = await o.chain.send({ agent: r.buyer }, calls[1]!);
  const after = await o.chain.receivable(id);
  const toLenders = amount < lenderDue ? amount : lenderDue;
  await record(o, {
    type: "Repaid",
    id,
    amount: amount.toString(),
    toLenders: toLenders.toString(),
    toSeller: (amount - toLenders).toString(),
    state: STATE_NAMES[after.state],
    approveTxHash: approve.txHash,
    txHash,
    hashscan: txLink(txHash),
    ...actor(caller),
  });
  return {
    id,
    mode: "sent" as const,
    approveTxHash: approve.txHash,
    txHash,
    hashscan: txLink(txHash),
    toLenders: toLenders.toString(),
    toSeller: (amount - toLenders).toString(),
    state: STATE_NAMES[after.state],
  };
}
