/**
 * Per-agent Hedera Agent Kit instance (D-P12). It runs the kit's own `submit_topic_message_tool` (agent-side notes
 * on an HCS topic) and `associate_token_tool` (HTS association) as the agent's account. The kit builds on
 * `@hashgraph/sdk`, so its client is separate from the `@hiero-ledger/sdk` one `@casheth/hedera` uses.
 */
import type { DemoAccount, Env } from "@casheth/shared";
import { Client, PrivateKey } from "@hashgraph/sdk";
import {
  AgentMode,
  coreConsensusPlugin,
  coreConsensusPluginToolNames,
  coreTokenPlugin,
  coreTokenPluginToolNames,
  type Context,
  type Tool,
} from "hedera-agent-kit";

/** What a kit tool resolves with: the kit reports failures in `raw.error` instead of throwing. */
type KitResult = { raw: { status: string; transactionId?: string; error?: string }; humanMessage: string };

export interface AgentKit {
  /** Posts `text` to the notes topic; resolves with the transaction id. */
  note(text: string): Promise<string>;
  /** Associates the HTS token with the agent's account; resolves with the transaction id. */
  associate(tokenId: string): Promise<string>;
}

export interface AgentKitOptions {
  client: Client;
  accountId: string;
  notesTopicId: string;
  /** The kit tools to run; defaults to `kitTools(accountId)`. */
  tools?: Tool[];
}

const contextFor = (accountId: string): Context => ({ mode: AgentMode.AUTONOMOUS, accountId });

/** The kit's consensus and token tools, configured to execute as `accountId`. */
export function kitTools(accountId: string): Tool[] {
  const context = contextFor(accountId);
  return [...coreConsensusPlugin.tools(context), ...coreTokenPlugin.tools(context)];
}

export function createAgentKit({ client, accountId, notesTopicId, tools = kitTools(accountId) }: AgentKitOptions): AgentKit {
  const context = contextFor(accountId);
  const find = (method: string): Tool => {
    const tool = tools.find((t) => t.method === method);
    if (!tool) throw new Error(`Hedera Agent Kit has no ${method}`);
    return tool;
  };
  const submitTopicMessage = find(coreConsensusPluginToolNames.SUBMIT_TOPIC_MESSAGE_TOOL);
  const associateToken = find(coreTokenPluginToolNames.ASSOCIATE_TOKEN_TOOL);

  async function run(tool: Tool, params: Record<string, unknown>): Promise<string> {
    const { raw } = (await tool.execute(client, context, params)) as KitResult;
    if (raw.error) throw new Error(raw.error);
    return raw.transactionId ?? "";
  }

  return {
    note: (text) => run(submitTopicMessage, { topicId: notesTopicId, message: text }),
    associate: (tokenId) => run(associateToken, { accountId, tokenIds: [tokenId] }),
  };
}

/**
 * The kit for a demo agent: its Hedera account from `<PREFIX>_ID` / `<PREFIX>_KEY` (`.env.accounts`) and the topic
 * from `AGENT_NOTES_TOPIC_ID`. It must be a topic agents may submit to: the audit topic has the operator as its
 * submit key and would reject an agent's signature, so it is not a fallback.
 */
export function agentKitFromEnv(env: Env, account: DemoAccount): AgentKit {
  const accountId = env[`${account}_ID`];
  const privateKey = env[`${account}_KEY`];
  if (!accountId) throw new Error(`${account}_ID is not set (run scripts/setup-accounts.ts)`);
  if (!privateKey) throw new Error(`${account}_KEY is not set (run scripts/setup-accounts.ts)`);
  const notesTopicId = env.AGENT_NOTES_TOPIC_ID;
  if (typeof notesTopicId !== "string" || notesTopicId.trim() === "") {
    throw new Error("AGENT_NOTES_TOPIC_ID is not set: agent notes need an HCS topic without a submit key");
  }
  const client = Client.forName(env.HEDERA_NETWORK).setOperator(accountId, PrivateKey.fromStringECDSA(privateKey));
  return createAgentKit({ client, accountId, notesTopicId });
}
