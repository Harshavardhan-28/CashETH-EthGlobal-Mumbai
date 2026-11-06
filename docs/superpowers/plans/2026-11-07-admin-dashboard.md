# Admin Dashboard and MCP Docs Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A password-gated `/admin` console (GCP-style, CashETH theme) that shows, live and historically, every on-chain action of the AI agents connected to the CashETH MCP server, plus a docs page that matches the MCP server.

**Architecture:** Pure, tested TypeScript modules in `frontend/src/lib/admin/` turn the MCP read API (`/health`, `/events`, `/agents`, `/lenders`) into plain-English rows, runs, KPIs and chart buckets. A polling hook feeds a client-side `AdminApp` (views: Overview, Agents, Activity, Runs) built from small components in `frontend/src/components/admin/`. A server-side password check sets an HMAC cookie that the `/admin` route verifies. No backend changes.

**Tech Stack:** Next.js 16.4 (App Router, `cacheComponents: true`), React 19, TypeScript (target ES2017), CSS modules, vitest + Testing Library (jsdom). npm (the frontend has its own `package-lock.json`).

**Spec:** `docs/superpowers/specs/2026-11-07-admin-dashboard-design.md`

## Global Constraints

- All work under `frontend/`. Run commands from `frontend/`. No backend (`apps/`, `packages/`, `agents/`) changes.
- No new runtime dependencies. No chart library: charts and sparklines are inline SVG.
- No BigInt literals (`123n`); tsconfig targets ES2017. Amount maths on decimal strings.
- Amounts from the API are USDC base units as decimal strings, 6 decimals. Display as `$1,234.56`.
- Read API base URL: `process.env.NEXT_PUBLIC_API_URL || "http://localhost:4030"`. Poll interval 3000 ms.
- HCS audit topic: `process.env.NEXT_PUBLIC_HCS_TOPIC_ID || "0.0.11338927"`. HCS proof URL: `https://hashscan.io/testnet/topic/<topic>/message/<hcsSeq>`.
- Password: `process.env.ADMIN_PASSWORD || "admin@01"`, checked server-side only. Session cookie `casheth_admin`, httpOnly, SameSite=Lax, path `/`, max-age 43200 s, value = HMAC-SHA256 hex of `"casheth-admin-v1"` keyed by `process.env.ADMIN_SESSION_SECRET || "casheth-demo-admin-secret"`.
- "Active" agent = it was the actor of an event in the last 120 s; otherwise "Idle".
- Primary row text is a plain-English sentence, never a raw event type. Sample data appears only with the visible label `Sample data · MCP server offline`.
- Keep the design system: tokens in `src/app/globals.css` (both `:root` dark and `html[data-theme="light"]`), Geist fonts, `Logo`, `ThemeToggle`. Role colours `var(--seller)`, `var(--buyer)`, `var(--worker)`, `var(--lender)`; add `--mcp` (neutral, e.g. `var(--muted)`) if needed.
- Next 16: read `frontend/node_modules/next/dist/docs/01-app/02-guides/authentication-with-cache-components.md` and `.../01-getting-started/16-proxy.md` before writing the gate; follow them over memory.
- Every task ends green on: `npx vitest run`, `npx tsc --noEmit`, `npm run lint`. Task 6 onward also `npm run build`.

## Review Focus

1. MCP server down at page load, or going down mid-demo → status pill `MCP offline`, last good data stays, polling keeps going and recovers; if nothing ever loaded, labelled sample data. (Task 5 tests)
2. An event of unknown type, or missing `amount` / `id` / `agent` → generic sentence, never `undefined`, `NaN` or a crash. (Task 2 tests)
3. Agent addresses differing only in case (checksummed vs lowercase) → still resolve to the same agent. (Task 2 tests)
4. Amount strings that are huge, `"0"`, or non-numeric → exact formatting, `"—"` for garbage. (Task 1 tests)
5. Fresh server with zero events and zero agents → every view shows a friendly empty state, no live-run crash. (Task 6 and 7 tests)

---

### Task 1: Typed read-API client and formatters

**Files:**
- Create: `frontend/src/lib/admin/api.ts`, `frontend/src/lib/admin/format.ts`
- Test: `frontend/src/lib/admin/api.test.ts`, `frontend/src/lib/admin/format.test.ts`

**Interfaces:**
- Produces (`api.ts`): types `AuditEvent`, `AgentStats`, `LenderYield`, `Health` exactly as `docs/API.md` §4 (port from `git show origin/feat/frontend-integration:frontend/src/lib/api.ts`; `AuditEvent.type` is `string` widened with the known union so unknown types type-check); `class ApiError extends Error { status: number }`; `createApiClient(baseUrl: string, fetchImpl?: typeof fetch): { health(): Promise<Health>; events(): Promise<AuditEvent[]>; agents(): Promise<AgentStats[]>; lenders(): Promise<LenderYield[]> }`; `API_URL: string`; `HCS_TOPIC_ID: string`.
- Produces (`format.ts`): `formatUsdc(units: string | undefined): string`; `shortAddress(addr: string): string`; `relativeTime(iso: string, nowMs: number): string`; `initials(name: string): string`; `humanizeCode(code: string): string`.

