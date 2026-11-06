// In-memory log of settled payments, shown at GET /receipts so the demo
// dashboard can display a live feed. It resets when the instance restarts,
// which is fine for a demo (run Cloud Run with max-instances=1).

const MAX = 100;
const receipts = [];

function hashscanUrl(network, transactionId) {
  if (!transactionId) return null;
  const net = network?.endsWith("mainnet") ? "mainnet" : "testnet";
  return `https://hashscan.io/${net}/transaction/${encodeURIComponent(transactionId)}`;
}

export function recordReceipt({ paymentPayload, requirements, result }, decimals) {
  const atomic = result?.amount ?? requirements?.amount ?? "0";
  const entry = {
    at: new Date().toISOString(),
    resource: paymentPayload?.resource?.url ?? null,
    payer: result?.payer ?? null,
    payTo: requirements?.payTo ?? null,
    asset: requirements?.asset ?? null,
    amountAtomic: String(atomic),
    amountUsdc: Number(atomic) / 10 ** decimals,
    network: result?.network ?? requirements?.network ?? null,
    transactionId: result?.transaction ?? null,
    hashscan: hashscanUrl(result?.network, result?.transaction),
  };
  receipts.unshift(entry);
  if (receipts.length > MAX) receipts.length = MAX;
  console.log(JSON.stringify({ event: "payment_settled", ...entry }));
  return entry;
}

export function listReceipts() {
  const totalUsdc = receipts.reduce((sum, r) => sum + r.amountUsdc, 0);
  return { count: receipts.length, totalUsdc: Number(totalUsdc.toFixed(6)), receipts };
}
