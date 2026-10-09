import { command } from "ccstate";
import { asc, inArray } from "drizzle-orm";
import type {
  MemberUsage,
  UsageMembersResponse,
} from "@okouai/api-contracts/contracts/usage";
import type { UsageRecordRange } from "@okouai/api-contracts/contracts/usage-record";
import { userCache } from "@okouai/db/schema/user-cache";
import { clerk$, type ClerkUser } from "../external/clerk";
import { writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";
import { getOrgBillingPeriod$ } from "./org-billing-period.service";
import {
  memberUsageBreakdownQuery,
  memberUsageTotalsQuery,
} from "./usage-reporting-ledger";
import { buildUsageBreakdowns } from "./usage-reporting-breakdown";
import { fixedRangeToPeriod } from "./usage-period";

interface UsageMembersArgs {
  readonly orgId: string;
  readonly range: UsageRecordRange;
  readonly tz: string;
}

export const usageMembers$ = command(
  async (
    { set },
    args: UsageMembersArgs,
    signal: AbortSignal,
  ): Promise<UsageMembersResponse> => {
    const billingPeriod =
      args.range === "billingPeriod"
        ? await set(getOrgBillingPeriod$, args.orgId, signal)
        : null;
    signal.throwIfAborted();

    if (args.range === "billingPeriod" && !billingPeriod) {
      return { period: null, members: [] };
    }

    const period =
      args.range === "billingPeriod"
        ? billingPeriod
        : fixedRangeToPeriod(args.range, args.tz);
    if (!period) {
      throw new Error("member usage period was not resolved");
    }

    const db = set(writeDb$);
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0309; new non-billing transactions are prohibited.
    const { rows, breakdownByUser } = await db.transaction(
      async (tx) => {
        const rows = await tx
          .select()
          .from(memberUsageTotalsQuery(args.orgId, period));
        const breakdownQuery = memberUsageBreakdownQuery(args.orgId, period);
        const breakdown = await tx
          .select()
          .from(breakdownQuery)
          .orderBy(
            asc(breakdownQuery.key),
            asc(breakdownQuery.kind),
            asc(breakdownQuery.provider),
            asc(breakdownQuery.usageKind),
          );
        signal.throwIfAborted();
        return { rows, breakdownByUser: buildUsageBreakdowns(breakdown) };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    signal.throwIfAborted();

    if (rows.length === 0) {
      return {
        period: {
          start: period.start.toISOString(),
          end: period.end.toISOString(),
        },
        members: [],
      };
    }

    const userIds = rows.map((row) => {
      return row.userId;
    });
    const emailMap = await set(resolveUsageEmails$, userIds, signal);

    const members: MemberUsage[] = rows.map((row) => {
      return {
        userId: row.userId,
        email: emailMap.get(row.userId) ?? "unknown",
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadInputTokens: row.cacheReadInputTokens,
        cacheCreationInputTokens: row.cacheCreationInputTokens,
        creditsCharged: row.creditsCharged,
        breakdown: breakdownByUser.get(row.userId) ?? [],
      };
    });

    members.sort((a, b) => {
      return (
        b.creditsCharged - a.creditsCharged || a.userId.localeCompare(b.userId)
      );
    });

    return {
      period: {
        start: period.start.toISOString(),
        end: period.end.toISOString(),
      },
      members,
    };
  },
);

function primaryEmail(user: ClerkUser): string {
  const primary = user.emailAddresses.find((email) => {
    return email.id === user.primaryEmailAddressId;
  });
  return primary?.emailAddress ?? "unknown";
}

export const resolveUsageEmails$ = command(
  async (
    { get, set },
    userIds: readonly string[],
    signal: AbortSignal,
  ): Promise<Map<string, string>> => {
    const db = set(writeDb$);
    const client = get(clerk$);
    if (userIds.length === 0) {
      return new Map();
    }

    const cachedUsers = await db
      .select({ userId: userCache.userId, email: userCache.email })
      .from(userCache)
      .where(inArray(userCache.userId, [...userIds]));
    signal.throwIfAborted();

    const emailMap = new Map(
      cachedUsers.map((user) => {
        return [user.userId, user.email];
      }),
    );

    const missingIds = userIds.filter((id) => {
      return !emailMap.has(id);
    });
    if (missingIds.length === 0) {
      return emailMap;
    }

    const clerkUsers = await client.users.getUserList({
      userId: [...missingIds],
      limit: missingIds.length,
    });
    signal.throwIfAborted();
    const now = nowDate();

    for (const user of clerkUsers.data) {
      const email = primaryEmail(user);
      emailMap.set(user.id, email);
      await db
        .insert(userCache)
        .values({
          userId: user.id,
          email,
          imageUrl: user.imageUrl ?? null,
          cachedAt: now,
        })
        .onConflictDoUpdate({
          target: userCache.userId,
          set: { email, imageUrl: user.imageUrl ?? null, cachedAt: now },
        });
      signal.throwIfAborted();
    }

    return emailMap;
  },
);
