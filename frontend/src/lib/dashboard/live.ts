"use client";

/**
 * Live reads for the agent dashboard: the agent's wallet balances straight from the public Hedera mirror node
 * (no backend involved) and `/receivables/:id` details from the MCP read API. Both poll, one request batch at a time.
 */
import { useEffect, useState } from "react";
import { API_URL, ApiError, type ReceivableDetails } from "@/lib/admin/api";

export const MIRROR_URL = process.env.NEXT_PUBLIC_MIRROR_URL || "https://testnet.mirrornode.hedera.com";
export const USDC_TOKEN_ID = process.env.NEXT_PUBLIC_USDC_TOKEN_ID || "0.0.429274";

export type Wallet = {
  status: "loading" | "ok" | "error";
  accountId?: string;
  hbar?: number; // tinybars
  usdc?: string; // USDC base units
  updatedAt?: number;
};

type MirrorAccount = { account?: string; balance?: { balance?: number; tokens?: { token_id: string; balance: number }[] } };

export async function fetchWallet(evmAddress: string, fetchImpl: typeof fetch = (i, init) => fetch(i, init)): Promise<Omit<Wallet, "status">> {
  const res = await fetchImpl(`${MIRROR_URL}/api/v1/accounts/${evmAddress}?transactions=false`, { cache: "no-store" });
  if (!res.ok) throw new Error(`mirror node ${res.status}`);
  const acct = (await res.json()) as MirrorAccount;
  let usdc = acct.balance?.tokens?.find((t) => t.token_id === USDC_TOKEN_ID)?.balance;
  if (usdc === undefined && acct.account) {
    const t = await fetchImpl(`${MIRROR_URL}/api/v1/accounts/${acct.account}/tokens?token.id=${USDC_TOKEN_ID}`, { cache: "no-store" });
    if (t.ok) usdc = ((await t.json()) as { tokens?: { balance: number }[] }).tokens?.[0]?.balance;
  }
  return {
    ...(acct.account ? { accountId: acct.account } : {}),
    ...(typeof acct.balance?.balance === "number" ? { hbar: acct.balance.balance } : {}),
    ...(typeof usdc === "number" ? { usdc: String(usdc) } : {}),
    updatedAt: Date.now(),
  };
}

export const WALLET_POLL_MS = 15_000;

/** Polls the wallet of `evmAddress`; `enabled: false` (sample data) skips the network. */
export function useWallet(evmAddress: string | undefined, enabled = true, load: typeof fetchWallet = fetchWallet): Wallet {
  const [wallet, setWallet] = useState<Wallet>({ status: "loading" });

  useEffect(() => {
    if (!evmAddress || !enabled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setWallet({ status: "error" });
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setWallet({ status: "loading" });
    const poll = async () => {
      try {
        const w = await load(evmAddress);
        if (!stopped) setWallet({ status: "ok", ...w });
      } catch {
        if (!stopped) setWallet((prev) => (prev.status === "ok" ? prev : { status: "error" }));
      }
      if (!stopped) timer = setTimeout(poll, WALLET_POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [evmAddress, enabled, load]);

  return wallet;
}

export const RECEIVABLES_POLL_MS = 10_000;
const MAX_TRACKED = 25;

export type ReceivableLoader = (id: string) => Promise<ReceivableDetails>;

/** `GET /receivables/:id` on the MCP read API (docs/API.md section 4). */
export const fetchReceivable: ReceivableLoader = async (id) => {
  const res = await fetch(`${API_URL.replace(/\/+$/, "")}/receivables/${encodeURIComponent(id)}`, { cache: "no-store" });
  if (!res.ok) throw new ApiError(res.status, res.statusText || `HTTP ${res.status}`);
  return (await res.json()) as ReceivableDetails;
};

/** Polls `/receivables/:id` for `ids` (newest first, capped); a failed id keeps its last good details. */
export function useReceivables(ids: string[], enabled = true, load: ReceivableLoader = fetchReceivable): ReadonlyMap<string, ReceivableDetails> {
  const [details, setDetails] = useState<ReadonlyMap<string, ReceivableDetails>>(new Map());
  const key = ids.slice(0, MAX_TRACKED).join(",");

  useEffect(() => {
    if (!enabled || !key) return;
    const tracked = key.split(",");
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const got = await Promise.all(tracked.map((id) => load(id).catch(() => undefined)));
      if (stopped) return;
      setDetails((prev) => {
        const next = new Map(prev);
        got.forEach((d, i) => d && next.set(tracked[i].toLowerCase(), d));
        return next;
      });
      timer = setTimeout(poll, RECEIVABLES_POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [key, enabled, load]);

  return details;
}

export const formatHbar = (tinybars: number | undefined): string =>
  typeof tinybars === "number" ? `${(tinybars / 1e8).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })} ℏ` : "—";
