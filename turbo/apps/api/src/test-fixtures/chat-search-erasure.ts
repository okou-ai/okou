import {
  barrierQueryBinds,
  barrierQueryText,
  withDatabaseTransactionBarrierFixture,
  type TransactionBarrier,
} from "./account-erasure-subject";

/** The per-thread transaction's first statement: the unlocked, content-free
 * ownership resolution. Candidate selection also joins Agents, but it left-joins
 * the watermarks and never filters on a single thread id.
 */
function isProjectionOwnershipRead(
  queryArgs: unknown[],
  chatThreadId: string,
): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith("select") &&
    text.includes('from "chat_threads" inner join "agents"') &&
    !text.includes("left join") &&
    text.includes('where "chat_threads"."id" =') &&
    barrierQueryBinds(queryArgs, chatThreadId)
  );
}

function isProjectionAgentLock(queryArgs: unknown[]): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith("select") &&
    text.includes('from "agents"') &&
    text.includes("for key share")
  );
}

/** Where the paused transaction stops. `ownership` precedes subject admission,
 * `agent-lock` sits between the unlocked ownership read and the first identity
 * lock, and `commit` retains every barrier with all writes already applied.
 */
type ChatSearchProjectionBarrierStop = "ownership" | "agent-lock" | "commit";

function reachedBarrierStop(
  stop: ChatSearchProjectionBarrierStop,
  queryArgs: unknown[],
  ownershipRead: boolean,
): boolean {
  if (stop === "ownership") {
    return ownershipRead;
  }
  if (stop === "agent-lock") {
    return isProjectionAgentLock(queryArgs);
  }
  return barrierQueryText(queryArgs) === "commit";
}

/** Pauses the search projector's own per-thread transaction. See
 * {@link withDatabaseTransactionBarrierFixture} for the mechanism and the
 * infrastructure exception it documents.
 */
export async function withChatSearchProjectionBarrierFixture<T>(
  args: {
    readonly chatThreadId: string;
    readonly stopAt: ChatSearchProjectionBarrierStop;
    readonly work: (barrier: TransactionBarrier) => Promise<T>;
  },
  signal: AbortSignal,
): Promise<T> {
  return await withDatabaseTransactionBarrierFixture(
    {
      select: (queryArgs) => {
        return isProjectionOwnershipRead(queryArgs, args.chatThreadId);
      },
      stopAt: (queryArgs, selectingStatement) => {
        return reachedBarrierStop(args.stopAt, queryArgs, selectingStatement);
      },
      work: args.work,
    },
    signal,
  );
}