- [ ] **Step 1: Write failing tests**

`format.test.ts`:
```ts
expect(formatUsdc("800000000")).toBe("$800.00");
expect(formatUsdc("800000")).toBe("$0.80");
expect(formatUsdc("0")).toBe("$0.00");
expect(formatUsdc("123456789012345678")).toBe("$123,456,789,012.34"); // truncates, no float loss
expect(formatUsdc("abc")).toBe("—");
expect(formatUsdc(undefined)).toBe("—");
expect(shortAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
const now = Date.parse("2026-11-07T12:00:00Z");
expect(relativeTime("2026-11-07T11:59:56Z", now)).toBe("4s ago");
expect(relativeTime("2026-11-07T11:59:59.5Z", now)).toBe("just now"); // < 2 s
expect(relativeTime("2026-11-07T11:58:00Z", now)).toBe("2m ago");
expect(relativeTime("2026-11-07T09:00:00Z", now)).toBe("3h ago");
expect(relativeTime("2026-11-05T12:00:00Z", now)).toBe("2d ago");
expect(initials("Worker 1")).toBe("W1");
expect(initials("Lender A")).toBe("LA");
expect(initials("Seller")).toBe("S");
expect(humanizeCode("AGENT_BUDGET_EXCEEDED")).toBe("Over its budget");
expect(humanizeCode("SOME_NEW_CODE")).toBe("Some new code");
```
Map at least: `AGENT_BUDGET_EXCEEDED` "Over its budget", `TX_LIMIT_EXCEEDED` "Above its per-payment limit", `DAILY_LIMIT_EXCEEDED` "Over its daily limit", `MERCHANT_NOT_ALLOWED` "Merchant not on its allow-list", `MERCHANT_URL_NOT_ALLOWED` same, `BAD_BUYER_SIG` "Buyer signature did not check out", `KYA_FAIL` "Agent identity check failed", `KYA_LEVEL_TOO_LOW` "Agent trust level too low", `SELF_DEALING` "Seller and buyer are the same party", `DUPLICATE_RECEIVABLE` "Invoice already financed", `CREDIT_DECLINED` "Credit check declined", `COSIGNER_REFUSED` "Payment co-signer refused", `RESERVATION_EXPIRED` "Reservation expired".

`api.test.ts`: with a fake `fetchImpl`, `createApiClient("http://x").events()` GETs `http://x/events` and returns the JSON; a 503 response rejects with `ApiError` whose `status === 503`; a network rejection propagates.

- [ ] **Step 2: Run** `npx vitest run src/lib/admin` → FAIL (modules missing).
- [ ] **Step 3: Implement** both files. `formatUsdc`: validate `/^\d+$/`, split integer/fraction by string slicing (pad to ≥7 chars), 2 decimals truncated, thousands separators by regex.
- [ ] **Step 4: Run** `npx vitest run src/lib/admin` → PASS.
- [ ] **Step 5: Commit** `feat(admin): typed read-API client and formatters`

---

### Task 2: Plain-English narration of audit events

**Files:**
- Create: `frontend/src/lib/admin/narrate.ts`
- Test: `frontend/src/lib/admin/narrate.test.ts`

**Interfaces:**
- Consumes: Task 1 types and formatters.
- Produces:
```ts
export type ActorRole = "seller" | "buyer" | "worker" | "lender" | "mcp";
export type Actor = { key: string; name: string; role: ActorRole; initials: string; address?: string };
export type Tone = "ok" | "blocked" | "warn" | "info";
export type Narrated = {
  seq: number; ts: string; type: string; id?: string; spendId?: string;
  actor: Actor; sentence: string; detail: string; tone: Tone;
  amount?: string;            // base units, when the event moved money
  proofUrl?: string;
};
export function resolveActor(e: AuditEvent, agents: AgentStats[]): Actor;
export function narrate(e: AuditEvent, agents: AgentStats[], hcsTopicId: string): Narrated;
export function narrateAll(events: AuditEvent[], agents: AgentStats[], hcsTopicId: string): Narrated[]; // newest first (seq desc)
```

Before writing templates, read the real event fields: `grep -n "record(o, {" -A14 ../apps/mcp-server/src/orchestrator/*.ts` (e.g. which events carry `amount`, `merchant`, `fills`/lenders, `evmAddress`, `name`, `role`, `level`, `code`). Use those field names.

Actor resolution order: `e.agent` matched case-insensitively to `agents[].address` → `e.agentUaid` to `agents[].uaid` → for `AgentRegistered`, `e.evmAddress`/`e.name`/`e.role` of the registered agent → type-inferred generic actor (`ReceivableUploaded`/`InvoiceDocumentStored`/`BudgetsSet` → "Seller" seller; `ReceivableConfirmed`/`Repaid` → "Buyer" buyer; `Spend*` → "Worker" worker; `StrategyShipped`/`StrategyDocked`/`FacilityFunded` → "Lenders" lender) → `{ name: "CashETH MCP", role: "mcp" }`. `key` = lowercase address when known, else `role:name`. Name = agent `label` (`AgentStats.label`).

