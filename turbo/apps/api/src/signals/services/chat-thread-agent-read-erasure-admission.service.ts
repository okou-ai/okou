import {
  assertErasureSubjectWritable,
  type ErasureSubject,
} from "@okouai/db/operations/account-erasure";
import { agents } from "@okouai/db/schema/agent";
import { eq, sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import type { Db } from "../external/db";
import { settle } from "../utils";

/**
 * Content-free canonical identity of one Agent: its own row, its `owner` and
 * its organization. The bulk read-cursor writer matches every unread thread of
 * one actor user under one Agent, so the actor plus these two parents are the
 * complete subject set however many threads match. A thread scan would add no
 * subject and is never needed to admit this write.
 */
interface ChatThreadAgentIdentity {
  readonly agentId: string;
  readonly owner: string;
  readonly orgId: string;
}

/** The canonical Agent moved between the unlocked resolution and the locks. */
class ChatThreadAgentOwnershipChangedError extends Error {
  constructor() {
    super("Agent ownership changed while acquiring read-cursor locks");
    this.name = "ChatThreadAgentOwnershipChangedError";
  }
}

/** The existing content-write profile: this route writes account content too. */
const AGENT_READ_LOCK_TIMEOUT = "1s";
const AGENT_READ_STATEMENT_TIMEOUT = "5s";
/** One reselection per canonical parent the write depends on, then fail. */
const OWNERSHIP_ATTEMPTS = 3;

/**
 * `written` carries the inner write's own result, `missing` is a resolved
 * absent or out-of-organization Agent that keeps this route's existing 204, and
 * `closed` is B1's exact subject closure. Closure stays separate from every
 * database failure and from cancellation, which keep their original
 * propagation, so a statement timeout can never surface as a fabricated
 * success or denial.
 */
type ChatThreadAgentReadWriteOutcome<T> =
  | { readonly outcome: "written"; readonly value: T }
  | { readonly outcome: "missing" }
  | { readonly outcome: "closed" };

async function setChatThreadAgentReadDeadlines(tx: Tx): Promise<void> {
  await tx.execute(
    sql`SELECT set_config('lock_timeout', ${AGENT_READ_LOCK_TIMEOUT}, true)`,
  );
  await tx.execute(
    sql`SELECT set_config('statement_timeout', ${AGENT_READ_STATEMENT_TIMEOUT}, true)`,
  );
}

/**
 * Resolves ownership from the real persisted Agent row by primary key. The
 * request's own `userId`/`orgId` is never authority here: it is compared
 * against this result, not substituted for it.
 */
async function loadChatThreadAgentIdentity(
  tx: Tx,
  agentId: string,
): Promise<ChatThreadAgentIdentity | null> {
  const [agent] = await tx
    .select({
      agentId: agents.id,
      owner: agents.owner,
      orgId: agents.orgId,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return agent ?? null;
}

/** At most three subjects: user and organization are separate domains, and a
 * shared Agent's owner is a user subject distinct from the actor. The count is
 * independent of how many threads the bulk update matches. */
function chatThreadAgentSubjects(
  actorUserId: string,
  identity: ChatThreadAgentIdentity,
): ErasureSubject[] {
  const subjects: ErasureSubject[] = [
    { subjectKind: "user", subjectId: actorUserId },
    { subjectKind: "user", subjectId: identity.owner },
    { subjectKind: "organization", subjectId: identity.orgId },
  ];
  return [
    ...new Map(
      subjects.map((subject) => {
        return [JSON.stringify(subject), subject];
      }),
    ).values(),
  ];
}

/** Sorted shared B1 admission, before any business-row lock and before any
 * cursor write. Only B1's exact closure error denies the write; every other
 * failure, including a bounded lock wait, propagates unchanged. */
async function admitChatThreadAgentSubjects(
  tx: Tx,
  actorUserId: string,
  identity: ChatThreadAgentIdentity,
): Promise<boolean> {
  const result = await settle(
    assertErasureSubjectWritable(
      tx,
      chatThreadAgentSubjects(actorUserId, identity),
    ),
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

function sameChatThreadAgentIdentity(
  left: ChatThreadAgentIdentity,
  right: ChatThreadAgentIdentity,
): boolean {
  return (
    left.agentId === right.agentId &&
    left.owner === right.owner &&
    left.orgId === right.orgId
  );
}

/**
 * Retains the canonical Agent identity lock through COMMIT.
 *
 * `agents` carries the `(id, org_id, owner)` unique key, so KEY SHARE conflicts
 * with an owner or organization transfer and with Agent deletion, which cascades
 * the matched threads. It does not conflict with the FOR NO KEY UPDATE that this
 * transaction's own cursor UPDATE takes on `chat_threads`, so holding it adds no
 * serialization of its own to thread traffic, and this route takes no separate
 * per-thread admission lock: the admitted subject set is the same for one
 * matched thread and for every matched thread. The cursor UPDATE itself still
 * locks every row it matches until COMMIT, so writers of those same rows do
 * contend.
 *
 * Re-reading the same content-free identity under the retained lock turns a
 * transfer committed between resolution and lock acquisition into a rollback,
 * instead of writing cursors under a newly discovered owner or widening the
 * admitted subject set after the business locks.
 */
async function lockChatThreadAgentIdentity(
  tx: Tx,
  identity: ChatThreadAgentIdentity,
): Promise<ChatThreadAgentIdentity | null> {
  await tx
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, identity.agentId))
    .for("key share");
  const current = await loadChatThreadAgentIdentity(tx, identity.agentId);
  if (!current) {
    return null;
  }
  if (!sameChatThreadAgentIdentity(current, identity)) {
    throw new ChatThreadAgentOwnershipChangedError();
  }
  return current;
}

/**
 * Owns the transaction for the bulk Agent read-cursor write: deadlines ->
 * content-free Agent identity -> the route's own organization check -> shared
 * B1 admission -> the Agent identity lock -> revalidation -> the write, with
 * every barrier retained through COMMIT.
 *
 * `authorize` is the caller's existing route contract expressed over the real
 * canonical identity. It runs before admission so an unauthorized request never
 * takes another account's subject locks, and it is a pure function of the
 * identity the revalidation already compares field by field, so the locked
 * re-read needs no second evaluation.
 *
 * The Agent moving under the lock rolls the attempt back and reselects a bounded
 * number of times. Exhausting them raises `ChatThreadAgentOwnershipChangedError`
 * rather than reporting closure or a silent success.
 */
export async function withChatThreadAgentReadWrite<T>(
  db: Db,
  args: {
    readonly agentId: string;
    readonly actorUserId: string;
    readonly authorize: (identity: ChatThreadAgentIdentity) => boolean;
  },
  write: (tx: Tx, identity: ChatThreadAgentIdentity) => Promise<T>,
  signal: AbortSignal,
): Promise<ChatThreadAgentReadWriteOutcome<T>> {
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    const result = await settle(
      db.transaction(
        async (tx): Promise<ChatThreadAgentReadWriteOutcome<T>> => {
          await setChatThreadAgentReadDeadlines(tx);
          const selected = await loadChatThreadAgentIdentity(tx, args.agentId);
          if (!selected || !args.authorize(selected)) {
            return { outcome: "missing" };
          }
          if (
            !(await admitChatThreadAgentSubjects(
              tx,
              args.actorUserId,
              selected,
            ))
          ) {
            return { outcome: "closed" };
          }
          const locked = await lockChatThreadAgentIdentity(tx, selected);
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
      !(result.error instanceof ChatThreadAgentOwnershipChangedError) ||
      attempt === OWNERSHIP_ATTEMPTS
    ) {
      throw result.error;
    }
  }
}
