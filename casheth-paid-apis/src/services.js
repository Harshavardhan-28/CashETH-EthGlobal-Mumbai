// The paid services themselves. They are deliberately simple and
// self-contained so the demo never depends on a third-party API key.
// If a handler responds with an error status, x402 does not settle,
// so the caller is not charged for a failed call.

import dns from "node:dns/promises";
import net from "node:net";

// ---------- 1. Price feed ($0.50) ----------

const BASE_PRICES = {
  HBAR: 0.27,
  ETH: 3450,
  BTC: 98500,
  USDC: 1,
  SOL: 182,
  INR: 0.0118,
};

// Smooth, repeatable movement so numbers change between calls
// but stay believable on stage.
function demoPrice(symbol, nowMs) {
  const base = BASE_PRICES[symbol];
  if (symbol === "USDC") return { price: 1, change24hPct: 0 };
  const seed = [...symbol].reduce((s, c) => s + c.charCodeAt(0), 0);
  const t = nowMs / 60000; // minutes
  const wave = Math.sin(t / 7 + seed) * 0.012 + Math.sin(t / 53 + seed * 2) * 0.02;
  const change = Math.sin(t / 180 + seed) * 4.5;
  const decimals = base < 1 ? 6 : 2;
  return {
    price: Number((base * (1 + wave)).toFixed(decimals)),
    change24hPct: Number(change.toFixed(2)),
  };
}

export function priceFeed(req, res) {
  const raw = String(req.query.symbols || req.query.symbol || "HBAR,ETH,BTC");
  const symbols = [...new Set(raw.toUpperCase().split(",").map((s) => s.trim()).filter(Boolean))];
  const unknown = symbols.filter((s) => !(s in BASE_PRICES));
  if (symbols.length === 0 || symbols.length > 10 || unknown.length) {
    return res.status(400).json({
      error: "invalid_symbols",
      message: `Use up to 10 of: ${Object.keys(BASE_PRICES).join(", ")}`,
      unknown,
    });
  }
  const now = Date.now();
  res.json({
    service: "price-feed",
    source: "casheth-demo-oracle",
    quote: "USD",
    asOf: new Date(now).toISOString(),
    prices: symbols.map((symbol) => ({ symbol, ...demoPrice(symbol, now) })),
  });
}

// ---------- 2. Web scrape ($1.00) ----------

const MAX_BYTES = 750_000;
const FETCH_TIMEOUT_MS = 8000;

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v6 = ip.toLowerCase();
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") ||
    v6.startsWith("fe80") || v6.startsWith("::ffff:");
}

// Block internal targets (localhost, VPC, the Cloud Run metadata server).
async function assertPublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw Object.assign(new Error("url is not a valid URL"), { status: 400 });
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw Object.assign(new Error("only http and https URLs are allowed"), { status: 400 });
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".internal") || host.endsWith(".local")) {
    throw Object.assign(new Error("internal hosts are not allowed"), { status: 400 });
  }
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (addresses.some(isPrivateAddress)) {
    throw Object.assign(new Error("private network addresses are not allowed"), { status: 400 });
  }
  return url;
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

// Page chrome (menus, headers, footers, cookie banners) is dropped so the
// text is the actual content an agent wants to read or summarise.
const CHROME_TAGS = "script|style|noscript|svg|template|nav|header|footer|aside|form|button|select|dialog|menu|iframe";

function tagsToText(html) {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/?(p|div|li|h[1-6]|br|tr|section|article|blockquote|dd|dt)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\u00a0]+/g, " ")
    .split("\n")
    .map((line) =>
      line
        .replace(/\[\s*(\d+|[a-z]|citation needed)\s*\]/gi, "") // [ 8 ] style citation marks
        .replace(/\s+([,.;:!?)\]%’])/g, "$1") // "HBAR ." -> "HBAR."
        .replace(/([(\[])\s+/g, "$1")
        .replace(/\s{2,}/g, " ")
        .trim(),
    )
    .filter(Boolean);
}

