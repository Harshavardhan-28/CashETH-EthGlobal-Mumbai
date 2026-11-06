/**
 * Worker agent: buys a service from the cheapest merchant. It discovers the merchants' catalogues (ours or an external
 * x402 merchant's, see `discoverServices`), compares prices,
 * then runs the control plane's reserve -> pay -> commit sequence. Any rejection is logged with its error code and
 * ends the purchase: nothing is retried inside `buy`. The idempotency keys are derived from the receivable, the
 * service and the caller's `purchaseId`, so calling `buy` again with the same `purchaseId` replays the stored
 * results instead of paying twice; use a new `purchaseId` for a new purchase.
 */
import { cheapest, discoverServices, longZeroEvmAddress, type Service } from "@casheth/hedera";
import type { Address, Hex } from "viem";
import { consoleLog, type Log } from "./log.js";
import { idempotencyKey, ToolCallError, type ToolCaller } from "./mcpClient.js";

export interface WorkerOptions {
  client: ToolCaller;
  /** The worker's own address (the `worker` of its budget). */
  worker: Address;
  /** Long-zero EVM address of the worker's 2-of-2 spend wallet. */
  spendWallet: Address;
  /** Merchant catalogue URLs to compare: `<merchant>/catalog` for ours, the root URL of an external merchant. */
  catalogUrls: string[];
  fetch?: typeof fetch;
  log?: Log;
}

export interface PurchaseRequest {
  /** The facility (receivable) whose budget pays. */
  id: Hex;
  /** Catalog service name, e.g. `research`. */
  service: string;
  /** USDC base units the worker expects to spend; a higher price is logged, and the server still decides. */
  budgetHint: bigint;
  /** Names this purchase: the same id replays it (same reservation, payment and commit), a new id buys again. */
  purchaseId: string;
  /** Appended to the service URL (the research topic). */
  query?: string;
  /**
   * Pay this URL instead of the service's. The reservation is still made for `service`'s merchant and price, so a URL
   * whose 402 names another payee is refused by the co-signer (the rogue-payee demo).
   */
  payUrl?: string;
  /** USDC base units to reserve instead of the offer's price: a bulk order, or the demo's over-limit probes. */
  amount?: bigint;
}

export type PurchaseOutcome =
  /** `body` is what the merchant returned for the payment (the purchased data). */
  | { status: "committed"; spendId: Hex; transactionId: string; price: bigint; merchant: string; body: unknown }
  /** Nothing was paid: the control plane refused the reservation or the payment. */
  | { status: "rejected"; stage: "reserve" | "pay"; code: string }
  /** The merchant was paid (`transactionId`) but the commit failed (`reason`: error code or message); call `buy` again with the same `purchaseId` to retry the commit. */
  | { status: "paid_uncommitted"; spendId: Hex; transactionId: string; reason: string; body: unknown };

/** A failure after the reservation whose payment status is unknown; `spendId` identifies the reservation to reconcile. */
export class PurchaseError extends Error {
  constructor(
    readonly spendId: Hex,
    cause: unknown,
  ) {
    super(`payment failed after reserving ${spendId}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "PurchaseError";
  }
}

type Reserved = { spendId: Hex };
type Paid = { transactionId?: string; body?: unknown };
type Attempt<T> = { ok: true; value: T } | { ok: false; code: string };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The cheapest offer for `service` across the catalogs; throws when none lists it. */
export async function pickOffer(catalogUrls: string[], service: string, fetchImpl: typeof fetch = fetch): Promise<Service> {
  const { services } = await discoverServices(catalogUrls, fetchImpl);
  const offer = cheapest(services, service);
  if (!offer) throw new Error(`no offer for "${service}" in ${catalogUrls.join(", ")}`);
  return offer;
}

export function createWorkerAgent({ client, worker, spendWallet, catalogUrls, fetch: fetchImpl, log = consoleLog }: WorkerOptions) {
  /** Runs one tool call; a tool error is logged and returned as `{ ok: false }`, anything else is a real failure. */
  async function attempt<T>(stage: "reserve" | "pay" | "commit", run: () => Promise<T>): Promise<Attempt<T>> {
    try {
      return { ok: true, value: await run() };
    } catch (error) {
      if (!(error instanceof ToolCallError)) throw error;
      log("spend rejected", { stage, code: error.code, ...error.details });
      return { ok: false, code: error.code };
    }
  }

  return {
    /** `release_spend`: returns an expired, unpaid reservation to the facility and frees the spend wallet; resolves with the transaction hash. */
    async release(spendId: Hex): Promise<{ txHash: Hex }> {
      return client.call<{ txHash: Hex }>("release_spend", { spendId, idempotencyKey: idempotencyKey("release", spendId) });
    },

    async buy({ id, service, budgetHint, purchaseId, query = "", payUrl, amount }: PurchaseRequest): Promise<PurchaseOutcome> {
      const offer = await pickOffer(catalogUrls, service, fetchImpl);
      // `pay_x402` fetches with GET only: refuse before reserving anything.
      if (offer.method !== "GET") throw new Error(`"${service}" is a ${offer.method} service; the worker can only buy GET services`);
      const price = amount ?? offer.priceUnits;
      log("cheapest offer", { service, price: offer.price, payTo: offer.payTo, catalog: offer.catalog });
      if (price > budgetHint) log("price is above the budget hint; the control plane decides", { price, budgetHint });

      const key = (step: string) => idempotencyKey(`buy-${step}`, id, service, purchaseId);
      const reserved = await attempt("reserve", () =>
        client.call<Reserved>("reserve_spend", {
          id,
          worker,
          spendWallet,
          merchant: longZeroEvmAddress(offer.payTo),
          amount: price.toString(),
          idempotencyKey: key("reserve"),
        }),
      );
      if (!reserved.ok) return { status: "rejected", stage: "reserve", code: reserved.code };
      const { spendId } = reserved.value;

      const paid = await attempt("pay", () =>
        client.call<Paid>("pay_x402", { spendId, url: payUrl ?? `${offer.url}${encodeURIComponent(query)}`, idempotencyKey: key("pay") }),
      ).catch((error: unknown) => {
        throw new PurchaseError(spendId, error);
      });
      if (!paid.ok) return { status: "rejected", stage: "pay", code: paid.code };
      const { transactionId, body } = paid.value;
      if (!transactionId) throw new PurchaseError(spendId, new Error("payment settled with no transaction id"));

      const committed = await attempt("commit", () =>
        client.call("commit_spend", { spendId, hederaTxId: transactionId, idempotencyKey: key("commit") }),
      ).catch((error: unknown): Attempt<never> => {
        log("commit failed after payment", { spendId, transactionId, reason: messageOf(error) });
        return { ok: false, code: messageOf(error) };
      });
      if (!committed.ok) return { status: "paid_uncommitted", spendId, transactionId, reason: committed.code, body };

      log("purchase committed", { spendId, transactionId });
      return { status: "committed", spendId, transactionId, price, merchant: offer.payTo, body };
    },
  };
}

export type WorkerAgent = ReturnType<typeof createWorkerAgent>;
