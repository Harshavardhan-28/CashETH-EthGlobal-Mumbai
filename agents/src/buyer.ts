/** Buyer agent: confirms an uploaded receivable with its own EIP-712 signature and repays financed ones. */
import { receivableDomain, signReceivableConfirmation, type ReceivableConfirmation } from "@casheth/shared";
import { getAddress, type Hex, type LocalAccount } from "viem";
import { idempotencyKey, type ToolCaller } from "./mcpClient.js";
import type { UploadResult, WireTypedData } from "./seller.js";
import { sendInOrder, type CallSender, type Calldata } from "./sendCalls.js";

/** The wire typed data as signable values; the domain is always `AgentReceivables` version `1`. */
export function confirmationMessage({ domain, message }: WireTypedData) {
  const confirmation: ReceivableConfirmation = {
    ...message,
    amount: BigInt(message.amount),
    dueDate: BigInt(message.dueDate),
    nonce: BigInt(message.nonce),
    deadline: BigInt(message.deadline),
  };
  return { domain: receivableDomain(Number(domain.chainId), domain.verifyingContract), message: confirmation };
}

/** Signs `typedData` as the buyer it names; refuses typed data that is about another buyer. */
export async function signConfirmation(account: LocalAccount, typedData: WireTypedData): Promise<Hex> {
  if (getAddress(typedData.message.buyer) !== getAddress(account.address)) {
    throw new Error(`typed data names another buyer (${typedData.message.buyer}), not ${account.address}`);
  }
  const { domain, message } = confirmationMessage(typedData);
  return signReceivableConfirmation(account, domain, message);
}

type Sent = { id: Hex; mode: "sent"; [field: string]: unknown };
type RepayResult = Sent | { id: Hex; mode: "calldata"; calls: Calldata[] };

export interface BuyerOptions {
  client: ToolCaller;
  account: LocalAccount;
  /** Signs and sends the calldata `repay_receivable` returns when the server does not hold the buyer key. */
  send?: CallSender;
}

export function createBuyerAgent({ client, account, send }: BuyerOptions) {
  return {
    /** Signs the typed data of an upload and sends it to `confirm_receivable`; resolves with the credit decision. */
    async confirm({ pendingId, confirmationRequest }: UploadResult) {
      const signature = await signConfirmation(account, confirmationRequest.typedData);
      return client.call("confirm_receivable", { pendingId, signature, idempotencyKey: idempotencyKey("confirm", pendingId) });
    },

    /**
     * `repay_receivable`: the exact-amount approval and the repayment, sent from the buyer's wallet in order. The
     * idempotency key comes from (id, amount, attempt), so retrying after a timeout replays the first repayment
     * instead of paying again; pass a new `attempt` only for a deliberate further payment of the same amount.
     */
    async repay(id: Hex, amount: bigint, { attempt = "1" }: { attempt?: string } = {}): Promise<Sent> {
      const key = idempotencyKey("repay", id.toLowerCase(), amount.toString(), attempt);
      const result = await client.call<RepayResult>("repay_receivable", { id, amount: amount.toString(), idempotencyKey: key });
      if (result.mode !== "calldata") return result;
      return { id, mode: "sent", txHashes: await sendInOrder(send, result.calls) };
    },
  };
}
