# Admin dashboard and MCP docs refresh — design

Date: 2026-11-07 · Branch: `feat/admin-dashboard` · Frontend: `frontend/` (Next.js 16, React 19, CSS modules, vitest)

## Intent

Sponsors need to *see* CashETH working: AI agents connected to the CashETH MCP server doing real things (uploading invoices, confirming, lending, spending through x402, repaying) and every one of those actions recorded on Hedera. Today that evidence lives in `GET /events` JSON and HashScan. The admin dashboard turns it into a page a non-technical sponsor understands at a glance, live while a demo runs, with previous runs kept.

The public docs page also lags the MCP server (it lists 12 of the 20 tools and has no connection / auth / read-API guidance). It must match `docs/API.md` and `apps/mcp-server/src/tools.ts`.

## Goals

1. `/admin` dashboard, gated by a password (`admin@01`), in the site's theme, styled like a modern cloud console (GCP-like): top bar, left nav, KPI scorecards with sparklines, a chart, a live-run progress panel, an agents table, a plain-English activity feed.
2. Live: updates within a few seconds of an agent action, with a visible "Live · MCP connected" / "MCP offline" status.
3. Previous runs: every past invoice lifecycle is listed and can be opened.
4. Every agent has its own section: its role in plain words, status, last action, trust score, money moved, and its own activity.
5. Every action row links to its proof on Hedera (HashScan transaction or HCS audit message).
6. Docs page reflects the MCP server as it is: all 20 tools with exact roles and scopes, how to connect an agent, auth, read API, errors, config.

## Non-goals

- No backend changes. The MCP server already persists every state change to `DATA_DIR/events.jsonl` (survives restarts → "previous runs saved") and publishes it to the HCS audit topic, and already serves `GET /health`, `/events`, `/agents`, `/lenders`, `/receivables/:id` with CORS. AGENTS.md forbids changing read-API shapes without updating API.md + tests, and forbids UI in backend apps.
- No LLM reasoning / chain-of-thought display. The user chose "whatever is recorded on the blockchain".
- No real user management, roles, or per-user accounts. One shared demo password.
- No chart library dependency.

## Anti-goals (failure even if it works)

- Showing technical event names (`SpendCommitted`) as the primary text. Primary text is a plain sentence; the raw type may appear as secondary detail.
- Showing made-up data as if it were live. Sample data is allowed only behind an unmistakable "Sample data · MCP server offline" label.
- Cluttered, dense, or hard-to-read screens (the user rejected two denser mockups for this reason).

## Approved look

