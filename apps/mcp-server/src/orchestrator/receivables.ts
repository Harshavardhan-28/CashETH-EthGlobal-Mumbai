/**
 * Receivable intake: the seller uploads the terms (pending), the buyer signs the EIP-712 confirmation, and the
 * server verifies, dedupes, scores and runs the KYA checks off-chain before `ReceivableRegistry.register`, then
 * mints the HTS receivable NFT and records it on HCS.
 */
import { scoreReceivable, type Decision } from "@casheth/engine";
import {
  computeReceivableId,
  hashscan,
  ReceivableRegistryAbi,
  receivableConfirmationTypedData,
  receivableDomain,
  type ReceivableConfirmation,
} from "@casheth/shared";
import { encodeAbiParameters, encodeFunctionData, isHex, keccak256, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { jsonSafe, record } from "./audit.js";
import { actor, addr, bytes32, bytes32OrHash, sameAddress, STATE, STATE_NAMES, txLink, units, requireParty } from "./common.js";
import { fail, ToolError, type ToolErrorCode } from "./errors.js";
import { checkDocumentAgainstTerms, documentOfCommitment } from "./invoices.js";
import type { PendingReceivable } from "./pending.js";
import type { Caller, Orchestrator } from "./types.js";

const DAY = 86_400n;
/** How long the buyer has to sign (the confirmation's `deadline`). */
export const CONFIRMATION_TTL_SECONDS = DAY;
/** BUILD.md 6.3 rule 4: due date 1 to 120 days out. */
const MIN_TENOR = DAY;
const MAX_TENOR = 120n * DAY;
const MIN_BUYER_LEVEL = 3;
const MIN_SELLER_LEVEL = 2;

export type UploadInput = {
  seller?: string;
  buyer: string;
  amount: string;
  dueDate: number;
  buyerRef: string;
  /** Exactly one of `detailsCommitment` and `documentKeccak` is needed (both may be given, when equal). */
  detailsCommitment?: string;
  /** keccak256 of a document stored with `upload_invoice_document`; becomes the commitment. */
  documentKeccak?: string;
};

/** The commitment is the document's hash when a document is named; otherwise the caller's own 32 bytes. */
function commitmentOf(input: UploadInput): { detailsCommitment: Hex; documentKeccak?: Hex } {
  const documentKeccak = input.documentKeccak ? bytes32(input.documentKeccak, "documentKeccak") : undefined;
  const given = input.detailsCommitment ? bytes32(input.detailsCommitment, "detailsCommitment") : undefined;
  if (documentKeccak && given && documentKeccak !== given) {
    fail("BAD_INPUT", "detailsCommitment must equal documentKeccak when both are given", { field: "detailsCommitment" });
  }
  const detailsCommitment = documentKeccak ?? given;
  if (!detailsCommitment) fail("BAD_INPUT", "give documentKeccak (an uploaded invoice document) or detailsCommitment", { field: "documentKeccak" });
  return { detailsCommitment, ...(documentKeccak ? { documentKeccak } : {}) };
}

function confirmationOf(p: PendingReceivable): ReceivableConfirmation {
  return {
    seller: p.seller,
    buyer: p.buyer,
    currency: p.currency,
    amount: BigInt(p.amount),
    dueDate: BigInt(p.dueDate),
    buyerRef: p.buyerRef,
    detailsCommitment: p.detailsCommitment,
    payTo: p.payTo,
    nonce: BigInt(p.nonce),
    deadline: BigInt(p.deadline),
  };
}

function typedDataOf(p: PendingReceivable) {
  return receivableConfirmationTypedData(receivableDomain(p.chainId, p.verifyingContract), confirmationOf(p));
}

/** `upload_receivable`: stores the pending terms and returns the typed data the buyer must sign. */
export async function uploadReceivable(o: Orchestrator, caller: Caller, input: UploadInput) {
  const seller = input.seller ? addr(input.seller, "seller") : caller.agent;
  requireParty(caller, seller, "seller");
  const buyer = addr(input.buyer, "buyer");
  if (sameAddress(buyer, seller)) fail("SELF_DEALING", "the buyer cannot be the seller");
  const amount = units(input.amount, "amount");
  const dueDate = BigInt(input.dueDate);
  const buyerRef = bytes32OrHash(input.buyerRef);
  const { detailsCommitment, documentKeccak } = commitmentOf(input);

  const a = o.chain.addresses();
  const id = computeReceivableId(buyer, buyerRef);
  if ((await o.chain.receivableState(id)) !== STATE.None) {
    await record(o, { type: "ReceivableRejected", id, code: "DUPLICATE_RECEIVABLE", stage: "upload", ...actor(caller) });
    fail("DUPLICATE_RECEIVABLE", "a receivable with this buyer and buyerRef is already registered", { id });
  }
  if (documentKeccak) {
    const check = checkDocumentAgainstTerms(o, seller, documentKeccak, { amount: amount.toString(), dueDate: input.dueDate, buyerRef: input.buyerRef });
    if (!check.ok) {
      await record(o, { type: "ReceivableRejected", id, code: "INVOICE_MISMATCH", stage: "upload", documentKeccak, ...actor(caller) });
      fail("INVOICE_MISMATCH", "the invoice document does not match the submitted terms", { id, mismatches: check.mismatches });
    }
  }
  const now = o.now();
  const nonce = await o.chain.buyerNonce(buyer);
  const pendingId = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint64" }, { type: "bytes32" }, { type: "bytes32" }],
      [seller, buyer, a.usdc, amount, dueDate, buyerRef, detailsCommitment],
    ),
  );
  const pending: PendingReceivable = {
    pendingId,
    id,
    seller,
    buyer,
    currency: a.usdc,
    amount: amount.toString(),
    dueDate: dueDate.toString(),
    buyerRef,
    detailsCommitment,
    ...(documentKeccak ? { documentKeccak } : {}),
    payTo: a.repaymentRouter,
    nonce: nonce.toString(),
    deadline: (now + CONFIRMATION_TTL_SECONDS).toString(),
    chainId: a.chainId,
    verifyingContract: a.receivableRegistry,
    createdAt: new Date(Number(now) * 1000).toISOString(),
  };
  o.pending.put(pending);
  await record(o, {
    type: "ReceivableUploaded",
    id,
    pendingId,
    seller,
    buyer,
    amount: pending.amount,
    dueDate: pending.dueDate,
    ...(documentKeccak ? { documentKeccak } : {}),
    ...actor(caller),
  });
  return { pendingId, id, confirmationRequest: { typedData: jsonSafe(typedDataOf(pending)) } };
}

