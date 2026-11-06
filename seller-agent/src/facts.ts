/** What the run has established so far, read from tool results by code (never from what the model says). */
import type { Hex } from "viem";

export interface Paywall {
  url: string;
  /** Hedera account id of the payee (`accepts[0].payTo`). */
  payTo: string;
  /** Price in USDC units. */
  amount: string;
  asset?: string;
}

export interface Facts {
  /** The x402 requirements of the paid resource (the first 402 `http_get` saw). */
  paywall?: Paywall;
  documentKeccak?: Hex;
  pendingId?: Hex;
  receivableId?: Hex;
  /** `upload_receivable`'s answer: the buyer signs its typed data, never the model. */
  upload?: Record<string, unknown>;
  /** The receivable's face amount (units): what the buyer repays. */
  amount?: string;
  /** HashScan link of the buyer's confirmation (registration). */
  confirmed?: string;
  quoted?: boolean;
  /** The facility's funded amount (units) once `open_facility` succeeded. */
  funded?: string;
  budgetsSet?: boolean;
  /** Reservations made in this run: the only ones `pay_x402` and `commit_spend` may use. */
  spendIds: string[];
  /** USDC units reserved in this run (a decimal string, so the state stays JSON). */
  spent: string;
  /** The x402 settlement of the purchase. */
  settlement?: { spendId: string; transactionId: string; hashscan?: string };
  /** What the paid API returned once paid. */
  data?: unknown;
  committed?: boolean;
  /** Transaction hash of the buyer's repayment. */
  repayTx?: string;
  /** `get_receivable_status` showed the receivable as Repaid. */
  repaid?: boolean;
}

export const emptyFacts = (): Facts => ({ spendIds: [], spent: "0" });

type Result = Record<string, unknown>;
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

function paywallOf(args: Record<string, unknown>, result: Result): Paywall | undefined {
  const accepts = (result.paymentRequired as { accepts?: Result[] } | undefined)?.accepts?.[0];
  const payTo = str(accepts?.payTo);
  const amount = str(accepts?.amount);
  if (result.status !== 402 || !payTo || !amount) return undefined;
  return { url: String(args.url), payTo, amount, ...(str(accepts?.asset) ? { asset: String(accepts!.asset) } : {}) };
}

/** The face amount the buyer signs for, from the typed data the server built; the call's own amount as a fallback. */
const faceAmount = (args: Record<string, unknown>, result: Result): string | undefined =>
  str((result.confirmationRequest as { typedData?: { message?: Result } } | undefined)?.typedData?.message?.amount) ?? str(args.amount);

/** What a tool result establishes. Only successful results count; the model's own claims never do. */
export function applyResult(facts: Facts, call: { name: string; args: Record<string, unknown> }, raw: unknown): Partial<Facts> {
  if (typeof raw !== "object" || raw === null || "error" in raw || "code" in raw) return {};
  const result = raw as Result;
  const { args } = call;
  switch (call.name) {
    case "http_get": {
      const paywall = facts.paywall ? undefined : paywallOf(args, result);
      return paywall ? { paywall } : {};
    }
    case "upload_invoice_document":
      return str(result.keccak256) ? { documentKeccak: result.keccak256 as Hex } : {};
    case "upload_receivable": {
      const amount = faceAmount(args, result);
      return str(result.pendingId) && str(result.id)
        ? { pendingId: result.pendingId as Hex, receivableId: result.id as Hex, upload: result, ...(amount ? { amount } : {}) }
        : {};
    }
    case "request_buyer_confirmation":
      return { confirmed: str(result.hashscan) ?? str(result.txHash) ?? "confirmed" };
    case "get_quotes":
      return { quoted: true };
    case "open_facility":
      return str(result.funded) ? { funded: String(result.funded) } : {};
    case "set_budgets":
      return { budgetsSet: true };
    case "reserve_spend":
      return str(result.spendId)
        ? { spendIds: [...facts.spendIds, String(result.spendId)], spent: (BigInt(facts.spent) + BigInt(String(args.amount))).toString() }
        : {};
    case "pay_x402":
      return str(result.transactionId)
        ? { settlement: { spendId: String(args.spendId), transactionId: String(result.transactionId), ...(str(result.hashscan) ? { hashscan: String(result.hashscan) } : {}) }, data: result.body }
        : {};
    case "commit_spend":
      return { committed: true };
    case "request_buyer_repayment": {
      const tx = str(result.txHash) ?? (Array.isArray(result.txHashes) ? str(result.txHashes.at(-1)) : undefined);
      return tx ? { repayTx: tx } : {};
    }
    case "get_receivable_status":
      return result.state === "Repaid" ? { repaid: true } : {};
    default:
      return {};
  }
}
