import { createHash } from "node:crypto";

import {
  lockErasureSubjects,
  type ErasureSubject,
} from "@okouai/db/operations/account-erasure";
import { piStableContextErasureFences } from "@okouai/db/schema/pi-stable-context";

import type { Tx } from "../../lib/db-types";

type PiStableContextErasureSubject = ErasureSubject;

function piStableContextErasureSubjectDigest(
  subject: PiStableContextErasureSubject,
): string {
  return createHash("sha256")
    .update(subject.subjectKind)
    .update("\0")
    .update(subject.subjectId)
    .digest("hex");
}

/**
 * Permanently closes one legacy Clerk subject under the same exclusive lock
 * used by account erasure. The caller performs final lifecycle cleanup in the
 * same transaction before releasing that lock.
 */
export async function closePiStableContextErasureSubject(
  tx: Tx,
  subject: PiStableContextErasureSubject,
): Promise<void> {
  await lockErasureSubjects(tx, [subject]);
  await tx
    .insert(piStableContextErasureFences)
    .values({
      subjectKind: subject.subjectKind,
      subjectDigest: piStableContextErasureSubjectDigest(subject),
    })
    .onConflictDoNothing();
}
