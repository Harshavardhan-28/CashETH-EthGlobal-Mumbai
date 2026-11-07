/**
 * The demo's lifecycle (BUILD.md section 16), one small step per Hedera transaction. Every step drives an agent
 * (which talks to the MCP server) and returns the proof it produced; none of them sends a chain call itself.
 */
import { computeReceivableId, hashscan } from "@casheth/shared";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { idempotencyKey as stableKey, ToolCallError } from "../mcpClient.js";
import type { ShipOutcome } from "../lender.js";
import type { PurchaseOutcome } from "../worker.js";
import { checkQuotePlan, expiredReservation, purchaseAttempt, findShippedStrategy, formatAgentTable, formatLenderTable, formatUsdc, topUpShortfall } from "./checks.js";
import { ADVANCE_BPS, BUDGETS, expectedSplit, FRESH_LENDERS, INVOICE, PURCHASE_ATTEMPT_BASE, SPEND } from "./plan.js";
import { poll } from "./poll.js";
import { findEvent, type AuditEvent } from "./readApi.js";
import type { DemoContext, DemoWorker, Step, StepOutcome } from "./types.js";

type Proof = Pick<StepOutcome, "txId" | "link">;

const proofOfTx = (txId: string): Proof => ({ txId, link: hashscan.tx(txId) });

/** An EVM transaction hash, shown as the Hedera transaction it became. */
async function proofOfEvmTx(ctx: DemoContext, hash: string): Promise<Proof> {
  return proofOfTx(await ctx.resolveTx(hash));
}

/** The HCS message the control plane published for an event it recorded (rejections have no other transaction). */
function proofOfEvent(event: AuditEvent | undefined, what: string): Proof {
  if (!event?.hcsTxId) throw new Error(`the server recorded no HCS transaction for ${what}`);
  return proofOfTx(event.hcsTxId);
}

/** The receivable's id: from this run's upload, or derived from the invoice on a rerun whose upload was done earlier. */
function receivableId(ctx: DemoContext): Hex {
  return ctx.state.upload?.id ?? computeReceivableId(ctx.invoice.buyer, keccak256(toHex(ctx.invoice.buyerRef)));
}

const describeOutcome = (outcome: PurchaseOutcome): string => {
  if (outcome.status === "rejected") return `rejected at ${outcome.stage}: ${outcome.code}`;
  if (outcome.status === "paid_uncommitted") return `paid (${outcome.transactionId}) but the commit failed: ${outcome.reason}`;
  return `committed ${outcome.spendId}`;
};

/** The hash of the credit-strategy transaction: the server's own, or the last of the calls the lender sent. */
function shipTxHash(outcome: ShipOutcome): string {
  if (outcome.mode === "shipped") return String(outcome.credit.txHash);
  return outcome.txHashes[outcome.txHashes.length - 1]!;
}

/** The hash of the repayment transaction, however the buyer's transactions were sent. */
function repayTxHash(result: Record<string, unknown>): string {
  if (typeof result.txHash === "string") return result.txHash;
  if (Array.isArray(result.txHashes) && result.txHashes.length > 0) return String(result.txHashes[result.txHashes.length - 1]);
  throw new Error("the repayment returned no transaction hash");
}

// ---------------------------------------------------------------------------------------------------- 1. lenders

/** Whether the receivable's facility is already funded: a rerun past step 4, when the lender steps have nothing left to do. */
async function facilityFunded(ctx: DemoContext): Promise<boolean> {
  const id = computeReceivableId(ctx.invoice.buyer, keccak256(toHex(ctx.invoice.buyerRef)));
  const details = await ctx.read.receivable(id);
  return details !== undefined && BigInt(details.funded) > 0n;
}

const FUNDED_ALREADY: StepOutcome = { skipped: true, note: "the facility is already funded: an earlier run did this step" };

/**
 * Whether the receivable is already registered on chain: a rerun against a fresh server, whose own records do not
 * hold the earlier upload, so the registry (not the server's replay store) says what was done.
 */
