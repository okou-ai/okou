import { computed, command, state, type Computed } from "ccstate";
import {
  count,
  eq,
  or,
  and,
  isNull,
  lte,
  gt,
  notInArray,
  notExists,
  asc,
} from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import {
  matchAgentRunContextSignals,
  preloadAgentRunContext$,
  type AgentRunContextSignals,
} from "./agent-run-context.signals";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { db$, writeDb$ } from "../external/db";
import { waitUntil } from "../context/wait-until";
import { nowDate } from "../../lib/time";
import type { ChatThreadRequestFacts } from "./chat-thread-request-facts";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  createThreadClaimRunObjects,
  type ThreadClaim,
} from "./thread-claim-run.service";

export interface OrgPickCursor {
  readonly queuedAt: Date;
  readonly chatThreadId: string;
  readonly visitedThreadIds: readonly string[];
}

/** Actual lease-write receipt, including this invocation's plain prefetch. */
interface LeasedThreadClaim extends ThreadClaim {
  readonly queuedAt: Date;
  readonly userId: string;
  readonly agentId: string;
  readonly context?: AgentRunContextSignals;
  readonly requestFacts?: ChatThreadRequestFacts;
}

/** Fixed chat thread lease; it is never renewed. */
const CHAT_THREAD_LEASE_MS = 10_000;

/** One pick launches a run, observes full capacity, or launches nothing. */
export type PickResult =
  | { readonly kind: "launched"; readonly runId: string }
  | { readonly kind: "org-full" }
  | { readonly kind: "none" };

/** A fresh occupancy observation combined with the org's captured limit. */
function createOrgHasCapacity(context: AgentRunContextSignals) {
  const { orgId } = context;
  const orgActiveRunCount$ = computed(async (get) => {
    const database = get(db$);
    const [row] = await database
      .select({ count: count() })
      .from(activeAgentRuns)
      .where(eq(activeAgentRuns.orgId, orgId));
    if (!row) {
      throw new Error("Active agent run count returned no row");
    }
    return row.count;
  });

  return computed(async (get) => {
    const [activeCount, capacity] = await Promise.all([
      get(orgActiveRunCount$),
      get(context.concurrencyCapacity$),
    ]);
    return capacity === 0 || activeCount < capacity;
  });
}

function createCapturedClaimObjects(
  claim: LeasedThreadClaim,
  context: AgentRunContextSignals,
) {
  const preparation = createThreadClaimRunObjects(
    {
      orgId: claim.orgId,
      chatThreadId: claim.chatThreadId,
      claimId: claim.claimId,
    },
    context,
    claim.requestFacts,
  );
  const orgHasCapacity$ = createOrgHasCapacity(context);
  // Reobserve occupancy after release, but retain the same org capacity snapshot.
  // Newly purchased slots take effect only in a subsequent context.
  const orgHasCapacityAfterRelease$ = createOrgHasCapacity(context);
  return {
    ...preparation,
    context,
    orgHasCapacity$,
    orgHasCapacityAfterRelease$,
  };
}

interface PickInput {
  readonly orgId: string;
  readonly chatThreadId?: string;
  readonly after?: OrgPickCursor | null;
  readonly context?: AgentRunContextSignals;
  readonly requestFacts?: ChatThreadRequestFacts;
}

export interface PickIteration {
  readonly result: PickResult;
  readonly cursor: OrgPickCursor | null;
}

