import type { CloudflareAccessErrorCode } from "@okouai/api-contracts/contracts/cloudflare-access-errors";

export function cloudflareAccessErrorResponse<
  Status extends 400 | 403 | 404 | 409,
>(status: Status, code: CloudflareAccessErrorCode, message: string) {
  return { status, body: { error: { code, message } } };
}
