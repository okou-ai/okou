import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { chatContentErasureSubjects } from "../schema/chat-content-erasure-subject";

type Db = NodePgDatabase<Record<string, never>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
interface ConfirmedDeletion {
  readonly subjectKind: "user" | "organization";
  readonly subjectId: string;
  readonly sourceReference: string;
}

/** Called only after authenticating a deletion, before acknowledging its receipt. */
export async function recordChatContentDeletion(
  db: Db | Tx,
  subject: ConfirmedDeletion,
): Promise<void> {
  await db
    .insert(chatContentErasureSubjects)
    .values(subject)
    .onConflictDoNothing();
}

/** Completion does not retire the subject: late writes need future sweeps too. */
export async function completeChatContentDeletion(
  db: Db | Tx,
  subject: ConfirmedDeletion,
): Promise<void> {
  await recordChatContentDeletion(db, subject);
  await db
    .update(chatContentErasureSubjects)
    .set({
      completedAt: sql`COALESCE(${chatContentErasureSubjects.completedAt}, clock_timestamp())`,
    })
    .where(
      and(
        eq(chatContentErasureSubjects.subjectKind, subject.subjectKind),
        eq(chatContentErasureSubjects.subjectId, subject.subjectId),
      ),
    );
}
