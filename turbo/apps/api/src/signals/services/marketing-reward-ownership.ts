import { isNull, notInArray, or, sql, type SQLWrapper } from "drizzle-orm";
import { env } from "../../lib/env";

export type MarketingRewardWriter = "app" | "marketing";

/** Personal ownership is global to the original beneficiary, not the selected org/executor. */
export function getStartedRewardWriter(
  target: "user" | "org",
  id: string,
): MarketingRewardWriter {
  const routing = env("MARKETING_REWARDS_ROUTING");
  if (!routing || routing.mode === "app") {
    return "app";
  }
  if (routing.mode === "marketing") {
    return "marketing";
  }
  return (target === "user" ? routing.userIds : routing.orgIds).includes(id)
    ? "marketing"
    : "app";
}

/** Candidate filtering and publication use the same immutable instance policy. */
export function appOwnedRewardPredicate(
  target: "user" | "org",
  identity: SQLWrapper,
) {
  const routing = env("MARKETING_REWARDS_ROUTING");
  if (!routing || routing.mode === "app") {
    return sql`true`;
  }
  if (routing.mode === "marketing") {
    return sql`false`;
  }
  const ids = target === "user" ? routing.userIds : routing.orgIds;
  return ids.length === 0
    ? sql`true`
    : or(isNull(identity), notInArray(identity, ids));
}
