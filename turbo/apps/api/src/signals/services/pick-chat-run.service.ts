import { projectCommittedChatThreadSearch$ } from "./chat-event-publication.service";
import { deliverMarketingRewardEvents$ } from "./marketing-reward-event-delivery.service";
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
  inArray,
  type SQL,
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
import { publishDesktopShellAuthorizationChangedSafely } from "../external/realtime";
import { nowDate } from "../../lib/time";
import type { EnqueuedChatInputFacts } from "./chat-run-preparation-facts";
import type { ReleasedRunSlot } from "./agent-run-terminal-transition.service";
import {
  prepareDirectRunDispatch$,
  dispatchPreparedRun$,
} from "./direct-run-dispatch.service";
import {
  prepareExecutionBundleUrls$,
  publishDirectRunCache$,
} from "./direct-run-preparation.service";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  CHAT_THREAD_LEASE_MS,
  type PublishedChatThreadLease,
} from "./queued-chat-thread.service";
import {
  createThreadClaimRunObjects,
  type ThreadClaim,
} from "./thread-claim-run.service";
import {
  createDeferredPromise,
  joinAllInOrder,
  settle,
  settleIncludingAbort,
} from "../utils";

export interface OrgPickCursor {
  readonly queuedAt: Date;
  readonly chatThreadId: string;
  readonly visitedThreadIds: readonly string[];
}

/** Actual lease-write receipt, including this invocation's plain prefetch. */
interface LeasedThreadClaim extends ThreadClaim {
  readonly queuedAt: Date;
  readonly userId: string;
  readonly context?: AgentRunContextSignals;
  readonly requestInput?: EnqueuedChatInputFacts;
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
    claim.requestInput,
  );
  // Reobserve occupancy after release, but retain the same org capacity snapshot.
  // Newly purchased slots take effect only in a subsequent context.
  const orgHasCapacityAfterRelease$ = createOrgHasCapacity(context);
  return {
    ...preparation,
    context,
    orgHasCapacityAfterRelease$,
  };
}

interface PickInput {
  readonly orgId: string;
  readonly chatThreadId?: string;
  readonly after?: OrgPickCursor | null;
  readonly context?: AgentRunContextSignals;
  readonly requestInput?: EnqueuedChatInputFacts;
  readonly publishedLease?: PublishedChatThreadLease;
  readonly computerUseHostChangedForUserId?: string;
}

export interface PickIteration {
  readonly result: PickResult;
  readonly cursor: OrgPickCursor | null;
}

function captureThreadClaim(
  receipt: Omit<LeasedThreadClaim, "context" | "requestInput">,
  input: PickInput,
): LeasedThreadClaim {
  const { context, requestInput } = input;
  return Object.freeze({
    ...receipt,
    ...(context === undefined ? {} : { context }),
    ...(requestInput?.orgId === receipt.orgId &&
    requestInput.chatThreadId === receipt.chatThreadId &&
    requestInput.userId === receipt.userId
      ? { requestInput }
      : {}),
  });
}

function nextOrgThread(
  database: ReturnType<(typeof writeDb$)["write"]>,
  input: PickInput,
  at: Date,
) {
  const { orgId } = input;
  const after = input.after ?? null;
  return database
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
              eq(activeAgentRuns.chatThreadId, queuedChatThreads.chatThreadId),
            ),
        ),
      ),
    )
    .orderBy(
      asc(queuedChatThreads.queuedAt),
      asc(queuedChatThreads.chatThreadId),
    )
    .limit(1);
}

async function leaseQueuedThread(
  database: ReturnType<(typeof writeDb$)["write"]>,
  input: PickInput,
  at: Date,
  claimId: string,
) {
  const { orgId } = input;
  let cursor = input.after ?? null;
  const update = (threadIdCondition: SQL) => {
    return database
      .update(queuedChatThreads)
      .set({
        claimId,
        claimExpiresAt: new Date(at.getTime() + CHAT_THREAD_LEASE_MS),
      })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, queuedChatThreads.chatThreadId),
          eq(chatThreads.orgId, orgId),
          eq(queuedChatThreads.orgId, orgId),
          threadIdCondition,
          or(
            isNull(queuedChatThreads.claimExpiresAt),
            lte(queuedChatThreads.claimExpiresAt, at),
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
      )
      .returning({
        chatThreadId: queuedChatThreads.chatThreadId,
        queuedAt: queuedChatThreads.queuedAt,
        userId: chatThreads.userId,
      });
  };
  let row:
    { chatThreadId: string; queuedAt: Date; userId: string } | null | undefined;
  if (input.chatThreadId !== undefined) {
    [row] = await update(
      eq(queuedChatThreads.chatThreadId, input.chatThreadId),
    );
  } else {
    const candidate = database
      .$with("queue_candidate")
      .as(nextOrgThread(database, input, at));
    const leased = database
      .$with("leased_candidate")
      .as(
        update(
          inArray(
            queuedChatThreads.chatThreadId,
            database.select({ id: candidate.chatThreadId }).from(candidate),
          ),
        ),
      );
    // Keep the selected cursor even if a competing claim wins the update.
    const [result] = await database
      .with(candidate, leased)
      .select({
        candidate: {
          chatThreadId: candidate.chatThreadId,
          queuedAt: candidate.queuedAt,
        },
        lease: {
          chatThreadId: leased.chatThreadId,
          queuedAt: leased.queuedAt,
          userId: leased.userId,
        },
      })
      .from(candidate)
      .leftJoin(leased, eq(leased.chatThreadId, candidate.chatThreadId));
    if (result) {
      row = result.lease;
      cursor = {
        ...result.candidate,
        visitedThreadIds: [
          ...(cursor?.visitedThreadIds ?? []),
          result.candidate.chatThreadId,
        ],
      };
    }
  }
  return { row, cursor };
}

