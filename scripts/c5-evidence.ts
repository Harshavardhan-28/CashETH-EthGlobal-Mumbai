/**
 * Appends the "C5 spend (x402)" section to docs/EVIDENCE.md from `deployments/testnet/c5.json` (written by
 * scripts/c5-spend.ts) and `spend-wallets.json` (the standing allowances). Does nothing when the section exists.
 *
 *   pnpm tsx scripts/c5-evidence.ts
 */
import { appendFileSync, readFileSync } from "node:fs";
import { readJson, ROOT } from "./spikes/lib.js";

const HEADING = "## C5 spend (x402)";
const EVIDENCE = `${ROOT}docs/EVIDENCE.md`;

type Tx = { label?: string; transactionId: string; hashscan: string };
type Transfer = { account: string; amount: string };
type Hcs = { type: string; seq: number; hashscan?: string };
type Rejection = { tx: Tx; status: string; errorMessage: string; decoded: string };

const c5 = readJson<any>(`${ROOT}deployments/testnet/c5.json`);
const wallets = readJson<any>(`${ROOT}deployments/testnet/spend-wallets.json`);
if (readFileSync(EVIDENCE, "utf8").includes(HEADING)) {
  console.log("EVIDENCE.md already has the C5 spend section");
  process.exit(0);
}

const link = (t: { transactionId: string; hashscan: string }) => `[${t.transactionId}](${t.hashscan})`;
const hcs = (h?: Hcs) => (h ? `[${h.type} seq ${h.seq}](${h.hashscan})` : "n/a");
const usdc = (units: string) => `${(Number(units) / 1e6).toFixed(2)}`;
const moves = (ts: Transfer[]) => ts.map((t) => `${t.account} ${Number(t.amount) > 0 ? "+" : ""}${usdc(t.amount)}`).join(", ");
const revert = (r: Rejection) => `\`${r.errorMessage}\` = \`${r.decoded}\` (${r.status})`;

const { budgets, purchase: p, rejections: r, expiry: e } = c5;
const allowance = wallets.facilityAllowance;

