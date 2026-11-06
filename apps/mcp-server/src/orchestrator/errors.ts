/**
 * Tool errors carry a machine-readable `code`: either a shared error name (`ErrorCode`, BUILD.md section 12.2,
 * the names the contracts revert with) or one of the MCP-side orchestration codes below.
 */
import type { ErrorCode } from "@casheth/shared";

export const MCP_ERROR_CODES = [
  "NOT_FOUND",
  "NOT_DEPLOYED",
  "BAD_INPUT",
  "INVOICE_MISMATCH",
  "IDEMPOTENCY_KEY_REUSED",
  "CREDIT_DECLINED",
  "NO_ELIGIBLE_LIQUIDITY",
  "SPEND_WALLET_NOT_REGISTERED",
  "MERCHANT_URL_NOT_ALLOWED",
  "COSIGNER_REFUSED",
  "PAYMENT_FAILED",
  "PAYMENT_IN_FLIGHT",
  "RESERVATION_PAID",
  "RESERVATION_NOT_EXPIRED",
  "ALREADY_REPAID",
  "KEY_NOT_HELD",
  "CONTRACT_REVERTED",
  "CHAIN_ERROR",
  "INTERNAL",
] as const;

export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];
export type ToolErrorCode = ErrorCode | McpErrorCode;

export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string = code,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ToolError";
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...this.details };
  }
}

export function fail(code: ToolErrorCode, message?: string, details?: Record<string, unknown>): never {
  throw new ToolError(code, message, details);
}
