/** Test fixtures: the live addresses.json shape, a buyer key and the `upload_receivable` result it confirms. */
import type { Addresses } from "@casheth/shared";
import { ABI } from "@1inch/aqua-sdk";
import { RepaymentRouterAbi } from "@casheth/shared";
import { encodeFunctionData, erc20Abi, getAddress, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const ADDRESSES: Addresses = {
  chainId: 296,
  receivableRegistry: getAddress("0x0D118059D67cbe738aD86C4B8c25cdf06837791f"),
  repaymentRouter: getAddress("0x63B6f03a60026626B6052D800864dD74604f6a8a"),
  creditFacility: getAddress("0x38ACd9F1FEED870b2507b1421bE887d9a751d9e0"),
  aqua: getAddress("0xc65A0788a9AE598aEAB5DbC529B7649a1383d54c"),
  swapRouter: getAddress("0x458b3b7CaDec64Cd0AE0B244d582006C4E99ce1b"),
  tUsdt: getAddress("0x65C25Cc145f0836C8fFAb83Bf9676e98a8a2648a"),
  usdc: getAddress("0x0000000000000000000000000000000000068cDa"),
};

export const BUYER_KEY = keccak256(toHex("test buyer key"));
export const SELLER_KEY = keccak256(toHex("test seller key"));
export const BUYER = privateKeyToAccount(BUYER_KEY);
export const SELLER = privateKeyToAccount(SELLER_KEY);

export const RECEIVABLE_ID = keccak256(toHex("receivable"));
export const PENDING_ID = keccak256(toHex("pending"));

/** `upload_receivable`'s answer as the CashETH MCP server returns it (uint fields as decimal strings). */
export function uploadResult(overrides: { domain?: Record<string, unknown>; message?: Record<string, unknown> } = {}) {
  return {
    pendingId: PENDING_ID,
    id: RECEIVABLE_ID,
    confirmationRequest: {
      typedData: {
        domain: { name: "AgentReceivables", version: "1", chainId: 296, verifyingContract: ADDRESSES.receivableRegistry, ...overrides.domain },
        types: {},
        primaryType: "ReceivableConfirmation",
        message: {
          seller: SELLER.address,
          buyer: BUYER.address,
          currency: ADDRESSES.usdc,
          amount: "2000000",
          dueDate: "1797800000",
          buyerRef: keccak256(toHex("PO-2001")),
          detailsCommitment: keccak256(toHex("invoice pdf")),
          payTo: ADDRESSES.repaymentRouter,
          nonce: "3",
          deadline: "1797000000",
          ...overrides.message,
        },
      },
    },
  };
}

export const approve = (token: Hex, spender: Hex, amount: bigint) => ({
  to: token,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
  description: "USDC.approve(RepaymentRouter, amount)",
});

export const repay = (amount: bigint) => ({
  to: ADDRESSES.repaymentRouter!,
  data: encodeFunctionData({ abi: RepaymentRouterAbi, functionName: "repay", args: [RECEIVABLE_ID, amount] }),
  description: "RepaymentRouter.repay(id, amount)",
});

export const dock = () => ({
  to: ADDRESSES.aqua!,
  data: encodeFunctionData({
    abi: ABI.AQUA_ABI,
    functionName: "dock",
    args: [ADDRESSES.swapRouter!, keccak256(toHex("strategy")), [ADDRESSES.usdc!]],
  }),
  description: "Aqua.dock(strategy)",
});

export const transfer = (to: Hex, amount: bigint) => ({
  to: ADDRESSES.usdc!,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }),
  description: "USDC.transfer",
});