const section = [
  "",
  HEADING,
  "",
  `Produced on ${new Date().toISOString().slice(0, 10)} by \`scripts/c5-allowance.ts\` and \`scripts/c5-spend.ts\`; the full record is \`deployments/testnet/c5.json\`. Everything below runs on the facility funded for PO-1002 (\`${c5.receivableId}\`, 4.5 USDC, \`${c5.facility}\`) through the MCP server's tools (\`set_budgets\`, \`reserve_spend\`, \`pay_x402\`, \`commit_spend\`), driven by the seller and worker agents of \`agents/\` with \`AGENT_KEYS_IN_PROCESS=true\`. The MCP server, authorization server and merchant ran locally; the chain, the facilitator (\`https://x402.org/facilitator\`, fee payer 0.0.9185802) and HCS are live Hedera testnet.`,
  "",
  "### Standing allowance (Ruling R26)",
  "",
  `Each spend wallet (2-of-2 worker + co-signer key) granted the new CreditFacility (contract ${allowance.spender.contractId}) an exact USDC allowance of ${allowance.units} units (HTS allowances are int64; no \`max\`). \`release\` pulls an unspent reservation back through it.`,
  "",
  "| Spend wallet | Allowance tx | Mirror `amount_granted` | ERC-20 `allowance` |",
  "| --- | --- | --- | --- |",
  ...Object.entries(allowance.wallets as Record<string, Tx>).map(
    ([name, t]) => `| ${name} ${wallets.wallets[name].accountId} | ${link(t)} | ${allowance.verified[name].mirror} | ${allowance.verified[name].erc20} |`,
  ),
  "",
  "### Budgets",
  "",
  `Seller \`set_budgets\`: ${link(budgets.tx)}. Research worker: alloc ${usdc(budgets.research.alloc)} USDC, maxPerTx ${usdc(budgets.research.maxPerTx)}, maxDaily ${usdc(budgets.research.maxDaily)}. Compute worker: alloc ${usdc(budgets.compute.alloc)} USDC, maxPerTx ${usdc(budgets.compute.maxPerTx)}, maxDaily ${usdc(budgets.compute.maxDaily)}. Merchant allowlist for both: the x402 merchant (0.0.11333304).`,
  "",
  "### Research purchase: reserve, x402 pay, commit",
  "",
  `The research worker's \`buy\` (purchase id \`${p.purchaseId}\`, spend id \`${p.spendId}\`) bought \`/research\` for 0.25 USDC.`,
  "",
  "| Leg | Transaction | USDC movement (mirror node) | Audit event |",
  "| --- | --- | --- | --- |",
  `| Reserve (facility pays the spend wallet) | ${link(p.reserve.tx)} | ${moves(p.reserve.transfers)} | ${hcs(p.hcs[0])} |`,
  `| **x402 settlement** (spend wallet pays the merchant, facilitator pays the fee) | **${link(p.settlement)}** | ${moves(p.settlement.transfers)} | n/a |`,
  `| Commit (\`keccak256(settlement tx id)\` recorded) | ${link(p.commit.tx)} | none | ${hcs(p.hcs[1])} |`,
  "",
  `**The settlement transaction id \`${p.settlement.transactionId}\` is the Hedera x402 headline.** It came back in the \`PAYMENT-RESPONSE\` header, the merchant's body repeats it as \`paidWith.transactionId\`, and \`SpendCommitted\` carries both it and its keccak256. The payment was signed by the worker and, only after \`approvePayment\` and the byte-level transfer check accepted it against the open reservation, by the co-signer; a worker-only signature does not satisfy the wallet's key.`,
  "",
  `Facility accounting after the purchase: reserved ${usdc(p.accounting.facilityReserved)}, committed ${usdc(p.accounting.facilityCommitted)}; research budget ${p.accounting.budget.research}; spend wallets hold ${usdc(p.accounting.walletUsdc.research)} (research) and ${usdc(p.accounting.walletUsdc.compute)} (compute) USDC.`,
  "",
  "### Rejections",
  "",
  "| Request | Where | Result | Audit event |",
  "| --- | --- | --- | --- |",
  ...r.engine.map((x: any) => `| ${x.label} | engine pre-flight, no transaction | \`${x.code}\` | ${hcs(x.hcs)} |`),
  `| compute 5.5 USDC sent straight to \`CreditFacility.reserve\` by the coordinator | contract | ${revert(r.contract)} | ${link(r.contract.tx)} |`,
  "",
  "The research worker's 0.6 USDC is `TX_LIMIT_EXCEEDED` (maxPerTx 0.5, Ruling R24) and the compute worker's 5.5 USDC is `AGENT_BUDGET_EXCEEDED` (budget 3.0). The contract refuses the same 5.5 USDC on-chain with the same error, so the engine's check is not the only line of defence. The selector is read from the mirror node's `error_message` of a real transaction.",
  "",
  "### Expiry: an unpaid reservation is refused late and released",
  "",
  `The research worker reserved 0.25 USDC again (spend id \`${e.spendId}\`, ttl ${e.ttlSeconds} s, expiry ${e.reserve.expiry}): ${link(e.reserve.tx)}. Nothing was paid. After the expiry:`,
  "",
  `- \`pay_x402\` is refused with \`${e.latePayment.code}\` before anything is fetched, recorded as ${hcs(e.latePayment.hcs)} (\`stage: "cosigner"\`).`,
  `- The co-signer's own policy (\`approvePayment\` from \`@casheth/engine\`, run against the merchant's real 402 quote and this reservation) answers \`${JSON.stringify(e.cosignerPolicy.atExpiry)}\` after the expiry and \`${JSON.stringify(e.cosignerPolicy.justBeforeExpiry)}\` one second before it, so the expiry alone decides.`,
  `- The public \`release\` is not open until expiry + 1 h (Ruling R25): the seller's call reverts ${revert(e.publicRelease)}, ${link(e.publicRelease.tx)}.`,
  `- The coordinator's \`release\` works at any time: ${link(e.release.tx)}, USDC movement ${moves(e.release.transfers)} (the facility's standing allowance pulls it back from the spend wallet). The reservation's status is ${e.release.status} (Released) and the wallet is free again. Recorded on HCS as ${hcs(e.hcs[0])}.`,
  "",
  `Final accounting: facility reserved ${usdc(e.accounting.facilityReserved)}, committed ${usdc(e.accounting.facilityCommitted)}; research budget ${e.accounting.budget.research}; compute budget ${e.accounting.budget.compute}.`,
  "",
].join("\n");

appendFileSync(EVIDENCE, readFileSync(EVIDENCE, "utf8").endsWith("\n") ? section : `\n${section}`);
console.log("EVIDENCE.md: appended the C5 spend section");
