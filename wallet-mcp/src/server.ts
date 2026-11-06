/**
 * The CashETH wallet as an MCP server: Claude Code calls these tools to act with the demo agents' own keys, which
 * stay in this local process. Every tool result is one JSON text item; a refusal or failure sets `isError` and
 * carries a `code`, and nothing was signed or sent unless the result says so.
 */
import { SendCallsError, sendInOrder, signConfirmation, type CallSender, type Calldata, type WireTypedData } from "@casheth/agents";
import { hashscan, type Addresses } from "@casheth/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { formatEther, formatUnits, getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { z } from "zod";
import type { HeldAccount, KeyRing } from "./accounts.js";
import { checkCalls, checkConfirmation, WalletRefusal } from "./policy.js";

export interface WalletDeps {
  ring: KeyRing;
  /** `deployments/testnet/addresses.json`, read on every call. */
  addresses: () => Addresses;
  /** Largest `approve` one call may carry, USDC (or tUSDT) base units. */
  approveCap: bigint;
  /** Signs and sends one call from the account, resolving once it is mined successfully. */
  sender: (account: HeldAccount) => CallSender;
  /** HBAR in weibars (18 decimals, as the JSON-RPC relay reports it) and USDC base units. */
  balances: (address: Address) => Promise<{ hbar: bigint; usdc: bigint }>;
}

/** A call of a batch failed on-chain or at the relay after the calls before it were mined. */
class CallFailed extends Error {
  constructor(private readonly body: Record<string, unknown>) {
    super(String(body.message));
  }

  toJSON(): Record<string, unknown> {
    return { code: "CALL_FAILED", ...this.body };
  }
}

const address = z.string().refine((v) => isAddress(v), "not an EVM address").transform((v) => getAddress(v));
const hex = z.string().refine((v) => isHex(v), "not 0x hex").transform((v) => v as Hex);
const uint = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform(String);

/** `upload_receivable`'s answer: `{ pendingId, id, confirmationRequest: { typedData } }` (uint fields as decimal strings). */
const UploadSchema = z.object({
  pendingId: hex,
  id: hex.optional(),
  confirmationRequest: z.object({
    typedData: z.object({
      domain: z.object({ name: z.string(), version: z.string(), chainId: z.coerce.number().int(), verifyingContract: address }),
      message: z.object({
        seller: address,
        buyer: address,
        currency: address,
        amount: uint,
        dueDate: uint,
        buyerRef: hex,
        detailsCommitment: hex,
        payTo: address,
        nonce: uint,
        deadline: uint,
      }),
    }),
  }),
});

const CallSchema = z.object({ to: address, data: hex, description: z.string().optional() });

function parseUpload(upload: unknown): z.infer<typeof UploadSchema> {
  let value = upload;
  if (typeof upload === "string") {
    try {
      value = JSON.parse(upload);
    } catch {
      throw new WalletRefusal("BAD_INPUT", "upload is not JSON: pass the upload_receivable result as it came back");
    }
  }
  const parsed = UploadSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new WalletRefusal("BAD_INPUT", `upload is not an upload_receivable result (${issues})`);
  }
  return parsed.data;
}

function result(value: unknown, isError = false): CallToolResult {
  return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(value) }] };
}

/** Runs a tool body; refusals and failures become `isError` results with their code. Keys never reach a message. */
async function guarded(run: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return result(await run());
  } catch (error) {
    if (error instanceof WalletRefusal || error instanceof CallFailed) return result(error.toJSON(), true);
    return result({ code: "INTERNAL", message: error instanceof Error ? error.message : String(error) }, true);
  }
}

const link = (hashes: Hex[], calls: Calldata[]) =>
  hashes.map((txHash, index) => ({ index, description: calls[index]!.description, txHash, hashscan: hashscan.tx(txHash) }));