function htmlToText(html) {
  let body = html.replace(new RegExp(`<(${CHROME_TAGS})\\b[\\s\\S]*?<\\/\\1>`, "gi"), " ");
  // Prefer <main> or <article> when the page has one with real content.
  for (const tag of ["main", "article"]) {
    const m = body.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*)<\\/${tag}>`, "i"));
    if (m && tagsToText(m[1]).join(" ").length > 400) {
      body = m[1];
      break;
    }
  }
  const lines = tagsToText(body);
  // Keep headings and prose; drop leftover one- or two-word link labels ("Learn More").
  const kept = lines.filter((line) => line.split(" ").length >= 3 || /[.!?:]$/.test(line));
  return [...new Set(kept)].join("\n").trim();
}

function meta(html, name) {
  const re = new RegExp(
    `<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`,
    "i",
  );
  const m = html.match(re);
  return m ? decodeEntities(m[1]).trim() : null;
}

async function readLimited(response) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function webScrape(req, res) {
  const target = req.query.url;
  if (!target) {
    return res.status(400).json({ error: "missing_url", message: "Pass ?url=https://..." });
  }
  try {
    let url = await assertPublicUrl(String(target));
    let response;
    // Follow up to 3 redirects by hand so each hop is checked.
    for (let hop = 0; hop < 4; hop++) {
      response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "user-agent": "CashETH-Demo-Scraper/0.1", accept: "text/html,text/plain;q=0.9,*/*;q=0.5" },
      });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        url = await assertPublicUrl(new URL(location, url).toString());
        continue;
      }
      break;
    }
    if (!response.ok) {
      return res.status(502).json({ error: "upstream_error", status: response.status });
    }
    const body = await readLimited(response);
    const isHtml = (response.headers.get("content-type") || "").includes("html");
    const text = isHtml ? htmlToText(body) : body.trim();
    const title = isHtml ? (body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim() : null;
    const links = isHtml ? (body.match(/<a\s[^>]*href=/gi) || []).length : 0;
    res.json({
      service: "web-scrape",
      url: url.toString(),
      fetchedAt: new Date().toISOString(),
      title: title ? decodeEntities(title) : null,
      description: isHtml ? meta(body, "description") || meta(body, "og:description") : null,
      wordCount: text.split(/\s+/).filter(Boolean).length,
      links,
      text: text.slice(0, 8000),
      truncated: text.length > 8000,
    });
  } catch (err) {
    const status = err.status || (err.name === "TimeoutError" ? 504 : 502);
    res.status(status).json({ error: "scrape_failed", message: err.message });
  }
}

// ---------- 3. LLM summary ($2.00) ----------
// A small extractive summarizer: scores sentences by word frequency and
// keeps the best ones in their original order. No model key needed.

const STOP = new Set(
  ("a an the and or but if then of to in on for with at by from as is are was were be been " +
    "it its this that these those which who whom what when where why how not no can could " +
    "will would should may might do does did has have had i you he she they we our your their " +
    "his her them us me my about into over after before more most also than so such very just")
    .split(" "),
);

function splitSentences(text) {
  const seen = new Set();
  return text
    .split(/\n+/)
    .flatMap((line) => line.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/))
    .map((s) => s.trim())
    .filter((s) => {
      const n = s.split(" ").length;
      // Real sentences: 6-60 words with some function words (menus have none).
      const stopRatio = s.toLowerCase().split(" ").filter((w) => STOP.has(w)).length / n;
      if (n < 6 || n > 60 || stopRatio < 0.12 || seen.has(s)) return false;
      seen.add(s);
      return true;
    });
}

function words(s) {
  return s.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) || [];
}

export function llmSummary(req, res) {
  const text = String(req.body?.text || "").trim();
  const maxSentences = Math.min(Math.max(Number(req.body?.maxSentences) || 3, 1), 10);
  if (text.length < 40) {
    return res.status(400).json({
      error: "text_too_short",
      message: 'POST JSON {"text": "...", "maxSentences": 3} with at least 40 characters',
    });
  }
  if (text.length > 100_000) {
    return res.status(413).json({ error: "text_too_long", message: "Limit is 100,000 characters" });
  }

  const sentences = splitSentences(text);
  const freq = new Map();
  for (const w of words(text)) if (!STOP.has(w) && w.length > 2) freq.set(w, (freq.get(w) || 0) + 1);
  const top = Math.max(1, ...freq.values());

  const scored = sentences.map((s, i) => {
    const ws = words(s).filter((w) => freq.has(w));
    const score = ws.reduce((sum, w) => sum + freq.get(w) / top, 0) / Math.sqrt(words(s).length || 1);
    // Headlines without end punctuation make choppy summaries; prefer real sentences.
    const isSentence = /[.!?]["')]?$/.test(s);
    return { s, i, score: (score + (i === 0 ? 0.15 : 0)) * (isSentence ? 1 : 0.4) };
  });
  const chosen = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSentences)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.s);

  const keywords = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);

  res.json({
    service: "llm-summary",
    model: "casheth-extractive-v1",
    summary: chosen.length
      ? chosen.map((x) => (/[.!?]["')]?$/.test(x) ? x : `${x}.`)).join(" ")
      : text.slice(0, 400),
    bullets: chosen,
    keywords,
    stats: { inputChars: text.length, inputSentences: sentences.length, outputSentences: chosen.length },
  });
}

// ---------- 4. Premium data ($5.00, unapproved payee) ----------
// Exists so the demo can show CashETH refusing to pay a payee that is not
// on the agent's allowlist. If a payment ever does go through, it still
// returns something sensible.

export function premiumData(req, res) {
  res.json({
    service: "premium-data",
    note: "This endpoint pays a different account on purpose (demo of a blocked payee).",
    dataset: "exclusive-market-signals",
    signals: [
      { market: "HBAR/USD", signal: "accumulate", confidence: 0.62 },
      { market: "ETH/USD", signal: "hold", confidence: 0.55 },
    ],
  });
}
