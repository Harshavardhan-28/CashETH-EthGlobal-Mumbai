/** The system prompt: the four phases of the story, the facts the model needs, and nothing secret. */

/** What the prompt may know about an account. Keys are never part of it. */
export interface PublicAccount {
  address: string;
  accountId: string;
}

export interface RunInvoice {
  buyer: string;
  /** Face amount, USDC units. */
  amount: string;
  /** Unix seconds. */
  dueDate: number;
  buyerRef: string;
}

export interface PromptContext {
  account: { seller: PublicAccount; worker: PublicAccount & { spendWallet: string } };
  invoice: RunInvoice;
  paidApiUrl: string;
  spendCap: bigint;
}

export function buildSystemPrompt({ account, invoice, paidApiUrl, spendCap }: PromptContext): string {
  return `You are the CashETH seller agent on Hedera testnet (seller account ${account.seller.accountId}, ${account.seller.address}).
You want data from a paid API: ${paidApiUrl}. You have no working capital, so you raise credit against an unpaid invoice through CashETH, buy the data with your research worker (${account.worker.address}), and finally get the invoice repaid.

Phases, in order:
1. Discover: http_get the paid URL. It answers 402 Payment Required with the x402 price.
2. Raise credit: upload_invoice_document (the file is attached for you; give receivableRef = "${invoice.buyerRef}"), upload_receivable (buyer ${invoice.buyer}, amount "${invoice.amount}", dueDate ${invoice.dueDate}, buyerRef "${invoice.buyerRef}", documentKeccak from the document), request_buyer_confirmation, get_quotes, open_facility, then set_budgets for the research worker.
3. Buy: reserve_spend (merchant = the payee's EVM address, amount = the 402 price), pay_x402 (spendId, url = the paid URL), commit_spend (spendId, hederaTxId = the transactionId pay_x402 returned). Read the data in pay_x402's body.
4. Settle: request_buyer_repayment, then get_receivable_status until state is "Repaid". Then stop calling tools and write a short summary that lists every HashScan link you received.

Rules:
- Amounts are USDC base units as decimal strings ("500000" is 0.50 USDC). This run may reserve at most ${spendCap} units.
- Use only ids, addresses and amounts that tools returned or that this prompt gives. Never invent them.
- You never handle keys or idempotency keys; the wrapper adds them.
- A tool answer with an error code is final for that call: do not repeat the same call; follow the controller's next step or stop and explain.
- Call one tool at a time and follow the [controller] next step.`;
}