Sentence (actor rendered separately, so the sentence omits it) / detail / tone:

| type | sentence | detail | tone |
|---|---|---|---|
| AgentRegistered | `joined CashETH` | `Identity registered on Hedera · trust level {level}` | info |
| InvoiceDocumentStored | `stored an invoice document` | `Only its fingerprint goes on Hedera` | info |
| ReceivableUploaded | `uploaded invoice {id} for {amount}` | `Waiting for the buyer to confirm` | ok |
| ReceivableConfirmed | `confirmed it owes {amount} on invoice {id}` | `Signed by the buyer's agent` | ok |
| ReceivableRejected | `was refused for invoice {id}` | `{humanizeCode(code)} · the guardrail worked` | blocked |
| NftMinted | `turned invoice {id} into an on-chain asset` | `Receivable NFT minted on Hedera` | ok |
| StrategyShipped | `offered capital to lend` | `Lending strategy published on 1inch Aqua` | info |
| StrategyDocked | `withdrew its lending offer` | `Capital returned to the lender` | info |
| FacilityFunded | `lent {amount} against invoice {id}` | `Cheapest offers filled first` | ok |
| BudgetsSet | `set spending budgets for its workers` | `Each worker gets a hard limit` | info |
| SpendReserved | `set aside {amount} to pay {merchant}` | `Reserved inside its budget` | info |
| SpendCommitted | `paid {amount} to {merchant}` | `x402 payment settled on Hedera` | ok |
| SpendReleased | `cancelled a {amount} reservation` | `Unused money went back to the budget` | info |
| SpendRejected | `was blocked from spending {amount}` | `{humanizeCode(code)} · the guardrail worked` | blocked |
| Repaid | `repaid {amount} on invoice {id}` | `Lenders were paid back first` | ok |
| Overdue | `flagged invoice {id} as overdue` | `Set on time by Hedera's schedule service` | warn |
| Defaulted | `flagged invoice {id} as defaulted` | `Lenders' losses are now recorded` | blocked |
| Disputed | `marked invoice {id} as disputed` | `Financing paused while it is resolved` | warn |
| LlmToolCall | `asked the MCP server to {tool}` | `Outcome: {outcome}` | info (blocked if outcome ≠ ok) |
| LlmRunFinished | `finished its task` | `Status: {status}` | info |
| anything else | `recorded {type}` | `""` | info |

Missing placeholders degrade cleanly: no amount → drop ` for {amount}` / use `money`; no id → `an invoice`; merchant → `shortAddress(merchant)`, or `a merchant`. Never emit `undefined`/`NaN`. Overdue/Defaulted actor is "CashETH MCP" unless `agent` resolves. Proof: `e.hashscan` (string) → else HCS URL when `typeof e.hcsSeq === "number"` → else undefined. `amount` set for FacilityFunded, SpendCommitted, Repaid, ReceivableUploaded, ReceivableConfirmed, SpendReserved, SpendRejected when present.

- [ ] **Step 1: Write failing tests**: one test per table row asserting `sentence`, `tone`, and `actor.name` with a realistic event; plus:
  - `resolveActor` matches `agent: "0xABCDEF…"` to an `/agents` entry `address: "0xabcdef…"` (case-insensitive).
  - unknown type `"SomethingNew"` with no fields → `sentence === "recorded SomethingNew"`, actor "CashETH MCP".
  - `SpendCommitted` without `amount` or `merchant` → sentence contains no `undefined`/`NaN`.
  - proof: `hashscan` wins over `hcsSeq`; `hcsSeq: 12` with topic `0.0.1` → `https://hashscan.io/testnet/topic/0.0.1/message/12`; neither → `undefined`.
  - `narrateAll` returns seq-descending.
- [ ] **Step 2: Run** `npx vitest run src/lib/admin/narrate.test.ts` → FAIL.
- [ ] **Step 3: Implement** `narrate.ts` (a `Record<type, (e) => {sentence, detail, tone}>` table).
- [ ] **Step 4: Run** → PASS; full `npx vitest run` green.
- [ ] **Step 5: Commit** `feat(admin): plain-English narration of audit events`

---

### Task 3: Derived views — runs, KPIs, chart buckets, agent rows

**Files:**
- Create: `frontend/src/lib/admin/derive.ts`
- Test: `frontend/src/lib/admin/derive.test.ts`

