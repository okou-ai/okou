import { randomUUID } from "node:crypto";

import { cliTokens } from "@okouai/db/schema/cli-tokens";
import { orgCache } from "@okouai/db/schema/org-cache";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { userCache } from "@okouai/db/schema/user-cache";
import { command, computed, type Computed } from "ccstate";
import { and, desc, eq, ne, sql } from "drizzle-orm";

import { generateCliToken } from "../auth/tokens";
import { clerk$ } from "../external/clerk";
import { db$, writeDb$, type Db } from "../external/db";
import { nowDate } from "../../lib/time";
import { writeOrgMetadataWithDefaultPlanEntitlement } from "./org-plan-entitlements.service";

export const DEFAULT_TEST_EMAIL = "dev+clerk_test+serial@vm0-e2e.ai";
const CLI_TOKEN_EXPIRES_IN_SECONDS = 90 * 24 * 60 * 60;

const FAR_FUTURE_CACHE_MS = 365 * 24 * 60 * 60 * 1000;
const USER_CACHE_TTL_MS = 15 * 60 * 1000;
const TEST_ORG_CREDITS = 100_000;

interface IssuedCliToken {
  readonly token: string;
  readonly expiresIn: number;
}

export const issueCliToken$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly name: string;
    },
    _signal: AbortSignal,
  ): Promise<IssuedCliToken> => {
    const writeDb = set(writeDb$);
    const tokenId = randomUUID();
    const now = nowDate();
    const expiresAt = new Date(
      now.getTime() + CLI_TOKEN_EXPIRES_IN_SECONDS * 1000,
    );
    const token = generateCliToken(args.userId, args.orgId, tokenId);

    await writeDb.insert(cliTokens).values({
      id: tokenId,
      token,
      userId: args.userId,
      name: args.name,
      expiresAt,
      createdAt: now,
    });

    return { token, expiresIn: CLI_TOKEN_EXPIRES_IN_SECONDS };
  },
);

interface TestUserIdArgs {
  readonly email: string;
  readonly refresh: boolean;
}

