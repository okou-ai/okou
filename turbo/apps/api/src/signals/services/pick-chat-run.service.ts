import { computed, command, state } from "ccstate";
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
import { orgConcurrencySubscriptions } from "@okouai/db/schema/org-concurrency-subscription";
import {
  createOrgModelBootstrap,
  type PrefetchedModelBootstrap,
  type OrgModelBootstrap,
} from "./model-bootstrap.service";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { db$, writeDb$ } from "../external/db";
import { waitUntil } from "../context/wait-until";
import { nowDate } from "../../lib/time";
import type { PrefetchedAgentBootstrap } from "./agent-bootstrap.service";
import {
  activeConcurrencySubscriptionPredicate,
  totalConcurrencyLimit,
  cappedBaseConcurrencyLimit,
} from "./org-concurrency-entitlements.service";
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
  readonly prefetchedBootstrap?: PrefetchedAgentBootstrap;
  readonly prefetchedModels?: PrefetchedModelBootstrap;
}

/** Fixed chat thread lease; it is never renewed. */
const CHAT_THREAD_LEASE_MS = 10_000;

/** One pick launches a run, observes full capacity, or launches nothing. */
export type PickResult =
  | { readonly kind: "launched"; readonly runId: string }
  | { readonly kind: "org-full" }
  | { readonly kind: "none" };

/** An independent observation, evaluated only when its owner first reads it. */
function createOrgHasCapacity(orgId: string, models: OrgModelBootstrap) {
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

  const orgCapacity$ = computed(async (get) => {
    const database = get(db$);
    const at = nowDate();
    const subscriptions = await database
      .select({ slots: orgConcurrencySubscriptions.slots })
      .from(orgConcurrencySubscriptions)
      .where(activeConcurrencySubscriptionPredicate(orgId, at));
    const limit = totalConcurrencyLimit({
      baseLimit: cappedBaseConcurrencyLimit(
        models.capabilities?.baseConcurrencyLimit ?? 0,
      ),
      paidSlots: subscriptions.reduce((total, row) => {
        return total + row.slots;
      }, 0),
    });
    return Number.isFinite(limit) ? limit : 0;
  });

  return computed(async (get) => {
    const [activeCount, capacity] = await Promise.all([
      get(orgActiveRunCount$),
      get(orgCapacity$),
    ]);
    return capacity === 0 || activeCount < capacity;
  });
}

function createCapturedClaimObjects(
  claim: LeasedThreadClaim,
  models: OrgModelBootstrap,
) {
  const preparation = createThreadClaimRunObjects(
    {
      orgId: claim.orgId,
      chatThreadId: claim.chatThreadId,
      claimId: claim.claimId,
    },
    claim.prefetchedBootstrap,
    claim.prefetchedModels,
    models,
  );
  const orgHasCapacity$ = createOrgHasCapacity(claim.orgId, models);
  // This separate, predeclared graph is first evaluated after an org-full
  // release. Re-reading the initial memoized graph would lose a slot wakeup.
  const orgHasCapacityAfterRelease$ = createOrgHasCapacity(claim.orgId, models);
  return { ...preparation, orgHasCapacity$, orgHasCapacityAfterRelease$ };
}

interface PickInput {
  readonly orgId: string;
  readonly chatThreadId?: string;
  readonly after?: OrgPickCursor | null;
  readonly prefetchedBootstrap?: PrefetchedAgentBootstrap;
  readonly prefetchedModels?: PrefetchedModelBootstrap;
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
      ReturnType<typeof createCapturedClaimObjects>
    >();
  });
  const capturedClaims$ = computed(async (get) => {
    const graphCache = get(graphCache$);
    const graphs = new Map<
      string,
      ReturnType<typeof createCapturedClaimObjects>
    >();
    for (const claim of get(claimReceipts$)) {
      let graph = graphCache.get(claim);
      if (!graph) {
        const models =
          claim.prefetchedModels?.orgId === claim.orgId
            ? await claim.prefetchedModels.org
            : await get(createOrgModelBootstrap(claim.orgId));
        graph = createCapturedClaimObjects(claim, models);
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
      const { orgId, prefetchedBootstrap, prefetchedModels } = input;
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
          .where(
            and(
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
          })
      )[0];
      const claim: LeasedThreadClaim | null = row
        ? Object.freeze({
            orgId,
            chatThreadId: row.chatThreadId,
            claimId,
            queuedAt: row.queuedAt,
            ...(prefetchedBootstrap === undefined
              ? {}
              : { prefetchedBootstrap }),
            ...(prefetchedModels === undefined ? {} : { prefetchedModels }),
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
      const claimed = (await get(capturedClaims$)).get(claim.claimId);
      if (!claimed) {
        throw new Error("Successful queue claim has no captured run graph");
      }
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
