This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Admin console

`/admin` is a live view of the AI agents connected to the CashETH MCP server: who they are, what they did, and the Hedera proof of every action. It polls the MCP server's read API (`/health`, `/events`, `/agents`, `/lenders`) every 3 seconds. Previous runs (one per invoice) come from the server's persisted audit log.

1. Start the MCP server (`pnpm -F @casheth/mcp start`, port 4030). Its `CORS_ORIGINS` must include this app's origin (default `http://localhost:3000`).
2. Open `http://localhost:3000/admin` and sign in with the admin password (default `admin@01`).

If the MCP server is unreachable, the console keeps showing the last data it received. If it never connected, it shows sample data under a "Sample data · MCP server offline" banner.

| Variable | Default | Use |
|---|---|---|
| `ADMIN_PASSWORD` | `admin@01` | Admin console password (checked server-side) |
| `ADMIN_SESSION_SECRET` | demo constant | Signs the session cookie; set your own outside a local demo |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4030` | MCP server read API |
| `NEXT_PUBLIC_HCS_TOPIC_ID` | `0.0.11338927` | HCS audit topic used for proof links |

The password gates the page only. The read API it displays is public by design (hashes, addresses and amounts), and the session is a demo-grade signed cookie with no revocation.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
