/** Signing and sending the calldata the MCP server hands back when it does not hold the agent's key. */
import { publicActions, type Account, type Address, type Chain, type Hex, type Transport, type WalletClient } from "viem";

export type Calldata = { to: Address; data: Hex; description: string };

/** Sends one call and resolves with its transaction hash once it is mined successfully. */
export type CallSender = (call: Calldata) => Promise<Hex>;

/** A viem wallet client with an account and a chain: the agent's own key. */
export type AgentWallet = WalletClient<Transport, Chain, Account>;

export function walletCallSender(wallet: AgentWallet): CallSender {
  return async ({ to, data }) => {
    const hash = await wallet.sendTransaction({ account: wallet.account, chain: wallet.chain, to, data });
    const receipt = await wallet.extend(publicActions).waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
    return hash;
  };
}

/**
 * Sends the calls one after another (an approval must be mined before the call that spends it). The first failure
 * stops the sequence; the error names the failed call and lists the transactions already sent.
 */
export async function sendInOrder(send: CallSender | undefined, calls: Calldata[]): Promise<Hex[]> {
  if (!send) throw new Error("the server returned calldata for the agent to sign but this agent has no call sender (wallet)");
  const hashes: Hex[] = [];
  for (const [index, call] of calls.entries()) {
    try {
      hashes.push(await send(call));
    } catch (error) {
      const sent = hashes.length ? `already sent: ${hashes.join(", ")}` : "nothing was sent before it";
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`call ${index + 1} of ${calls.length} (${call.description}) failed, ${sent}: ${reason}`, { cause: error });
    }
  }
  return hashes;
}