**Interfaces:**
- Consumes: Task 2 `Narrated`, `Actor`, `ActorRole`; Task 1 types.
- Produces:
```ts
export type Range = "1h" | "24h" | "7d" | "all";
export const RANGE_MS: Record<Exclude<Range, "all">, number>; // 3_600_000, 86_400_000, 604_800_000
export function inRange(items: Narrated[], range: Range, nowMs: number): Narrated[];

export type RunStatus = "in_progress" | "repaid" | "overdue" | "defaulted" | "rejected";
export type RunStep = { label: string; done: boolean; current: boolean; who?: string; ts?: string };
export type Run = { id: string; title: string; status: RunStatus; amount?: string; startedAt: string; lastAt: string; events: Narrated[] /* oldest first */; steps: RunStep[] /* always 5 */ };
export const SETUP_RUN_ID = "setup";
export function groupRuns(items: Narrated[]): Run[]; // newest lastAt first; the setup group (if any) last

export type Kpis = { agents: number; activeNow: number; financed: string; financedInRange: string; spent: string; payments: number; records: number; lastRecordAt?: string; spark: { agents: number[]; financed: number[]; spent: number[]; records: number[] } /* 12 points each */ };
export function computeKpis(all: Narrated[], agents: AgentStats[], range: Range, nowMs: number): Kpis;

export type RoleBucket = { start: number; counts: Record<ActorRole, number> };
export function roleBuckets(items: Narrated[], range: Range, nowMs: number, buckets?: number /* 12 */): RoleBucket[];

export type AgentRow = { stats: AgentStats; actor: Actor; status: "active" | "idle"; last?: Narrated; money: string /* e.g. "$38.20 spent" */ };
export function agentRows(agents: AgentStats[], all: Narrated[], lenders: LenderYield[], nowMs: number): AgentRow[]; // active first, then by last activity
export const ACTIVE_WINDOW_MS = 120_000;
```

Runs: key = `item.id`. Before writing, check whether spend events carry the receivable `id` (`../apps/mcp-server/src/orchestrator/spend.ts`). If they do not, attach each `Spend*` event to the most recent run with a `FacilityFunded` at or before it and no `Repaid` before it; otherwise to the setup group. Events with no id and no attachment → setup group (`id: "setup"`, `title: "Setup & other"`, steps all not done, status `in_progress`). Run `title` = `Invoice {id}`; `amount` = first `amount` from ReceivableUploaded/Confirmed/FacilityFunded.

Steps (labels exact): `Invoice uploaded` (ReceivableUploaded or InvoiceDocumentStored), `Buyer confirmed` (ReceivableConfirmed or NftMinted), `Lenders funded` (FacilityFunded), `Agents spending` (SpendReserved or SpendCommitted), `Repaid` (Repaid). `done` when any matching event exists; `who`/`ts` from the first match; `current` = first not-done step while status is `in_progress`. Status: Defaulted → `defaulted`; else ReceivableRejected → `rejected`; else Repaid → `repaid`; else Overdue → `overdue`; else `in_progress`.

KPIs: `agents` = `agents.length`; `activeNow` = distinct actor keys with an event within `ACTIVE_WINDOW_MS`; `financed` = sum of FacilityFunded amounts (all time) as units string; `financedInRange` = same within range; `spent`/`payments` = sum/count of SpendCommitted within range; `records` = count within range; `lastRecordAt` = newest ts. Sparklines: 12 equal buckets across the range (for `all`, from oldest event to now): cumulative financed, cumulative spent, per-bucket record count, and distinct active actors per bucket. Sum units as decimal strings (write a small `addUnits(a, b)` string adder; no BigInt literals, no float).

Money label by role: worker → sum of `spendByMerchant` values `"{$} spent"`; lender → its `/lenders` entry lent amount `"{$} lent"` (match by address, case-insensitive; field per API.md `LenderYield`); seller → sum of FacilityFunded amounts of runs whose `Invoice uploaded` actor key is this seller `"{$} borrowed"`; buyer → sum of its Repaid amounts `"{$} repaid"`; else `"—"`.

- [ ] **Step 1: Write failing tests** with a fixture of ~12 narrated items covering PO-1002 (full lifecycle, repaid) and PO-1003 (uploaded → funded → one SpendCommitted) and a setup AgentRegistered:
  - `groupRuns` → `["PO-1003", "PO-1002", "setup"]` order; PO-1002 `status === "repaid"` and all 5 steps done; PO-1003 steps done `[true,true,true,true,false]`, `current` on index 4; amounts set.
  - Defaulted wins over Repaid/Overdue; ReceivableRejected → `rejected`.
  - `groupRuns([])` → `[]`.
  - `computeKpis` on the fixture: `financed` equals the exact string sum; `activeNow` counts only events within 120 s of `nowMs`; every spark array has length 12; empty input → zeros, `financed === "0"`, no throw.
  - `roleBuckets(items, "1h", now)` → 12 buckets, counts per role sum to the in-range count.
  - `inRange` with `"all"` returns everything; with `"1h"` drops a 2-hour-old item.
  - `agentRows`: an agent with an event 30 s ago is `active` and sorted first; worker money `"$1.20 spent"` from `spendByMerchant {"0xm": "1200000"}`.
- [ ] **Step 2: Run** `npx vitest run src/lib/admin/derive.test.ts` → FAIL.
- [ ] **Step 3: Implement** `derive.ts`.
- [ ] **Step 4: Run** → PASS; full suite green.
- [ ] **Step 5: Commit** `feat(admin): runs, KPIs, chart buckets and agent rows`

---

### Task 4: Password gate

