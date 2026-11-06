# CashETH frontend

Next.js app (`@casheth/frontend`): landing page and docs for CashETH, agent working capital on Hedera testnet.

## Run it

From the repository root:

```bash
pnpm install
pnpm -F @casheth/frontend dev      # http://localhost:3000
pnpm -F @casheth/frontend build
pnpm -F @casheth/frontend test     # Vitest
```

## Live data

The landing page's live console reads the CashETH read API (`docs/API.md` section 4), served without auth by
`apps/mcp-server` on port 4030. Point the app at it with `NEXT_PUBLIC_API_URL` (see `.env.example`; default
`http://localhost:4030`). The MCP server allows the browser origin through `CORS_ORIGINS` (default
`http://localhost:3000`).

- `src/lib/api.ts`: typed client for `GET /health`, `/events`, `/agents`, `/lenders` and `/receivables/:id`.
- `src/lib/liveConsole.ts`, `src/lib/useLiveAudit.ts`: turn `/events` and the latest `/receivables/:id` into the console feed and stats, polled every 5 seconds.
- Until the API answers with at least one event, the console plays the scripted demo from `src/lib/content.ts`.
- `src/lib/fixtures.ts`: read-API-shaped sample data used by the tests.
