/**
 * Typed bridge to the HCS-14 helpers of `@hashgraphonline/standards-sdk@0.1.192`. The functions
 * are real ESM exports of the package, but its `.d.ts` files re-export with extensionless paths
 * (`export * from './hcs-14'`) that `moduleResolution: NodeNext` cannot follow, so TypeScript sees
 * no members. The signatures below are copied from `dist/es/hcs-14/{did,caip,types}.d.ts`.
 */
import * as sdk from "@hashgraphonline/standards-sdk";

/** `CanonicalAgentData` in hcs-14/types.d.ts. */
export interface CanonicalAgentData {
  registry: string;
  name: string;
  version: string;
  protocol: string;
  nativeId: string;
  skills: number[];
}

/** `DidRoutingParams` in hcs-14/types.d.ts. */
export interface DidRoutingParams {
  registry?: string;
  proto?: string;
  nativeId?: string;
  uid?: string;
  domain?: string;
  src?: string;
}

/** `ParsedHcs14Did` in hcs-14/types.d.ts. */
export interface ParsedHcs14Did {
  method: "aid" | "uaid";
  id: string;
  params: Record<string, string>;
}

interface Hcs14Exports {
  createUaid(input: CanonicalAgentData, params?: DidRoutingParams, options?: { includeParams?: boolean }): Promise<string>;
  parseHcs14Did(did: string): ParsedHcs14Did;
  toHederaCaip10(network: "mainnet" | "testnet" | "previewnet" | "devnet", accountId: string): string;
}

const hcs14 = sdk as unknown as Hcs14Exports;

export const createUaid: Hcs14Exports["createUaid"] = hcs14.createUaid;
export const parseHcs14Did: Hcs14Exports["parseHcs14Did"] = hcs14.parseHcs14Did;
export const toHederaCaip10: Hcs14Exports["toHederaCaip10"] = hcs14.toHederaCaip10;