async function registeredAlready(ctx: DemoContext): Promise<boolean> {
  const id = computeReceivableId(ctx.invoice.buyer, keccak256(toHex(ctx.invoice.buyerRef)));
  const details = await ctx.read.receivable(id);
  return details !== undefined && details.state !== "Pending" && details.state !== "None";
}

const REGISTERED_ALREADY: StepOutcome = { skipped: true, note: "the receivable is already registered on chain: an earlier run did this step" };

/** Runs `step` unless the receivable is already registered, in which case the step is reported as done earlier. */
function unlessRegistered(step: Step): Step {
  return {
    label: step.label,
    async run(ctx) {
      if (await registeredAlready(ctx)) return REGISTERED_ALREADY;
      return step.run(ctx);
    },
  };
}

/** Tops an account up from the operator by exactly what it is short of `required`, or skips when it holds enough. */
function topUpStep(label: string, account: (ctx: DemoContext) => { address: Address; accountId: string }, required: bigint, purpose: string): Step {
  return {
    label,
    async run(ctx) {
      const { address, accountId } = account(ctx);
      const balance = await ctx.usdcBalance(address);
      const shortfall = topUpShortfall(balance, required);
      if (shortfall === 0n) {
        ctx.log("already done: the balance covers it", { account: accountId, balance, required });
        return { skipped: true, note: `holds ${formatUsdc(balance)} USDC, enough for the ${formatUsdc(required)} ${purpose}` };
      }
      const txId = await ctx.topUpFromOperator(accountId, shortfall);
      return { ...proofOfTx(txId), note: `operator sent exactly ${formatUsdc(shortfall)} USDC (held ${formatUsdc(balance)}, ${purpose} ${formatUsdc(required)})` };
    },
  };
}

function lenderTopUpStep(key: "A" | "B"): Step {
  const topUp = topUpStep(`1. lender ${key}: top up USDC from the operator`, (ctx) => ctx.lenders[key], FRESH_LENDERS[key].creditUsdc, "it ships");
  // Once the facility is funded the lender holds less because it lent: no top-up is owed.
  return { ...topUp, run: async (ctx) => ((await facilityFunded(ctx)) ? FUNDED_ALREADY : topUp.run(ctx)) };
}

const buyerTopUpStep: Step = topUpStep("8. buyer: top up USDC from the operator", (ctx) => ctx.buyer, INVOICE.amount, "it repays");

/** The strategy is already open (an earlier run shipped it): show that run's ship transaction when the server recorded it. */
async function shippedEarlier(ctx: DemoContext, strategyHash: Hex): Promise<StepOutcome> {
  ctx.log("already done: the strategy is open, not shipping again", { strategyHash });
  const event = findEvent(await ctx.read.events(), { type: "StrategyShipped", strategyHash });
  if (!event?.txHash) return { skipped: true, note: `strategy ${strategyHash} is already open (shipped by an earlier run)` };
  return { ...(await proofOfEvmTx(ctx, event.txHash)), note: `strategy ${strategyHash} is already open: the ship transaction of an earlier run` };
}

function shipStep(key: "A" | "B"): Step {
  const { slabs, creditUsdc } = FRESH_LENDERS[key];
  return {
    label: `1. lender ${key} ships a ${formatUsdc(creditUsdc)} USDC credit strategy for ${slabs.join(" + ")} risk`,
    async run(ctx) {
      if (await facilityFunded(ctx)) return FUNDED_ALREADY;
      const lender = ctx.lenders[key];
      const { maxPerBuyer } = FRESH_LENDERS[key];
      const planned = { maker: lender.address, seller: ctx.seller.address, creditUsdc, slabs, ...(maxPerBuyer ? { maxPerBuyer } : {}) };
      const open = findShippedStrategy(await ctx.openStrategies(), planned);
      if (open) return shippedEarlier(ctx, open.strategyHash);

      // A stable key per invoice and lender: a rerun whose strategy is not yet visible replays a ship that landed.
      const idempotencyKey = stableKey("demo-ship", INVOICE.buyerRef, key);
      const outcome = await ctx.lenders[key].agent.ship({ slabs, sellers: [ctx.seller.address], creditUsdc, idempotencyKey, ...(maxPerBuyer ? { maxPerBuyer } : {}) });
      return { ...(await proofOfEvmTx(ctx, shipTxHash(outcome))), note: `funds ${outcome.slabs.join(" + ")} risk at the seller's own rate, seller list [seller]` };
    },
  };
}

