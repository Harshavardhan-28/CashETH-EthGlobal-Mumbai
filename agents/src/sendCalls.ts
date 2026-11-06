/** Signing and sending the calldata the MCP server hands back when it does not hold the agent's key. */
import { publicActions, type Account, type Address, type Chain, type Hex, type Transport, type WalletClient } from "viem";

export type Calldata = { to: Address; data: Hex; description: string };

/** Sends one call and resolves with its transaction hash once it is mined successfully. */
export type CallSender = (call: Calldata) => Promise<Hex>;

/** A viem wallet client with an account and a chain: the agent's own key. */
export type AgentWallet = WalletClient<Transport, Chain, Account>;

/** Gas headroom over the relay's estimate, as the MCP server sends its own transactions. */
const GAS_MARGIN_PERCENT = 130n;

/**
 * Dry-runs each call first (a revert is reported before anything is signed or paid for), then sends it with the
 * estimate plus 30% and waits for a successful receipt.
 */
export function walletCallSender(wallet: AgentWallet): CallSender {
  const chain = wallet.extend(publicActions);
  return async ({ to, data }) => {
    const { account } = wallet;
    await chain.call({ account, to, data });
    const gas = ((await chain.estimateGas({ account, to, data })) * GAS_MARGIN_PERCENT) / 100n;
    const hash = await wallet.sendTransaction({ account, chain: wallet.chain, to, data, gas });
    const receipt = await chain.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
    return hash;
  };
}

/** A call of a sequence failed: `index` is its position, `sent` the hashes of the calls mined before it. */
export class SendCallsError extends Error {
  constructor(
    readonly index: number,
    readonly call: Calldata,
    readonly sent: Hex[],
    readonly reason: string,
    total: number,
    cause: unknown,
  ) {
    const already = sent.length ? `already sent: ${sent.join(", ")}` : "nothing was sent before it";
    super(`call ${index + 1} of ${total} (${call.description}) failed, ${already}: ${reason}`, { cause });
    this.name = "SendCallsError";
  }
}

/**
 * Sends the calls one after another (an approval must be mined before the call that spends it). The first failure
 * stops the sequence with a `SendCallsError` naming the failed call and the transactions already sent.
 */
export async function sendInOrder(send: CallSender | undefined, calls: Calldata[]): Promise<Hex[]> {
  if (!send) throw new Error("the server returned calldata for the agent to sign but this agent has no call sender (wallet)");
  const hashes: Hex[] = [];
  for (const [index, call] of calls.entries()) {
    try {
      hashes.push(await send(call));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new SendCallsError(index, call, [...hashes], reason, calls.length, error);
    }
  }
  return hashes;
}
