# LLM-driven agents

The seller, buyer, worker and lender agents in `agents/` are scripted. This optional mode puts a language model behind the same MCP tools: the model decides which tool to call, an agent wrapper decides whether the call goes out. The scripted demo is unchanged.

The model runs locally with [Ollama](https://ollama.com) by default, so no API key is needed. Claude through the Anthropic API is an optional alternative.

## Run it

```bash
ollama pull qwen2.5:7b            # or llama3.1:8b; both support tool calling
pnpm -r build
pnpm -F @casheth/auth-server start   # :4020
pnpm -F @casheth/mcp-server start    # :4030
pnpm -F @casheth/merchant start      # :3003 (the worker reads its /catalog)

pnpm -F @casheth/agents llm -- --role worker --receivable <id> \
  --goal "Buy a research report on Hedera x402 from the cheapest merchant" --max-spend 0.5
```

The CLI prints the provider and model it uses (`LLM provider: ollama, model: qwen2.5:7b`) before it does anything. It acts as a demo account from `.env.accounts` (`WORKER_RESEARCH`, `SELLER`, `LENDER_A` by role; `--account` picks another) and authenticates through the normal token flow.

| Flag | Meaning |
|---|---|
| `--role worker\|seller\|lender` | which system prompt and default tools (`agents/src/llm/prompts.ts`) |
| `--goal "<text>"` | what to achieve |
| `--receivable <id>` | receivable (facility) id, pinned on every tool that takes an `id` |
| `--allow a,b` | side-effecting tools the model may use; default is the role's list below |
| `--max-spend <usdc>` | spend cap for the run, default `1` |
| `--max-steps <n>` | model turns before the run stops, default `12` |
| `--catalog <url>` | merchant `/catalog`, repeatable; default `http://localhost:3003/catalog` |
| `--dry-run` | a fake model makes one read-only call and answers: checks the wiring (MCP connection, tool list, audit file) without a model server |

Exit status is 0 when the model finished, 2 when the run was stopped (step cap, refusal, truncated answer), 1 for a usage or setup error.

### Choosing the model

| Variable | Use |
|---|---|
| `CASHETH_LLM_PROVIDER` | `ollama` or `anthropic`. Unset: Anthropic when `ANTHROPIC_API_KEY` is set, otherwise Ollama |
| `CASHETH_LLM_MODEL` | model name; default `qwen2.5:7b` (Ollama) or `claude-sonnet-5-5` (Anthropic; `claude-haiku-5-5` for cheap runs) |
| `OLLAMA_BASE_URL` | default `http://localhost:11434`; the agent calls `/v1/chat/completions` (tool calling through `tools` / `tool_calls`) |
| `ANTHROPIC_API_KEY` | enables the Anthropic backend |

The run is refused with a message saying what to start or set when Ollama is not reachable (`GET /api/tags`) and no key is set, or when Ollama does not have the model (`ollama pull <model>`). Small local models sometimes fumble multi-step tool use; the guardrails below hold whatever the model does, and a bigger model (`CASHETH_LLM_MODEL=llama3.1:8b`, or Claude) is the lever when a run stalls.

## What the model can and cannot do

The loop: the model gets the system prompt, the goal and the tools generated from the server's `tools/list` (names, descriptions, input schemas), then calls tools until it answers or hits `--max-steps`. Each result goes back to it; tool errors come back as error results, so it can explain them.

- **No keys.** The model sees only tool names, schemas and results. Keys stay in the `AgentClient`, which signs the token assertion.
- **Allowlist.** Read-only tools (`get_receivable_status`, `get_quotes`, `explain_decision`, `list_agents`, `get_agent_stats`, `get_lender_yield`) are always offered. Every other tool, including the money-moving ones (`reserve_spend`, `pay_x402`, `commit_spend`, `repay_receivable`, `open_facility`, `fund_agents`), is offered and callable only when `allowTools` names it. The CLI defaults per role: worker `reserve_spend pay_x402 commit_spend`; seller `upload_receivable open_facility set_budgets`; lender `fund_agents`. A name the model invents is refused. The server's token check is separate and unchanged: a tool outside the role's scopes still answers `INSUFFICIENT_SCOPE`.
- **Spend cap.** A run that may call `reserve_spend` must have a cap (`maxSpend`, `--max-spend`). A reservation that would take the run's total over the cap is refused with `SPEND_CAP_EXCEEDED` before it is sent; non-numeric or zero amounts are refused too.
- **Own reservations only.** `pay_x402` and `commit_spend` accept only a `spendId` that this run reserved.
- **Pinned arguments.** `--receivable` (and, for a worker, its own address and spend wallet from `deployments/testnet/spend-wallets.json`) overwrite whatever the model writes in those arguments and are hidden from its tool schemas, so it cannot redirect a spend.
- **Idempotency keys.** The model never sees or writes `idempotencyKey`. The wrapper derives it as `llm-<tool>:<hash of run id and the call's arguments>`: repeating a run with the same run id replays the stored results instead of acting twice, and a repeated identical call inside one run replays the first result. A different amount, merchant or run id is a new key.
- **Server limits still apply.** Budgets, per-transaction and daily limits, the merchant allowlist, KYA level and the co-signer policy are enforced by the control plane exactly as for scripted agents.
- **Worker catalog.** The worker has one extra local tool, `list_catalog`, that fetches only the configured `--catalog` URLs and returns each offer with its price in base units, merchant address and URL.

## The audit trail

Every tool call, refused or not, is appended to `agents/data/llm-audit.jsonl` (gitignored) in the engine's event-store format, and the run's end follows:

```json
{"type":"LlmToolCall","id":"0x…","agentUaid":"…","role":"worker","model":"ollama:qwen2.5:7b","runId":"…","step":2,"tool":"reserve_spend","input":{"merchant":"0x…","amount":"250000"},"outcome":"ok","result":{"spendId":"0x…"},"seq":3,"prevSeq":2,"ts":"…"}
{"type":"LlmRunFinished","role":"worker","runId":"…","status":"completed","steps":4,"spent":"250000","answer":"Bought the research report …"}
```

`outcome` is `ok`, `error` (the server refused, `code` is lifted out) or `refused` (the wrapper refused: `TOOL_NOT_ALLOWED`, `SPEND_CAP_EXCEEDED`, `UNKNOWN_SPEND`, `BAD_INPUT`). The on-chain effects of the calls the server accepted show up in the MCP server's own audit log and the read API (`/events`) like any other agent's, attributed to the agent's UAID; this file adds what the model decided and what the wrapper stopped.

## Code map

| File (`agents/src/llm/`) | Role |
|---|---|
| `agent.ts` | `LlmAgent`: the loop and the guardrails |
| `types.ts` | provider-neutral `ChatModel.chat(messages, tools)` returning text and tool calls |
| `ollama.ts`, `anthropic.ts` | the two backends (Ollama over plain `fetch`; Anthropic through `@anthropic-ai/sdk`) |
| `provider.ts` | provider selection and the refusal messages |
| `prompts.ts` | role prompts and default allowlists |
| `tools.ts`, `catalogTool.ts` | tool definitions from `tools/list`; the worker's `list_catalog` |
| `audit.ts` | audit sink onto `@casheth/engine`'s `EventStore` |
| `scripted.ts` | fake model for tests and `--dry-run` |

Tests (`pnpm -F @casheth/agents test`) need no key and no model server: a scripted model drives the loop, a local fake HTTP server stands in for Ollama and the Anthropic API, and one suite runs the loop over the real auth server and MCP app.