// ---------------------------------------------------------------------------------------------------- 2. upload and confirm

const uploadStep: Step = {
  label: `2. seller uploads ${INVOICE.buyerRef}`,
  async run(ctx) {
    const upload = await ctx.seller.agent.run({ invoice: ctx.invoice, invoiceFile: ctx.invoiceFile });
    ctx.state.upload = upload;
    const { document } = upload;
    if (!document?.verification?.ok) throw new Error(`the invoice document does not match the submitted terms: ${JSON.stringify(document?.verification?.mismatches ?? "no verification")}`);
    const event = findEvent(await ctx.read.events(), { type: "ReceivableUploaded", id: upload.id });
    return {
      ...proofOfEvent(event, "the upload"),
      note: `invoice PDF stored (keccak256 ${document.keccak256}) and matched against the terms; receivable ${upload.id} waits for the buyer's EIP-712 confirmation`,
    };
  },
};

const sellerNoteStep: Step = {
  label: "2. seller agent posts a note on the agent-notes HCS topic",
  async run(ctx) {
    const txId = await ctx.seller.kit.note(`seller agent: uploaded ${INVOICE.buyerRef} as receivable ${receivableId(ctx)}`);
    return { ...proofOfTx(txId), note: "Hedera Agent Kit submit_topic_message_tool, signed by the seller account" };
  },
};

const confirmStep: Step = {
  label: `2. buyer confirms ${INVOICE.buyerRef}: registration`,
  async run(ctx) {
    const upload = ctx.state.upload;
    if (!upload) throw new Error("no receivable was uploaded yet");
    const confirmed = await ctx.buyer.agent.confirm(upload);
    if (!confirmed.decision.approved) throw new Error(`the credit decision was declined: ${confirmed.decision.reasons.join(", ")}`);
    const { score, advanceBps, limit } = confirmed.decision;
    return { ...(await proofOfEvmTx(ctx, confirmed.txHash)), note: `registered; score ${score}, advance ${advanceBps} bps, limit ${formatUsdc(BigInt(limit))} USDC` };
  },
};

const documentStep: Step = {
  label: "2. invoice document: the registry commitment is the file's hash (get_receivable_status)",
  async run(ctx) {
    const id = receivableId(ctx);
    const { document } = await ctx.seller.agent.status(id);
    if (!document?.verified) throw new Error(`expected document.verified true, got ${JSON.stringify(document)}`);
    const txId = ctx.state.upload?.document?.hashscan?.split("/transaction/")[1];
    if (!txId) throw new Error("the invoice document hashes were not anchored on HCS");
    return { ...proofOfTx(txId), note: `document.verified: true (keccak256 ${document.keccak}); the file's hashes are anchored on HCS` };
  },
};

const nftStep: Step = {
  label: "2. receivable NFT minted",
  async run(ctx) {
    const event = findEvent(await ctx.read.events(), { type: "NftMinted", id: receivableId(ctx) });
    if (!event?.txId) throw new Error("the server recorded no NFT mint for the receivable");
    return { ...proofOfTx(event.txId), note: `serial ${String(event.serial)} of ${String(event.tokenId)}` };
  },
};

