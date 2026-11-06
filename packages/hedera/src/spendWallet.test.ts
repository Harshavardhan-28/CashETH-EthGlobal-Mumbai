import { loadEnv, type Env } from "@casheth/shared";
import { AccountId, Client, PrivateKey, TransactionId, type AccountAllowanceApproveTransaction } from "@hiero-ledger/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mirror } from "./mirror.js";
import {
  approveFacilityAllowance,
  decodeMirrorKey,
  facilityAllowanceTx,
  resolveContractId,
  signWithAll,
} from "./spendWallet.js";

const USDC = "0.0.429274";
const WALLET = "0.0.11338499";
const FACILITY = "0.0.11339001";
const MAX_INT64 = 2n ** 63n - 1n;

/** Public keys only: the spike S3 spend wallet's key as returned by `GET /accounts/0.0.11338499`. */
const SPIKE_WALLET_MIRROR_KEY = {
  _type: "ProtobufEncoded",
  key:
    "2a4e0802124a0a233a2103992d6204ee754421f9643bf73bf1826fea6def1b2549656d9df96d3a205e29470a233a21031ca1230064d86ff1e48a4825d999f30dea7f006f29c20e4f62d4af7b3397e0a1",
};

const signers = (tx: AccountAllowanceApproveTransaction): string[] =>
  tx
    .getSignatures()
    .getFlatSignatureList()
    .flatMap((pairs) => [...pairs.keys()].map((k) => k.toStringRaw()));

const stubEnv = { HEDERA_MIRROR_NODE_URL: "https://mirror.example/api/v1" } as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("facility allowance (offline)", () => {
  it("approveFacilityAllowance builds a transaction with the right token, owner, spender and amount and is signed by all keys", async () => {
    const worker = PrivateKey.generateECDSA();
    const cosigner = PrivateKey.generateECDSA();
    const params = { walletId: WALLET, tokenId: USDC, spenderContractId: FACILITY, units: 1_000_000_000n };

    // The builder on its own, frozen without a network.
    const tx = facilityAllowanceTx(params)
      .setNodeAccountIds([new AccountId(3)])
      .setTransactionId(TransactionId.generate("0.0.1001"))
      .freeze();
    await signWithAll(tx, [worker, cosigner]);
    const [approval, ...rest] = tx.tokenApprovals;
    expect(rest).toHaveLength(0);
    expect(approval!.tokenId.toString()).toBe(USDC);
    expect(approval!.ownerAccountId!.toString()).toBe(WALLET);
    expect(approval!.spenderAccountId!.toString()).toBe(FACILITY);
    expect(approval!.amount!.toString()).toBe("1000000000");
    expect(signers(tx).sort()).toEqual([worker.publicKey.toStringRaw(), cosigner.publicKey.toStringRaw()].sort());

    // The full helper: frozen against an offline client, the executor receives the doubly signed tx.
    const client = Client.forNetwork({ "127.0.0.1:50211": "0.0.3" }, { scheduleNetworkUpdate: false }).setOperator(
      "0.0.1001",
      PrivateKey.generateECDSA(),
    );
    let executed: AccountAllowanceApproveTransaction | undefined;
    try {
      const txId = await approveFacilityAllowance(client, { ...params, keys: [worker, cosigner] }, async (_c, t) => {
        executed = t as AccountAllowanceApproveTransaction;
        return { receipt: {} as never, txId: "0.0.1001@1.2" };
      });
      expect(txId).toBe("0.0.1001@1.2");
    } finally {
      client.close();
    }
    expect(executed!.isFrozen()).toBe(true);
    expect(executed!.tokenApprovals[0]!.spenderAccountId!.toString()).toBe(FACILITY);
    expect(new Set(signers(executed!))).toEqual(
      new Set([worker.publicKey.toStringRaw(), cosigner.publicKey.toStringRaw()]),
    );
  });

  it("units >= 2^63 throws", () => {
    const base = { walletId: WALLET, tokenId: USDC, spenderContractId: FACILITY };
    expect(() => facilityAllowanceTx({ ...base, units: MAX_INT64 + 1n })).toThrow(/int64/);
    expect(() => facilityAllowanceTx({ ...base, units: 2n ** 64n - 1n })).toThrow(/int64/);
    expect(() => facilityAllowanceTx({ ...base, units: -1n })).toThrow(/negative/);
    expect(facilityAllowanceTx({ ...base, units: MAX_INT64 }).tokenApprovals[0]!.amount!.toString()).toBe(
      MAX_INT64.toString(),
    );
  });

  it("resolveContractId parses contract_id from a stubbed mirror response", async () => {
    const evm = "0x1111111111111111111111111111111111111111";
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ contract_id: FACILITY, evm_address: evm }), { status: 200 });
    });
    await expect(resolveContractId(stubEnv, evm)).resolves.toBe(FACILITY);
    expect(urls).toEqual([`https://mirror.example/api/v1/contracts/${evm}`]);
  });

  it("resolveContractId rejects a malformed address and a response without a contract id", async () => {
    await expect(resolveContractId(stubEnv, "0x1234")).rejects.toThrow(/EVM address/);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ evm_address: "0x" }), { status: 200 }));
    await expect(resolveContractId(stubEnv, `0x${"22".repeat(20)}`)).rejects.toThrow(/contract_id/);
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    await expect(resolveContractId(stubEnv, `0x${"22".repeat(20)}`)).rejects.toThrow(/404/);
  });
});

