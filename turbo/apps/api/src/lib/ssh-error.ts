import type { SshErrorCode } from "@okouai/api-contracts/contracts/ssh-errors";

export function sshErrorResponse<Status extends 400 | 403 | 404 | 409>(
  status: Status,
  code: SshErrorCode,
  message: string,
) {
  return { status, body: { error: { code, message } } };
}
