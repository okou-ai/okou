import type { WorkflowOwnerProfile } from "@okouai/api-contracts/contracts/workflows";
import { userCache } from "@okouai/db/schema/user-cache";
import { eq } from "drizzle-orm";

import { singleton } from "../../lib/singleton";
import { now, nowDate } from "../../lib/time";
import { isClerkResourceNotFound, type ClerkClient } from "../external/clerk";
import type { Db } from "../external/db";
import { awaitWithSignal, settle } from "../utils";

const POSITIVE_TTL_MS = 15 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 1000;
const MAX_OWNERS = 512;

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
    missing: new Map<string, number>(),
    refreshing: new Map<string, Refresh>(),
  };
});

async function refreshProfile(
  db: Db,
  client: ClerkClient,
  ownerUserId: string,
  signal: AbortSignal,
): Promise<WorkflowOwnerProfile | null> {
  const [cached] = await db
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
    client.users.getUser(ownerUserId, undefined, signal),
    signal,
  );
  if (!result.ok && !isClerkResourceNotFound(result.error)) {
    throw result.error;
  }
  const user = result.ok ? result.value : null;
  if (!user) {
    const missing = ownerProfiles().missing;
    if (missing.size >= MAX_OWNERS) {
      const oldest = missing.keys().next().value;
      if (oldest !== undefined) {
        missing.delete(oldest);
      }
    }
    missing.set(ownerUserId, now() + NEGATIVE_TTL_MS);
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
    await db
      .insert(userCache)
      .values({ userId: user.id, email, name, imageUrl, cachedAt })
      .onConflictDoUpdate({
        target: userCache.userId,
        set: { email, name, imageUrl, cachedAt },
      });
    signal.throwIfAborted();
  }
  return { displayName: name ?? email, imageUrl };
}

/** Call only after workflow visibility is authorized. Undefined means busy. */
export async function loadWorkflowOwnerProfile(
  db: Db,
  client: ClerkClient,
  ownerUserId: string,
  signal: AbortSignal,
): Promise<WorkflowOwnerProfile | null | undefined> {
  signal.throwIfAborted();
  const cache = ownerProfiles();
  for (const [id, expiresAt] of cache.missing) {
    if (expiresAt <= now()) {
      cache.missing.delete(id);
    }
  }
  if (cache.missing.has(ownerUserId)) {
    return null;
  }

  let refresh = cache.refreshing.get(ownerUserId);
  if (!refresh) {
    // Bound retained refreshes as well as negative results. Reject excess work
    // transiently; never evict another caller's active refresh or cache an error.
    if (cache.refreshing.size >= MAX_OWNERS) {
      return undefined;
    }
    const controller = new AbortController();
    const promise = refreshProfile(db, client, ownerUserId, controller.signal);
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
}
