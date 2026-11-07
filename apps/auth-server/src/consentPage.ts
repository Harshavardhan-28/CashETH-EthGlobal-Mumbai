/**
 * The demo consent page (`GET /authorize` with `AUTH_DEMO_GRANT=true`). Claude Code signs in as the seller agent only,
 * so the page is one approval card: the client, the seller it will act as, and that seller's permissions in plain words.
 */
import { scopesForRole } from "@casheth/shared";

export const SELLER_ROLE = 1;

export type SellerChoice = { address: `0x${string}`; level: number };

export type ConsentPageInput = {
  clientName: string;
  action: string;
  /** Hidden OAuth parameters echoed back on submit. */
  fields: Record<string, string>;
  sellers: SellerChoice[];
  /** Scopes the client asked for; empty means the seller's full row. */
  requested: string[];
};

const SCOPE_TEXT: Record<string, string> = {
  "receivable:write": "Upload invoices and register receivables",
  "receivable:read": "Read receivables and their status",
  "credit:read": "Read credit scores and quotes",
  "facility:open": "Open a credit facility funded by the lenders",
  "budget:write": "Set spending budgets for its worker agents",
  "spend:reserve": "Spend the credit on paid APIs through x402",
  "stats:read": "Read agent and lender statistics",
};

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function permissions(level: number, requested: string[]): string[] {
  const allowed = scopesForRole(SELLER_ROLE, level);
  return requested.length ? allowed.filter((s) => requested.includes(s)) : allowed;
}

function sellerOption(s: SellerChoice, checked: boolean): string {
  return (
    `<label class="seller"><input type="radio" name="agent" value="${s.address}"${checked ? " checked" : ""}>` +
    `<span class="who"><b>Seller agent</b><code title="${s.address}">${short(s.address)}</code></span>` +
    `<span class="kya">KYA level ${s.level}</span></label>`
  );
}

function body(input: ConsentPageInput): string {
  const client = escapeHtml(input.clientName);
  if (input.sellers.length === 0) {
    return (
      `<h1>No seller agent is registered</h1>` +
      `<p class="lead">${client} signs in as the seller agent, but <code>KYARegistry</code> has no live seller. Register one, then try again.</p>`
    );
  }
  const scopes = permissions(input.sellers[0]!.level, input.requested);
  const hidden = Object.entries(input.fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("");
  const list = scopes.map((s) => `<li><span>${escapeHtml(SCOPE_TEXT[s] ?? s)}</span><code>${escapeHtml(s)}</code></li>`).join("");
  return (
    `<h1>Sign in as your seller agent</h1>` +
    `<p class="lead"><b>${client}</b> wants to act as this seller on CashETH.</p>` +
    `<form method="post" action="${escapeHtml(input.action)}">${hidden}` +
    `<fieldset>${input.sellers.map((s, i) => sellerOption(s, i === 0)).join("")}</fieldset>` +
    `<h2>It will be able to</h2><ul class="scopes">${list}</ul>` +
    // Approve comes first in the markup so Enter submits it; the row is reversed to show it on the right.
    `<div class="actions"><button type="submit" name="grant" value="1" autofocus>Approve</button>` +
    `<button type="submit" name="grant" value="0" class="ghost">Cancel</button></div></form>` +
    `<p class="note">Access lasts 8 hours and renews on its own. Lenders, the buyer and the workers are run by the server.</p>`
  );
}

const STYLE = `
:root{--bg:#f6f5f1;--card:#fff;--ink:#16181d;--ink-2:#5b616e;--line:#e4e2db;--accent:#0f7b5f;--accent-ink:#fff;--warn:#8a5a00;--warn-bg:#fff6e0}
@media (prefers-color-scheme:dark){:root{--bg:#0f1114;--card:#181b20;--ink:#eceef2;--ink-2:#9aa1ad;--line:#2a2e35;--accent:#35c493;--accent-ink:#06150f;--warn:#f0c060;--warn-bg:#2a2110}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px}
.brand{font-weight:700;letter-spacing:.02em;margin-bottom:20px}.brand span{color:var(--accent)}
h1{font-size:21px;line-height:1.25;margin:0 0 6px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-2);margin:20px 0 8px}
.lead{color:var(--ink-2);margin:0 0 18px}.lead b{color:var(--ink)}
fieldset{border:0;margin:0;padding:0;display:grid;gap:8px}
.seller{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--line);border-radius:12px;cursor:pointer}
.seller:has(input:checked){border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.seller input{accent-color:var(--accent);margin:0}
.who{display:grid;flex:1}.kya{font-size:12px;color:var(--ink-2)}
code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink-2)}
.scopes{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.scopes li{display:grid;grid-template-columns:14px 1fr auto;gap:10px;align-items:baseline}
.scopes li::before{content:"✓";color:var(--accent);font-weight:700}
.scopes code{font-size:11.5px;white-space:nowrap}
.actions{display:flex;flex-direction:row-reverse;gap:10px;margin-top:24px}
button{font:inherit;font-weight:600;border-radius:10px;padding:10px 18px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-ink);cursor:pointer}
button.ghost{background:transparent;color:var(--ink);border-color:var(--line)}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.note{font-size:13px;color:var(--ink-2);margin:18px 0 0}
.demo{margin-top:16px;font-size:12.5px;color:var(--warn);background:var(--warn-bg);border-radius:10px;padding:8px 12px}
`;

export function consentPage(input: ConsentPageInput): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>CashETH sign-in</title><style>${STYLE}</style></head><body><main>` +
    `<div class="brand">Cash<span>ETH</span></div>${body(input)}` +
    `<p class="demo">Demo sign-in on Hedera testnet: there is no owner login, so keep this server on localhost.</p>` +
    `</main></body></html>`
  );
}
