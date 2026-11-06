# Third-party notices

Powered by Aqua — © Degensoft Ltd 2025

CashETH builds on two components published by Degensoft Ltd (1inch). This file records how each is used.

## 1. SwapVM, modified router

| Item | Value |
| --- | --- |
| Upstream | 1inch SwapVM, `AquaSwapVMRouter` (`github.com/1inch/swap-vm`, pinned as the submodule `contracts/lib/swap-vm`) |
| License terms | `LicenseRef-Degensoft-SwapVM-1.1` |
| Our file | [contracts/src/aqua/CashEthSwapVMRouter.sol](contracts/src/aqua/CashEthSwapVMRouter.sol) and the added instruction [contracts/src/aqua/ReceivableCredit.sol](contracts/src/aqua/ReceivableCredit.sol) |
| Deployed | Hedera testnet, `0xFcE311Ea7f4B4F8D5d897d48BFA2a21DcC34A562` ([0.0.11339992](https://hashscan.io/testnet/contract/0.0.11339992)) |

The source of `CashEthSwapVMRouter` is published in this repository under `LicenseRef-Degensoft-SwapVM-1.1` terms. Our changes to the upstream router are marked and dated 2026-11-06. They are:

- One added instruction, `ReceivableCredit`, on the free slot `Opcode._21` of the conditions bank.
- Three added immutables the instruction reads: `REGISTRY`, `KYA` and `FACILITY`, and an added view `exposure(maker, buyer)`.
- `_runOpcode` tries `ReceivableCredit` first, then dispatches the Aqua opcode set in the same order as upstream.
- One upstream instruction, `XYCConcentrateSwap`, is removed so the runtime fits EIP-170 (23,759 B; 24,650 B with it).

The router keeps the upstream base contracts (`Simulator`, `SwapVM`, `AquaOpcodes`) and constructor arguments.

## 2. Aqua registry, redeployed unmodified

| Item | Value |
| --- | --- |
| Upstream | 1inch Aqua (`github.com/1inch/aqua`, pinned as the submodule `contracts/lib/aqua`) |
| License terms | `LicenseRef-Degensoft-Aqua-Source-1.1` (source-available) |
| Use | Redeployed on Hedera testnet only, with no source changes |
| Deployed | `0xc65A0788a9AE598aEAB5DbC529B7649a1383d54c` ([0.0.11339989](https://hashscan.io/testnet/contract/0.0.11339989)) |

Aqua is not deployed on Hedera by 1inch. This registry is a separate CashETH deployment for the ETHGlobal Mumbai hackathon and is not production use.

## Attribution

Powered by Aqua — © Degensoft Ltd 2025

The full license texts are in the upstream repositories listed above (the submodules under `contracts/lib/`).

Note: the license headers and dated change notes were added to `contracts/src/aqua/CashEthSwapVMRouter.sol` and `contracts/src/aqua/ReceivableCredit.sol` after the testnet deployment (commit 85e70d3). The change is comment-only; the deployed runtime bytecode is unchanged and only the Solidity metadata hash appended to a fresh build differs.
