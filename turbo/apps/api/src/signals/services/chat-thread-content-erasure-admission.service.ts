import {
  assertErasureSubjectWritable,
  type ErasureSubject,
} from "@okouai/db/operations/account-erasure";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { eq, sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import type { Db } from "../external/db";
import { settle } from "../utils";

/**
 * Content-free canonical identity of one chat thread: the thread's own user
 * plus, when the thread has one, the Agent it belongs to, that Agent's `owner`
 * and its organization. It carries no title, draft or attachment, so it can be
 * resolved and admitted before any account content is written.
 *
 * `agentId` is nullable in the schema and the draft writer accepts an owned
 * thread without an Agent, so such a thread has a thread-user subject only. A
 * non-null Agent reference that does not resolve is a missing canonical parent,
 * never permission to admit the thread user alone.
 */
export interface ChatThreadContentIdentity {
  readonly chatThreadId: string;
  readonly userId: string;
  readonly agentId: string | null;
  readonly agentOwner: string | null;
  readonly orgId: string | null;
}

/** The canonical parents moved between the unlocked resolution and the locks. */
export class ChatThreadContentOwnershipChangedError extends Error {
  constructor() {
    super("Chat thread content ownership changed while acquiring locks");
    this.name = "ChatThreadContentOwnershipChangedError";
  }
}

const CONTENT_LOCK_TIMEOUT = "1s";
const CONTENT_STATEMENT_TIMEOUT = "5s";
/** One reselection per canonical parent the write depends on, then fail. */
const OWNERSHIP_ATTEMPTS = 3;

/**
 * `written` carries the inner write's own result, `missing` is a resolved
 * absent or unauthorized thread that keeps each route's existing not-found
 * disposition, and `closed` is B1's exact subject closure. Closure stays
 * separate from every database failure and from cancellation, which keep their
 * original propagation, so a timeout can never surface as a fabricated 404.
 */
type ChatThreadContentWriteOutcome<T> =
  | { readonly outcome: "written"; readonly value: T }
  | { readonly outcome: "missing" }
  | { readonly outcome: "closed" };

async function setChatThreadContentDeadlines(tx: Tx): Promise<void> {
  await tx.execute(
    sql`SELECT set_config('lock_timeout', ${CONTENT_LOCK_TIMEOUT}, true)`,
  );
  await tx.execute(
    sql`SELECT set_config('statement_timeout', ${CONTENT_STATEMENT_TIMEOUT}, true)`,
  );
}

/**
 * Resolves ownership from the real persisted parents by primary key. The
 * request's own `userId`/`orgId` and any stored sidebar label are never
 * authority here: they are compared against this result, not substituted for it.
 */
async function loadChatThreadContentIdentity(
  tx: Tx,
  chatThreadId: string,
): Promise<ChatThreadContentIdentity | null> {
  const [thread] = await tx
    .select({
      chatThreadId: chatThreads.id,
      userId: chatThreads.userId,
      threadAgentId: chatThreads.agentId,
      agentId: agents.id,
      agentOwner: agents.owner,
      orgId: agents.orgId,
    })
    .from(chatThreads)
    .leftJoin(agents, eq(chatThreads.agentId, agents.id))
    .where(eq(chatThreads.id, chatThreadId))
    .limit(1);
  if (!thread) {
    return null;
  }
  if (thread.threadAgentId !== null && thread.agentId === null) {
    // `chat_threads.agent_id` cascades from `agents`, so this is the window
    // where that cascade has committed under READ COMMITTED. Reselecting
    // resolves it; it must never degrade to a thread-user-only admission.
    throw new ChatThreadContentOwnershipChangedError();
  }
  return {
    chatThreadId: thread.chatThreadId,
    userId: thread.userId,
    agentId: thread.agentId,
    agentOwner: thread.agentOwner,
    orgId: thread.orgId,
  };
}

/** At most three subjects: user and organization are separate domains, and a
 * shared Agent's owner is a user subject distinct from the thread user. */
function chatThreadContentSubjects(
  identity: ChatThreadContentIdentity,
): ErasureSubject[] {
  const subjects: ErasureSubject[] = [
    { subjectKind: "user", subjectId: identity.userId },
  ];
  if (identity.agentOwner !== null) {
    subjects.push({ subjectKind: "user", subjectId: identity.agentOwner });
  }
  if (identity.orgId !== null) {
    subjects.push({ subjectKind: "organization", subjectId: identity.orgId });
  }
  return [
    ...new Map(
      subjects.map((subject) => {
        return [JSON.stringify(subject), subject];
      }),
    ).values(),
  ];
}

/** Sorted shared B1 admission, before any business-row lock and before any
 * content write. Only B1's exact closure error denies the write; every other
 * failure, including a bounded lock wait, propagates unchanged. */
async function admitChatThreadContentSubjects(
  tx: Tx,
  identity: ChatThreadContentIdentity,
): Promise<boolean> {
  const result = await settle(
    assertErasureSubjectWritable(tx, chatThreadContentSubjects(identity)),
  );
  if (result.ok) {
    return true;
  }
  if (
    result.error instanceof Error &&
    result.error.message === "account_erasure:subject_closed"
  ) {
    return false;
  }
  throw result.error;
}

function sameChatThreadContentIdentity(
  left: ChatThreadContentIdentity,
  right: ChatThreadContentIdentity,
): boolean {
  return (
    left.chatThreadId === right.chatThreadId &&
    left.userId === right.userId &&
    left.agentId === right.agentId &&
    left.agentOwner === right.agentOwner &&
    left.orgId === right.orgId
  );
}

/**
 * Retains the canonical identity locks through COMMIT in the Agent -> thread
 * order the run-output writer and the search projector already use.
 *
 * `agents` carries the `(id, org_id, owner)` unique key, so KEY SHARE conflicts
 * with an owner or organization transfer and with Agent deletion, which
 * cascades this thread. `chat_threads` has no unique key over `user_id` and no
 * production writer moves it; its KEY SHARE conflicts with the FOR UPDATE that
 * `deleteChatThread$` takes before removing the row. Neither conflicts with the
 * FOR NO KEY UPDATE that this transaction's own title or draft UPDATE takes, so
 * unrelated draft and rename traffic on other threads is never serialized.
 *
 * Re-reading the same content-free identity under the retained locks turns a
 * transfer committed between resolution and lock acquisition into a rollback,
 * instead of relabelling a title or draft under a newly discovered owner or
 * widening the admitted subject set after the business locks.
 */
async function lockChatThreadContentIdentity(
  tx: Tx,
  identity: ChatThreadContentIdentity,
): Promise<ChatThreadContentIdentity | null> {
  if (identity.agentId !== null) {
    await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, identity.agentId))
      .for("key share");
  }
  await tx
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(eq(chatThreads.id, identity.chatThreadId))
    .for("key share");
  const current = await loadChatThreadContentIdentity(
    tx,
    identity.chatThreadId,
  );
  if (!current) {
    return null;
  }
  if (!sameChatThreadContentIdentity(current, identity)) {
    throw new ChatThreadContentOwnershipChangedError();
  }
  return current;
}