**Files:**
- Create: `frontend/src/lib/admin/session.ts`, `frontend/src/app/api/admin/login/route.ts`, `frontend/src/app/api/admin/logout/route.ts`, `frontend/src/app/admin/login/page.tsx`, `frontend/src/components/admin/LoginForm.tsx`, `frontend/src/components/admin/Login.module.css`, `frontend/src/app/admin/page.tsx` (gate + placeholder body replaced in Task 6)
- Possibly create: `frontend/src/proxy.ts` (only if the Next 16 docs make it the right place for the redirect)
- Test: `frontend/src/lib/admin/session.test.ts`, `frontend/src/app/api/admin/login/route.test.ts`, `frontend/src/components/admin/LoginForm.test.tsx`

**Interfaces:**
- Produces (`session.ts`, server-only, `node:crypto`): `SESSION_COOKIE = "casheth_admin"`; `SESSION_MAX_AGE = 43200`; `checkPassword(input: string): boolean` (constant-time compare of SHA-256 digests against `ADMIN_PASSWORD || "admin@01"`); `sessionToken(): string`; `isValidSession(value: string | undefined): boolean` (constant-time).
- Produces (routes): `POST /api/admin/login` body `{ password: string }` → 200 `{ ok: true }` + `Set-Cookie` per Global Constraints (`secure` when `NODE_ENV === "production"`), 401 `{ ok: false, error: "Wrong password" }`, 400 on bad JSON; `POST /api/admin/logout` → 200, cookie cleared (max-age 0).
- `/admin` without a valid cookie → redirect to `/admin/login`. `/admin/login` with a valid cookie → redirect to `/admin`.

Read `node_modules/next/dist/docs/01-app/02-guides/authentication-with-cache-components.md` first and use its pattern for reading `cookies()` under `cacheComponents: true` (Suspense boundary or proxy, as it prescribes).

Login page look: centred card (max-width 380px) on `var(--bg)` with the soft green glow used by the hero (`--glow-a/b`), `Logo`, title `Admin console`, subtitle `Live view of the agents on the CashETH MCP server`, password input (label `Password`, `autoFocus`, `type="password"`), full-width accent button `Sign in` (shows `Signing in…` while pending), inline error in `var(--err)`; on success `router.replace("/admin")`. Theme toggle in a corner.

- [ ] **Step 1: Write failing tests**
  - `session.test.ts`: `checkPassword("admin@01") === true`; `checkPassword("admin@02") === false`; `checkPassword("") === false`; with `process.env.ADMIN_PASSWORD = "x"` (restored after) `checkPassword("x") === true`; `isValidSession(sessionToken()) === true`; `isValidSession(undefined) === false`; `isValidSession(sessionToken().slice(1) + "0") === false`.
  - `route.test.ts`: call the exported `POST` with `new Request(…, { method: "POST", body: JSON.stringify({ password: "admin@01" }) })` → status 200 and a `set-cookie` header containing `casheth_admin=` and `HttpOnly`; wrong password → 401 with JSON `error: "Wrong password"` and no cookie; body `"not json"` → 400.
  - `LoginForm.test.tsx` (mock `fetch` and `next/navigation`): typing a password and submitting POSTs `{ password }` to `/api/admin/login`; on 401 shows `Wrong password`; on 200 calls `replace("/admin")`.
- [ ] **Step 2: Run** `npx vitest run src/lib/admin/session.test.ts src/app/api src/components/admin/LoginForm.test.tsx` → FAIL.
- [ ] **Step 3: Implement** session, routes, login page, gate in `/admin/page.tsx` (placeholder body `Admin console` + sign-out button for now).
- [ ] **Step 4: Run** tests → PASS; `npx tsc --noEmit`, `npm run lint`, `npm run build` pass. Then `npm run start -- -p 3100 &` and verify: `curl -sI localhost:3100/admin` → 307 to `/admin/login`; `curl -s -c /tmp/cj -X POST localhost:3100/api/admin/login -H 'content-type: application/json' -d '{"password":"admin@01"}'` → `{"ok":true}`; `curl -s -b /tmp/cj -o /dev/null -w '%{http_code}' localhost:3100/admin` → 200. Stop the server. Put the outputs in the report.
- [ ] **Step 5: Commit** `feat(admin): password-gated admin route`

---

### Task 5: Live data hook with offline handling and sample data

**Files:**
- Create: `frontend/src/lib/admin/useAdminData.ts`, `frontend/src/lib/admin/sample.ts`
- Test: `frontend/src/lib/admin/useAdminData.test.ts`

**Interfaces:**
- Consumes: Task 1 `createApiClient`, `API_URL`; types.
- Produces:
```ts
export type ConnStatus = "loading" | "live" | "offline";
export type AdminData = { status: ConnStatus; sample: boolean; events: AuditEvent[]; agents: AgentStats[]; lenders: LenderYield[]; health?: Health; updatedAt?: number };
export function useAdminData(opts?: { client?: ApiClient; intervalMs?: number /* 3000 */ }): AdminData;
// sample.ts
export const SAMPLE_EVENTS: AuditEvent[]; export const SAMPLE_AGENTS: AgentStats[]; export const SAMPLE_LENDERS: LenderYield[];
// ApiClient = ReturnType<typeof createApiClient> (export it from api.ts if Task 1 did not)
```
Behaviour: fetch all four in parallel immediately, then every `intervalMs` (setTimeout chain, no overlap; cleared on unmount). Success → `status "live"`, `sample false`, data replaced. Failure (any of the four) → `status "offline"`; keep the last good data; if none ever loaded, use the SAMPLE_* data with `sample: true`. Recovery on a later success flips back to live, `sample false`. `"loading"` only before the first attempt settles.

