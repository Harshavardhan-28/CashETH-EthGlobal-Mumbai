# CashETH on-chain evidence

Every link below is a Hedera testnet (chain 296) HashScan link for activity produced by this repo's code and scripts.

## Accounts

Demo agent accounts created by `scripts/setup-accounts.ts`: ECDSA keys with EVM-address aliases, 20 HBAR each, USDC (`0.0.429274`) associated. Initial USDC: buyer 10, lenderA 4, lenderB 2, lenderC 1.

| Label | Account | EVM address |
| --- | --- | --- |
| seller | [0.0.11337987](https://hashscan.io/testnet/account/0.0.11337987) | `0x164334ee48b6ab0c07514af2a84646b23f3dcf0f` |
| buyer | [0.0.11337988](https://hashscan.io/testnet/account/0.0.11337988) | `0xf5ffbcd1e9ca403fec295127eace1a3674f949c9` |
| workerResearch | [0.0.11337989](https://hashscan.io/testnet/account/0.0.11337989) | `0xbead36c554746b00eb2a3b87ce38adc926ddf62f` |
| workerCompute | [0.0.11337990](https://hashscan.io/testnet/account/0.0.11337990) | `0x3f8960701e2bb81869a0e64259e191cdb6790858` |
| lenderA | [0.0.11337991](https://hashscan.io/testnet/account/0.0.11337991) | `0xc502fe381481abd2e56921dc58dfc3ca3776a096` |
| lenderB | [0.0.11337992](https://hashscan.io/testnet/account/0.0.11337992) | `0x502ea0745ddd16128b8f649394cd0c8c93fed238` |
| lenderC | [0.0.11337993](https://hashscan.io/testnet/account/0.0.11337993) | `0xeaabaef2df2bd6c1e13207573b233d1d33042377` |
| coordinator | [0.0.11337994](https://hashscan.io/testnet/account/0.0.11337994) | `0x45fdf15ed9c6327deb0e57db6b78f592b254ab68` |
| cosigner | [0.0.11337995](https://hashscan.io/testnet/account/0.0.11337995) | `0xdd479f3ca489d481374d04a409d7f0e7a972c9e4` |
| kyaIssuer | [0.0.11337996](https://hashscan.io/testnet/account/0.0.11337996) | `0x8918f395c2e80066901a01d2cbe134ca9d31f582` |

## Spike S1: Aqua + SwapVM on Hedera

Official 1inch `AquaRouter` and an unmodified `AquaSwapVMRouter` (runtime 21,981 B) deployed to Hedera testnet; lender A shipped a 1 USDC / 1 TOKENB XYC strategy and `SpikeTaker` filled 0.1 TOKENB → USDC against real HTS USDC (`0.0.429274`). Produced by `contracts/script/00_DeployAquaSpike.s.sol` and `scripts/spikes/s1-aqua-xyc.ts`; machine-readable record in `deployments/testnet/spike-aqua.json`.

**Deploy path that worked:** `forge script script/00_DeployAquaSpike.s.sol --rpc-url testnet --private-key $HEDERA_OPERATOR_KEY --broadcast --legacy --slow --skip-simulation --gas-estimate-multiplier 130` through the Hashio relay. The router's ~23.5 KB initcode was accepted by the relay as an ordinary EVM creation; the `ContractCreateFlow` fallback was not needed. `--skip-simulation` is required because forge's replay simulation cannot execute the HTS `associate()` call in `SpikeTaker`'s constructor (revm has no HTS system contract).

Transaction ids of EVM transactions show the Hashio relay (`0.0.7314364`) as the transaction payer; gas is charged to the signing EVM account (operator `0.0.11333252` for creations, mints and the fill; lender A for approvals and ship).

### Contracts

| Contract | Contract id | EVM address | Creation tx | Gas used |
| --- | --- | --- | --- | --- |
| AquaRouter (official Aqua registry, `lib/aqua` @ 86abe30f) | [0.0.11338088](https://hashscan.io/testnet/contract/0.0.11338088) | `0xE696943051d272e63b02429C4449174Df73AEFEF` | [0.0.7314364@1793962858.989301503](https://hashscan.io/testnet/transaction/0.0.7314364@1793962858.989301503) | 887,121 |
| AquaSwapVMRouter (unmodified, `lib/swap-vm` @ f9f4acfe) | [0.0.11338089](https://hashscan.io/testnet/contract/0.0.11338089) | `0xad3b3E9C8569d3A98F46638706e988593a60F177` | [0.0.7314364@1793962861.258758871](https://hashscan.io/testnet/transaction/0.0.7314364@1793962861.258758871) | 4,849,926 |
| SpikeTokenB (TOKENB, 6-dec ERC-20) | [0.0.11338091](https://hashscan.io/testnet/contract/0.0.11338091) | `0x5E8D4A662506a181F92f13B227BdAe2035aFb112` | [0.0.7314364@1793962867.786577686](https://hashscan.io/testnet/transaction/0.0.7314364@1793962867.786577686) | 576,050 |
| SpikeOrderBuilder | [0.0.11338092](https://hashscan.io/testnet/contract/0.0.11338092) | `0x044A0A14DcD0F43c38c2531d76579e2a089A8E83` | [0.0.7314364@1793962870.241347429](https://hashscan.io/testnet/transaction/0.0.7314364@1793962870.241347429) | 1,188,224 |
| SpikeTaker | [0.0.11338095](https://hashscan.io/testnet/contract/0.0.11338095) | `0xCaB7F04e7AAA2780B86E5688a69ad9DeFFC7BfbA` | [0.0.7314364@1793962871.567047578](https://hashscan.io/testnet/transaction/0.0.7314364@1793962871.567047578) | 1,156,573 |

`SpikeTaker` associated itself with USDC in its constructor (HIP-719 `associate()` on the facade); the mirror node lists `0.0.429274` on `0.0.11338095`.

### Ship (lender A [0.0.11337991](https://hashscan.io/testnet/account/0.0.11337991))

Strategy hash (`keccak256(abi.encode(order))` = `router.hash(order)`): `0xc9125dc82af7085ec0de8c18e9265f9f61f7ea3636903ef40e29f0b412f88af3`

| Step | Transaction |
| --- | --- |
| mint 1 TOKENB to lender A | [0.0.7314364@1793963051.329017528](https://hashscan.io/testnet/transaction/0.0.7314364@1793963051.329017528) |
| mint 0.1 TOKENB to SpikeTaker | [0.0.7314364@1793963054.440703515](https://hashscan.io/testnet/transaction/0.0.7314364@1793963054.440703515) |
| lender A approves Aqua for 1 USDC (HTS allowance via facade) | [0.0.7314364@1793963063.234109476](https://hashscan.io/testnet/transaction/0.0.7314364@1793963063.234109476) |
| lender A approves Aqua for TOKENB | [0.0.7314364@1793963066.063489567](https://hashscan.io/testnet/transaction/0.0.7314364@1793963066.063489567) |
| lender A ships XYC strategy | [0.0.7314364@1793963071.121512471](https://hashscan.io/testnet/transaction/0.0.7314364@1793963071.121512471) |

### Fill

`router.quote` from the SpikeTaker address: 100000 TOKENB in → 90909 USDC out (XYC: ⌊0.1·1/1.1⌋). Fill used the quote as min-out threshold.

- `SpikeTaker.fill(order, 100000, takerData)`: [0.0.7314364@1793963078.419965153](https://hashscan.io/testnet/transaction/0.0.7314364@1793963078.419965153) (EVM hash `0x21939d23b9dd6d3c3b1022ec934ce18527125e077558f6f14491a59da911e322`, gas used 141,141)
- HTS child transfer at `1793963082.954511105`: lender A −90,909 USDC (`is_approval: true`, Aqua spending lender A's HTS allowance), SpikeTaker `0.0.11338095` +90,909 USDC

| Balance (6-dec units) | Before | After | Delta |
| --- | --- | --- | --- |
| lender A USDC (mirror) | 4,000,000 | 3,909,091 | -90,909 |
| SpikeTaker USDC (mirror) | 0 | 90,909 | +90,909 |
| lender A TOKENB | 1,000,000 | 1,100,000 | +100,000 |
| SpikeTaker TOKENB | 100,000 | 0 | -100,000 |

HBAR spent: operator ~11.1 HBAR (five creations, two mints, the fill); lender A ~1.06 HBAR (two approvals, ship).

Findings for later tasks: HTS `approve(spender, type(uint256).max)` through the facade fails (`CONTRACT_EXECUTION_EXCEPTION` in simulation; HTS allowances are int64), so USDC approvals must be bounded. The relay's gas estimate for a facade `approve` was ~822k.
