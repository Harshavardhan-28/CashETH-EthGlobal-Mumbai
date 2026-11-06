import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";

const address = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), "not an EVM address")
  .transform((v) => getAddress(v) as Address);

/** `deployments/testnet/addresses.json`. Contract keys appear as tasks deploy them, so all are optional. */
export const AddressesSchema = z.looseObject({
  chainId: z.number().int().positive(),
  kyaRegistry: address.optional(),
  receivableRegistry: address.optional(),
  usdc: address.optional(),
  deployer: address.optional(),
  deployedAt: z.string().optional(),
});

export type Addresses = z.infer<typeof AddressesSchema>;

/** Repo root, resolved from this file's location (packages/shared/{src,dist}/addresses.*). */
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const ADDRESSES_PATH = `${repoRoot}deployments/testnet/addresses.json`;

export function loadAddresses(path: string = ADDRESSES_PATH): Addresses {
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}: run "pnpm tsx scripts/c2-register-demo.ts", which deploys contracts/script/01_DeployCore.s.sol and writes it.`);
  }
  const result = AddressesSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid ${path}: ${issues}`);
  }
  return result.data;
}
