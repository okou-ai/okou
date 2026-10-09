import type { WorkflowOwnerProfile } from "@okouai/api-contracts/contracts/workflows";
import { userCache } from "@okouai/db/schema/user-cache";
import { eq } from "drizzle-orm";
import { command } from "ccstate";

import {
  createWorkflowOwnerProfileNegativeCache,
  WORKFLOW_OWNER_PROFILE_CACHE_LIMIT,
} from "../../lib/workflow-owner-profile-negative-cache";
import { singleton } from "../../lib/singleton";
import { now, nowDate } from "../../lib/time";
import { clerk$, isClerkResourceNotFound } from "../external/clerk";
import { db$, writeDb$ } from "../external/db";
import { awaitWithSignal, settle } from "../utils";

const POSITIVE_TTL_MS = 15 * 60 * 1000;

interface Refresh {
  readonly controller: AbortController;
  readonly promise: Promise<WorkflowOwnerProfile | null>;
  consumers: number;
}

// Display-only, process-local caches. Neither authorization nor fleet-wide
// deduplication lives here. Expired negatives are pruned on access, oldest
// negatives are evicted at capacity, and refreshes leave the map on settlement
// or when their final request consumer aborts. Cold instances start empty.
const ownerProfiles = singleton(() => {
  return {
    missing: createWorkflowOwnerProfileNegativeCache(),
    refreshing: new Map<string, Refresh>(),
  };
});

const refreshProfile$ = command(
  async (
    { get, set },
    ownerUserId: string,
    signal: AbortSignal,
  ): Promise<WorkflowOwnerProfile | null> => {
    const [cached] = await get(db$)
      .select({
        name: userCache.name,
        email: userCache.email,
        imageUrl: userCache.imageUrl,
        cachedAt: userCache.cachedAt,
      })
      .from(userCache)
      .where(eq(userCache.userId, ownerUserId))
      .limit(1);
    signal.throwIfAborted();
    if (cached && now() - cached.cachedAt.getTime() < POSITIVE_TTL_MS) {
      return {
        displayName: cached.name ?? cached.email,
        imageUrl: cached.imageUrl,
      };
    }

    // The direct lookup has an authoritative 404 and no list/count pagination.
    const result = await settle(
      get(clerk$).users.getUser(ownerUserId, undefined, signal),
      signal,
    );
    if (!result.ok && !isClerkResourceNotFound(result.error)) {
      throw result.error;
    }
    const user = result.ok ? result.value : null;
    if (!user) {
      ownerProfiles().missing.record(ownerUserId, now());
      return null;
    }

    const email =
      user.emailAddresses.find((entry) => {
        return entry.id === user.primaryEmailAddressId;
      })?.emailAddress ??
      user.emailAddresses[0]?.emailAddress ??
      null;
    const name =
      [user.firstName, user.lastName].filter(Boolean).join(" ") || null;
    const imageUrl = user.imageUrl || null;
    // An existing user without email still has a display profile. Do not invent
    // an address to satisfy user_cache's NOT NULL identity-storage contract.
    if (email) {
      const cachedAt = nowDate();
      await set(writeDb$)
        .insert(userCache)
        .values({ userId: user.id, email, name, imageUrl, cachedAt })
        .onConflictDoUpdate({
          target: userCache.userId,
          set: { email, name, imageUrl, cachedAt },
        });
      signal.throwIfAborted();
    }
    return { displayName: name ?? email, imageUrl };
  },
);

/** Call only after workflow visibility is authorized. Undefined means busy. */
export const loadWorkflowOwnerProfile$ = command(
  async (
    { get, set },
    ownerUserId: string,
    signal: AbortSignal,
  ): Promise<WorkflowOwnerProfile | null | undefined> => {
    // Preserve provider initialization before the shared-cache decision.
    get(clerk$);
    signal.throwIfAborted();
    const cache = ownerProfiles();
    if (cache.missing.has(ownerUserId, now())) {
      return null;
    }

    let refresh = cache.refreshing.get(ownerUserId);
    if (!refresh) {
      // Bound retained refreshes as well as negative results. Reject excess work
      // transiently; never evict another caller's active refresh or cache an error.
      if (cache.refreshing.size >= WORKFLOW_OWNER_PROFILE_CACHE_LIMIT) {
        return undefined;
      }
      const controller = new AbortController();
      const promise = set(refreshProfile$, ownerUserId, controller.signal);
      refresh = { controller, promise, consumers: 0 };
      cache.refreshing.set(ownerUserId, refresh);
    }
    refresh.consumers += 1;
    return await awaitWithSignal(refresh.promise, signal).finally(() => {
      refresh.consumers -= 1;
      if (refresh.consumers === 0) {
        refresh.controller.abort();
        if (cache.refreshing.get(ownerUserId) === refresh) {
          cache.refreshing.delete(ownerUserId);
        }
      }
    });
  },
);