const confirmedOnHcsStep: Step = {
  label: "2. ReceivableConfirmed published to the HCS audit topic",
  async run(ctx) {
    const event = findEvent(await ctx.read.events(), { type: "ReceivableConfirmed", id: receivableId(ctx) });
    return { ...proofOfEvent(event, "ReceivableConfirmed"), note: `HCS sequence ${String(event?.hcsSeq)}` };
  },
};

// ---------------------------------------------------------------------------------------------------- 3. duplicate

const duplicateStep: Step = {
  label: `3. duplicate ${INVOICE.buyerRef} is rejected (DUPLICATE_RECEIVABLE)`,
  async run(ctx) {
    const id = receivableId(ctx);
    try {
      await ctx.seller.agent.run({ invoice: ctx.invoice, invoiceFile: ctx.invoiceFile, submission: "duplicate" });
    } catch (error) {
      if (!(error instanceof ToolCallError) || error.code !== "DUPLICATE_RECEIVABLE") throw error;
      const event = findEvent(await ctx.read.events(), { type: "ReceivableRejected", id, code: "DUPLICATE_RECEIVABLE" });
      return { ...proofOfEvent(event, "the rejection"), note: "rejected by registry state check: DUPLICATE_RECEIVABLE (the server read the registered state, no contract call); recorded on HCS" };
    }
    throw new Error("the duplicate submission was accepted");
  },
};

// ---------------------------------------------------------------------------------------------------- 4. facility

const openFacilityStep: Step = {
  label: "4. seller opens the facility: cheapest-first fill through the modified SwapVM router",
  async run(ctx) {
    const id = receivableId(ctx);
    if (await facilityFunded(ctx)) {
      // A rerun: the quotes only cover a Confirmed receivable, so replay the stored `open_facility` result for its transaction.
      const opened = await ctx.seller.agent.openFacility(id);
      return { ...(await proofOfEvmTx(ctx, opened.txHash)), note: `funded ${formatUsdc(BigInt(opened.total))} USDC by an earlier run (replayed from the server)` };
    }
    const quotes = await ctx.seller.agent.quotes(id);
    if (quotes.decision.advanceBps !== ADVANCE_BPS) throw new Error(`expected an advance of ${ADVANCE_BPS} bps, the decision is ${quotes.decision.advanceBps}`);
    const plan = checkQuotePlan(quotes, ctx.makers);
    const opened = await ctx.seller.agent.openFacility(id);
    if (opened.total !== quotes.plan.total) throw new Error(`funded ${opened.total}, the quote was ${quotes.plan.total}`);
    return { ...(await proofOfEvmTx(ctx, opened.txHash)), note: `${plan}; one transaction funds the facility (advance ${ADVANCE_BPS} bps)` };
  },
};

// ---------------------------------------------------------------------------------------------------- 5. budgets

const budgetsStep: Step = {
  label: "5. seller sets the worker budgets",
  async run(ctx) {
    const { research, compute } = BUDGETS;
    const { txHash } = await ctx.seller.agent.setBudgets(receivableId(ctx), [
      { worker: ctx.research.address, ...research, merchants: [ctx.merchant] },
      { worker: ctx.compute.address, ...compute, merchants: [ctx.merchant] },
    ]);
    const note = `research ${formatUsdc(research.alloc)} (max ${formatUsdc(research.maxPerTx)}/tx, ${formatUsdc(research.maxDaily)}/day), compute ${formatUsdc(compute.alloc)}; merchant allowlist [x402 merchant]`;
    return { ...(await proofOfEvmTx(ctx, txHash)), note };
  },
};

// ---------------------------------------------------------------------------------------------------- 6. trader

const traderStep: Step = {
  label: "6. trader agent runs scripted volume against the base-yield strategies",
  async run() {
    return { skipped: true, note: "the trader agent (Task 4.6) is not part of this build; base-yield volume is not scripted" };
  },
};

// ---------------------------------------------------------------------------------------------------- 7. spend