export const testUserId$ = command(
  async (
    { get, set },
    args: TestUserIdArgs,
    signal: AbortSignal,
  ): Promise<string> => {
    const refreshStartedAt = nowDate();
    const db = get(db$);

    if (!args.refresh) {
      const [cached] = await db
        .select({ userId: userCache.userId, cachedAt: userCache.cachedAt })
        .from(userCache)
        .where(eq(userCache.email, args.email))
        .orderBy(desc(userCache.cachedAt))
        .limit(1);
      signal.throwIfAborted();
      if (
        cached &&
        refreshStartedAt.getTime() - cached.cachedAt.getTime() <
          USER_CACHE_TTL_MS
      ) {
        return cached.userId;
      }
    }

    const clerk = get(clerk$);
    const writeDb = set(writeDb$);
    return await writeDb.transaction(async (tx): Promise<string> => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`clerk_user_email:${args.email}`}))`,
      );
      signal.throwIfAborted();

      const [lockedCached] = await tx
        .select({ userId: userCache.userId, cachedAt: userCache.cachedAt })
        .from(userCache)
        .where(eq(userCache.email, args.email))
        .orderBy(desc(userCache.cachedAt))
        .limit(1);
      signal.throwIfAborted();
      if (
        lockedCached &&
        (args.refresh
          ? lockedCached.cachedAt.getTime() >= refreshStartedAt.getTime()
          : refreshStartedAt.getTime() - lockedCached.cachedAt.getTime() <
            USER_CACHE_TTL_MS)
      ) {
        return lockedCached.userId;
      }

      const { data: users } = await clerk.users.getUserList({
        emailAddress: [args.email],
      });
      signal.throwIfAborted();
      const user = users[0];
      if (!user) {
        await tx.delete(userCache).where(eq(userCache.email, args.email));
        throw new Error(`Test user not found for email: ${args.email}`);
      }

      const resolvedEmail =
        user.emailAddresses?.find((entry) => {
          return entry.id === user.primaryEmailAddressId;
        })?.emailAddress ??
        user.emailAddresses?.[0]?.emailAddress ??
        args.email;
      const name =
        [user.firstName, user.lastName].filter(Boolean).join(" ") || null;
      const cachedAt = nowDate();

      await tx
        .delete(userCache)
        .where(
          and(
            eq(userCache.email, resolvedEmail),
            ne(userCache.userId, user.id),
          ),
        );
      await tx
        .insert(userCache)
        .values({
          userId: user.id,
          email: resolvedEmail,
          name,
          imageUrl: user.imageUrl ?? null,
          cachedAt,
        })
        .onConflictDoUpdate({
          target: userCache.userId,
          set: {
            email: resolvedEmail,
            name,
            imageUrl: user.imageUrl ?? null,
            cachedAt,
          },
        });
      signal.throwIfAborted();
      return user.id;
    });
  },
);

function clerkRoleToCacheRole(role: string): "admin" | "member" {
  return role === "org:admin" ? "admin" : "member";
}

async function ensureTestOrgBillingRow(
  writeDb: Db,
  orgId: string,
): Promise<void> {
  await writeDb.transaction(async (tx) => {
    await writeOrgMetadataWithDefaultPlanEntitlement(
      tx,
      orgId,
      async (writeTx) => {
        return await writeTx
          .insert(orgMetadataCanonicalWrites)
          .values({
            orgId,
            tier: "pro",
            credits: TEST_ORG_CREDITS,
            updatedAt: nowDate(),
          })
          .onConflictDoUpdate({
            target: orgMetadataCanonicalWrites.orgId,
            set: {
              tier: "pro",
              credits: sql`
            GREATEST(COALESCE(${orgMetadata.credits}, 0), ${TEST_ORG_CREDITS})
          `,
              updatedAt: nowDate(),
            },
          })
          .returning({ orgId: orgMetadata.orgId, tier: orgMetadata.tier });
      },
    );
  });
}

export const ensureTestOrg$ = command(
  async (
    { get, set },
    userId: string,
    signal: AbortSignal,
  ): Promise<{ readonly orgId: string }> => {
    const memberships = await get(clerk$).users.getOrganizationMembershipList({
      userId,
    });
    signal.throwIfAborted();

    const ordered = [...memberships.data].sort((a, b) => {
      return a.createdAt - b.createdAt;
    });
    const membership = ordered[0];
    if (!membership) {
      throw new Error(`Test user ${userId} has no organization membership`);
    }

    const org = membership.organization;
    const writeDb = set(writeDb$);
    const [cached] = await writeDb
      .select({ orgId: orgCache.orgId })
      .from(orgCache)
      .where(eq(orgCache.orgId, org.id))
      .limit(1);
    signal.throwIfAborted();

    if (!cached) {
      await writeDb.insert(orgCache).values({
        orgId: org.id,
        name: org.name,
        cachedAt: new Date(nowDate().getTime() + FAR_FUTURE_CACHE_MS),
      });
      signal.throwIfAborted();
    }

    await ensureTestOrgBillingRow(writeDb, org.id);
    signal.throwIfAborted();

    await writeDb
      .insert(orgMembersCache)
      .values({
        orgId: org.id,
        userId,
        role: clerkRoleToCacheRole(membership.role),
        cachedAt: new Date(nowDate().getTime() + FAR_FUTURE_CACHE_MS),
      })
      .onConflictDoUpdate({
        target: [orgMembersCache.orgId, orgMembersCache.userId],
        set: {
          role: clerkRoleToCacheRole(membership.role),
          cachedAt: new Date(nowDate().getTime() + FAR_FUTURE_CACHE_MS),
        },
      });
    signal.throwIfAborted();

    return { orgId: org.id };
  },
);

export function testUserOrgId(
  userId: string,
): Computed<Promise<string | null>> {
  return computed(async (get): Promise<string | null> => {
    const [cached] = await get(db$)
      .select({ orgId: orgMembersCache.orgId })
      .from(orgMembersCache)
      .where(eq(orgMembersCache.userId, userId))
      .orderBy(desc(orgMembersCache.cachedAt))
      .limit(1);
    return cached?.orgId ?? null;
  });
}

export const resolveTestOrgId$ = command(
  async (
    { get, set },
    userId: string,
    signal: AbortSignal,
  ): Promise<string> => {
    const cachedOrgId = await get(testUserOrgId(userId));
    signal.throwIfAborted();
    if (cachedOrgId) {
      return cachedOrgId;
    }

    const clerk = get(clerk$);
    const writeDb = set(writeDb$);
    return await writeDb.transaction(async (tx): Promise<string> => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`clerk_test_org:${userId}`}))`,
      );
      signal.throwIfAborted();

      const [lockedCached] = await tx
        .select({ orgId: orgMembersCache.orgId })
        .from(orgMembersCache)
        .where(eq(orgMembersCache.userId, userId))
        .orderBy(desc(orgMembersCache.cachedAt))
        .limit(1);
      signal.throwIfAborted();
      if (lockedCached) {
        return lockedCached.orgId;
      }

      const memberships = await clerk.users.getOrganizationMembershipList({
        userId,
      });
      signal.throwIfAborted();
      const membership = [...memberships.data].sort((a, b) => {
        return a.createdAt - b.createdAt;
      })[0];
      if (!membership) {
        throw new Error(`Test user ${userId} has no organization membership`);
      }

      const org = membership.organization;
      const cachedAt = new Date(nowDate().getTime() + FAR_FUTURE_CACHE_MS);
      await tx
        .insert(orgCache)
        .values({
          orgId: org.id,
          name: org.name,
          cachedAt,
        })
        .onConflictDoUpdate({
          target: orgCache.orgId,
          set: {
            name: org.name,
            cachedAt,
          },
        });
      await tx
        .insert(orgMembersCache)
        .values({
          orgId: org.id,
          userId,
          role: clerkRoleToCacheRole(membership.role),
          cachedAt,
        })
        .onConflictDoUpdate({
          target: [orgMembersCache.orgId, orgMembersCache.userId],
          set: {
            role: clerkRoleToCacheRole(membership.role),
            cachedAt,
          },
        });
      signal.throwIfAborted();
      return org.id;
    });
  },
);