async function reject(o: Orchestrator, caller: Caller, id: Hex, code: ToolErrorCode, message: string): Promise<never> {
  await record(o, { type: "ReceivableRejected", id, code, stage: "confirm", ...actor(caller) });
  throw new ToolError(code, message, { id });
}

/** Decision as stored in events (bigints as strings). */
export type StoredDecision = Omit<Decision, "limit"> & { limit: string };

export function storedDecision(d: Decision): StoredDecision {
  return { approved: d.approved, score: d.score, advanceBps: d.advanceBps, limit: d.limit.toString(), reasons: [...d.reasons] };
}

export type DecisionInputs = {
  buyerReputation: { onTime: number; late: number; defaults: number };
  sellerLevel: number;
  buyerLevel: number;
  tenorDays: number;
};

/**
 * `confirm_receivable`: verifies the buyer's signature off-chain, then the registry rules the contract will enforce
 * (deadline and tenor, nonce, KYA levels, owner separation, dedupe), scores the receivable, registers it with the
 * coordinator key, records `ReceivableConfirmed` (with the decision), mints the NFT and records `NftMinted`.
 */
export async function confirmReceivable(o: Orchestrator, caller: Caller, input: { pendingId: string; signature: string }) {
  const pending = o.pending.get(input.pendingId);
  if (!pending) fail("NOT_FOUND", `no pending receivable ${input.pendingId}`);
  requireParty(caller, pending.buyer, "buyer");
  if (!isHex(input.signature)) fail("BAD_INPUT", "signature must be 0x-prefixed hex");
  const signature = input.signature as Hex;
  const { id } = pending;
  const typedData = typedDataOf(pending);

  let signer: Address;
  try {
    signer = await recoverTypedDataAddress({ ...typedData, signature });
  } catch {
    return reject(o, caller, id, "BAD_BUYER_SIG", "the signature does not recover");
  }
  if (!sameAddress(signer, pending.buyer)) return reject(o, caller, id, "BAD_BUYER_SIG", `signature recovers ${signer}, not the buyer`);

  const now = await o.chain.latestTimestamp();
  const dueDate = BigInt(pending.dueDate);
  if (now > BigInt(pending.deadline)) return reject(o, caller, id, "TERM_INELIGIBLE", "the confirmation deadline has passed; upload again");
  if (dueDate < now + MIN_TENOR || dueDate > now + MAX_TENOR) {
    return reject(o, caller, id, "TERM_INELIGIBLE", "the due date must be 1 to 120 days out");
  }
  if ((await o.chain.buyerNonce(pending.buyer)) !== BigInt(pending.nonce)) {
    return reject(o, caller, id, "BAD_NONCE", "the buyer's nonce moved since upload; upload again");
  }

  const [buyerKya, sellerKya] = await Promise.all([o.chain.kyaAgent(pending.buyer), o.chain.kyaAgent(pending.seller)]);
  const live = (a: { revoked: boolean; expiresAt: bigint }) => !a.revoked && (a.expiresAt === 0n || a.expiresAt > now);
  if (buyerKya.level < MIN_BUYER_LEVEL || sellerKya.level < MIN_SELLER_LEVEL || !live(buyerKya) || !live(sellerKya)) {
    return reject(o, caller, id, "KYA_FAIL", `KYA levels buyer ${buyerKya.level} (needs 3), seller ${sellerKya.level} (needs 2), both unrevoked`);
  }
  if (buyerKya.ownerGroup.toLowerCase() === sellerKya.ownerGroup.toLowerCase()) {
    return reject(o, caller, id, "SELF_DEALING", "buyer and seller share an owner group");
  }
  if ((await o.chain.receivableState(id)) !== STATE.None) {
    return reject(o, caller, id, "DUPLICATE_RECEIVABLE", "this obligation is already registered");
  }

  const buyerReputation = await o.chain.reputation(pending.buyer);
  const decision = scoreReceivable({
    amount: BigInt(pending.amount),
    dueDate,
    now,
    buyerReputation,
    sellerLevel: sellerKya.level,
    buyerLevel: buyerKya.level,
  });
  const decisionInputs: DecisionInputs = {
    buyerReputation,
    sellerLevel: sellerKya.level,
    buyerLevel: buyerKya.level,
    tenorDays: Number((dueDate - now) / DAY),
  };

  const a = o.chain.addresses();
  const { txHash } = await o.chain
    .send("coordinator", {
      to: a.receivableRegistry,
      data: encodeFunctionData({ abi: ReceivableRegistryAbi, functionName: "register", args: [confirmationOf(pending), signature] }),
      description: "ReceivableRegistry.register(confirmation, buyerSig)",
    })
    .catch(async (err: unknown) => {
      if (err instanceof ToolError) await record(o, { type: "ReceivableRejected", id, code: err.code, stage: "contract", ...actor(caller) });
      throw err;
    });

  const stored = storedDecision(decision);
  const confirmed = await record(o, {
    type: "ReceivableConfirmed",
    id,
    seller: pending.seller,
    buyer: pending.buyer,
    amount: pending.amount,
    dueDate: pending.dueDate,
    txHash,
    hashscan: txLink(txHash),
    decision: stored,
    decisionInputs,
    ...actor(caller),
  });
  const hcsSeq = typeof confirmed.hcsSeq === "number" ? confirmed.hcsSeq : undefined;

  let nft: { serial: number; txId: string } | undefined;
  let nftError: string | undefined;
  if (!o.nft.tokenId) {
    nftError = "RECEIVABLE_NFT_TOKEN_ID is not configured";
  } else {
    try {
      nft = await o.nft.mint({ id, hcsSeq: hcsSeq ?? 0 });
      await record(o, {
        type: "NftMinted",
        id,
        tokenId: o.nft.tokenId,
        serial: nft.serial,
        txId: nft.txId,
        hashscan: hashscan.tx(nft.txId),
        ...actor(caller),
      });
    } catch (err) {
      nftError = err instanceof Error ? err.message : String(err);
      o.log("nft mint failed", { id, error: nftError });
    }
  }

  const document = documentOfCommitment(o, pending.detailsCommitment);
  return {
    id,
    txHash,
    hashscan: txLink(txHash),
    ...(document ? { document } : {}),
    nftSerial: nft?.serial ?? null,
    ...(nftError ? { nftError } : {}),
    hcsSeq: hcsSeq ?? null,
    ...(typeof confirmed.hcsError === "string" ? { hcsError: confirmed.hcsError } : {}),
    decision: stored,
  };
}