const releaseStaleReservationStep: Step = {
  label: "7. research worker releases an expired, unpaid reservation (release_spend)",
  async run(ctx) {
    const stale = expiredReservation(await ctx.read.events(), ctx.research.address, ctx.nowSeconds());
    if (!stale) return { skipped: true, note: "the spend wallet holds no expired reservation" };
    const { txHash } = await ctx.research.agent.release(stale.spendId as Hex);
    return { ...(await proofOfEvmTx(ctx, txHash)), note: `an earlier run reserved ${String(stale.spendId)} and never paid it; its USDC returned to the facility and the spend wallet is free` };
  },
};

const researchPurchaseStep: Step = {
  label: `7. research worker buys /research for ${formatUsdc(SPEND.researchPrice)} USDC (reserve, x402, commit)`,
  async run(ctx) {
    const attempt = purchaseAttempt(await ctx.read.events(), ctx.research.address, PURCHASE_ATTEMPT_BASE);
    const outcome = await ctx.research.agent.buy({
      id: receivableId(ctx),
      service: "research",
      budgetHint: SPEND.researchPrice,
      purchaseId: `${INVOICE.buyerRef}-research-${attempt}`,
      query: "agent working capital on Hedera",
    });
    if (outcome.status !== "committed") throw new Error(describeOutcome(outcome));
    if (outcome.price !== SPEND.researchPrice) throw new Error(`the catalog price is ${formatUsdc(outcome.price)} USDC, expected ${formatUsdc(SPEND.researchPrice)}`);
    return { ...proofOfTx(outcome.transactionId), note: `x402 settlement from the 2-of-2 spend wallet; reservation ${outcome.spendId} committed` };
  },
};

const workerNoteStep: Step = {
  label: "7. research worker posts a note on the agent-notes HCS topic",
  async run(ctx) {
    const txId = await ctx.research.kit.note(`research worker: bought /research for ${formatUsdc(SPEND.researchPrice)} USDC on ${receivableId(ctx)}`);
    return { ...proofOfTx(txId), note: "Hedera Agent Kit submit_topic_message_tool, signed by the worker account" };
  },
};

/** A purchase the control plane must refuse at the reservation; the proof is the rejection it recorded on HCS. */
function overLimitStep(label: string, pick: (ctx: DemoContext) => DemoWorker, amount: bigint, code: string): Step {
  return {
    label,
    async run(ctx) {
      const id = receivableId(ctx);
      const worker = pick(ctx);
      const outcome = await worker.agent.buy({ id, service: "research", budgetHint: SPEND.researchPrice, purchaseId: `${INVOICE.buyerRef}-${code}`, amount });
      if (outcome.status !== "rejected" || outcome.code !== code) throw new Error(`expected ${code}, got ${describeOutcome(outcome)}`);
      const event = findEvent(await ctx.read.events(), { type: "SpendRejected", id, code, worker: worker.address });
      return { ...proofOfEvent(event, `the ${code} rejection`), note: `${formatUsdc(amount)} USDC refused before any money moved; rejection recorded on HCS` };
    },
  };
}

const researchOverLimitStep = overLimitStep(
  `7. research worker asks ${formatUsdc(SPEND.researchOverLimit)} USDC: TX_LIMIT_EXCEEDED`,
  (ctx) => ctx.research,
  SPEND.researchOverLimit,
  "TX_LIMIT_EXCEEDED",
);

const computeOverBudgetStep = overLimitStep(
  `7. compute worker asks ${formatUsdc(SPEND.computeOverBudget)} USDC: AGENT_BUDGET_EXCEEDED`,
  (ctx) => ctx.compute,
  SPEND.computeOverBudget,
  "AGENT_BUDGET_EXCEEDED",
);

// ---------------------------------------------------------------------------------------------------- 8. repay

