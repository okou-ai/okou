import { computed, command, state, type Command } from "ccstate";
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
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { db$, writeDb$ } from "../external/db";
import { waitUntil } from "../context/wait-until";
import { nowDate } from "../../lib/time";
import type { PrefetchedAgentBootstrap } from "./agent-bootstrap";
import {
  activeConcurrencySubscriptionPredicate,
  totalConcurrencyLimit,
  cappedBaseConcurrencyLimit,
} from "./org-concurrency-entitlements.service";
import {
  createThreadClaimRunObjects,
  type ThreadClaim,
} from "./thread-claim-run.service";

interface OrgPickCursor {
  readonly queuedAt: Date;
  readonly chatThreadId: string;
  readonly visitedThreadIds: readonly string[];
}

/**
 * The captured lease plus the `queuedAt` observed when it was taken. Only the
 * plain `{ orgId, chatThreadId, claimId }` identity crosses into the child.
 */
interface LeasedThreadClaim extends ThreadClaim {
  readonly queuedAt: Date;
}

/** Fixed chat thread lease; it is never renewed. */
const CHAT_THREAD_LEASE_MS = 10_000;

/**
 * One pick's outcome: the launched run, a claim released because the
 * organization had no free concurrency slot, or nothing launched.
 */
export type PickResult =
  | { readonly kind: "launched"; readonly runId: string }
  | { readonly kind: "org-full" }
  | { readonly kind: "none" };

export interface PickObjects {
  readonly pick$: Command<Promise<PickResult>, [signal: AbortSignal]>;
}

export function createPickObjects(
  orgId: string,
  fixedThreadId?: string,
  prefetchedBootstrap?: PrefetchedAgentBootstrap,
): PickObjects {
  const internalReloadPick$ = state(0);
  const internalSelectedClaim$ = state<LeasedThreadClaim | null>(null);
  const selectedClaimRunObjects$ = computed((get) => {
    const claim = get(internalSelectedClaim$);
    return claim
      ? createThreadClaimRunObjects(claim, prefetchedBootstrap)
      : null;
  });
  const internalOrgCursor$ = state<OrgPickCursor | null>(null);
  const orgActiveRunCount$ = computed(async (get) => {
    get(internalReloadPick$);
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
    get(internalReloadPick$);
    const database = get(db$);
    const at = nowDate();
    const [[plan], subscriptions] = await Promise.all([
      database
        .select({
          entitlementOrgId: orgPlanEntitlements.orgId,
          metadataOrgId: orgMetadata.orgId,
          baseConcurrencyLimit: orgPlanEntitlements.baseConcurrencyLimit,
        })
        .from(orgPlanEntitlements)
        .fullJoin(orgMetadata, eq(orgMetadata.orgId, orgPlanEntitlements.orgId))
        .where(
          or(
            eq(orgPlanEntitlements.orgId, orgId),
            eq(orgMetadata.orgId, orgId),
          ),
        )
        .limit(1),
      database
        .select({ slots: orgConcurrencySubscriptions.slots })
        .from(orgConcurrencySubscriptions)
        .where(activeConcurrencySubscriptionPredicate(orgId, at)),
    ]);
    if (plan?.entitlementOrgId === null && plan.metadataOrgId !== null) {
      throw new Error(`Missing org plan entitlement for ${orgId}`);
    }
    const limit = totalConcurrencyLimit({
      baseLimit: cappedBaseConcurrencyLimit(plan?.baseConcurrencyLimit ?? 0),
      paidSlots: subscriptions.reduce((total, row) => {
        return total + row.slots;
      }, 0),
    });
    return Number.isFinite(limit) ? limit : 0;
  });

  const orgHasCapacity$ = computed(async (get) => {
    const [activeCount, capacity] = await Promise.all([
      get(orgActiveRunCount$),
      get(orgCapacity$),
    ]);
    return capacity === 0 || activeCount < capacity;
  });

  const nextOrgThread$ = computed(async (get) => {
    get(internalReloadPick$);
    const after = get(internalOrgCursor$);
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
    return row ?? null;
  });

  const claim$ = command(async ({ get, set }, signal: AbortSignal) => {
    let threadId = fixedThreadId;
    if (threadId === undefined) {
      const candidate = await get(nextOrgThread$);
      signal.throwIfAborted();
      if (!candidate) {
        return null;
      }
      set(internalOrgCursor$, (previous) => {
        return {
          ...candidate,
          visitedThreadIds: [
            ...(previous?.visitedThreadIds ?? []),
            candidate.chatThreadId,
          ],
        };
      });
      threadId = candidate.chatThreadId;
    }
    const database = set(writeDb$);
    const at = nowDate();
    const claimId = randomUUID();
    const [row] = await database
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
      });
    signal.throwIfAborted();
    const claim = row
      ? {
          orgId,
          chatThreadId: row.chatThreadId,
          claimId,
          queuedAt: row.queuedAt,
        }
      : null;
    return claim;
  });

  /**
   * Release this claim's lease. Returns whether the lease was still ours; a
   * lease lost to expiry and another picker releases nothing.
   */
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

  /**
   * New input may remain behind this claim, so discover it with one fresh
   * fixed-thread pick in the background, as the enqueue scheduler does after
   * a commit. The scheduler lives in chat-thread-queue-drain, which imports
   * this module, so the pick is built here on the same request Store. This is
   * new work, not a retry: `pick$` never loops.
   */
  const scheduleThreadPick$ = command(
    ({ set }, claim: LeasedThreadClaim, signal: AbortSignal): void => {
      const { pick$: nextPick$ } = createPickObjects(
        claim.orgId,
        claim.chatThreadId,
      );
      waitUntil(set(nextPick$, signal));
    },
  );

  /** Release a claim that left input in the queue and pick the thread again. */
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

  /**
   * Delete the empty queue row only while both the token and `queuedAt` are
   * unchanged. A miss while the lease is still ours means input arrived under
   * this lease; its enqueuer's pick could not claim, so release and pick again.
   */
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

  /** Schedule one Thread owner; durable creation and startup are private to it. */
  const pick$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<PickResult> => {
      signal.throwIfAborted();
      set(internalReloadPick$, (revision) => {
        return revision + 1;
      });
      const claim = await set(claim$, signal);
      signal.throwIfAborted();
      if (!claim) {
        return { kind: "none" };
      }
      set(internalSelectedClaim$, claim);
      const claimed = get(selectedClaimRunObjects$);
      if (!claimed) {
        throw new Error("Selected thread claim is missing");
      }
      const [hasCapacity, hasInput] = await Promise.all([
        get(orgHasCapacity$),
        get(claimed.hasFirstPickableChatEvent$),
      ]);
      signal.throwIfAborted();
      if (!hasCapacity) {
        await set(releaseClaim$, claim, signal);
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
  return { pick$ };
}