/**
 * Owns the transaction for a direct chat-thread content write: deadlines ->
 * content-free identity -> the route's own ownership check -> shared B1
 * admission -> Agent and thread identity locks -> revalidation -> the write,
 * with every barrier retained through COMMIT.
 *
 * `authorize` is the caller's existing route contract expressed over the real
 * canonical identity. It runs before admission so an unauthorized request never
 * takes another account's subject locks, and it is a pure function of the
 * identity the revalidation already compares field by field, so the locked
 * re-read needs no second evaluation.
 *
 * A canonical parent that moves under the locks rolls the attempt back and
 * reselects a bounded number of times. Exhausting them raises
 * `ChatThreadContentOwnershipChangedError` rather than reporting closure or a
 * silent success.
 */
export async function withChatThreadContentWrite<T>(
  db: Db,
  args: {
    readonly chatThreadId: string;
    readonly authorize: (identity: ChatThreadContentIdentity) => boolean;
  },
  write: (tx: Tx, identity: ChatThreadContentIdentity) => Promise<T>,
  signal: AbortSignal,
): Promise<ChatThreadContentWriteOutcome<T>> {
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    const result = await settle(
      db.transaction(
        async (tx): Promise<ChatThreadContentWriteOutcome<T>> => {
          await setChatThreadContentDeadlines(tx);
          const selected = await loadChatThreadContentIdentity(
            tx,
            args.chatThreadId,
          );
          if (!selected || !args.authorize(selected)) {
            return { outcome: "missing" };
          }
          if (!(await admitChatThreadContentSubjects(tx, selected))) {
            return { outcome: "closed" };
          }
          const locked = await lockChatThreadContentIdentity(tx, selected);
          if (!locked) {
            return { outcome: "missing" };
          }
          signal.throwIfAborted();
          const value = await write(tx, locked);
          signal.throwIfAborted();
          return { outcome: "written", value };
        },
        { isolationLevel: "read committed" },
      ),
    );
    signal.throwIfAborted();
    if (result.ok) {
      return result.value;
    }
    if (
      !(result.error instanceof ChatThreadContentOwnershipChangedError) ||
      attempt === OWNERSHIP_ATTEMPTS
    ) {
      throw result.error;
    }
  }
}
