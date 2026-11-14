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
import type { ReleasedRunSlot } from "./agent-run-terminal-transition.service";
import { createDirectRunDispatcher } from "./direct-run-dispatch.service";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  CHAT_THREAD_LEASE_MS,
  type PublishedChatThreadLease,
} from "./queued-chat-thread.service";
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
  const dispatchRun$ = createDirectRunDispatcher(preparation.admittedLaunch$);
  // Reobserve occupancy after release, but retain the same org capacity snapshot.
  // Newly purchased slots take effect only in a subsequent context.
  const orgHasCapacityAfterRelease$ = createOrgHasCapacity(context);
  return {
    ...preparation,
    dispatchRun$,
    context,
    orgHasCapacityAfterRelease$,
  };
}

interface PickInput {
  readonly orgId: string;
  readonly chatThreadId?: string;
  readonly after?: OrgPickCursor | null;
  readonly context?: AgentRunContextSignals;
  readonly requestFacts?: ChatThreadRequestFacts;
  readonly publishedLease?: PublishedChatThreadLease;
}

export interface PickIteration {
  readonly result: PickResult;
  readonly cursor: OrgPickCursor | null;
}

function captureThreadClaim(
  receipt: Omit<LeasedThreadClaim, "context" | "requestFacts">,
  input: PickInput,
): LeasedThreadClaim {
  const { context, requestFacts } = input;
  return Object.freeze({
    ...receipt,
    ...(context === undefined ? {} : { context }),
    ...(requestFacts?.orgId === receipt.orgId &&
    requestFacts.thread.id === receipt.chatThreadId &&
    requestFacts.thread.userId === receipt.userId &&
    requestFacts.thread.agentId === receipt.agentId
      ? { requestFacts }
      : {}),
  });
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
      const { orgId } = input;
      const published = input.publishedLease;
      if (
        published?.orgId === orgId &&
        published.chatThreadId === input.chatThreadId &&
        published.claimExpiresAt.getTime() > nowDate().getTime()
      ) {
        const claim = captureThreadClaim(published, input);
        set(claimReceipts$, (previous) => {
          return [...previous, claim];
        });
        signal.throwIfAborted();
        return { claim, cursor: input.after ?? null };
      }
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
        ? captureThreadClaim(
            {
              orgId,
              chatThreadId: row.chatThreadId,
              claimId,
              queuedAt: row.queuedAt,
              userId: row.userId,
              agentId: row.agentId,
            },
            input,
          )
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
          {
            orgId: claim.orgId,
            chatThreadId: claim.chatThreadId,
          },
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
      const [threadHasActiveRun, hasCapacity, hasInput] = await Promise.all([
        get(claimed.threadHasActiveRun$),
        get(claimed.orgHasCapacity$),
        get(claimed.hasFirstPickableChatEvent$),
      ]);
      signal.throwIfAborted();
      // Publication can wait for a launch whose active row was not visible in
      // its earlier snapshot. Reobserve before reporting full/deleting empty
      // work so the send still notifies that running Run about pending input.
      if (threadHasActiveRun) {
        // Run completion may have skipped this live lease before its release.
        await set(releaseClaimAndSchedulePick$, claim, signal);
        return { kind: "none" };
      }
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
      // Load the run context only when this claim has work and capacity.
      set(preloadAgentRunContext$, claimed.context, signal);
      signal.throwIfAborted();
      const pending = await set(claimed.admitRun$, signal);
      if (pending === null) {
        await set(releaseClaim$, claim, signal);
        return { kind: "none" };
      }
      // Activation is outside the admission-failure boundary. Slot scheduling
      // precedes terminal callbacks so they cannot delay the next queued input.
      await set(claimed.publishPendingRun$, pending, signal);
      const dispatched = await set(claimed.dispatchRun$, signal);
      if (dispatched.terminal !== null) {
        set(
          scheduleReleasedSlotPicks$,
          dispatched.terminal.releasedSlots,
          signal,
        );
      }
      await set(claimed.finishPendingRun$, pending, dispatched, signal);
      return { kind: "launched", runId: pending.runId };
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

/**
 * A finite organization pass visits at most the queued-thread count captured
 * at entry. Active or leased threads are skipped; only full org capacity stops
 * the pass early. Enqueue, slot release and cron own subsequent passes.
 */
export const pickOrgQueuedChatThreads$ = command(
  async (
    { set },
    input: { readonly orgId: string },
    signal: AbortSignal,
  ): Promise<number> => {
    const database = set(writeDb$);
    const [snapshot] = await database
      .select({ count: count() })
      .from(queuedChatThreads)
      .where(
        and(
          eq(queuedChatThreads.orgId, input.orgId),
          or(
            isNull(queuedChatThreads.claimExpiresAt),
            lte(queuedChatThreads.claimExpiresAt, nowDate()),
          ),
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
      );
    signal.throwIfAborted();
    if (!snapshot) {
      throw new Error("Queued chat thread count returned no row");
    }
    let cursor: OrgPickCursor | null = null;
    let launched = 0;
    for (let visited = 0; visited < snapshot.count; visited++) {
      const { result: picked, cursor: nextCursor }: PickIteration = await set(
        pickChatThread$,
        { orgId: input.orgId, after: cursor },
        signal,
      );
      cursor = nextCursor;
      signal.throwIfAborted();
      if (picked.kind === "org-full") {
        return launched;
      }
      if (picked.kind === "launched") {
        launched += 1;
      }
    }
    return launched;
  },
);

/** Schedule each released organization before other terminal side effects. */
export const scheduleReleasedSlotPicks$ = command(
  ({ set }, slots: readonly ReleasedRunSlot[], signal: AbortSignal) => {
    signal.throwIfAborted();
    const orgIds = new Set(
      slots.map((slot) => {
        return slot.orgId;
      }),
    );
    for (const orgId of orgIds) {
      waitUntil(set(pickOrgQueuedChatThreads$, { orgId }, signal));
    }
  },
);
