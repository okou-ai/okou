import type { VncErrorCode } from "@okouai/api-contracts/contracts/vnc-errors";

export function vncErrorResponse<Status extends 400 | 404 | 409>(
  status: Status,
  code: VncErrorCode,
  message: string,
) {
  return { status, body: { error: { code, message } } };
}
