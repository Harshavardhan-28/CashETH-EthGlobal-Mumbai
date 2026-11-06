import { describe, expect, it } from "vitest";
import { assertModelAvailable } from "./model.js";

const tags = (names: string[]) => (async () => Response.json({ models: names.map((name) => ({ name })) })) as unknown as typeof fetch;

describe("assertModelAvailable", () => {
  it("passes when Ollama has the model", async () => {
    await expect(assertModelAvailable("http://localhost:11434", "qwen3:8b", tags(["qwen3:8b", "qwen2.5:7b"]))).resolves.toBeUndefined();
  });

  it("tells the user to pull a missing model", async () => {
    await expect(assertModelAvailable("http://localhost:11434", "qwen3:8b", tags(["qwen2.5:7b"]))).rejects.toThrow(/ollama pull qwen3:8b/);
  });

  it("tells the user to start Ollama when it does not answer", async () => {
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(assertModelAvailable("http://localhost:11434", "qwen3:8b", down)).rejects.toThrow(/ollama serve/);
  });
});
