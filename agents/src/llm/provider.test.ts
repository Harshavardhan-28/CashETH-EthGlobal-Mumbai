import { describe, expect, it } from "vitest";
import { createModel, NoProviderError, selectProvider } from "./provider.js";

const ollamaUp =
  (...models: string[]): typeof fetch =>
  async () =>
    Response.json({ models: models.map((name) => ({ name })) });
const ollamaDown: typeof fetch = async () => {
  throw new Error("ECONNREFUSED");
};

describe("selectProvider", () => {
  it("defaults to Ollama with qwen2.5:7b when no key is set and Ollama has the model", async () => {
    expect(await selectProvider({}, ollamaUp("qwen2.5:7b"))).toEqual({ provider: "ollama", model: "qwen2.5:7b", baseUrl: "http://localhost:11434" });
  });

  it("honours OLLAMA_BASE_URL and CASHETH_LLM_MODEL, and matches a :latest tag", async () => {
    const choice = await selectProvider({ OLLAMA_BASE_URL: "http://gpu:11434", CASHETH_LLM_MODEL: "llama3.1" }, ollamaUp("llama3.1:latest"));
    expect(choice).toEqual({ provider: "ollama", model: "llama3.1", baseUrl: "http://gpu:11434" });
  });

  it("uses Anthropic when a key is set, without probing Ollama", async () => {
    const choice = await selectProvider({ ANTHROPIC_API_KEY: "k" }, ollamaDown);
    expect(choice).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5" });
    expect(await selectProvider({ ANTHROPIC_API_KEY: "k", CASHETH_LLM_MODEL: "claude-haiku-5-5" }, ollamaDown)).toMatchObject({ model: "claude-haiku-5-5" });
  });

  it("CASHETH_LLM_PROVIDER=ollama wins over a key", async () => {
    expect(await selectProvider({ ANTHROPIC_API_KEY: "k", CASHETH_LLM_PROVIDER: "ollama" }, ollamaUp("qwen2.5:7b"))).toMatchObject({ provider: "ollama" });
  });

  it("refuses with a clear message when Ollama is unreachable and there is no key", async () => {
    const error = await selectProvider({}, ollamaDown).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoProviderError);
    expect((error as Error).message).toMatch(/Ollama is not reachable at http:\/\/localhost:11434.*ollama pull qwen2\.5:7b.*ANTHROPIC_API_KEY is not set/);
  });

  it("refuses with the pull command when Ollama runs without the model", async () => {
    await expect(selectProvider({}, ollamaUp("llama3.1:8b"))).rejects.toThrow(/ollama pull qwen2\.5:7b/);
  });

  it("refuses an explicit anthropic choice without a key, and an unknown provider", async () => {
    await expect(selectProvider({ CASHETH_LLM_PROVIDER: "anthropic" }, ollamaUp())).rejects.toThrow(/needs ANTHROPIC_API_KEY/);
    await expect(selectProvider({ CASHETH_LLM_PROVIDER: "openai" }, ollamaUp())).rejects.toThrow(/must be "ollama" or "anthropic"/);
  });
});

describe("createModel", () => {
  it("builds the backend the choice names", () => {
    expect(createModel({ provider: "ollama", model: "qwen2.5:7b" })).toMatchObject({ provider: "ollama", model: "qwen2.5:7b" });
    expect(createModel({ provider: "anthropic", model: "claude-sonnet-5-5" })).toMatchObject({ provider: "anthropic" });
  });
});
