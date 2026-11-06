/** Test-only: a localhost HTTP server whose answers a test scripts, recording every request (excluded from the build). */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

export interface FakeHttpServer {
  url: string;
  requests: Recorded[];
  close(): Promise<void>;
}

/** `respond` gets each request (body already parsed) and returns the status and JSON body to send. */
export async function fakeHttpServer(respond: (request: Recorded) => { status?: number; body: unknown }): Promise<FakeHttpServer> {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const recorded: Recorded = { method: req.method ?? "GET", path: req.url ?? "/", body: raw ? JSON.parse(raw) : undefined };
      requests.push(recorded);
      const { status = 200, body } = respond(recorded);
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://localhost:${port}`, requests, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
