import { SSH_ERROR_CODES } from "@okouai/api-contracts/contracts/ssh-errors";
import { sshSaveAttempts } from "@okouai/db/schema/ssh-save-attempt";
import { and, eq } from "drizzle-orm";
import type { Db } from "../external/db";
import { lockSshOwner } from "./ssh-owner.service";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Owner = { readonly orgId: string; readonly userId: string };

export const sshSaveAttemptResolved = Object.freeze({
  ok: false as const,
  kind: "conflict" as const,
  code: SSH_ERROR_CODES.SAVE_ATTEMPT_RESOLVED,
  message:
    "This save attempt has been resolved. Confirm its outcome before saving again.",
});

// Callers hold the SSH owner lock until their resource/receipt transaction commits.
export async function findSshSaveAttempt(
  tx: Transaction,
  owner: Owner,
  attemptId: string,
) {
  const [receipt] = await tx
    .select({ saved: sshSaveAttempts.saved })
    .from(sshSaveAttempts)
    .where(
      and(
        eq(sshSaveAttempts.orgId, owner.orgId),
        eq(sshSaveAttempts.userId, owner.userId),
        eq(sshSaveAttempts.attemptId, attemptId),
      ),
    );
  return receipt;
}

export async function recordSshSaveAttempt(
  tx: Transaction,
  owner: Owner,
  attemptId: string,
  saved: boolean,
) {
  await tx.insert(sshSaveAttempts).values({
    orgId: owner.orgId,
    userId: owner.userId,
    attemptId,
    saved,
  });
}

export function resolveSshSaveAttempt(db: Db, owner: Owner, attemptId: string) {
  return db.transaction(async (tx) => {
    await lockSshOwner(tx, owner);
    const receipt = await findSshSaveAttempt(tx, owner, attemptId);
    if (receipt) {
      return receipt;
    }
    // Absence alone cannot rule out an in-flight request. Fence it before
    // telling the caller that another submission is safe.
    await recordSshSaveAttempt(tx, owner, attemptId, false);
    return { saved: false };
  });
}
