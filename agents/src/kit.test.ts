import { describe, expect, it } from "vitest";
import { coreConsensusPluginToolNames, coreTokenPluginToolNames, type Tool } from "hedera-agent-kit";
import { loadEnv } from "@casheth/shared";
import { agentKitFromEnv, createAgentKit, kitTools } from "./kit.js";

const TOPIC = "0.0.7777";
const ACCOUNT = "0.0.1234";
const TX_ID = "0.0.1234@1800000000.000000001";

/** A kit tool that records the parameters it was run with instead of touching the network. */
function recordingTool(method: string, result: unknown) {
  const runs: unknown[] = [];
  const tool = { method, name: method, description: "", parameters: undefined, execute: async (_client: unknown, _context: unknown, params: unknown) => (runs.push(params), result) } as unknown as Tool;
  return { tool, runs };
}

const ok = { raw: { status: "SUCCESS", transactionId: TX_ID }, humanMessage: "done" };

describe("kitTools", () => {
  it("are the Hedera Agent Kit's submit-topic-message and associate-token tools", () => {
    const methods = kitTools(ACCOUNT).map((t) => t.method);
    expect(methods).toEqual(expect.arrayContaining([coreConsensusPluginToolNames.SUBMIT_TOPIC_MESSAGE_TOOL, coreTokenPluginToolNames.ASSOCIATE_TOKEN_TOOL]));
  });
});

const SUBMIT = coreConsensusPluginToolNames.SUBMIT_TOPIC_MESSAGE_TOOL;
const ASSOCIATE = coreTokenPluginToolNames.ASSOCIATE_TOKEN_TOOL;

/** A kit whose submit and associate tools answer with the given results; `runs` holds the params each was run with. */
function kitWith(results: { submit?: unknown; associate?: unknown }) {
  const submit = recordingTool(SUBMIT, results.submit ?? ok);
  const associate = recordingTool(ASSOCIATE, results.associate ?? ok);
  const kit = createAgentKit({ client: {} as never, accountId: ACCOUNT, notesTopicId: TOPIC, tools: [submit.tool, associate.tool] });
  return { kit, submit: submit.runs, associate: associate.runs };
}

describe("kit tool parameters", () => {
  const schemaOf = (method: string) => kitTools(ACCOUNT).find((t) => t.method === method)!.parameters;

  it("accept the parameters the agent kit wrapper sends", () => {
    expect(schemaOf(SUBMIT).safeParse({ topicId: TOPIC, message: "hello" }).success).toBe(true);
    expect(schemaOf(ASSOCIATE).safeParse({ accountId: ACCOUNT, tokenIds: ["0.0.429274"] }).success).toBe(true);
  });
});

describe("agent kit", () => {
  it("note posts the text to the notes topic and returns the transaction id", async () => {
    const { kit, submit } = kitWith({});
    expect(await kit.note("seller: invoice PO-1 uploaded")).toBe(TX_ID);
    expect(submit).toEqual([{ topicId: TOPIC, message: "seller: invoice PO-1 uploaded" }]);
  });

  it("associate links the token to the agent's own account", async () => {
    const { kit, associate } = kitWith({});
    expect(await kit.associate("0.0.429274")).toBe(TX_ID);
    expect(associate).toEqual([{ accountId: ACCOUNT, tokenIds: ["0.0.429274"] }]);
  });

  it("raises the error the kit reports instead of returning it (the kit never throws)", async () => {
    const failure = { raw: { status: "INVALID_TRANSACTION", error: "Failed to submit message to topic: INVALID_SIGNATURE" }, humanMessage: "Failed" };
    await expect(kitWith({ submit: failure }).kit.note("hello")).rejects.toThrow(/INVALID_SIGNATURE/);
  });

  it("refuses to be built without the tools it needs", () => {
    expect(() => createAgentKit({ client: {} as never, accountId: ACCOUNT, notesTopicId: TOPIC, tools: [] })).toThrow(/submit_topic_message_tool/);
  });
});

describe("agentKitFromEnv", () => {
  const env = loadEnv({
    source: {
      HEDERA_NETWORK: "testnet",
      HEDERA_CHAIN_ID: "296",
      HEDERA_JSON_RPC_URL: "https://testnet.hashio.io/api",
      HEDERA_MIRROR_NODE_URL: "https://testnet.mirrornode.hedera.com",
      HEDERA_OPERATOR_ID: "0.0.1001",
      HEDERA_OPERATOR_KEY: "0xoperator",
      MERCHANT_ACCOUNT_ID: "0.0.1002",
      MERCHANT_KEY: "0xmerchant",
      USDC_TOKEN_ID: "0.0.429274",
      USDC_EVM_ADDRESS: "0x0000000000000000000000000000000000068cda",
      X402_FACILITATOR_URL: "https://facilitator.example",
      X402_NETWORK: "hedera-testnet",
      SELLER_ID: ACCOUNT,
      SELLER_KEY: `0x${"0b".repeat(32)}`,
      AGENT_NOTES_TOPIC_ID: TOPIC,
    },
  });

  it("builds the kit from the agent's <PREFIX>_ID and <PREFIX>_KEY and the HCS topic", () => {
    expect(() => agentKitFromEnv(env, "SELLER")).not.toThrow();
  });

  it("names the missing variable", () => {
    expect(() => agentKitFromEnv(env, "BUYER")).toThrow(/BUYER_ID/);
  });

  it("needs a notes topic: unset or empty (as in .env.example) both fail, and the audit topic is no substitute", () => {
    const { AGENT_NOTES_TOPIC_ID: _topic, ...withoutTopic } = env;
    expect(() => agentKitFromEnv({ ...withoutTopic, HCS_AUDIT_TOPIC_ID: TOPIC } as typeof env, "SELLER")).toThrow(/AGENT_NOTES_TOPIC_ID/);
    expect(() => agentKitFromEnv({ ...env, AGENT_NOTES_TOPIC_ID: "" }, "SELLER")).toThrow(/AGENT_NOTES_TOPIC_ID/);
  });
});