describe("decodeMirrorKey (offline)", () => {
  it("decodes the mirror node's ProtobufEncoded threshold key into threshold and ECDSA keys", () => {
    expect(decodeMirrorKey(SPIKE_WALLET_MIRROR_KEY)).toEqual({
      threshold: 2,
      keys: [
        { type: "ECDSA_SECP256K1", publicKey: "03992d6204ee754421f9643bf73bf1826fea6def1b2549656d9df96d3a205e2947" },
        { type: "ECDSA_SECP256K1", publicKey: "031ca1230064d86ff1e48a4825d999f30dea7f006f29c20e4f62d4af7b3397e0a1" },
      ],
    });
  });

  it("reports a single-key account as threshold 1", () => {
    expect(decodeMirrorKey({ _type: "ECDSA_SECP256K1", key: "02aa" })).toEqual({
      threshold: 1,
      keys: [{ type: "ECDSA_SECP256K1", publicKey: "02aa" }],
    });
  });
});

// Live testnet suites run only with `LIVE=1` (they need .env): LIVE=1 pnpm -F @casheth/hedera test
describe.skipIf(!process.env.LIVE)("spend wallets (live testnet)", () => {
  it("spend wallet has a 2-of-2 key list on the mirror node", async (ctx) => {
    const env = loadEnv();
    const walletId = env.SPEND_WALLET_RESEARCH_ID as string | undefined;
    if (!walletId) {
      ctx.skip("SPEND_WALLET_RESEARCH_ID is not in .env.accounts; run `pnpm tsx scripts/c5-spend-wallets.ts` first");
      return;
    }
    const account = await mirror.account(env, walletId);
    expect(account.account).toBe(walletId);
    expect(account.key?._type).toBe("ProtobufEncoded");
    const decoded = decodeMirrorKey(account.key!);
    expect(decoded.threshold).toBe(2);
    expect(decoded.keys.map((k) => k.type)).toEqual(["ECDSA_SECP256K1", "ECDSA_SECP256K1"]);
    expect(decoded.keys.map((k) => k.publicKey)).toEqual([
      PrivateKey.fromStringECDSA(env.WORKER_RESEARCH_KEY!).publicKey.toStringRaw(),
      PrivateKey.fromStringECDSA(env.COSIGNER_KEY!).publicKey.toStringRaw(),
    ]);
    expect(account.evm_address).toBe(`0x${AccountId.fromString(walletId).toEvmAddress()}`);
  });
});
