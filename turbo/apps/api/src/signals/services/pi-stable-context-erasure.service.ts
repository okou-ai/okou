import { createHash } from "node:crypto";

import {
  assertErasureSubjectWritable,
  lockErasureSubjects,
  type ErasureSubject,
} from "@okouai/db/operations/account-erasure";
import { piStableContextErasureFences } from "@okouai/db/schema/pi-stable-context";
import { and, eq, or } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { settle } from "../utils";
import { COMPUTE_CLOSURE_ERROR } from "./agent-run-terminal-transition.service";

type PiStableContextErasureSubject = ErasureSubject;

export function piStableContextErasureSubjectDigest(
  subject: PiStableContextErasureSubject,
): string {
  return createHash("sha256")
    .update(subject.subjectKind)
    .update("\0")
    .update(subject.subjectId)
    .digest("hex");
}

function canonicalSubjects(
  subjects: readonly PiStableContextErasureSubject[],
): readonly (PiStableContextErasureSubject & { readonly digest: string })[] {
  return [...subjects]
    .map((subject) => {
      return {
        ...subject,
        digest: piStableContextErasureSubjectDigest(subject),
      };
    })
    .sort((left, right) => {
      return `${left.subjectKind}:${left.digest}`.localeCompare(
        `${right.subjectKind}:${right.digest}`,
      );
    });
}

/**
 * Shares the canonical account-erasure admission lock, then checks the
 * feature-local durable closure written by the legacy Clerk cleanup path.
 */
export async function admitPiStableContextSubjects(
  tx: Tx,
  subjects: readonly PiStableContextErasureSubject[],
): Promise<boolean> {
  const canonical = canonicalSubjects(subjects);
  const admission = await settle(assertErasureSubjectWritable(tx, canonical));
  if (!admission.ok) {
    if (
      admission.error instanceof Error &&
      admission.error.message === COMPUTE_CLOSURE_ERROR
    ) {
      return false;
    }
    throw admission.error;
  }
  const [closed] = await tx
    .select({ subjectDigest: piStableContextErasureFences.subjectDigest })
    .from(piStableContextErasureFences)
    .where(
      or(
        ...canonical.map((subject) => {
          return and(
            eq(piStableContextErasureFences.subjectKind, subject.subjectKind),
            eq(piStableContextErasureFences.subjectDigest, subject.digest),
          );
        }),
      ),
    )
    .limit(1);
  return closed === undefined;
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
