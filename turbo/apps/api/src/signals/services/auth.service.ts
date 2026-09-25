import { command, computed, type Computed } from "ccstate";
import { cliTokens } from "@okouai/db/schema/cli-tokens";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { and, eq, gt } from "drizzle-orm";
import { timeout } from "signal-timers";

import { clerk$, isClerkResourceNotFound } from "../external/clerk";
import { db$, writeDb$ } from "../external/db";
import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import { singleton } from "../../lib/singleton";
import type { ApiOrgRole, CliAuth, CliTokenRecord } from "../../types/auth";
import { awaitWithSignal, settle } from "../utils";

const L = logger("AuthService");

const MEMBER_ROLE_CACHE_TTL_MS = 60_000;
const NEGATIVE_MEMBER_ROLE_TTL_MS = 5000;
const MAX_MEMBER_ROLE_ENTRIES = 512;
const MEMBER_ROLE_REFRESH_TIMEOUT_MS = 15_000;

/**
 * Outcome of an organization membership read.
 *
 * `not_member` keeps its long-standing meaning: the identity is valid but
 * holds no role in this organization, which legitimately degrades to a
 * user-only context. `identity_not_found` is a distinct outcome — Clerk no
 * longer knows the user at all — so callers can fail closed instead of
 * silently degrading a deleted identity into the `not_member` path.
 */
type MemberRoleResult =
  | { readonly kind: "member"; readonly role: ApiOrgRole }
  | { readonly kind: "not_member" }
  | { readonly kind: "identity_not_found" };

type NegativeMemberRole = Exclude<MemberRoleResult, { kind: "member" }>;

interface MemberRoleRefresh {
  readonly controller: AbortController;
  readonly promise: Promise<MemberRoleResult>;
  consumers: number;
}

export class MemberRoleRefreshUnavailableError extends Error {
  constructor(readonly reason: "capacity" | "deadline") {
    super("Membership refresh is temporarily unavailable");
    this.name = "MemberRoleRefreshUnavailableError";
  }
}

// Process-local only. The database remains the sole positive cache. Cold
// instances can each refresh a key; see docs/membership-refresh.md for bounds.
const memberRoleRefreshes = singleton(() => {
  return {
    active: new Map<string, MemberRoleRefresh>(),
    missing: new Map<
      string,
      { readonly result: NegativeMemberRole; readonly expiresAt: number }
    >(),
  };
});

function memberRoleKey(orgId: string, userId: string): string {
  return JSON.stringify([orgId, userId]);
}

function rememberNegativeMemberRole(
  orgId: string,
  userId: string,
  result: NegativeMemberRole,
  observedAt: number,
): NegativeMemberRole {
  const missing = memberRoleRefreshes().missing;
  if (missing.size >= MAX_MEMBER_ROLE_ENTRIES) {
    const oldest = missing.keys().next().value;
    if (oldest !== undefined) {
      missing.delete(oldest);
    }
  }
  missing.set(memberRoleKey(orgId, userId), {
    result,
    expiresAt: observedAt + NEGATIVE_MEMBER_ROLE_TTL_MS,
  });
  return result;
}

