/**
 * x402 merchant: `GET /research?topic=` costs 0.25 USDC (HTS 0.0.429274) on Hedera, paid through an
 * x402 facilitator that verifies and settles the buyer's partially signed TransferTransaction.
 */
import type { Server } from "node:http";
import type { Env } from "@casheth/shared";
import { decodePaymentResponseHeader, HTTPFacilitatorClient } from "@x402/core/http";
import type { Network } from "@x402/core/types";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import express, { type RequestHandler, type Response } from "express";

export const RESEARCH_PRICE = "0.25";
export const RESEARCH_SOURCES = [
  "https://docs.hedera.com/solutions/ai/x402",
  "https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_hedera.md",
];

export interface MerchantOptions {
  /** Facilitator base URL; defaults to `env.X402_FACILITATOR_URL`. */
  facilitatorUrl?: string;
  /** Public base URL advertised in `/catalog`; defaults to `http://localhost:<port>`. */
  publicUrl?: string;
}

/** Short deterministic research note (no LLM): the paid content of `/research`. */
export function researchSummary(topic: string): string {
  return (
    `Research note on "${topic}": x402 turns HTTP 402 into a payment handshake. The server quotes ` +
    `PaymentRequirements, the client returns a signed Hedera TransferTransaction, and a facilitator ` +
    `pays the fee and settles it, so "${topic}" was delivered against a settled USDC transfer.`
  );
}

/**
 * The payment middleware settles after the handler has written its body, so the handler cannot see
 * the settlement. This middleware (mounted before it) sees the replayed body once `PAYMENT-RESPONSE`
 * is set and fills `paidWith.transactionId` from it.
 */
function settlementReceipt(): RequestHandler {
  return (_req, res, next) => {
    const end = res.end.bind(res) as (...args: unknown[]) => Response;
    res.end = ((chunk?: unknown, ...rest: unknown[]) => {
      const header = res.getHeader("PAYMENT-RESPONSE");
      const patched = typeof header === "string" ? withTransactionId(chunk, header) : undefined;
      if (patched === undefined) return end(chunk, ...rest);
      res.setHeader("Content-Length", Buffer.byteLength(patched));
      res.removeHeader("ETag");
      return end(patched, ...rest);
    }) as Response["end"];
    next();
  };
}

function withTransactionId(chunk: unknown, header: string): string | undefined {
  if (typeof chunk !== "string" && !Buffer.isBuffer(chunk)) return undefined;
  try {
    const body = JSON.parse(chunk.toString()) as { paidWith?: { transactionId?: string | null } };
    if (!body.paidWith || typeof body.paidWith !== "object") return undefined;
    body.paidWith.transactionId = decodePaymentResponseHeader(header).transaction;
    return JSON.stringify(body);
  } catch {
    return undefined;
  }
}

export function createMerchantApp(env: Env, opts: MerchantOptions = {}): express.Application {
  const facilitatorUrl = opts.facilitatorUrl ?? env.X402_FACILITATOR_URL;
  const network = env.X402_NETWORK as Network;
  const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitatorUrl })).register(
    "hedera:*",
    new ExactHederaScheme({ defaultAssets: { [network]: { asset: env.USDC_TOKEN_ID, decimals: 6 } } }),
  );

  const app = express();
  app.get("/health", (_req, res) => {
    res.json({ ok: true, network, payTo: env.MERCHANT_ACCOUNT_ID, asset: env.USDC_TOKEN_ID, facilitatorUrl });
  });

  app.get("/catalog", (req, res) => {
    const base = (opts.publicUrl ?? `http://localhost:${req.socket.localPort ?? ""}`).replace(/\/+$/, "");
    res.json({
      services: [
        {
          name: "research",
          description: "Topic research summary with sources",
          url: `${base}/research?topic=`,
          method: "GET",
          price: RESEARCH_PRICE,
          asset: env.USDC_TOKEN_ID,
          decimals: 6,
          network,
          payTo: env.MERCHANT_ACCOUNT_ID,
        },
      ],
    });
  });

  app.use(settlementReceipt());
  app.use(
    paymentMiddleware(
      {
        "GET /research": {
          accepts: { scheme: "exact", price: RESEARCH_PRICE, network, payTo: env.MERCHANT_ACCOUNT_ID },
          description: "Deterministic research note on a topic",
          mimeType: "application/json",
        },
      },
      resourceServer,
    ),
  );

  app.get("/research", (req, res) => {
    const topic = typeof req.query.topic === "string" && req.query.topic.trim() ? req.query.topic.trim() : "hedera";
    res.json({
      topic,
      summary: researchSummary(topic),
      sources: RESEARCH_SOURCES,
      paidWith: { transactionId: null as string | null },
    });
  });
  return app;
}

/** Starts the merchant on `port`; resolves once it is listening. */
export function startMerchant(env: Env, port: number, opts: MerchantOptions = {}): Promise<Server> {
  const app = createMerchantApp(env, opts);
  return new Promise((resolve, reject) => {
    const server = app.listen(port, (error?: Error) => (error ? reject(error) : resolve(server)));
  });
}
