import { userCache } from "@okouai/db/schema/user-cache";
import { inArray } from "drizzle-orm";

import { now, nowDate } from "../../lib/time";
import {
  clerkRateLimit,
  clerkReadUnavailable,
  type ClerkClient,
  type ClerkReadContext,
  type ClerkUser,
} from "../external/clerk";
import type { Db } from "../external/db";
import { settle } from "../utils";

const USER_PROFILE_CACHE_TTL_MS = 15 * 60 * 1000;
const CLERK_USER_LIST_BATCH_SIZE = 100;

export interface ClerkUserProfile {
  readonly email: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly imageUrl: string;
}

function userPrimaryEmail(user: ClerkUser): string {
  const primary = user.emailAddresses.find((e) => {
    return e.id === user.primaryEmailAddressId;
  });
  return primary?.emailAddress ?? "";
}

/**
 * Who a set of user IDs belong to, read through `user_cache` and refreshed
 * from Clerk.
 *
 * Batched rather than resolved one ID at a time because every caller starts
 * from a list — an organization's memberships, a catalog's owners — and a stale
 * cache entry would otherwise cost one round trip per row. Clerk is the
 * authority for the profile; the table is only how a list of them is afforded.
 *
 * A user Clerk does not return is simply absent from the map. Callers decide
 * what an unresolved ID means for them: this is display data, so it never
 * decides access.
 */
export async function fetchUserProfileMap(
  db: Db,
  client: ClerkClient,
  userIds: readonly string[],
  context: ClerkReadContext,
  signal: AbortSignal,
): Promise<Map<string, ClerkUserProfile>> {
  const map = new Map<string, ClerkUserProfile>();
  const uniqueUserIds = [...new Set(userIds)];
  if (uniqueUserIds.length === 0) {
    return map;
  }

  const currentTime = now();
  const cachedUsers = await db
    .select({
      userId: userCache.userId,
      email: userCache.email,
      name: userCache.name,
      imageUrl: userCache.imageUrl,
      cachedAt: userCache.cachedAt,
    })
    .from(userCache)
    .where(inArray(userCache.userId, uniqueUserIds));
  signal.throwIfAborted();
  const missingUserIds = new Set(uniqueUserIds);
  for (const cached of cachedUsers) {
    if (currentTime - cached.cachedAt.getTime() >= USER_PROFILE_CACHE_TTL_MS) {
      continue;
    }
    const [firstName = null, ...rest] = (cached.name ?? "").split(/\s+/);
    map.set(cached.userId, {
      email: cached.email,
      firstName: firstName || null,
      lastName: rest.join(" ") || null,
      imageUrl: cached.imageUrl ?? "",
    });
    missingUserIds.delete(cached.userId);
  }

  if (missingUserIds.size === 0) {
    return map;
  }

  const refreshedAt = nowDate();
  const userIdsToFetch = [...missingUserIds];
  for (
    let offset = 0;
    offset < userIdsToFetch.length;
    offset += CLERK_USER_LIST_BATCH_SIZE
  ) {
    const users = await client.users.getUserList(
      {
        userId: userIdsToFetch.slice(
          offset,
          offset + CLERK_USER_LIST_BATCH_SIZE,
        ),
        limit: CLERK_USER_LIST_BATCH_SIZE,
      },
      context,
      signal,
    );
    for (const user of users.data) {
      const email = userPrimaryEmail(user);
      const name =
        [user.firstName, user.lastName].filter(Boolean).join(" ") || null;
      const imageUrl = user.imageUrl || null;
      map.set(user.id, {
        email,
        firstName: user.firstName,
        lastName: user.lastName,
        imageUrl: imageUrl ?? "",
      });
      if (email) {
        await db
          .insert(userCache)
          .values({
            userId: user.id,
            email,
            name,
            imageUrl,
            cachedAt: refreshedAt,
          })
          .onConflictDoUpdate({
            target: userCache.userId,
            set: {
              email,
              name,
              imageUrl,
              cachedAt: refreshedAt,
            },
          });
        signal.throwIfAborted();
      }
    }
  }
  return map;
}

/**
 * The one string that names this person to another member.
 *
 * The email is the fallback rather than an extra line: a Clerk account can be
 * created from an invitation and never given a name, and an address still says
 * who it is. Null when the profile carries neither, which is the only case a
 * surface has to word for itself.
 */
function userProfileDisplayName(profile: ClerkUserProfile): string | null {
  const name = [profile.firstName, profile.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  return name || profile.email || null;
}

/**
 * Names for a set of user IDs, for a response that is worth serving without
 * them.
 *
 * The degraded mode is deliberate and narrow. A name here labels a row the
 * reader is already authorized to see, so a provider that cannot answer must
 * not take the row away with it; the caller's contract makes the name nullable
 * and its surface words the gap. Only the two outcomes that mean "Clerk could
 * not answer" — reads exhausted and rate limiting — degrade. Everything else,
 * including this service's own database failures and a rejected Clerk
 * credential, stays an error, because none of those are the provider saying it
 * does not know.
 */
export async function loadUserDisplayNames(
  db: Db,
  client: ClerkClient,
  userIds: readonly string[],
  context: ClerkReadContext,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, string>> {
  const names = new Map<string, string>();
  const profiles = await settle(
    fetchUserProfileMap(db, client, userIds, context, signal),
    signal,
  );
  if (!profiles.ok) {
    if (
      clerkReadUnavailable(profiles.error) === null &&
      clerkRateLimit(profiles.error) === null
    ) {
      throw profiles.error;
    }
    return names;
  }
  for (const [userId, profile] of profiles.value) {
    const displayName = userProfileDisplayName(profile);
    if (displayName !== null) {
      names.set(userId, displayName);
    }
  }
  return names;
}
