# Contributing to CashETH

Thanks for your interest in CashETH. This guide explains how to set up the repo, make a change, and get it merged. For what the project does, read the [README](README.md) first.

CashETH is a hackathon prototype running on **Hedera testnet**. Contributions that improve correctness, safety, documentation and developer experience are especially welcome.

## Contents

1. [Ways to contribute](#ways-to-contribute)
2. [Before you start](#before-you-start)
3. [Development setup](#development-setup)
4. [Project layout](#project-layout)
5. [Making a change](#making-a-change)
6. [Coding conventions](#coding-conventions)
7. [Testing](#testing)
8. [Testnet rules](#testnet-rules)
9. [Pull requests](#pull-requests)
10. [Reporting bugs and security issues](#reporting-bugs-and-security-issues)
11. [Licensing](#licensing)

## Ways to contribute

- **Report a bug** or unclear behaviour through the [feedback issue form](https://github.com/Harshavardhan-28/CashETH-EthGlobal-Mumbai/issues/new?template=feedback.yml).
- **Improve the docs.** Fixes to the README, `docs/` and code comments are always useful.
- **Fix a known limitation.** The list is in the README under [Known limitations](README.md#known-limitations) and in [docs/SUBMISSION.md](docs/SUBMISSION.md#8-known-limitations-and-rulings). Good starting points are a pull-based repayment router, returning undrawn funds on default, and more tests.
- **Add tests.** More fuzz and invariant coverage for the contracts is welcome.
- **Build on the read API.** The `/admin` console and the public `/dashboard` already read it (`docs/API.md`, section 4). New views, such as per-buyer exposure or a lender's history over time, are welcome.

For anything larger than a small fix, please open an issue first so we can agree on the approach before you spend time on it.

## Before you start

Read these, in this order:

1. [README.md](README.md) for the overview and the eight-step flow.
2. [AGENTS.md](AGENTS.md) for conventions, the repo layout and the Hedera and 1inch gotchas we hit. It is written for coding agents, and it is just as useful for people.
3. [docs/API.md](docs/API.md) if you touch the MCP server or the read API.

Some things were deliberately deferred. Check [docs/SUBMISSION.md section 8](docs/SUBMISSION.md#8-known-limitations-and-rulings) before "fixing" something that looks wrong.

## Development setup

### Prerequisites

- **Node 22** (`.nvmrc`) and **pnpm 11**
- **Foundry** (`foundryup`). Run `forge --version` and confirm it prints *forge Version*. On some machines `forge` on `PATH` is a different tool. If so, set `FORGE=/path/to/foundry/forge` for scripts and `FOUNDRY_BIN=$HOME/.foundry/bin` for the anvil-backed tests.
- Git, with submodule support

### Install

```bash
git clone --recurse-submodules https://github.com/<your-fork>/CashETH-EthGlobal-Mumbai.git
cd CashETH-EthGlobal-Mumbai

pnpm install
pnpm -r build
(cd contracts && forge build)
```

If you cloned without `--recurse-submodules`, run `git submodule update --init --recursive`.

### Environment and secrets

Live runs read two gitignored files:

- `.env` for operator, merchant, relay URL, USDC ids and the facilitator URL. Copy it from `.env.example`.
- `.env.accounts` for every demo account, key, EVM address and spend wallet.

You can build, lint and run all unit tests **without** either file. You only need them to run against testnet. We do not hand out the demo account keys to external contributors. If you need a live run, create your own Hedera testnet accounts and fund them from the [Hedera faucet](https://portal.hedera.com/faucet) and the [Circle faucet](https://faucet.circle.com).

**Never commit keys, `.env` or `.env.accounts`, and never paste them into an issue or a PR.**

### Run the stack locally

```bash
pnpm servers                         # auth (:4020) and MCP (:4030)
pnpm -F @casheth/merchant start      # x402 merchant (:3003)
cd frontend && npm ci && npm run dev # http://localhost:3000
```

## Project layout

| Path | What lives there |
|---|---|
| `contracts/` | Foundry project: `src/core`, `src/aqua`, `src/hedera`, `test/`, `script/` |
| `packages/shared`, `hedera`, `engine`, `aqua` | Shared TypeScript libraries (pnpm workspace) |
| `apps/auth-server`, `mcp-server`, `merchant` | The three servers |
| `agents/`, `seller-agent/`, `wallet-mcp/` | Agent clients and the local wallet |
| `frontend/` | Next.js app. It uses **npm** and is not part of the pnpm workspace. |
| `scripts/` | One-off testnet scripts, ABI sync, evidence verification |
| `deployments/testnet/` | Live addresses and run records |
| `docs/` | API contract, evidence, demo guides, business docs |

`casheth-paid-apis/` is a teammate's standalone merchant with its own `package-lock.json`. Please do not edit it.

## Making a change

1. **Fork** the repo and create a branch from `main`:
   ```bash
   git checkout -b fix/short-description
   ```
   Use a prefix that matches the change: `feat/`, `fix/`, `docs/`, `test/`, `refactor/`, `perf/`.
2. **Make small, focused changes.** One concern per PR is much easier to review.
3. **Add or update tests** for any behaviour change.
4. **Update the docs** when you change a public surface. If you change a read API shape, an MCP tool, or an error code, update [docs/API.md](docs/API.md) and the MCP server tests in the same PR.
5. **Run the checks** in [Testing](#testing) before you push.

### If you change a contract

- Run `cd contracts && forge build --sizes`. `CashEthSwapVMRouter` is close to the EIP-170 limit (23,759 B runtime, 817 B margin). A change that pushes it over fails the build.
- After changing an ABI, run `pnpm abi:sync` to regenerate `packages/shared/src/abis` and commit the result.
- **Do not redeploy or re-wire contracts as part of a PR.** The facility address is an immutable in the router, the repayment router and the taker, and every `wire()` call is one-shot, so a facility change means redeploying the whole core stack and re-shipping every strategy. Maintainers do this deliberately.
- Keep error names in sync across the engine, the contracts and the MCP server. Error codes are a typed union in `packages/shared/src/errors.ts`.

## Coding conventions

- **Real on-chain only.** No mock data in production code paths. Fakes belong inside unit tests.
- **TypeScript:** strict mode, ESM, tests in vitest. Reuse helpers from `packages/*` instead of copying them.
- **Solidity:** 0.8.30 with via-IR, tests in Foundry. Keep functions small and readable.
- **Comments** only where the reason is not obvious from the code.
- **Frontend:** keep the existing design system and add pages instead of rewriting. The `tsconfig` targets ES2017, so no BigInt literals. Use string math or raise the target deliberately.
- **Do not add dashboards or UI pages to the backend apps.** The UI lives in `frontend/`.

### Commit messages

We use conventional prefixes with a scope:

```
feat(mcp): add upload_invoice_document tool
fix(contracts): schedule only markOverdue at funding
docs(readme): rewrite overview and add architecture diagram
perf(read-api): cache /agents rows stale-while-revalidate
test(engine): cover co-signer rejection of a second payment
```

Keep commits small and meaningful. Explain the *why* in the body when it is not obvious.

## Testing

Run the checks that match what you touched. CI runs all of them on every pull request.

```bash
pnpm lint                                    # type-check every package
pnpm -r test                                 # TypeScript suites (vitest)
pnpm test:scripts                            # tests for scripts/

cd contracts
forge build --sizes                          # contract sizes, must stay under EIP-170
forge test                                   # unit, fuzz and invariant tests

FOUNDRY_BIN=$HOME/.foundry/bin pnpm -F @casheth/aqua test   # Aqua tests on anvil

cd frontend && npm test && npm run lint && npm run build
```

Tests that touch testnet are opt-in, for example `LIVE=1 pnpm -F @casheth/aqua exec vitest run --project unit discover.live`. Do not make a default test depend on the live network.

If you changed anything that records HashScan links, run `pnpm verify:evidence` to check them against the mirror node.

## Testnet rules

These exist because demo balances are tight and every live step is recorded as evidence. Breaking them can wreck the demo environment.

- **Never run `scripts/setup-accounts.ts`.** It rewrites `.env.accounts` destructively.
- **Do not move USDC or HBAR** between the shared demo accounts, dock strategies, or re-wire contracts without a maintainer's approval.
- **Never approve `type(uint256).max`** on HTS USDC. It reverts, because HTS allowances are int64. Approve exact amounts.
- **Never call `openAndFund` with two schedules.** Hedera allows one `scheduleCall` per transaction.
- **Never write `"test": true` probes to the production HCS topic.** Use your own topic.
- **Before you retry a transaction** through the Hashio relay, check the mirror node. A "failed" send may have landed, and a blind retry can pay twice.
- `eth_getLogs` ranges must be 1,000 blocks or fewer.

More background is in [AGENTS.md section 4](AGENTS.md#4-hedera-and-1inch-facts-that-bit-us-verified-on-testnet).

## Pull requests

Before you open one:

- [ ] The branch is up to date with `main`.
- [ ] `pnpm lint`, the relevant tests and (for contracts) `forge test` pass locally.
- [ ] New behaviour has tests. Bug fixes have a test that fails without the fix.
- [ ] Docs are updated (`docs/API.md`, README, comments) where needed.
- [ ] No secrets, no `.env*` files, no generated noise.

In the description, say **what** changed and **why**, how you tested it, and link the issue it closes. Screenshots help for frontend changes. Keep the PR focused. If a reviewer asks for changes, push new commits to the same branch.

Maintainers merge once CI is green and at least one review is approved. Please do not force-push `main`, and do not push worktree branches as `main`.

## Reporting bugs and security issues

For ordinary bugs, use the [feedback issue form](https://github.com/Harshavardhan-28/CashETH-EthGlobal-Mumbai/issues/new?template=feedback.yml). Include what you ran, what you expected, what happened, and any HashScan link or transaction id.

**Do not report a security vulnerability in a public issue.** Contact the maintainers privately and give them time to respond before you disclose it. The contracts are unaudited testnet code, so please do not treat anything in this repository as safe for real funds.

## Licensing

CashETH builds on 1inch's SwapVM and Aqua. Their code keeps its original license terms and attribution ("Powered by Aqua — © Degensoft Ltd 2025"). Do not remove or change those notices, and mark and date any change you make to files under those terms. See [LICENSE-THIRD-PARTY.md](LICENSE-THIRD-PARTY.md).

By submitting a contribution, you agree that you have the right to submit it and that it may be distributed under the same terms as the rest of the project.
