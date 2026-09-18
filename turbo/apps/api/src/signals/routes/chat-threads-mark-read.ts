import { command } from "ccstate";
import { and, eq, gt, isNotNull, isNull, or } from "drizzle-orm";
import { chatThreadMarkReadContract } from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreads } from "@okouai/db/schema/chat-thread";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishChatThreadReadCursorUpdatedSafely } from "../external/realtime";
import { notFound } from "../../lib/error";
import { withChatThreadContentWrite } from "../services/chat-thread-content-erasure-admission.service";
import { latestReadWatermarkEventSubquery } from "../services/chat-thread-read-state-query";
import { chatThreadUnreads } from "../services/chat-thread.service";
import type { RouteEntry } from "../route-entry";

/** The committed cursor plus the canonical parents the publication needs. */
interface MarkReadOutcome {
  readonly agentId: string;
  readonly orgId: string;
  readonly lastReadAt: string | null;
  readonly advanced: boolean;
}

const markReadInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadMarkReadContract.markRead));
  signal.throwIfAborted();

  const writeDb = set(writeDb$);

  // A read cursor is account read state, so the advancing UPDATE now runs
  // inside the shared B1 admission and the canonical Agent/thread locks. This
  // route deliberately keeps its user-only authorization: it requires no
  // organization and no capability, and the caller may hold no organization or
  // a different active one while still owning the thread. The Agent's actual
  // organization is still an erasure subject, because it is the organization
  // this route publishes to. Closure reuses the existing 404, and the
  // invalidation below still publishes only after a successful COMMIT.
  const result = await withChatThreadContentWrite(
    writeDb,
    {
      chatThreadId: params.id,
      authorize: (identity) => {
        return identity.userId === auth.userId && identity.agentId !== null;
      },
    },
    async (tx, identity): Promise<MarkReadOutcome | null> => {
      if (identity.agentId === null || identity.orgId === null) {
        // `authorize` already required a resolved Agent, so this only narrows
        // the canonical publication target; it is not a second contract.
        return null;
      }
      // The cursor this route preserves when nothing advances. It is read
      // inside the admitted transaction rather than carried in from an
      // unfenced pre-read, and it stays out of the canonical identity, which
      // is deliberately content-free.
      const [current] = await tx
        .select({ lastReadAt: chatThreads.lastReadAt })
        .from(chatThreads)
        .where(eq(chatThreads.id, params.id))
        .limit(1);
      const latestReadWatermark = latestReadWatermarkEventSubquery(
        tx,
        params.id,
      );
      const [updated] = await tx
        .update(chatThreads)
        .set({ lastReadAt: latestReadWatermark.createdAt })
        .from(latestReadWatermark)
        .where(
          and(
            eq(chatThreads.id, params.id),
            eq(chatThreads.userId, auth.userId),
            isNotNull(chatThreads.agentId),
            or(
              isNull(chatThreads.lastReadAt),
              gt(latestReadWatermark.createdAt, chatThreads.lastReadAt),
            ),
          ),
        )
        .returning({ lastReadAt: chatThreads.lastReadAt });
      const committed = updated ?? current;
      return {
        agentId: identity.agentId,
        orgId: identity.orgId,
        lastReadAt: committed?.lastReadAt?.toISOString() ?? null,
        advanced: updated !== undefined,
      };
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.outcome !== "written" || result.value === null) {
    return notFound("Chat thread not found");
  }
  const marked = result.value;

  if (marked.advanced) {
    // Read-state invalidation only. Thread-list shape is unchanged, and the
    // SharedWorker fans the user-org signal out to every matching tab. The
    // organization is the committed canonical one, never the request's.
    await publishChatThreadReadCursorUpdatedSafely(
      { userId: auth.userId, orgId: marked.orgId },
      {
        threadId: params.id,
        agentId: marked.agentId,
        lastReadAt: marked.lastReadAt,
      },
    );
    signal.throwIfAborted();
  }

  const unreads = await get(
    chatThreadUnreads({
      userId: auth.userId,
      orgId: marked.orgId,
      agentId: marked.agentId,
    }),
  );
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      lastReadAt: marked.lastReadAt,
      unreads: [...unreads],
    },
  };
});

export const chatThreadMarkReadRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadMarkReadContract.markRead,
    handler: authRoute({}, markReadInner$),
  },
];
