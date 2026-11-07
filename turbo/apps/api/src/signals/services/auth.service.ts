import { command, computed, type Computed } from "ccstate";
import { cliTokens } from "@okouai/db/schema/cli-tokens";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { and, eq, gt } from "drizzle-orm";

import { clerk$, isClerkResourceNotFound } from "../external/clerk";
import { db$, writeDb$ } from "../external/db";
import { logger } from "../../lib/log";
import { normalizeBuildCommitSha } from "../../lib/build-info";
import { env } from "../../lib/env";
import { monotonicNow, now, nowDate } from "../../lib/time";
import type { ApiOrgRole, CliAuth, CliTokenRecord } from "../../types/auth";
import { recordApiOperationTimings } from "../external/sandbox-op-log";
import { awaitWithSignal, settle, settleIncludingAbort } from "../utils";

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

type MemberRoleAuthPath = "pat" | "agent" | "oauth" | "shared";
type MemberRoleCacheState = "fresh" | "missing" | "expired" | "unavailable";
type MemberRoleStage =
  "cache_lookup" | "clerk_read" | "cache_upsert" | "cache_delete";

/** One invocation owns these content-free wall timings, including failed stages. */
class MemberRoleTiming {
  private readonly startedAt = monotonicNow();
  private readonly durations: Partial<Record<`${MemberRoleStage}_ms`, number>> =
    {};
  private active:
    { readonly stage: MemberRoleStage; readonly startedAt: number } | undefined;
  cacheState: MemberRoleCacheState = "unavailable";

  constructor(private readonly authPath: MemberRoleAuthPath) {}

  start(stage: MemberRoleStage): void {
    this.active = { stage, startedAt: monotonicNow() };
  }

  complete(): void {
    if (this.active) {
      this.durations[`${this.active.stage}_ms`] =
        monotonicNow() - this.active.startedAt;
      this.active = undefined;
    }
  }

  async observe(
    operation: Promise<MemberRoleResult>,
    signal: AbortSignal,
  ): Promise<MemberRoleResult> {
    // Only observe cancellation to finish the census. No authority or cache
    // work follows this boundary, and the original error is rethrown intact.
    const result = await settleIncludingAbort(operation);
    await this.record(
      result.ok
        ? result.value.kind
        : signal.aborted
          ? "caller_cancelled"
          : "failed",
    );
    if (!result.ok) {
      throw result.error;
    }
    return result.value;
  }

  private async record(
    outcome: MemberRoleResult["kind"] | "failed" | "caller_cancelled",
  ): Promise<void> {
    // Optional observation includes abort-shaped sink failures; the caller still
    // returns or rethrows the exact required membership result below.
    await settleIncludingAbort(() => {
      const failedStage = this.active?.stage;
      this.complete();
      const apiCommitSha = normalizeBuildCommitSha(env("GIT_COMMIT_SHA"));
      recordApiOperationTimings([
        {
          actionType: "auth_member_role",
          durationMs: monotonicNow() - this.startedAt,
          success: outcome !== "failed" && outcome !== "caller_cancelled",
          dimensions: {
            auth_path: this.authPath,
            cache_state: this.cacheState,
            membership_outcome: outcome,
            ...this.durations,
            ...(failedStage ? { failed_stage: failedStage } : {}),
            ...(apiCommitSha ? { api_commit_sha: apiCommitSha } : {}),
          },
        },
      ]);
    });
  }
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

export const getMemberRoleAndUpdateCache$ = command(
  async (
    { get, set },
    orgId: string,
    userId: string,
    authPath: MemberRoleAuthPath,
    signal: AbortSignal,
  ): Promise<MemberRoleResult> => {
    const timing = new MemberRoleTiming(authPath);
    return await timing.observe(
      (async (): Promise<MemberRoleResult> => {
        signal.throwIfAborted();
        timing.start("cache_lookup");
        const cached = await set(readMemberRoleCache$, orgId, userId, signal);
        timing.complete();
        const fresh = freshMemberRole(cached);
        timing.cacheState = fresh ? "fresh" : cached ? "expired" : "missing";
        if (fresh) {
          return fresh;
        }

        timing.start("clerk_read");
        const read = await settle(
          awaitWithSignal(
            get(clerk$).users.getOrganizationMembershipList(
              { userId, limit: 100 },
              undefined,
              signal,
            ),
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
          timing.complete();

          // Drop the stale row so cached organization authority cannot outlive the
          // identity any longer than the row that is being removed here.
          if (cached) {
            timing.start("cache_delete");
            await set(deleteMemberRoleCache$, orgId, userId, signal);
            timing.complete();
          }
          // A handled, expected condition: debug is the level `api/no-logger-info`
          // prescribes for a routine diagnostic. The record carries the stable
          // type and no user, organization or Clerk trace identifier.
          L.debug("Clerk identity no longer exists during membership read", {
            type: "clerk_identity_not_found",
          });
          return { kind: "identity_not_found" };
        }
        timing.complete();

        const membership = read.value.data.find((candidate) => {
          return candidate.organization.id === orgId;
        });

        if (!membership) {
          // Remove stale organization authority when membership is revoked.
          if (cached) {
            timing.start("cache_delete");
            await set(deleteMemberRoleCache$, orgId, userId, signal);
            timing.complete();
          }
          return { kind: "not_member" };
        }

        const role = mapClerkRole(membership.role);
        timing.start("cache_upsert");
        await set(upsertMemberRoleCache$, orgId, userId, role, signal);
        timing.complete();
        return { kind: "member", role };
      })(),
      signal,
    );
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
