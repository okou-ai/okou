import { backgroundJobs } from "@okouai/db/schema/background-job";
import { sql, type SQL } from "drizzle-orm";
import type { MarketingRewardOAuthEvent } from "../../lib/marketing-reward-events";

export const MARKETING_REWARD_EVENT_JOB_KIND = "marketing-reward-source-event";
export const MARKETING_REWARD_EVENT_HANDLER_VERSION = 1;

/** The owning OAuth statement supplies only its actually accepted account IDs. */
export function marketingRewardOAuthEventInsert(
  event: Omit<MarketingRewardOAuthEvent, "version" | "type" | "connectionId">,
  acceptedConnection: SQL,
): SQL {
  const input = { version: 1, type: "connector.oauth-authorized", ...event };
  // A DB-free INSERT...SELECT composes with all OAuth publication CTEs. The
  // existing job table retains the fact even when delivery is not configured.
  return sql`INSERT INTO ${backgroundJobs}
    (id, kind, handler_version, user_id, org_id, input, available_at, created_at, updated_at)
    SELECT ${event.id}::uuid, ${MARKETING_REWARD_EVENT_JOB_KIND}, ${MARKETING_REWARD_EVENT_HANDLER_VERSION},
      ${event.userId}, ${event.orgId},
      ${JSON.stringify(input)}::jsonb || jsonb_build_object('connectionId', source_connection.id::text),
      timezone('UTC', clock_timestamp()), timezone('UTC', clock_timestamp()), timezone('UTC', clock_timestamp())
    FROM (${acceptedConnection}) AS source_connection
    RETURNING ${backgroundJobs.id}`;
}
