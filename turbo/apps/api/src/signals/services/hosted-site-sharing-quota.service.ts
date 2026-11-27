import { createHash } from "node:crypto";
import { command } from "ccstate";
import { lt, lte, or, sql } from "drizzle-orm";
import { hostedSiteShareRateLimits } from "@okouai/db/schema/hosted-site-share-rate-limit";
import { nowDate, timestampWithoutTimeZone } from "../../lib/time";
import { writeDb$ } from "../external/db";

export type SharingQuotaRequest = {
  readonly userId: string;
  readonly orgId: string;
} & (
  | { readonly kind: "search" }
  | { readonly kind: "share"; readonly email: string }
  | { readonly kind: "user-share"; readonly recipientKey: string }
  | { readonly kind: "channel-share" }
  | { readonly kind: "channel-recipient"; readonly email: string }
);

interface Quota {
  readonly key: string;
  readonly limit: number;
  readonly windowMs: number;
}

function quota(
  identity: readonly string[],
  limit: number,
  windowMs: number,
): Quota {
  return {
    key: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
    limit,
    windowMs,
  };
}

function quotas(args: SharingQuotaRequest): readonly Quota[] {
  if (args.kind === "search") {
    return [
      quota(["search", "user", args.userId], 30, 60_000),
      quota(["search", "org", args.orgId], 120, 60_000),
    ];
  }
  const operation = quota(["share", "user", args.userId], 10, 60_000);
  if (args.kind === "channel-share") {
    return [operation];
  }
  if (args.kind === "user-share") {
    return [
      operation,
      quota(["share", "user-hour", args.userId], 60, 3_600_000),
      quota(["share", "org", args.orgId], 60, 3_600_000),
      quota(
        ["share", "recipient", args.orgId, args.recipientKey],
        3,
        3_600_000,
      ),
    ];
  }
  return [
    ...(args.kind === "share" ? [operation] : []),
    quota(["share", "user-hour", args.userId], 60, 3_600_000),
    quota(["share", "org", args.orgId], 60, 3_600_000),
    quota(["share", "recipient", args.orgId, args.email], 3, 3_600_000),
  ];
}

const consumeQuota$ = command(
  async ({ set }, policy: Quota, signal: AbortSignal) => {
    const database = set(writeDb$);
    const startedAt = nowDate();
    const expired = lte(
      hostedSiteShareRateLimits.windowStartedAt,
      new Date(startedAt.getTime() - policy.windowMs),
    );
    // The conditional upsert admits at most the quota even across API instances.
    const accepted = await database
      .insert(hostedSiteShareRateLimits)
      .values({ key: policy.key, windowStartedAt: startedAt, requests: 1 })
      .onConflictDoUpdate({
        target: hostedSiteShareRateLimits.key,
        set: {
          windowStartedAt: sql`CASE WHEN ${expired} THEN ${timestampWithoutTimeZone(startedAt)}::timestamp ELSE ${hostedSiteShareRateLimits.windowStartedAt} END`,
          requests: sql`CASE WHEN ${expired} THEN 1 ELSE ${hostedSiteShareRateLimits.requests} + 1 END`,
        },
        setWhere: or(
          expired,
          lt(hostedSiteShareRateLimits.requests, policy.limit),
        ),
      })
      .returning({ key: hostedSiteShareRateLimits.key });
    signal.throwIfAborted();
    return accepted.length > 0;
  },
);

/** Admission counts attempts before Clerk or email effects, not account existence. */
export const consumeHostedSiteSharingQuota$ = command(
  async ({ set }, args: SharingQuotaRequest, signal: AbortSignal) => {
    for (const policy of quotas(args)) {
      if (!(await set(consumeQuota$, policy, signal))) {
        return Math.ceil(policy.windowMs / 1000);
      }
    }
    return null;
  },
);
