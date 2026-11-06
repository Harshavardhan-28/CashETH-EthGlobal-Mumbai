/** The agent-notes HCS topic: created once without a submit key, remembered in `.env.accounts`, reused afterwards. */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { hashscan, type Env } from "@casheth/shared";
import type { StepResult } from "./types.js";

/** Appends `KEY=value` on its own line, whether or not the file ends with a newline; creates the file if needed. */
export function appendEnvVar(file: string, key: string, value: string): void {
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  appendFileSync(file, `${existing === "" || existing.endsWith("\n") ? "" : "\n"}${key}=${value}\n`);
}

export interface NotesTopicDeps {
  /** The env file the topic id is remembered in (`.env.accounts`). */
  envFile: string;
  /** Creates the topic and resolves with its id and transaction id. */
  create(): Promise<{ topicId: string; txId: string }>;
}

/**
 * The topic agents post notes to. `AGENT_NOTES_TOPIC_ID` wins when set; otherwise a topic is created and its id
 * appended to the env file. Returns the env with the id set, and the setup step's result.
 */
export async function ensureNotesTopic(env: Env, { envFile, create }: NotesTopicDeps): Promise<{ env: Env; result: StepResult }> {
  const existing = env.AGENT_NOTES_TOPIC_ID;
  const label = "0. agent-notes HCS topic (no submit key)";
  if (typeof existing === "string" && existing.trim() !== "") {
    return { env, result: { label, skipped: true, link: hashscan.topic(existing), note: `reusing ${existing}` } };
  }
  const { topicId, txId } = await create();
  appendEnvVar(envFile, "AGENT_NOTES_TOPIC_ID", topicId);
  return {
    env: { ...env, AGENT_NOTES_TOPIC_ID: topicId },
    result: { label, txId, link: hashscan.tx(txId), note: `created ${topicId} and saved it as AGENT_NOTES_TOPIC_ID in ${envFile}` },
  };
}
