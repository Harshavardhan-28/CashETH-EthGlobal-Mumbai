/**
 * EIP-712 `ReceivableConfirmation` as verified by `ReceivableRegistry` (domain `AgentReceivables`, version `1`).
 * Field order and types mirror `IReceivableRegistry.ReceivableConfirmation` exactly.
 */
import {
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  type Address,
  type Hex,
  type LocalAccount,
  type TypedDataDomain,
} from "viem";

export const RECEIVABLE_DOMAIN_NAME = "AgentReceivables";
export const RECEIVABLE_DOMAIN_VERSION = "1";

export const RECEIVABLE_CONFIRMATION_TYPES = {
  ReceivableConfirmation: [
    { name: "seller", type: "address" },
    { name: "buyer", type: "address" },
    { name: "currency", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "dueDate", type: "uint64" },
    { name: "buyerRef", type: "bytes32" },
    { name: "detailsCommitment", type: "bytes32" },
    { name: "payTo", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export interface ReceivableConfirmation {
  seller: Address;
  buyer: Address;
  currency: Address;
  amount: bigint;
  dueDate: bigint;
  buyerRef: Hex;
  detailsCommitment: Hex;
  payTo: Address;
  nonce: bigint;
  deadline: bigint;
}

export interface ReceivableDomain extends TypedDataDomain {
  name: typeof RECEIVABLE_DOMAIN_NAME;
  version: typeof RECEIVABLE_DOMAIN_VERSION;
  chainId: number;
  verifyingContract: Address;
}

export function receivableDomain(chainId: number, verifyingContract: Address): ReceivableDomain {
  return { name: RECEIVABLE_DOMAIN_NAME, version: RECEIVABLE_DOMAIN_VERSION, chainId, verifyingContract };
}

export function receivableConfirmationTypedData(domain: ReceivableDomain, message: ReceivableConfirmation) {
  return {
    domain,
    types: RECEIVABLE_CONFIRMATION_TYPES,
    primaryType: "ReceivableConfirmation" as const,
    message,
  };
}

/** The digest `ReceivableRegistry.hashConfirmation` returns for the same confirmation. */
export function hashReceivableConfirmation(domain: ReceivableDomain, message: ReceivableConfirmation): Hex {
  return hashTypedData(receivableConfirmationTypedData(domain, message));
}

/** 65-byte `r || s || v` signature, the layout `register` expects. */
export function signReceivableConfirmation(
  account: LocalAccount,
  domain: ReceivableDomain,
  message: ReceivableConfirmation,
): Promise<Hex> {
  return account.signTypedData(receivableConfirmationTypedData(domain, message));
}

/** Receivable id: `keccak256(abi.encode(buyer, buyerRef))`, so one obligation maps to one id. */
export function computeReceivableId(buyer: Address, buyerRef: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [buyer, buyerRef]));
}
