/**
 * C9 evidence: checks that the invoice document behind a receivable is the file the registry committed to.
 * Downloads `GET /invoices/:keccak` from the MCP server, hashes the bytes, reads `detailsCommitment` from
 * `ReceivableRegistry` on Hedera testnet and prints VERIFIED or MISMATCH. Needs no keys, only the public RPC.
 *
 *   pnpm tsx scripts/c9-invoice-verify.ts <receivableId> [keccak256]
 *
 * `MCP_BASE_URL` (default http://localhost:4030) is the MCP server's read API; the document hash defaults to the one
 * `GET /receivables/:id` reports. Exit code 0 when VERIFIED, 1 otherwise.
 */
import { createHash } from "node:crypto";
import { hederaTestnet } from "@casheth/hedera";
import { loadAddresses, ReceivableRegistryAbi } from "@casheth/shared";
import { createPublicClient, http, isHex, keccak256, type Hex } from "viem";

const baseUrl = process.env.MCP_BASE_URL ?? "http://localhost:4030";
const [receivableId, hashArg] = process.argv.slice(2);
if (!receivableId || !isHex(receivableId) || receivableId.length !== 66) {
  console.error("usage: pnpm tsx scripts/c9-invoice-verify.ts <receivableId 0x..32 bytes> [documentKeccak256]");
  process.exit(2);
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(new URL(path, baseUrl));
  if (!res.ok) throw new Error(`GET ${path} answered HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function main(): Promise<boolean> {
  const documentKeccak =
    hashArg ?? (await getJson<{ document?: { keccak: Hex } }>(`/receivables/${receivableId}`)).document?.keccak;
  if (!documentKeccak) throw new Error(`receivable ${receivableId} has no invoice document on ${baseUrl}`);

  const res = await fetch(new URL(`/invoices/${documentKeccak}`, baseUrl));
  if (!res.ok) throw new Error(`GET /invoices/${documentKeccak} answered HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const fileKeccak = keccak256(bytes);

  const registry = loadAddresses().receivableRegistry;
  if (!registry) throw new Error("deployments/testnet/addresses.json has no receivableRegistry");
  const chain = createPublicClient({ chain: hederaTestnet, transport: http() });
  const { detailsCommitment } = await chain.readContract({ address: registry, abi: ReceivableRegistryAbi, functionName: "get", args: [receivableId as Hex] });

  const verified = fileKeccak === detailsCommitment.toLowerCase();
  console.log(`receivable          ${receivableId}`);
  console.log(`document            ${baseUrl}/invoices/${documentKeccak} (${bytes.length} bytes, ${res.headers.get("content-type")})`);
  console.log(`sha256              ${createHash("sha256").update(bytes).digest("hex")}`);
  console.log(`keccak256 of file   ${fileKeccak}`);
  console.log(`registry commitment ${detailsCommitment}  (ReceivableRegistry ${registry})`);
  console.log(verified ? "VERIFIED: the file is exactly what the buyer signed and the registry holds" : "MISMATCH: the served file does not hash to the on-chain commitment");
  return verified;
}

main().then(
  (ok) => process.exit(ok ? 0 : 1),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  },
);
