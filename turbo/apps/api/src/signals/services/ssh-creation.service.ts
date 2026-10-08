import { SSH_ERROR_CODES } from "@okouai/api-contracts/contracts/ssh-errors";

type Owner = { readonly orgId: string; readonly userId: string | null };

export function resourceIdConflict() {
  return {
    ok: false as const,
    kind: "conflict" as const,
    code: SSH_ERROR_CODES.RESOURCE_ID_CONFLICT,
    message: "This resource ID cannot be used for this SSH configuration.",
  };
}

/** Shared interpretation only; callers own the reads and transaction. */
export function sshCreationResult(owner: Owner, existing: Owner | undefined) {
  if (
    existing &&
    (existing.orgId !== owner.orgId || existing.userId !== owner.userId)
  ) {
    return resourceIdConflict();
  }
  return { ok: true as const, value: existing === undefined };
}
