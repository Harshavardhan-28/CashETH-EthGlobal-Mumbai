import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const entityId = z.string().regex(/^\d+\.\d+\.\d+$/, "expected a Hedera entity id like 0.0.123");

/** Hedera-native ids written by `scripts/c2-topic-and-nft.ts` to `deployments/testnet/hedera.json`. */
export const HederaIdsSchema = z.object({
  network: z.literal("testnet"),
  hcsAuditTopicId: entityId,
  receivableNftTokenId: entityId,
  createdAt: z.string().min(1),
});

export type HederaIds = z.infer<typeof HederaIdsSchema>;

/** Resolved from this file's location (packages/shared/{src,dist}/hederaIds.*) to the repo root. */
export const HEDERA_IDS_PATH = fileURLToPath(
  new URL("../../../deployments/testnet/hedera.json", import.meta.url),
);

export function loadHederaIds(options: { path?: string } = {}): HederaIds {
  const path = options.path ?? HEDERA_IDS_PATH;
  if (!existsSync(path)) {
    throw new Error(`${path} not found; run scripts/c2-topic-and-nft.ts to create the topic and collection`);
  }
  const result = HederaIdsSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid ${path}: ${issues}`);
  }
  return result.data;
}