const readMemberRoleCache$ = command(
  async ({ get }, orgId: string, userId: string, signal: AbortSignal) => {
    const [cached] = await get(db$)
      .select({
        role: orgMembersCache.role,
        cachedAt: orgMembersCache.cachedAt,
      })
      .from(orgMembersCache)
      .where(
        and(
          eq(orgMembersCache.orgId, orgId),
          eq(orgMembersCache.userId, userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return cached;
  },
);

function freshMemberRole(
  cached: { readonly role: string; readonly cachedAt: Date } | undefined,
): MemberRoleResult | undefined {
  if (cached && now() - cached.cachedAt.getTime() < MEMBER_ROLE_CACHE_TTL_MS) {
    return {
      kind: "member",
      role: cached.role === "admin" ? "admin" : "member",
    };
  }
  return undefined;
}

function mapClerkRole(role: string): ApiOrgRole {
  return role === "org:admin" ? "admin" : "member";
}

export const updateCliTokenLastUsedAt$ = command(
  async ({ set }, tokenId: string, _signal: AbortSignal): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .update(cliTokens)
      .set({ lastUsedAt: nowDate() })
      .where(eq(cliTokens.id, tokenId));
  },
);

const upsertMemberRoleCache$ = command(
  async (
    { set },
    orgId: string,
    userId: string,
    role: ApiOrgRole,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const writeDb = set(writeDb$);
    await writeDb
      .insert(orgMembersCache)
      .values({ orgId, userId, role, cachedAt: nowDate() })
      .onConflictDoUpdate({
        target: [orgMembersCache.orgId, orgMembersCache.userId],
        set: { role, cachedAt: nowDate() },
      });
    signal.throwIfAborted();
  },
);

const deleteMemberRoleCache$ = command(
  async (
    { set },
    orgId: string,
    userId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const writeDb = set(writeDb$);
    await writeDb
      .delete(orgMembersCache)
      .where(
        and(
          eq(orgMembersCache.orgId, orgId),
          eq(orgMembersCache.userId, userId),
        ),
      );
    signal.throwIfAborted();
  },
);

const refreshMemberRole$ = command(
  async (
    { get, set },
    orgId: string,
    userId: string,
    signal: AbortSignal,
  ): Promise<MemberRoleResult> => {
    // Recheck after ownership: another refresh may have completed while this
    // caller's initial database miss was still in flight.
    const cached = await set(readMemberRoleCache$, orgId, userId, signal);
    const fresh = freshMemberRole(cached);
    if (fresh) {
      return fresh;
    }

    const read = await settle(
      get(clerk$).users.getOrganizationMembershipList(
        { userId, limit: 100 },
        undefined,
        signal,
      ),
      signal,
    );
    const observedAt = now();

    if (!read.ok) {
      // Allowlist, deliberately written as a negated guard: a missing Clerk
      // identity is the only failure this boundary is allowed to convert into
      // a controlled result. Exhausted provider reads, rate limits, database
      // failures and every other error keep their existing path by
      // construction, because authentication must never swallow an error it
      // has not explicitly classified.
      if (!isClerkResourceNotFound(read.error)) {
        throw read.error;
      }

      // Drop the stale row so cached organization authority cannot outlive the
      // identity any longer than the row that is being removed here.
      if (cached) {
        await set(deleteMemberRoleCache$, orgId, userId, signal);
      }
      // A handled, expected condition: debug is the level `api/no-logger-info`
      // prescribes for a routine diagnostic. The record carries the stable
      // type and no user, organization or Clerk trace identifier.
      L.debug("Clerk identity no longer exists during membership read", {
        type: "clerk_identity_not_found",
      });
      return rememberNegativeMemberRole(
        orgId,
        userId,
        { kind: "identity_not_found" },
        observedAt,
      );
    }

    const membership = read.value.data.find((candidate) => {
      return candidate.organization.id === orgId;
    });

    if (!membership) {
      // Remove stale organization authority before retaining the negative.
      if (cached) {
        await set(deleteMemberRoleCache$, orgId, userId, signal);
      }
      return rememberNegativeMemberRole(
        orgId,
        userId,
        { kind: "not_member" },
        observedAt,
      );
    }

    const role = mapClerkRole(membership.role);
    await set(upsertMemberRoleCache$, orgId, userId, role, signal);
    return { kind: "member", role };
  },
);

export const getMemberRoleAndUpdateCache$ = command(
  async (
    { set },
    orgId: string,
    userId: string,
    signal: AbortSignal,
  ): Promise<MemberRoleResult> => {
    signal.throwIfAborted();
    const cached = await set(readMemberRoleCache$, orgId, userId, signal);
    const fresh = freshMemberRole(cached);
    const cache = memberRoleRefreshes();
    const key = memberRoleKey(orgId, userId);
    if (fresh) {
      cache.missing.delete(key);
      return fresh;
    }

    for (const [missingKey, entry] of cache.missing) {
      if (entry.expiresAt <= now()) {
        cache.missing.delete(missingKey);
      }
    }
    const missing = cache.missing.get(key);
    if (missing) {
      return missing.result;
    }

    let refresh = cache.active.get(key);
    if (!refresh) {
      if (cache.active.size >= MAX_MEMBER_ROLE_ENTRIES) {
        throw new MemberRoleRefreshUnavailableError("capacity");
      }
      const controller = new AbortController();
      timeout(
        () => {
          controller.abort(new MemberRoleRefreshUnavailableError("deadline"));
        },
        MEMBER_ROLE_REFRESH_TIMEOUT_MS,
        { signal: controller.signal },
      );
      const promise = awaitWithSignal(
        set(refreshMemberRole$, orgId, userId, controller.signal),
        controller.signal,
      ).finally(() => {
        controller.abort();
        if (cache.active.get(key)?.promise === promise) {
          cache.active.delete(key);
        }
      });
      refresh = { controller, promise, consumers: 0 };
      cache.active.set(key, refresh);
    }
    refresh.consumers += 1;
    return await awaitWithSignal(refresh.promise, signal).finally(() => {
      refresh.consumers -= 1;
      if (refresh.consumers === 0) {
        refresh.controller.abort();
        if (cache.active.get(key) === refresh) {
          cache.active.delete(key);
        }
      }
    });
  },
);

export function cliTokenRecord(
  cliAuth: CliAuth,
): Computed<Promise<CliTokenRecord | null>> {
  return computed(async (get): Promise<CliTokenRecord | null> => {
    const db = get(db$);
    const currentDate = nowDate();
    const [record] = await db
      .select()
      .from(cliTokens)
      .where(
        and(
          eq(cliTokens.id, cliAuth.tokenId),
          gt(cliTokens.expiresAt, currentDate),
        ),
      )
      .limit(1);

    if (!record) {
      return null;
    }

    return {
      userId: cliAuth.userId,
      orgId: cliAuth.orgId,
    };
  });
}