/** The latest stored decision for `id`, or a fresh score from chain state when none was recorded here. */
export async function decisionFor(o: Orchestrator, id: Hex): Promise<{ decision: StoredDecision; inputs?: DecisionInputs; source: "event" | "recomputed" }> {
  const event = o.events
    .byId(id)
    .filter((e) => e.type === "ReceivableConfirmed" && e.decision)
    .at(-1);
  if (event) {
    return { decision: event.decision as StoredDecision, inputs: event.decisionInputs as DecisionInputs | undefined, source: "event" };
  }
  const r = await o.chain.receivable(id);
  if (r.state === STATE.None) fail("NOT_FOUND", `receivable ${id} is not registered`);
  const [now, buyerReputation, buyerKya, sellerKya] = await Promise.all([
    o.chain.latestTimestamp(),
    o.chain.reputation(r.buyer),
    o.chain.kyaAgent(r.buyer),
    o.chain.kyaAgent(r.seller),
  ]);
  const decision = scoreReceivable({ amount: r.amount, dueDate: r.dueDate, now, buyerReputation, sellerLevel: sellerKya.level, buyerLevel: buyerKya.level });
  return {
    decision: storedDecision(decision),
    inputs: { buyerReputation, sellerLevel: sellerKya.level, buyerLevel: buyerKya.level, tenorDays: Number((r.dueDate - now) / DAY) },
    source: "recomputed",
  };
}

