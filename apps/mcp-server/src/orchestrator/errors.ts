/**
 * Tool errors carry a machine-readable `code`: the shared error names (BUILD.md section 12.2, the same names the
 * contracts revert with) plus a few MCP-side codes (`NOT_FOUND`, `NOT_DEPLOYED`, `BAD_INPUT`, `COSIGNER_REFUSED`,
 * `KEY_NOT_HELD`, `IDEMPOTENCY_KEY_REUSED`, `CHAIN_ERROR`, `INTERNAL`).
 */
export class ToolError extends Error {
  constructor(
    readonly code: string,
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

export function fail(code: string, message?: string, details?: Record<string, unknown>): never {
  throw new ToolError(code, message, details);
}