export function createWalletServer(deps: WalletDeps): McpServer {
  const server = new McpServer({ name: "casheth-wallet", version: "0.0.0" });
  /** Successful batches by (account, calls): an identical repeat (a retry after a lost answer) replays, never resends. */
  const done = new Map<string, Record<string, unknown>>();
  /** One batch in flight per account, so two batches never race for a nonce. */
  const queues = new Map<string, Promise<unknown>>();

  server.registerTool(
    "list_accounts",
    { description: "The accounts this local wallet signs for: role label, Hedera account id and EVM address (never a key)." },
    () => guarded(async () => ({ accounts: deps.ring.list() })),
  );

  server.registerTool(
    "sign_receivable_confirmation",
    {
      description:
        "Signs the buyer's EIP-712 ReceivableConfirmation from a CashETH upload_receivable result and returns { pendingId, signature } " +
        "for confirm_receivable. Refuses typed data that is not for the deployed ReceivableRegistry, that names another buyer than " +
        "`account`, or that pays anyone but the RepaymentRouter in USDC.",
      inputSchema: {
        account: z.string().describe('Wallet account label, e.g. "buyer" (see list_accounts)'),
        upload: z.union([z.string(), z.record(z.string(), z.unknown())]).describe("The upload_receivable result, unchanged (object or JSON string)"),
      },
    },
    ({ account, upload }) =>
      guarded(async () => {
        const held = deps.ring.get(account);
        const parsed = parseUpload(upload);
        const typedData = parsed.confirmationRequest.typedData as WireTypedData;
        checkConfirmation(typedData, { addresses: deps.addresses(), signer: held.signer.address });
        const signature = await signConfirmation(held.signer, typedData);
        const { seller, amount, dueDate, deadline } = typedData.message;
        return {
          account: held.info.account,
          signer: held.signer.address,
          pendingId: parsed.pendingId,
          ...(parsed.id ? { receivableId: parsed.id } : {}),
          signature,
          signed: { seller, amount, dueDate, deadline },
        };
      }),
  );

  server.registerTool(
    "send_calls",
    {
      description:
        "Signs and sends, in order, the calldata a CashETH tool returned in calldata mode (repay_receivable, fund_agents, close_strategy) " +
        "from the named account. Only USDC/tUSDT approve (exact, to the RepaymentRouter or Aqua, at most the wallet's per-call cap), " +
        "RepaymentRouter.repay and Aqua ship/dock are allowed; the whole batch is checked before anything is sent. Stops at the first " +
        "failure and reports what was already sent. Returns a HashScan link per transaction.",
      inputSchema: {
        account: z.string().describe('Wallet account label, e.g. "buyer" (see list_accounts)'),
        calls: z.array(CallSchema).min(1).max(8).describe("The `calls` array of the CashETH tool result, unchanged"),
      },
    },
    ({ account, calls: input }) =>
      guarded(async () => {
        const held = deps.ring.get(account);
        const calls: Calldata[] = input.map((c, i) => ({ to: c.to, data: c.data, description: c.description ?? `call ${i + 1} to ${c.to}` }));
        checkCalls(calls, { addresses: deps.addresses(), approveCap: deps.approveCap });
        const batchKey = JSON.stringify([held.info.account, calls.map((c) => [c.to.toLowerCase(), c.data.toLowerCase()])]);
        const run = async () => {
          const prior = done.get(batchKey);
          if (prior) return { ...prior, replayed: true };
          try {
            const hashes = await sendInOrder(deps.sender(held), calls);
            const outcome = { account: held.info.account, from: held.signer.address, sent: link(hashes, calls) };
            done.set(batchKey, outcome);
            return outcome;
          } catch (error) {
            if (!(error instanceof SendCallsError)) throw error;
            throw new CallFailed({
              message: error.message,
              account: held.info.account,
              failedIndex: error.index,
              failedCall: error.call.description,
              reason: error.reason,
              sent: link(error.sent, calls),
            });
          }
        };
        const queued = (queues.get(held.info.account) ?? Promise.resolve()).then(run, run);
        queues.set(held.info.account, queued.catch(() => undefined));
        return queued;
      }),
  );

  server.registerTool(
    "get_balances",
    {
      description: "HBAR and USDC balances of a wallet account (USDC as base units and as a decimal).",
      inputSchema: { account: z.string().describe('Wallet account label, e.g. "buyer"') },
    },
    ({ account }) =>
      guarded(async () => {
        const { info } = deps.ring.get(account);
        const { hbar, usdc } = await deps.balances(info.address);
        return { account: info.account, ...(info.accountId ? { accountId: info.accountId } : {}), address: info.address, hbar: formatEther(hbar), usdc: usdc.toString(), usdcDisplay: formatUnits(usdc, 6) };
      }),
  );

  return server;
}