Sample data: a believable story with 6 agents (Seller, Buyer, Worker 1, Worker 2, Lender A, Lender B; plausible `0x…` addresses, roles, scores 60–95), runs PO-1001 and PO-1002 repaid and PO-1003 in progress (uploaded, confirmed, NFT, funded by both lenders, 3 spends, one SpendRejected `AGENT_BUDGET_EXCEEDED`), ~25 events with increasing `seq`, `hcsSeq`, timestamps generated relative to `Date.now()` at module use (export a `sampleEvents(nowMs)` builder if that is cleaner; then the hook calls it).

- [ ] **Step 1: Write failing tests** (`vi.useFakeTimers()`, `renderHook`, fake client):
  - first success → `status "live"`, `sample false`, events from client.
  - first failure → `status "offline"`, `sample true`, `events.length > 0`.
  - success then failure → `offline`, `sample false`, previous events kept.
  - failure then success after advancing 3000 ms → `live`, `sample false`.
  - unmount stops polling (client call count stops increasing).
  - `narrateAll(SAMPLE_EVENTS…, SAMPLE_AGENTS, "0.0.1")` contains no `undefined` in any sentence (guards the sample story against Task 2).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS, full suite green.
- [ ] **Step 5: Commit** `feat(admin): live polling hook with offline and sample data`

---

### Task 6: Console shell and Overview view

**Files:**
- Create: `frontend/src/components/admin/AdminApp.tsx` (client), `TopBar.tsx`, `SideNav.tsx`, `KpiCard.tsx`, `Sparkline.tsx`, `RoleActivityChart.tsx`, `RunStepper.tsx`, `AgentsTable.tsx`, `ActivityFeed.tsx`, `Avatar.tsx`, `StatusChip.tsx`, `Overview.tsx`, `Admin.module.css`
- Modify: `frontend/src/app/admin/page.tsx` (render `<AdminApp />` behind the gate), `frontend/src/app/globals.css` (only if a token is missing)
- Test: `frontend/src/components/admin/Overview.test.tsx`, `frontend/src/components/admin/AdminApp.test.tsx`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: `AdminApp` owns `view: "overview" | "agents" | "activity" | "runs"`, `range: Range` (default `"all"`), `query: string`, `selectedAgent?: string` (actor key), `selectedRun?: string`; syncs view+selection to `location.hash` (`#overview`, `#agents`, `#agents/<key>`, `#activity`, `#runs`, `#runs/<id>`) and reads it on mount. Task 7 adds `AgentsView`, `ActivityView`, `RunsView` and plugs them in; for now those views render `Overview`'s matching panel.
- Shared component props (Task 7 reuses): `ActivityFeed({ items: Narrated[]; nowMs: number; limit?: number; emptyText?: string; onSelectAgent?(key: string): void })`, `AgentsTable({ rows: AgentRow[]; nowMs: number; onSelect?(key: string): void })`, `RunStepper({ run: Run; nowMs: number })`, `Avatar({ actor: Actor; size?: number })`, `StatusChip({ kind: "active" | "idle" | RunStatus | "live" | "offline" })`.