The approved mockup is `.superpowers/brainstorm/29690-1793998483/content/dashboard-console.html` in the main checkout (git-ignored; the plan's task briefs restate what matters). Summary:

- **Top bar** (52px): CashETH logo, "Network Hedera testnet" pill, search box (filters agents/activity by text), live status pill (`● Live · MCP connected` in accent, or `MCP offline` in error colour), theme toggle, admin avatar with sign-out.
- **Left nav** (190px): Overview, Agents, Activity, Runs; group "Proof": Hedera audit log (external HashScan topic link), Contracts (external HashScan link to the facility or registry contract, from env or omitted); group "Help": Docs (`/docs`).
- **Page header**: title + one-line description, time-range segmented control `1h · 24h · 7d · All` (default All) that scopes KPIs, chart and feed.
- **KPI row** (4 cards, each with a sparkline): Agents connected (sub: "N active now"), Invoices financed ($, sub: "+$X in range"), Agent spending x402 ($, sub: "N payments"), On-chain records (count, sub: "Last: Ns ago").
- **Row 2**: "Activity by agent role" stacked bar chart (seller pink, buyer orange, worker blue, lender green; legend), and "Live run · Invoice <id>" vertical 5-step stepper: Invoice uploaded → Buyer confirmed → Lenders funded → Agents spending → Repaid, each step with who/when; status chip (In progress / Repaid / Overdue / Defaulted / Rejected).
- **Agents table**: avatar with initials in role colour, name + plain-English job, status chip (Active = action in last 2 min, else Idle), last action sentence + relative time, trust score bar (0–100 from `/agents` `score`), money moved.
- **Live activity feed**: newest first, avatar, bold actor, plain sentence, a grey sub-line explaining why it matters, relative time, `View proof ↗`. Newest row highlighted briefly. Blocked/rejected actions in error colour with an explanation ("Over its $25 budget · the guardrail worked").

Views behind the nav:
- **Overview**: everything above.
- **Agents**: an agent card grid (the agents "under their sections"); selecting one shows its detail: stats from `/agents` (KYA level, tier, on-time %, funded/repaid/defaulted, avg days to repay, spend by merchant, lender return %) and its own activity feed.
- **Activity**: full feed, filter by role and by outcome (all / succeeded / blocked).
- **Runs**: list of runs (one per receivable id), newest first, with status chip, amount, start time, event count; opening one shows its stepper and its events. Events with no receivable id (agent registration, strategy shipping, budgets) form a "Setup & other" group.

Must work in dark and light theme (existing `data-theme` tokens) and down to ~1024px width; below that, nav collapses to a top row and grids stack.

## Data

All from the MCP read API, base URL `NEXT_PUBLIC_API_URL` (default `http://localhost:4030`), polled every 3 s from the browser (the server has no push channel). Types: exactly `docs/API.md` §4. A typed client already exists on `origin/feat/frontend-integration:frontend/src/lib/api.ts` and may be ported.

- `GET /health` → connected/offline, total event count.
- `GET /events` → the activity, runs, KPIs, chart. Event `type` values: AgentRegistered, ReceivableUploaded, ReceivableConfirmed, ReceivableRejected, NftMinted, StrategyShipped, StrategyDocked, FacilityFunded, BudgetsSet, SpendReserved, SpendCommitted, SpendReleased, SpendRejected, Repaid, Overdue, Defaulted, Disputed, InvoiceDocumentStored, plus LlmToolCall / LlmRunFinished (may appear). Unknown types must render generically, never crash.
- `GET /agents` → agent list, labels, roles, scores, stats.
- `GET /lenders` → lender capital / APR for lender rows.

Actor attribution: `event.agent` (caller EVM address) matched case-insensitively to `/agents[].address`; else `agentUaid` to `uaid`; else inferred from type (e.g. ReceivableUploaded → seller, ReceivableConfirmed/Repaid → buyer, Spend* → worker, StrategyShipped/Docked → lender, FacilityFunded → lenders); else "CashETH MCP".

Proof link: `event.hashscan` if present; else `https://hashscan.io/testnet/topic/<HCS topic>/message/<hcsSeq>` when `hcsSeq` is set; else no link. HCS topic from `NEXT_PUBLIC_HCS_TOPIC_ID`, default `0.0.11338927` (`deployments/testnet/hedera.json`).

Amounts are USDC base units as strings (6 decimals); format as `$1,234.56` without BigInt literals (tsconfig targets ES2017).

Offline: when `/health` fails, status pill shows `MCP offline`, the last good data stays on screen, and polling continues. If no data has ever loaded, the page shows labelled sample data (`Sample data · MCP server offline`) so the layout is still demonstrable.

## Password gate

- `/admin/login`: a clean centred card (logo, password field, Sign in). Wrong password → inline error.
- Check is server-side: a Next route handler compares against `ADMIN_PASSWORD` (default `admin@01`) and on success sets an httpOnly, SameSite=Lax cookie holding an HMAC of a fixed payload with `ADMIN_SESSION_SECRET` (default: a constant; documented as demo-only). `/admin` verifies the cookie server-side and redirects to `/admin/login` if missing/invalid. Sign-out clears it.
- Honest scope: this gates the UI only. The read API it displays is already public by design (no auth, hashes and amounts only).

## Docs page

Bring `frontend/src/app/docs/page.tsx` + `frontend/src/lib/content.ts` in line with `docs/API.md` and `apps/mcp-server/src/tools.ts`:
- MCP tools table: all 20 tools, exact role(s) and scope from `tools.ts`, plain effect.
- New "Connect an agent" section: MCP endpoint `http://localhost:4030/mcp` (streamable HTTP, stateless, POST), `.mcp.json` example, OAuth flow summary (API.md §1), idempotency keys (§2).
- New "Read API" section: the five GET endpoints and what they return.
- Error codes and configuration reconciled with API.md §5–6; external x402 merchants section from API.md.
- Docs nav (`DOC_NAV`) and header links updated; existing sections that are still accurate stay.

## Constraints

- Keep the existing design system: tokens in `globals.css`, Geist fonts, CSS modules, `ThemeToggle`, `Logo`. Add `--seller/--buyer/--worker/--lender` role colours as used.
- No new runtime dependencies.
- Existing 119 frontend tests keep passing; `npm run lint`, `npx tsc --noEmit`, `npm run build` pass.
- Next.js 16 conventions (read `node_modules/next/dist/docs` when unsure; e.g. `cacheComponents: true` is on, so request-time APIs like `cookies()` need the documented pattern).

## Left to the builder

Component breakdown, exact spacing, sparkline maths, how the 3 s poll is structured (a hook), animation details, exact sentence wording (must stay plain English and accurate to the event).
