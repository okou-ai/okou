import { AsyncLocalStorage } from "node:async_hooks";

import { singleton } from "../../lib/singleton";
import { now } from "../../lib/time";
import type { ClerkClient } from "../external/clerk";

const PRIMARY_EMAIL_TTL_MS = 15 * 60 * 1000;
const MISSING_EMAIL_TTL_MS = 60 * 1000;
const MAX_EMAILS = 512;

interface CachedEmail {
  readonly email: string | undefined;
  readonly expiresAt: number;
  readonly readId: number;
}

function createEmailCache() {
  return { entries: new Map<string, CachedEmail>(), nextReadId: 0 };
}

// Display-only results for the single configured Clerk instance. The shared
// user_cache.email may contain a non-primary fallback, so it cannot supply this
// primary-only contract. Warm processes reuse results for 15 minutes, confirmed
// missing users/primary addresses for one minute; cold instances start empty.
// Freshness starts before the read; failures and cancellation are never cached.
// Expired entries are pruned on access and oldest entries evicted at capacity.
// Concurrent cold reads remain independently owned; no promises are retained.
const emailCache = singleton(createEmailCache);
const scopedEmailCache = singleton(() => {
  return new AsyncLocalStorage<ReturnType<typeof createEmailCache>>();
});

export async function withSlackAppHomeEmailCacheForTest<T>(
  work: () => Promise<T>,
): Promise<T> {
  return await scopedEmailCache().run(createEmailCache(), work);
}

export async function getSlackAppHomePrimaryEmail(
  client: ClerkClient,
  userId: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  signal.throwIfAborted();
  const cache = scopedEmailCache.peek()?.getStore() ?? emailCache();
  const startedAt = now();
  for (const [id, entry] of cache.entries) {
    if (entry.expiresAt <= startedAt) {
      cache.entries.delete(id);
    }
  }
  const cached = cache.entries.get(userId);
  if (cached) {
    return cached.email;
  }

  const readId = ++cache.nextReadId;
  const users = await client.users.getUserList(
    { userId: [userId] },
    undefined,
    signal,
  );
  signal.throwIfAborted();
  const user = users.data.find((candidate) => {
    return candidate.id === userId;
  });
  const email = user?.emailAddresses.find((candidate) => {
    return candidate.id === user.primaryEmailAddressId;
  })?.emailAddress;

  const latest = cache.entries.get(userId);
  if (latest && latest.readId > readId) {
    // A slower earlier request must not replace a newer observation.
    return latest.expiresAt > now() ? latest.email : email;
  }
  const expiresAt =
    startedAt +
    (email === undefined ? MISSING_EMAIL_TTL_MS : PRIMARY_EMAIL_TTL_MS);
  if (expiresAt > now()) {
    cache.entries.delete(userId);
    if (cache.entries.size >= MAX_EMAILS) {
      const oldest = cache.entries.keys().next().value;
      if (oldest !== undefined) {
        cache.entries.delete(oldest);
      }
    }
    cache.entries.set(userId, { email, expiresAt, readId });
  }
  return email;
}
