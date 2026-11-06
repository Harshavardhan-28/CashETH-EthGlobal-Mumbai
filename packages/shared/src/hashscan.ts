const BASE = "https://hashscan.io/testnet";

export const hashscan = {
  tx: (txId: string): string => `${BASE}/transaction/${txId}`,
  contract: (addr: string): string => `${BASE}/contract/${addr}`,
  account: (id: string): string => `${BASE}/account/${id}`,
  token: (id: string): string => `${BASE}/token/${id}`,
  topic: (id: string): string => `${BASE}/topic/${id}`,
  schedule: (id: string): string => `${BASE}/schedule/${id}`,
} as const;