function createPickObjects() {
  // Append only actual conditional-write receipts, not a latest-input slot.
  const claimReceipts$ = state<readonly LeasedThreadClaim[]>([]);
  const graphCache$ = computed(() => {
    return new WeakMap<
      LeasedThreadClaim,
      Computed<Promise<ReturnType<typeof createCapturedClaimObjects>>>
    >();
  });
  const capturedClaims$ = computed((get) => {
    const graphCache = get(graphCache$);
    const graphs = new Map<
      string,
      Computed<Promise<ReturnType<typeof createCapturedClaimObjects>>>
    >();
    for (const claim of get(claimReceipts$)) {
      let graph = graphCache.get(claim);
      if (!graph) {
        // Install the private receipt node synchronously, before its model
        // promise can yield. Concurrent receipt-list evaluations share it.
        graph = computed(() => {
          const context = matchAgentRunContextSignals(
            claim.context,
            claim.userId,
            claim.orgId,
            claim.agentId,
          );
          return Promise.resolve(createCapturedClaimObjects(claim, context));
        });
        graphCache.set(claim, graph);
      }
      graphs.set(claim.claimId, graph);
    }
    return graphs;
  });

  const nextOrgThread$ = command(
    async ({ get }, input: PickInput, signal: AbortSignal) => {
      const { orgId } = input;
      const after = input.after ?? null;
      const database = get(db$);
      const at = nowDate();
      const [row] = await database
        .select({
          chatThreadId: queuedChatThreads.chatThreadId,
          queuedAt: queuedChatThreads.queuedAt,
        })
        .from(queuedChatThreads)
        .where(
          and(
            eq(queuedChatThreads.orgId, orgId),
            or(
              isNull(queuedChatThreads.claimExpiresAt),
              lte(queuedChatThreads.claimExpiresAt, at),
            ),
            after === null
              ? undefined
              : or(
                  gt(queuedChatThreads.queuedAt, after.queuedAt),
                  and(
                    eq(queuedChatThreads.queuedAt, after.queuedAt),
                    gt(queuedChatThreads.chatThreadId, after.chatThreadId),
                  ),
                ),
            after === null
              ? undefined
              : notInArray(queuedChatThreads.chatThreadId, [
                  ...after.visitedThreadIds,
                ]),
            notExists(
              database
                .select({ runId: activeAgentRuns.runId })
                .from(activeAgentRuns)
                .where(
                  eq(
                    activeAgentRuns.chatThreadId,
                    queuedChatThreads.chatThreadId,
                  ),
                ),
            ),
          ),
        )
        .orderBy(
          asc(queuedChatThreads.queuedAt),
          asc(queuedChatThreads.chatThreadId),
        )
        .limit(1);
      signal.throwIfAborted();
      return row ?? null;
    },
  );

  const claim$ = command(
    async ({ set }, input: PickInput, signal: AbortSignal) => {
      const { orgId, context } = input;
      let threadId = input.chatThreadId;
      let cursor = input.after ?? null;
      if (threadId === undefined) {
        const candidate = await set(nextOrgThread$, input, signal);
        if (!candidate) {
          return { claim: null, cursor };
        }
        cursor = {
          ...candidate,
          visitedThreadIds: [
            ...(cursor?.visitedThreadIds ?? []),
            candidate.chatThreadId,
          ],
        };
        threadId = candidate.chatThreadId;
      }
      const database = set(writeDb$);
      const at = nowDate();
      const claimId = randomUUID();
      const row = (
        await database
          .update(queuedChatThreads)
          .set({
            claimId,
            claimExpiresAt: new Date(at.getTime() + CHAT_THREAD_LEASE_MS),
          })
          .from(chatThreads)
          .where(
            and(
              eq(chatThreads.id, queuedChatThreads.chatThreadId),
              eq(queuedChatThreads.orgId, orgId),
              eq(queuedChatThreads.chatThreadId, threadId),
              or(
                isNull(queuedChatThreads.claimExpiresAt),
                lte(queuedChatThreads.claimExpiresAt, at),
              ),
              notExists(
                database
                  .select({ runId: activeAgentRuns.runId })
                  .from(activeAgentRuns)
                  .where(eq(activeAgentRuns.chatThreadId, threadId)),
              ),
            ),
          )
          .returning({
            chatThreadId: queuedChatThreads.chatThreadId,
            queuedAt: queuedChatThreads.queuedAt,
            userId: chatThreads.userId,
            agentId: chatThreads.agentId,
          })
      )[0];
      if (row?.agentId === null) {
        throw new Error("A queued thread claim requires an Agent identity");
      }
      const claim: LeasedThreadClaim | null = row
        ? Object.freeze({
            orgId,
            chatThreadId: row.chatThreadId,
            claimId,
            queuedAt: row.queuedAt,
            userId: row.userId,
            agentId: row.agentId,
            ...(context === undefined ? {} : { context }),
            ...(input.requestFacts?.orgId === orgId &&
            input.requestFacts.thread.id === row.chatThreadId &&
            input.requestFacts.thread.userId === row.userId &&
            input.requestFacts.thread.agentId === row.agentId
              ? { requestFacts: input.requestFacts }
              : {}),
          })
        : null;
      if (claim) {
        // Preserve the actual SQL receipt before observing cancellation.
        set(claimReceipts$, (previous) => {
          return [...previous, claim];
        });
      }
      signal.throwIfAborted();
      return { claim, cursor };
    },
  );

  /** Release only this token; a replacement lease is never released. */
  const releaseClaim$ = command(
    async (
      { set },
      claim: LeasedThreadClaim,
      signal: AbortSignal,
    ): Promise<boolean> => {
      const [row] = await set(writeDb$)
        .update(queuedChatThreads)
        .set({ claimId: null, claimExpiresAt: null })
        .where(
          and(
            eq(queuedChatThreads.orgId, claim.orgId),
            eq(queuedChatThreads.chatThreadId, claim.chatThreadId),
            eq(queuedChatThreads.claimId, claim.claimId),
          ),
        )
        .returning({ chatThreadId: queuedChatThreads.chatThreadId });
      signal.throwIfAborted();
      return row !== undefined;
    },
  );

  /** New work uses the same stable command, without reusing S1 prefetch. */
  const scheduleThreadPick$ = command(
    ({ set }, claim: LeasedThreadClaim, signal: AbortSignal): void => {
      signal.throwIfAborted();
      waitUntil(
        set(
          pick$,
          { orgId: claim.orgId, chatThreadId: claim.chatThreadId },
          signal,
        ),
      );
    },
  );

  const releaseClaimAndSchedulePick$ = command(
    async (
      { set },
      claim: LeasedThreadClaim,
      signal: AbortSignal,
    ): Promise<void> => {
      if (await set(releaseClaim$, claim, signal)) {
        set(scheduleThreadPick$, claim, signal);
      }
    },
  );

  /** An enqueue under this lease advances queuedAt and prevents deletion. */
  const deleteEmptyQueue$ = command(
    async (
      { set },
      claim: LeasedThreadClaim,
      signal: AbortSignal,
    ): Promise<void> => {
      const [deleted] = await set(writeDb$)
        .delete(queuedChatThreads)
        .where(
          and(
            eq(queuedChatThreads.orgId, claim.orgId),
            eq(queuedChatThreads.chatThreadId, claim.chatThreadId),
            eq(queuedChatThreads.claimId, claim.claimId),
            eq(queuedChatThreads.queuedAt, claim.queuedAt),
          ),
        )
        .returning({ chatThreadId: queuedChatThreads.chatThreadId });
      signal.throwIfAborted();
      if (!deleted) {
        await set(releaseClaimAndSchedulePick$, claim, signal);
      }
    },
  );

  /** The Thread child exclusively owns creation, rejection and startup. */
  const pickClaim$ = command(
    async (
      { get, set },
      claim: LeasedThreadClaim,
      signal: AbortSignal,
    ): Promise<PickResult> => {
      signal.throwIfAborted();
      const captured = get(capturedClaims$).get(claim.claimId);
      if (!captured) {
        throw new Error("Successful queue claim has no captured run graph");
      }
      const claimed = await get(captured);
      signal.throwIfAborted();
      set(preloadAgentRunContext$, claimed.context, signal);
      signal.throwIfAborted();
      const [hasCapacity, hasInput] = await Promise.all([
        get(claimed.orgHasCapacity$),
        get(claimed.hasFirstPickableChatEvent$),
      ]);
      signal.throwIfAborted();
      if (!hasCapacity) {
        if (await set(releaseClaim$, claim, signal)) {
          const freed = await get(claimed.orgHasCapacityAfterRelease$);
          signal.throwIfAborted();
          if (freed) {
            set(scheduleThreadPick$, claim, signal);
          }
        }
        return { kind: "org-full" };
      }
      if (!hasInput) {
        await set(deleteEmptyQueue$, claim, signal);
        return { kind: "none" };
      }
      const runId = await set(claimed.startRun$, signal);
      if (runId === null) {
        await set(releaseClaim$, claim, signal);
        return { kind: "none" };
      }
      return { kind: "launched", runId };
    },
  );

  const pick$ = command(
    async (
      { set },
      input: PickInput,
      signal: AbortSignal,
    ): Promise<PickIteration> => {
      signal.throwIfAborted();
      const { claim, cursor } = await set(claim$, input, signal);
      return {
        result: claim ? await set(pickClaim$, claim, signal) : { kind: "none" },
        cursor,
      };
    },
  );
  return { pick$ };
}

/** Stable entry; successful write receipts own per-Store memoized child graphs. */
export const pickChatThread$ = createPickObjects().pick$;
