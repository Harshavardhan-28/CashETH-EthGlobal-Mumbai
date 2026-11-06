/** The local chat model: Ollama through LangChain's `ChatOllama`. */
import { listOllamaModels } from "@casheth/agents";
import { ChatOllama } from "@langchain/ollama";

/** Fails with the command that fixes it when Ollama is down or the model is not pulled. */
export async function assertModelAvailable(baseUrl: string, model: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const models = await listOllamaModels(baseUrl, fetchImpl);
  if (!models) throw new Error(`Ollama does not answer at ${baseUrl}: start it with \`ollama serve\``);
  if (!models.includes(model)) throw new Error(`Ollama at ${baseUrl} lacks ${model}: run \`ollama pull ${model}\``);
}

/** Deterministic and without the thinking phase: a tool-calling run needs answers, not essays. */
export const ollamaChatModel = (baseUrl: string, model: string) => new ChatOllama({ baseUrl, model, temperature: 0, think: false });
