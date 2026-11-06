# CashETH

CashETH lets a seller agent turn a buyer-signed receivable into USDC working capital on Hedera testnet (EVM chain 296). The credit is funded through a redeployed 1inch Aqua and a modified SwapVM, spent by the agent through x402, and repaid lenders-first when the buyer settles.

## Repository layout

```
contracts/                      Foundry
  foundry.toml  remappings.txt
  lib/{forge-std,openzeppelin-contracts,solidity-utils,aqua,swap-vm}   (submodules)
  src/core/{KYARegistry,ReceivableRegistry,ReceivableCreditNote,CreditFacility,RepaymentRouter}.sol
  src/core/interfaces/{IKYARegistry,IReceivableRegistry,ICreditFacility,IReceivableCreditNote}.sol
  src/core/libs/CashEthTraits.sol
  src/hedera/{IHRC719,IHederaScheduleService,HederaResponseCodes}.sol
  src/aqua/{ReceivableCredit,CashEthSwapVMRouter,CashEthOrderBuilder}.sol
  src/spikes/{AssocProbe,AlarmProbe}.sol
  test/mocks/{MockUSDC,MockHSS,MockSwapRouter}.sol
  test/{KYARegistry,ReceivableRegistry,ReceivableCreditNote,CreditFacility,RepaymentRouter,ReceivableCredit,CashEthSwapVMRouter}.t.sol
  test/invariants/FacilityInvariants.t.sol
  script/{00_DeployAquaSpike,01_DeployCore,02_DeployAquaRouter,03_Wire}.s.sol
packages/shared     @casheth/shared     env, addresses, ABIs, EIP-712 types, error codes, hashscan helpers
packages/hedera     @casheth/hedera     viem clients, Hiero SDK helpers, accounts, HCS, NFT, HCS-14, x402 client signer
packages/aqua       @casheth/aqua       order builder calls, ship/dock, strategy discovery, solver
packages/engine     @casheth/engine     score, borrowing base, spend policy, co-signer policy, event store, idempotency
apps/merchant       @casheth/merchant   x402 research API
apps/auth-server    @casheth/auth       OAuth 2.1 AS with KYA
apps/mcp-server     @casheth/mcp        MCP tools + orchestrator wiring
apps/web            @casheth/web        dashboard (Vite + React)
agents/             @casheth/agents     seller, buyer, worker, lender, demo runner
scripts/            account setup, funding, sweep, abi sync
docs/               EVIDENCE.md, superpowers/
```

Powered by Aqua — © Degensoft Ltd 2025
