import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { z } from "zod";

const nonEmpty = z.string().min(1);

/** Demo agent accounts; `scripts/setup-accounts.ts` writes `<PREFIX>_ID/_KEY/_EVM` to `.env.accounts`. */
export const DEMO_ACCOUNTS = [
  "SELLER",
  "BUYER",
  "WORKER_RESEARCH",
  "WORKER_COMPUTE",
  "LENDER_A",
  "LENDER_B",
  "LENDER_C",
  "COORDINATOR",
  "COSIGNER",
  "KYA_ISSUER",
] as const;

export type DemoAccount = (typeof DEMO_ACCOUNTS)[number];
type DemoAccountVar = `${DemoAccount}_${"ID" | "KEY" | "EVM"}`;

const demoAccountVars = Object.fromEntries(
  DEMO_ACCOUNTS.flatMap((prefix) =>
    (["ID", "KEY", "EVM"] as const).map((suffix) => [`${prefix}_${suffix}`, z.string().optional()]),
  ),
) as Record<DemoAccountVar, z.ZodOptional<z.ZodString>>;

/** Required variables; anything else in the environment passes through untouched. */
export const EnvSchema = z.looseObject({
  HEDERA_NETWORK: nonEmpty,
  HEDERA_CHAIN_ID: z.coerce.number().int().positive(),
  HEDERA_JSON_RPC_URL: z.url(),
  HEDERA_MIRROR_NODE_URL: z.url(),
  HEDERA_OPERATOR_ID: nonEmpty,
  HEDERA_OPERATOR_KEY: nonEmpty,
  MERCHANT_ACCOUNT_ID: nonEmpty,
  MERCHANT_KEY: nonEmpty,
  USDC_TOKEN_ID: nonEmpty,
  USDC_EVM_ADDRESS: nonEmpty,
  X402_FACILITATOR_URL: z.url(),
  X402_NETWORK: nonEmpty,
  ...demoAccountVars,
});

export type Env = z.infer<typeof EnvSchema>;

export interface LoadEnvOptions {
  /** Validate this object instead of reading `.env` files into `process.env`. */
  source?: Record<string, string | undefined>;
}

/** Repo root, resolved from this file's location (packages/shared/{src,dist}/env.*). */
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function readEnvFiles(): void {
  for (const name of [".env", ".env.accounts"]) {
    const path = `${repoRoot}${name}`;
    if (existsSync(path)) config({ path, override: false, quiet: true });
  }
}

export function loadEnv(options: LoadEnvOptions = {}): Env {
  let source = options.source;
  if (!source) {
    readEnvFiles();
    source = process.env;
  }
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  return result.data;
}
