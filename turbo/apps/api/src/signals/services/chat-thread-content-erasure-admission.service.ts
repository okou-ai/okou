import {
  assertErasureSubjectWritable,
  erasureSubjectOpenCondition,
  setErasureFenceDeadlines,
  type ErasureSubject,
} from "@okouai/db/operations/account-erasure";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { eq } from "drizzle-orm";

import { pgBooleanDecoder } from "../../lib/db-structured-result";
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
  await setErasureFenceDeadlines(tx, {
    lockTimeout: CONTENT_LOCK_TIMEOUT,
    statementTimeout: CONTENT_STATEMENT_TIMEOUT,
  });
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

/**
 * The same canonical identity plus the lock-free closure state of the subjects
 * that identity owns, resolved by one statement.
 *
 * A read creates nothing, so it needs no advisory lock and closure must not
 * have to wait for it; all a read owes is that it does not serve an already
 * closed subject. Folding `erasureSubjectOpenCondition` into the statement the
 * route already issues buys that for no extra round trip, and the predicate
 * covers exactly the subjects {@link chatThreadContentSubjects} derives from
 * the same row: an absent Agent parent contributes no subject here either,
 * because a job's subject id is never equal to SQL NULL.
 *
 * The result carries no authority. It can go stale the moment the statement
 * returns, so a caller that writes must still be admitted by
 * `assertErasureSubjectWritable` inside its own transaction.
 */