Layout and look (approved mockup; dark + light via tokens):
- **TopBar** 52px: `Logo`, pill `Network · Hedera testnet`, search input `Search agents, invoices, transactions` (sets `query`; filters feed rows and agent rows by actor name, sentence, or id, case-insensitive), status pill (`● Live · MCP connected` accent on accent-tint; `MCP offline` err colour; `Connecting…` muted), `ThemeToggle`, avatar `AD` button with a menu item `Sign out` (POST `/api/admin/logout`, then `location.href = "/admin/login"`).
- When `sample` is true: a full-width banner under the top bar: `Sample data · MCP server offline — start the MCP server on {API_URL} to see live agents`.
- **SideNav** 200px: Overview, Agents, Activity, Runs (active item accent tint + accent text); group label `PROOF`: `Hedera audit log ↗` → `https://hashscan.io/testnet/topic/{HCS_TOPIC_ID}`; group `HELP`: `Docs` → `/docs`. Simple inline-SVG line icons.
- **Header**: `h1` per view (`Overview`), subtitle `AI agents financing invoices through the CashETH MCP server, recorded on Hedera`, segmented control `1h · 24h · 7d · All`.
- **KPI row** (4 cards, sparkline under each, accent stroke): `Agents connected` / `{activeNow} active now`; `Invoices financed` / `+{financedInRange} in range`; `Agent spending (x402)` / `{payments} payments`; `On-chain records` / `Last: {relativeTime}` (or `No records yet`).
- **Row 2** (1.6fr / 1fr): `Activity by agent role` stacked bar chart (SVG, 12 bars, role colours, light gridlines, legend, `<title>` tooltips per segment `Workers: 5 actions`), and `Live run · Invoice {id}` with `StatusChip` + `RunStepper` (vertical, done = accent filled check, current = ring glow) for the newest non-setup run; empty → `No invoice in flight yet`.
- **Agents table** (top 6 rows, `View all` link → agents view): Agent (Avatar initials in role colour + name + plain job line: seller `Borrows against its invoices`, buyer `Confirms and pays invoices`, worker `Spends the loan on paid APIs`, lender `Lends capital · {blended APR}% return` when known), Status chip, Last action (sentence + relative time), Trust score (bar + number), Money moved.
- **Live activity** feed (latest 8, `View all` → activity view): avatar, **actor name** + sentence, detail line in faint colour, relative time, `View proof ↗` (opens new tab, `rel="noopener noreferrer"`) when `proofUrl`. Rows with tone `blocked` show the verb part in `var(--err)`; `warn` in `var(--warn)`. A row whose `seq` is new since the previous render gets a 2 s accent-tint fade-in (CSS animation; respect `prefers-reduced-motion`).
- Re-render relative times every 1 s (`nowMs` state).
- Responsive: ≥1024px as above; below, SideNav becomes a horizontal tab row, grids stack.
- Empty states: zero events → feed `No activity yet — connect an agent to the MCP server`, chart shows empty axes, KPIs zeros.

- [ ] **Step 1: Write failing tests**
  - `Overview.test.tsx`: render `Overview` with narrated sample data → shows `Agents connected`, `Invoices financed`, `Agent spending (x402)`, `On-chain records`; shows a sentence from the feed (e.g. `paid $` text); a `View proof ↗` link has `target="_blank"`; with empty inputs shows `No activity yet` and `No invoice in flight yet` and does not throw.
  - `AdminApp.test.tsx` (mock `useAdminData`): offline+sample → banner text `Sample data · MCP server offline` visible and status `MCP offline`; live → `Live · MCP connected`, no banner; typing `Worker` in search leaves only feed rows whose actor or sentence contains it; clicking `Runs` nav sets `location.hash` to `#runs`; clicking `1h` marks it `aria-pressed="true"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.**
- [ ] **Step 4: Run** full suite, `npx tsc --noEmit`, `npm run lint`, `npm run build` → all pass. Visual check: `npm run dev`, sign in at `http://localhost:3000/admin/login`, take screenshots of `/admin` in dark and light (MCP server likely offline → sample data) with a headless browser if one is available (`npx playwright screenshot` only if already installed; do not add dependencies); else describe what you verified. Save screenshots under the report directory, not in git.
- [ ] **Step 5: Commit** `feat(admin): console shell and overview`

---

### Task 7: Agents, Activity and Runs views

**Files:**
- Create: `frontend/src/components/admin/AgentsView.tsx`, `AgentDetail.tsx`, `ActivityView.tsx`, `RunsView.tsx`, `RunDetail.tsx`
- Modify: `frontend/src/components/admin/AdminApp.tsx` (plug views in), `Admin.module.css`
- Test: `frontend/src/components/admin/Views.test.tsx`

**Interfaces:**
- Consumes: Task 6 shared components and `AdminApp` state; Task 3 `agentRows`, `groupRuns`, `inRange`.

Behaviour:
- **Agents view** (`h1` `Agents`, subtitle `Every agent registered on Hedera (KYA) and what it has done`): grid of agent section cards (3 columns ≥1280px, 2 ≥1024px, 1 below), grouped under role headings in order Sellers, Buyers, Workers, Lenders (a heading only when it has agents). Card: Avatar, name, job line, status chip, trust score bar, money moved, last action + time. Clicking a card → `#agents/<key>` → `AgentDetail`: back link `← All agents`, header (avatar, name, role, status), stat tiles from `AgentStats` (`KYA level`, `Lender tier`, `On-time repayment` %, `Invoices funded` / `repaid` / `defaulted`, `Avg days to repay`, `Lender return` % for lenders), `Spending by merchant` list (shortAddress → $) when non-empty, then `ActivityFeed` of that agent's items only (all of them, in range). Unknown key → `Agent not found` with back link.
- **Activity view** (`h1` `Activity`): filter chips `All roles · Sellers · Buyers · Workers · Lenders` and `All · Succeeded · Blocked` (blocked = tone `blocked`; succeeded = tone `ok`/`info`), count `{n} actions`, full `ActivityFeed` (no limit) honouring range + search.
- **Runs view** (`h1` `Runs`, subtitle `Every invoice an agent has financed, from upload to repayment`): table/list of runs from `groupRuns` (all time, not range-filtered): `Invoice {id}` (or `Setup & other`), status chip, amount, started (relative), events count, mini progress (5 dots). Clicking → `#runs/<id>` → `RunDetail`: back link `← All runs`, title + status, `RunStepper` (horizontal on wide screens is fine), totals (financed, spent within the run, repaid), and the run's events oldest-first in an `ActivityFeed`-style timeline. Unknown id → `Run not found`.