/** R14 `GET /receivables/:id` shape. */
export type ReceivableDetails = {
  id: Hex;
  state: string;
  seller: Address;
  buyer: Address;
  amount: string;
  dueDate: number;
  funded: string;
  debt: string;
  positions: { maker: Address; principal: string; aprBps: number; fee: string }[];
  evidence: { label: string; url: string }[];
  /** The invoice document behind the receivable: `verified` = the registry commitment equals the stored file's hash. */
  document?: { keccak: Hex; verified: boolean };
};

function evidenceFor(o: Orchestrator, id: Hex): { label: string; url: string }[] {
  const out: { label: string; url: string }[] = [];
  for (const e of o.events.byId(id)) {
    if (typeof e.hashscan === "string") out.push({ label: e.type, url: e.hashscan });
    if (typeof e.hcsSeq === "number" && typeof e.hcsTxId === "string") {
      out.push({ label: `${e.type} (HCS #${e.hcsSeq})`, url: hashscan.tx(e.hcsTxId) });
    }
    if (e.type === "NftMinted" && typeof e.tokenId === "string" && typeof e.serial === "number") {
      out.push({ label: `Receivable NFT #${e.serial}`, url: `${hashscan.token(e.tokenId)}/${e.serial}` });
    }
  }
  return out;
}

/** On-chain state, facility, lender positions and evidence links of one receivable (pending ones included). */
export async function receivableDetails(o: Orchestrator, rawId: string): Promise<ReceivableDetails> {
  const id = bytes32(rawId, "id");
  const r = await o.chain.receivable(id);
  if (r.state === STATE.None) {
    const pending = o.pending.byReceivableId(id);
    if (!pending) fail("NOT_FOUND", `receivable ${id} is neither registered nor pending`);
    return {
      id,
      state: "Pending",
      seller: pending.seller,
      buyer: pending.buyer,
      amount: pending.amount,
      dueDate: Number(pending.dueDate),
      funded: "0",
      debt: "0",
      positions: [],
      evidence: evidenceFor(o, id),
      // Not on the registry yet, so nothing can be verified against it.
      ...(pending.documentKeccak ? { document: { keccak: pending.documentKeccak, verified: false } } : {}),
    };
  }
  const [info, makers, debt] = await Promise.all([o.chain.facilityInfo(id), o.chain.makers(id), o.chain.lenderDue(id)]);
  const positions = await Promise.all(
    makers.map(async (maker) => {
      const [p, due] = await Promise.all([o.chain.position(id, maker), o.chain.dueOf(id, maker)]);
      return { maker, principal: p.principal.toString(), aprBps: p.aprBps, fee: (p.paidFee + due.fee).toString() };
    }),
  );
  const document = documentOfCommitment(o, r.detailsCommitment);
  return {
    id,
    state: STATE_NAMES[r.state] ?? `Unknown(${r.state})`,
    seller: r.seller,
    buyer: r.buyer,
    amount: r.amount.toString(),
    dueDate: Number(r.dueDate),
    funded: info.funded.toString(),
    debt: debt.toString(),
    positions,
    evidence: evidenceFor(o, id),
    ...(document ? { document } : {}),
  };
}
