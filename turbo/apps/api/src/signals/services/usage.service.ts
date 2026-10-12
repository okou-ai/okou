import { command } from "ccstate";
import { asc, inArray } from "drizzle-orm";
import type {
  MemberUsage,
  UsageMembersResponse,
} from "@okouai/api-contracts/contracts/usage";
import type { UsageRecordRange } from "@okouai/api-contracts/contracts/usage-record";
import { userCache } from "@okouai/db/schema/user-cache";
import { clerk$, type ClerkUser } from "../external/clerk";
import { db$, writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";
import { getOrgBillingPeriod$ } from "./org-billing-period.service";
import { memberUsageQuery } from "./usage-reporting-ledger";
import {
  buildUsageBreakdowns,
  type UsageBreakdownSqlRow,
} from "./usage-reporting-breakdown";
import { fixedRangeToPeriod } from "./usage-period";

interface UsageMembersArgs {
  readonly orgId: string;
  readonly range: UsageRecordRange;
  readonly tz: string;
}

export const usageMembers$ = command(
  async (
    { get, set },
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

    const db = get(db$);
    const query = memberUsageQuery(args.orgId, period);
    signal.throwIfAborted();
    const joinedRows = await db
      .select()
      .from(query)
      .orderBy(
        asc(query.userId),
        asc(query.breakdownKind),
        asc(query.breakdownProvider),
        asc(query.breakdownUsageKind),
      );
    signal.throwIfAborted();

    const totalsByUser = new Map<string, (typeof joinedRows)[number]>();
    const breakdownRows: UsageBreakdownSqlRow[] = [];
    for (const row of joinedRows) {
      // Each aggregate total repeats for its display groups; save it only once.
      if (!totalsByUser.has(row.userId)) {
        totalsByUser.set(row.userId, row);
      }
      if (row.breakdownKey === null) {
        continue;
      }
      if (
        row.breakdownKind === null ||
        row.breakdownUsageKind === null ||
        row.breakdownProvider === null ||
        row.breakdownCredits === null
      ) {
        throw new Error("member usage breakdown is incomplete");
      }
      breakdownRows.push({
        key: row.breakdownKey,
        kind: row.breakdownKind,
        usageKind: row.breakdownUsageKind,
        provider: row.breakdownProvider,
        credits: row.breakdownCredits,
      });
    }
    const rows = [...totalsByUser.values()];
    const breakdownByUser = buildUsageBreakdowns(breakdownRows);

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