const repayStep: Step = {
  label: `8. buyer repays ${INVOICE.buyerRef} in full (${formatUsdc(INVOICE.amount)} USDC)`,
  async run(ctx) {
    const id = receivableId(ctx);
    const { A, B } = ctx.makers;
    const balances = async () => ({ A: await ctx.usdcBalance(A), B: await ctx.usdcBalance(B), seller: await ctx.usdcBalance(ctx.seller.address) });
    const buyerRepaid = async () => (await ctx.read.agents()).find((a) => a.address.toLowerCase() === ctx.buyer.address.toLowerCase())?.receivablesRepaid ?? 0;
    const [before, repaidBefore] = [await balances(), await buyerRepaid()];
    // Each lender is owed at the rate its position recorded: the seller's own rate when the facility was funded.
    const funded = await ctx.read.receivable(id);
    if (!funded) throw new Error(`the server does not know receivable ${id}`);
    const expected = expectedSplit(INVOICE.amount, funded.positions, ctx.makers);

    const result = await ctx.buyer.agent.repay(id, INVOICE.amount);
    const proof = await proofOfEvmTx(ctx, repayTxHash(result));

    const paid = await poll("the repayment payouts", async () => {
      const after = await balances();
      const delta = { A: after.A - before.A, B: after.B - before.B, seller: after.seller - before.seller };
      return delta.A === expected.A && delta.B === expected.B && delta.seller === expected.seller ? delta : undefined;
    }, ctx.poll).catch((error: unknown) => {
      throw new Error(`payouts differ from lender A ${expected.A}, lender B ${expected.B}, seller ${expected.seller}: ${error instanceof Error ? error.message : String(error)}`);
    });

    const details = await ctx.read.receivable(id);
    if (!details) throw new Error(`the server does not know receivable ${id}`);
    if (details.state !== "Repaid" || details.debt !== "0") throw new Error(`expected state Repaid with no debt, got ${details.state} with debt ${details.debt}`);
    await poll("the buyer's reputation update", async () => ((await buyerRepaid()) > repaidBefore ? true : undefined), ctx.poll);

    return { ...proof, note: `lender A +${paid.A}, lender B +${paid.B}, seller +${paid.seller} units; state Repaid, debt 0; buyer reputation updated` };
  },
};

// ---------------------------------------------------------------------------------------------------- 9. tables

const yieldStep: Step = {
  label: "9. lender yield table and agent stats",
  async run(ctx) {
    const [lenders, agents] = [await ctx.read.lenders(), await ctx.read.agents()];
    const detail = `Lender yield (GET /lenders), USDC base units\n${formatLenderTable(lenders)}\n\nAgent stats (GET /agents)\n${formatAgentTable(agents)}`;
    ctx.log(`\n${detail}\n`);
    return { readOnly: true, note: `${lenders.length} lenders and ${agents.length} agents from the read API`, detail };
  },
};

const verifyDocumentStep: Step = {
  label: "10. invoice document verified against the registry (scripts/c9-invoice-verify.ts)",
  async run(ctx) {
    const output = await ctx.verifyInvoiceDocument(receivableId(ctx));
    const verdict = output.split("\n").find((line) => line.startsWith("VERIFIED"));
    if (!verdict) throw new Error(`the served invoice did not verify:\n${output}`);
    return { readOnly: true, note: verdict, detail: output.trimEnd() };
  },
};

/** The steps of one demo run, in order. */
export const STEPS: Step[] = [
  lenderTopUpStep("A"),
  shipStep("A"),
  lenderTopUpStep("B"),
  shipStep("B"),
  unlessRegistered(uploadStep),
  unlessRegistered(sellerNoteStep),
  unlessRegistered(confirmStep),
  unlessRegistered(documentStep),
  unlessRegistered(nftStep),
  unlessRegistered(confirmedOnHcsStep),
  duplicateStep,
  openFacilityStep,
  budgetsStep,
  traderStep,
  releaseStaleReservationStep,
  researchPurchaseStep,
  workerNoteStep,
  researchOverLimitStep,
  computeOverBudgetStep,
  buyerTopUpStep,
  repayStep,
  yieldStep,
  verifyDocumentStep,
];
