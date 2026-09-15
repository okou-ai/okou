import { command, computed, type Computed } from "ccstate";
import { cliTokens } from "@okouai/db/schema/cli-tokens";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { and, eq, gt } from "drizzle-orm";

import { clerk$, isClerkResourceNotFound } from "../external/clerk";
import { db$, writeDb$ } from "../external/db";
import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import type { ApiOrgRole, CliAuth, CliTokenRecord } from "../../types/auth";
import { settle } from "../utils";

const L = logger("AuthService");

const MEMBER_ROLE_CACHE_TTL_MS = 60_000;

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
    _signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .insert(orgMembersCache)
      .values({ orgId, userId, role, cachedAt: nowDate() })
      .onConflictDoUpdate({
        target: [orgMembersCache.orgId, orgMembersCache.userId],
        set: { role, cachedAt: nowDate() },
      });
  },
);

const deleteMemberRoleCache$ = command(
  async (
    { set },
    orgId: string,
    userId: string,
    _signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .delete(orgMembersCache)
      .where(
        and(
          eq(orgMembersCache.orgId, orgId),
          eq(orgMembersCache.userId, userId),
        ),
      );
  },
);

export const getMemberRoleAndUpdateCache$ = command(
  async (
    { get, set },
    orgId: string,
    userId: string,
    signal: AbortSignal,
  ): Promise<MemberRoleResult> => {
    const db = get(db$);
    const [cached] = await db
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

    const currentTime = now();
    if (
      cached &&
      currentTime - cached.cachedAt.getTime() < MEMBER_ROLE_CACHE_TTL_MS
    ) {
      const role: ApiOrgRole = cached.role === "admin" ? "admin" : "member";
      return { kind: "member", role };
    }

    const read = await settle(
      get(clerk$).users.getOrganizationMembershipList(
        { userId, limit: 100 },
        undefined,
        signal,
      ),
      signal,
    );

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
      return { kind: "identity_not_found" };
    }

    const membership = read.value.data.find((candidate) => {
      return candidate.organization.id === orgId;
    });

    if (!membership) {
      // Drop the stale row so the next call doesn't keep falling back to Clerk
      // for a user that's no longer a member.
      if (cached) {
        await set(deleteMemberRoleCache$, orgId, userId, signal);
      }
      return { kind: "not_member" };
    }

    const role = mapClerkRole(membership.role);
    await set(upsertMemberRoleCache$, orgId, userId, role, signal);
    return { kind: "member", role };
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
