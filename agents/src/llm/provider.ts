/**
 * Which model backend a run uses. Ollama (local, no key) is the default; Anthropic is used when `ANTHROPIC_API_KEY` is
 * set, or when `CASHETH_LLM_PROVIDER` asks for either one. `CASHETH_LLM_MODEL` overrides the model of whichever is chosen.
 */
import Anthropic from "@anthropic-ai/sdk";
import { anthropicModel, DEFAULT_ANTHROPIC_MODEL } from "./anthropic.js";
import { DEFAULT_OLLAMA_MODEL, DEFAULT_OLLAMA_URL, listOllamaModels, ollamaModel } from "./ollama.js";
import type { ChatModel } from "./types.js";

export type ProviderName = "ollama" | "anthropic";

export interface ProviderChoice {
  provider: ProviderName;
  model: string;
  /** Ollama only. */
  baseUrl?: string;
}

/** No usable provider: the message says what to start or set. */
export class NoProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoProviderError";
  }
}

type Env = Record<string, string | undefined>;
type FetchLike = typeof fetch;

const isProvider = (value: string): value is ProviderName => value === "ollama" || value === "anthropic";
const hasModel = (pulled: string[], model: string) => pulled.some((name) => name === model || name === `${model}:latest`);

export async function selectProvider(env: Env, fetchImpl: FetchLike = fetch): Promise<ProviderChoice> {
  const requested = env.CASHETH_LLM_PROVIDER?.trim() || undefined;
  if (requested !== undefined && !isProvider(requested)) {
    throw new NoProviderError(`CASHETH_LLM_PROVIDER must be "ollama" or "anthropic", got "${requested}"`);
  }
  const hasKey = Boolean(env.ANTHROPIC_API_KEY);
  const provider: ProviderName = requested ?? (hasKey ? "anthropic" : "ollama");

  if (provider === "anthropic") {
    if (!hasKey) throw new NoProviderError("CASHETH_LLM_PROVIDER=anthropic needs ANTHROPIC_API_KEY (or unset it to use local Ollama)");
    return { provider, model: env.CASHETH_LLM_MODEL || DEFAULT_ANTHROPIC_MODEL };
  }

  const baseUrl = env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_URL;
  const model = env.CASHETH_LLM_MODEL || DEFAULT_OLLAMA_MODEL;
  const pulled = await listOllamaModels(baseUrl, fetchImpl);
  if (!pulled) {
    throw new NoProviderError(
      `no LLM available: Ollama is not reachable at ${baseUrl} (start it and run "ollama pull ${model}")` +
        (hasKey ? "" : " and ANTHROPIC_API_KEY is not set"),
    );
  }
  if (!hasModel(pulled, model)) throw new NoProviderError(`Ollama at ${baseUrl} has no model "${model}": run "ollama pull ${model}"`);
  return { provider, model, baseUrl };
}

export function createModel(choice: ProviderChoice, fetchImpl: FetchLike = fetch): ChatModel {
  return choice.provider === "ollama"
    ? ollamaModel({ model: choice.model, baseUrl: choice.baseUrl ?? DEFAULT_OLLAMA_URL, fetch: fetchImpl })
    : anthropicModel({ model: choice.model, client: new Anthropic({ fetch: fetchImpl }) });
}