- [ ] **Step 1: Write failing tests** (render `AdminApp` with mocked `useAdminData` returning sample data):
  - `#agents` shows role headings `Workers` and `Lenders` and a card for `Worker 1`; clicking it shows `← All agents` and `On-time repayment` and only that agent's rows.
  - `#agents/unknown` → `Agent not found`.
  - `#activity`, clicking `Blocked` → every visible row's sentence contains `blocked` or `refused`; count text updates.
  - `#runs` lists `Invoice PO-1003` before `Invoice PO-1002`; clicking PO-1002 shows status `Repaid` and 5 done steps; `#runs/nope` → `Run not found`.
  - empty data → Agents view `No agents registered yet`, Runs view `No runs yet`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** full suite, tsc, lint, build → pass.
- [ ] **Step 5: Commit** `feat(admin): agents, activity and runs views`

---

### Task 8: Docs page matches the MCP server

**Files:**
- Modify: `frontend/src/lib/content.ts` (`MCP_TOOLS`, `ERROR_CODES`, `CONFIG`, `DOC_NAV`, new exports), `frontend/src/app/docs/page.tsx`, `frontend/src/components/docs/DocsHeader.tsx`, `frontend/src/lib/content.test.ts`
- Sources of truth (read, do not edit): `../apps/mcp-server/src/tools.ts`, `../docs/API.md`, `../.mcp.json`

**Interfaces:**
- Produces: `MCP_TOOLS: { name: string; roles: string; scope: string; effect: string }[]` (20 entries, `roles` like `"seller · worker"` or `"any"`), `READ_API: { method: "GET"; path: string; returns: string }[]`, `MCP_ERROR_CODES: [string, string][]`. If `Role`-typed `role` field consumers exist (grep `MCP_TOOLS` usages), update them to the new shape.

Content:
- **MCP tools**: all 20 tools in `tools.ts` order with exactly these roles/scopes: register_agent any/`agent:admin`; upload_invoice_document seller/`receivable:write`; get_invoice_document any/`receivable:read`; upload_receivable seller/`receivable:write`; confirm_receivable buyer/`receivable:confirm`; get_receivable_status any/`receivable:read`; get_quotes seller/`credit:read`; open_facility seller/`facility:open`; set_budgets seller/`budget:write`; reserve_spend seller·worker/`spend:reserve`; pay_x402 worker/`spend:pay`; commit_spend worker/`spend:commit`; release_spend seller·worker/`spend:reserve`; repay_receivable buyer/`repay:write`; explain_decision any/`credit:read`; list_agents any/`stats:read`; get_agent_stats any/`stats:read`; fund_agents lender/`lend:write`; get_lender_yield lender/`stats:read`; close_strategy lender/`lend:write`. Effects summarised from API.md §3 per tool (one line, on-chain effect where there is one). Note under the table: every mutating tool takes an `idempotencyKey` (8–128 chars).
- **New section `connect` "Connect an agent"** (in `start` nav after Quickstart): MCP endpoint `http://localhost:4030/mcp`, streamable HTTP, stateless, POST only; `.mcp.json` example verbatim from the repo; OAuth summary from API.md §1 (agents get a token from the auth server; roles and scopes table summary; demo authorization-code grant for human clients); idempotency and replay (`_meta.replayed`).
- **New section `read-api` "Read API"** (in `ref` nav before Error codes): the five GETs (`/health`, `/events`, `/agents`, `/lenders`, `/receivables/:id`, plus `/invoices/:keccak256`) with one-line returns, "no auth, hashes and amounts only", amounts are USDC units (6 decimals), a short `AuditEvent` example. Mention the admin console reads these.
- **Error codes**: shared contract codes list and the MCP-side table from API.md §5 (all rows).
- **Configuration**: reconcile with API.md §6 (keep accurate existing rows, add missing env vars with one-line meanings).
- **External x402 merchants**: short subsection under x402 spending from API.md "External x402 merchants".
- `DocsHeader` nav: `Home`, `Connect`, `MCP tools`, `Read API`, `Error codes`.
- Keep all other existing sections; fix any statement that contradicts API.md.

- [ ] **Step 1: Update failing tests** in `content.test.ts`: `MCP_TOOLS.length === 20`; names equal the 20 above in order; `MCP_TOOLS.find(t => t.name === "reserve_spend")` has `roles === "seller · worker"` and `scope === "spend:reserve"`; `READ_API` paths include `/events` and `/agents`; `DOC_NAV.start` ids include `connect`, `DOC_NAV.ref` ids include `read-api`; every `DOC_NAV` id has a matching `id="…"` section (render `DocsPage` in a test or assert via a `SECTION_IDS` export used by the page).
- [ ] **Step 2: Run** `npx vitest run src/lib/content.test.ts` → FAIL. **Step 3: Implement.** **Step 4: Run** full suite, tsc, lint, build → pass.
- [ ] **Step 5: Commit** `docs(frontend): docs page matches the MCP server (20 tools, connect, read API, errors)`