async function loadChatThreadContentAdmission(
  tx: Tx,
  chatThreadId: string,
): Promise<{
  readonly identity: ChatThreadContentIdentity;
  readonly subjectOpen: boolean;
} | null> {
  const [thread] = await tx
    .select({
      chatThreadId: chatThreads.id,
      userId: chatThreads.userId,
      threadAgentId: chatThreads.agentId,
      agentId: agents.id,
      agentOwner: agents.owner,
      orgId: agents.orgId,
      subjectOpen: erasureSubjectOpenCondition(tx, [
        { subjectKind: "user", subjectId: chatThreads.userId },
        { subjectKind: "user", subjectId: agents.owner },
        { subjectKind: "organization", subjectId: agents.orgId },
      ]).mapWith(pgBooleanDecoder),
    })
    .from(chatThreads)
    .leftJoin(agents, eq(chatThreads.agentId, agents.id))
    .where(eq(chatThreads.id, chatThreadId))
    .limit(1);
  if (!thread) {
    return null;
  }
  if (thread.threadAgentId !== null && thread.agentId === null) {
    // Same cascade window as the identity resolution above: reselecting
    // resolves it, and it must never degrade to a thread-user-only admission.
    throw new ChatThreadContentOwnershipChangedError();
  }
  return {
    identity: {
      chatThreadId: thread.chatThreadId,
      userId: thread.userId,
      agentId: thread.agentId,
      agentOwner: thread.agentOwner,
      orgId: thread.orgId,
    },
    subjectOpen: thread.subjectOpen,
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
 * cascades this thread. The thread `(id, user_id)` key similarly retains its
 * owner under KEY SHARE. That lock conflicts with the FOR UPDATE that
 * `deleteChatThread$` takes before removing the row, while remaining
 * compatible with this transaction's own title or draft FOR NO KEY UPDATE.
 * Callers that explicitly request UPDATE serialize at this first thread lock;
 * they do not acquire KEY SHARE and upgrade later.
 *
 * Re-reading the same content-free identity under the retained locks turns a
 * transfer committed between resolution and lock acquisition into a rollback,
 * instead of relabelling a title or draft under a newly discovered owner or
 * widening the admitted subject set after the business locks.
 */
async function lockChatThreadContentIdentity(
  tx: Tx,
  identity: ChatThreadContentIdentity,
  threadLock: "key share" | "update",
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
    .for(threadLock);
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
 * The read transaction every lock-free caller shares: deadlines -> the folded
 * identity-and-closure statement -> the caller's own ownership check -> the
 * caller's bounded read -> a revalidation of the same content-free identity.
 *
 * It takes no lock of its own. It deliberately acquires neither
 * `pg_advisory_xact_lock_shared` nor `agents`/`chat_threads` KEY SHARE: a read
 * creates nothing that closure would have to erase, and those locks conflict
 * with the writers of the very rows being read — the chat queue's `FOR UPDATE`
 * on the same thread, and every ordinary content write. A reader that acquired
 * them would serialize behind the request that scheduled the work and add
 * nothing to erasure safety.
 *
 * The consequence is explicit: this carries **no authority**. A canonical
 * parent can move the moment it commits, so a caller that later writes what it
 * captured here must be readmitted under {@link withChatThreadContentWrite}.
 * Closure observed here is a reason to stop early, never a licence to write.
 *
 * Within the read the identity is still revalidated. The read is an await and
 * under READ COMMITTED without a lock a transfer can commit during it, so the
 * same content-free identity is read again afterwards and compared field by
 * field. Without that the gate could admit one account's subjects and then hand
 * the caller content belonging to another: a later writer's pin check rejects
 * the write, but it cannot recall content the caller has already sent
 * elsewhere. A moved identity raises
 * {@link ChatThreadContentOwnershipChangedError} rather than returning a value.
 *
 * This narrows the window to one transaction; it does not close it. Ownership
 * can still move between this COMMIT and whatever the caller does next.
 */
async function readAdmittedChatThreadContent<T>(
  tx: Tx,
  args: {
    readonly chatThreadId: string;
    readonly authorize: (identity: ChatThreadContentIdentity) => boolean;
  },
  read: (tx: Tx, identity: ChatThreadContentIdentity) => Promise<T>,
  signal: AbortSignal,
): Promise<ChatThreadContentWriteOutcome<T>> {
  await setChatThreadContentDeadlines(tx);
  const selected = await loadChatThreadContentAdmission(tx, args.chatThreadId);
  if (!selected || !args.authorize(selected.identity)) {
    return { outcome: "missing" };
  }
  if (!selected.subjectOpen) {
    return { outcome: "closed" };
  }
  signal.throwIfAborted();
  const value = await read(tx, selected.identity);
  const current = await loadChatThreadContentIdentity(tx, args.chatThreadId);
  if (!current) {
    return { outcome: "missing" };
  }
  if (!sameChatThreadContentIdentity(current, selected.identity)) {
    throw new ChatThreadContentOwnershipChangedError();
  }
  signal.throwIfAborted();
  return { outcome: "written", value };
}

/**
 * Admission for a read-only **initiation gate**, on the lock-free read path.
 *
 * An optional background workflow uses this to refuse to start producing
 * content for a subject already known closed. A moved canonical parent is
 * surfaced to its caller rather than reselected: the gate's own caller decides
 * whether starting that work is still meaningful.
 *
 * See {@link readAdmittedChatThreadContent} for the complete contract,
 * including why this gate carries no authority.
 */
export async function withChatThreadContentAdmission<T>(
  db: Db,
  args: {
    readonly chatThreadId: string;
    readonly authorize: (identity: ChatThreadContentIdentity) => boolean;
  },
  read: (tx: Tx, identity: ChatThreadContentIdentity) => Promise<T>,
  signal: AbortSignal,
): Promise<ChatThreadContentWriteOutcome<T>> {
  signal.throwIfAborted();
  const outcome = await db.transaction(
    async (tx): Promise<ChatThreadContentWriteOutcome<T>> => {
      return await readAdmittedChatThreadContent(tx, args, read, signal);
    },
    { isolationLevel: "read committed" },
  );
  signal.throwIfAborted();
  return outcome;
}

/**
 * Owns the transaction for a canonical route that only reads.
 *
 * It is {@link readAdmittedChatThreadContent} under the same bounded
 * reselection the write helper uses, so a GET that previously ran through
 * {@link withChatThreadContentWrite} keeps its existing behaviour when a
 * canonical parent moves: roll back, reselect a bounded number of times, and
 * raise `ChatThreadContentOwnershipChangedError` only once they are exhausted.
 * Its outcomes, and therefore each route's 404 and `closed` dispositions, are
 * unchanged; what it no longer does is take the write path's advisory,
 * `agents` and `chat_threads` locks.
 */
export async function withChatThreadContentRead<T>(
  db: Db,
  args: {
    readonly chatThreadId: string;
    readonly authorize: (identity: ChatThreadContentIdentity) => boolean;
  },
  read: (tx: Tx, identity: ChatThreadContentIdentity) => Promise<T>,
  signal: AbortSignal,
): Promise<ChatThreadContentWriteOutcome<T>> {
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    const result = await settle(
      db.transaction(
        async (tx): Promise<ChatThreadContentWriteOutcome<T>> => {
          return await readAdmittedChatThreadContent(tx, args, read, signal);
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

/**
 * Owns the transaction for a direct chat-thread content write: deadlines ->
 * content-free identity -> the route's own ownership check -> shared B1
 * admission -> Agent and thread identity locks -> revalidation -> the write,
 * with every barrier retained through COMMIT.
 *
 * The default thread lock remains KEY SHARE for existing writers. A caller that
 * must later take UPDATE while another same-thread operation can retain KEY
 * SHARE may opt into UPDATE here, so the first thread lock serializes before
 * either transaction can retain a weaker lock and then attempt an incompatible
 * upgrade. The opt-in changes neither subject nor Agent ordering.
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
    readonly threadLock?: "update";
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
          const locked = await lockChatThreadContentIdentity(
            tx,
            selected,
            args.threadLock ?? "key share",
          );
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