async function awaitPendingAdmission(
  admitted: ReturnType<
    ReturnType<typeof createThreadClaimRunObjects>["admitRun$"]["write"]
  > | null,
) {
  if (!admitted) {
    return null;
  }
  waitUntil(settle(admitted.resources.memory));
  const pending = await settleIncludingAbort(admitted.pending);
  // Dispatch joins successful preparation. An abandoned read has no consumer.
  if (admitted.early && (!pending.ok || !pending.value)) {
    waitUntil(admitted.early);
  }
  if (!pending.ok) {
    throw pending.error;
  }
  return pending.value;
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
          const context = matchAgentRunContextSignals(claim.context, claim);
          return Promise.resolve(createCapturedClaimObjects(claim, context));
        });
        graphCache.set(claim, graph);
      }
      graphs.set(claim.claimId, graph);
    }
    return graphs;
  });

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
      const claimId = randomUUID();
      // eslint-disable-next-line api/signal-check-await -- Keep the committed lease receipt before propagating cancellation.
      const { row, cursor } = await leaseQueuedThread(
        set(writeDb$),
        input,
        nowDate(),
        claimId,
      );
      const claim: LeasedThreadClaim | null = row
        ? captureThreadClaim(
            {
              orgId,
              chatThreadId: row.chatThreadId,
              claimId,
              queuedAt: row.queuedAt,
              userId: row.userId,
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

  const deliverPickedRun$ = command(
    async (
      { set },
      preparation: Awaited<
        ReturnType<(typeof prepareDirectRunDispatch$)["write"]>
      >,
      resolveFirstPostHandoff: (() => void) | undefined,
      signal: AbortSignal,
    ) => {
      const dispatched = await (async () => {
        if (preparation.kind === "failed") {
          return preparation.result;
        }
        // Signed URLs are already in the payload. Persisting reusable URLs can
        // proceed independently of ownership and delivery.
        waitUntil(
          set(publishDirectRunCache$, preparation.cachePublication, signal),
        );
        return await set(
          dispatchPreparedRun$,
          { ...preparation.delivery, resolveFirstPostHandoff },
          signal,
        );
      })();
      signal.throwIfAborted();
      // Schedule the released slots before the caller runs terminal callbacks.
      if (dispatched.terminal !== null) {
        set(
          scheduleReleasedSlotPicks$,
          dispatched.terminal.releasedSlots,
          signal,
        );
      }
      return dispatched;
    },
  );

  const scheduleClaimEffects$ = command(
    (
      { set },
      claim: LeasedThreadClaim,
      searchAtDispatch: boolean,
      marketingRewardEventId: string | null | undefined,
      signal: AbortSignal,
    ) => {
      // A standalone pick publishes its own committed claim or rejection.
      if (!searchAtDispatch) {
        waitUntil(
          set(
            projectCommittedChatThreadSearch$,
            {
              userId: claim.userId,
              orgId: claim.orgId,
              threadId: claim.chatThreadId,
            },
            signal,
          ),
        );
      }
      if (marketingRewardEventId) {
        waitUntil(
          set(
            deliverMarketingRewardEvents$,
            { jobId: marketingRewardEventId, handlerVersion: 4 },
            signal,
          ),
        );
      }
    },
  );

  const pickOnce$ = command(
    (
      { get, set },
      input: PickInput,
      resolveFirstPostHandoff: (() => void) | undefined,
      signal: AbortSignal,
    ): Promise<PickIteration> => {
      let hostChangeUserId = input.computerUseHostChangedForUserId;
      const picked = (async (): Promise<PickIteration> => {
        signal.throwIfAborted();
        const { claim, cursor } = await set(claim$, input, signal);
        if (!claim) {
          return { result: { kind: "none" }, cursor };
        }
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
          return { result: { kind: "none" }, cursor };
        }
        if (!hasCapacity) {
          if (await set(releaseClaim$, claim, signal)) {
            const freed = await get(claimed.orgHasCapacityAfterRelease$);
            signal.throwIfAborted();
            if (freed) {
              set(scheduleThreadPick$, claim, signal);
            }
          }
          return { result: { kind: "org-full" }, cursor };
        }
        if (!hasInput) {
          await set(deleteEmptyQueue$, claim, signal);
          return { result: { kind: "none" }, cursor };
        }
        // Load the run context only when this claim has work and capacity.
        set(preloadAgentRunContext$, claimed.context, signal);
        waitUntil(settle(get(claimed.inputResources$)));
        signal.throwIfAborted();
        const preparation = set(claimed.prepareRunAdmission$, signal);
        const bundleUrls = set(
          prepareExecutionBundleUrls$,
          get(claimed.executionBundleCache$),
          signal,
        );
        // The pick owns preparation even if admission loses.
        waitUntil(settle(bundleUrls));
        waitUntil(settle(preparation.resources.memoryArchive));
        waitUntil(settle(preparation.resources.networkPolicyInputs));
        const prepared = await preparation.context;
        signal.throwIfAborted();
        const admitted = prepared
          ? set(
              claimed.admitRun$,
              prepared,
              preparation.resources,
              bundleUrls,
              signal,
            )
          : null;
        const pending = await awaitPendingAdmission(admitted);
        signal.throwIfAborted();
        set(
          scheduleClaimEffects$,
          claim,
          resolveFirstPostHandoff !== undefined,
          pending?.marketingRewardEventId,
          signal,
        );
        if (!admitted || !pending) {
          await set(releaseClaim$, claim, signal);
          return { result: { kind: "none" }, cursor };
        }
        // The pending slot has committed. Its refresh also covers an earlier
        // host change for the same user, even if Runner delivery fails.
        const activation = (async () => {
          const pendingUserId = pending.head.userId;
          await publishDesktopShellAuthorizationChangedSafely(pendingUserId);
          if (hostChangeUserId === pendingUserId) {
            hostChangeUserId = undefined;
          }
          signal.throwIfAborted();
          await set(claimed.publishPendingRun$, pending, signal);
        })();
        // Activation is outside the admission-failure boundary. Slot scheduling
        // precedes terminal callbacks so they cannot delay the next queued input.
        const [, dispatchPreparation] = await joinAllInOrder(
          [
            activation,
            set(
              prepareDirectRunDispatch$,
              pending.admittedLaunch,
              { bundleUrls, resources: admitted.resources },
              admitted.early,
              signal,
            ),
          ],
          signal,
        );
        const dispatched = await set(
          deliverPickedRun$,
          dispatchPreparation,
          resolveFirstPostHandoff,
          signal,
        );
        await set(claimed.finishPendingRun$, pending, dispatched, signal);
        return {
          result: { kind: "launched", runId: pending.admittedLaunch.run.id },
          cursor,
        };
      })();
      return hostChangeUserId === undefined
        ? picked
        : (async () => {
            const outcome = await settleIncludingAbort(picked);
            if (hostChangeUserId !== undefined) {
              // Enqueue committed the host change even if picking failed.
              await publishDesktopShellAuthorizationChangedSafely(
                hostChangeUserId,
              );
            }
            if (!outcome.ok) {
              throw outcome.error;
            }
            return outcome.value;
          })();
    },
  );

  const pick$ = command(
    (
      { set },
      input: PickInput,
      signal: AbortSignal,
    ): Promise<PickIteration> => {
      const enqueued = input.requestInput;
      const resolveFirstPostHandoff = (() => {
        if (!enqueued || signal.aborted) {
          return undefined;
        }
        // This pick can publish both its initiating enqueue and the claim.
        const handoff = createDeferredPromise<void>(signal);
        waitUntil(
          (async () => {
            await handoff.promise;
            signal.throwIfAborted();
            await set(
              projectCommittedChatThreadSearch$,
              {
                userId: enqueued.userId,
                orgId: enqueued.orgId,
                threadId: enqueued.chatThreadId,
              },
              signal,
            );
          })(),
        );
        return () => {
          if (!handoff.settled()) {
            handoff.resolve(undefined);
          }
        };
      })();
      const picked = set(pickOnce$, input, resolveFirstPostHandoff, signal);
      // Release the same job when the pick exits before a POST.
      return resolveFirstPostHandoff
        ? picked.finally(resolveFirstPostHandoff)
        : picked;
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
