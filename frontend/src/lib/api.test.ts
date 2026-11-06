import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient } from "./api";
import { AGENTS_FIXTURE, EVENTS_FIXTURE, LENDERS_FIXTURE, RECEIVABLE_FIXTURE } from "./fixtures";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("createApiClient", () => {
  it("fetches each read endpoint from the base URL", async () => {
    const routes: Record<string, unknown> = {
      "/events": EVENTS_FIXTURE,
      "/agents": AGENTS_FIXTURE,
      "/lenders": LENDERS_FIXTURE,
      [`/receivables/${RECEIVABLE_FIXTURE.id}`]: RECEIVABLE_FIXTURE,
    };
    const fetchMock = vi.fn(async (url: string | URL | Request) => json(routes[new URL(String(url)).pathname]));
    const client = createApiClient("http://api.test:4030/", fetchMock as typeof fetch);

    expect(await client.events()).toEqual(EVENTS_FIXTURE);
    expect(await client.agents()).toEqual(AGENTS_FIXTURE);
    expect(await client.lenders()).toEqual(LENDERS_FIXTURE);
    expect(await client.receivable(RECEIVABLE_FIXTURE.id)).toEqual(RECEIVABLE_FIXTURE);
    expect(fetchMock.mock.calls[0][0]).toBe("http://api.test:4030/events");
  });

  it("turns an error body into an ApiError", async () => {
    const client = createApiClient("http://api.test", (async () =>
      json({ code: "NOT_FOUND", message: "no such receivable" }, 404)) as typeof fetch);

    await expect(client.receivable("0xnope")).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      code: "NOT_FOUND",
      message: "no such receivable",
    });
    await expect(client.receivable("0xnope")).rejects.toBeInstanceOf(ApiError);
  });
});
