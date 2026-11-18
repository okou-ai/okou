import { backgroundJobs } from "@okouai/db/schema/background-job";
import { sql, type SQL } from "drizzle-orm";
import type {
  MarketingRewardLinkEvent,
  MarketingRewardInvitationEvent,
  MarketingRewardOAuthEvent,
  MarketingRewardSourceEvent,
} from "../../lib/marketing-reward-events";

export const MARKETING_REWARD_EVENT_JOB_KIND = "marketing-reward-source-event";
export const MARKETING_REWARD_EVENT_HANDLER_VERSION = 1;
export const MARKETING_REWARD_LINK_EVENT_HANDLER_VERSION = 2;
export const MARKETING_REWARD_INVITATION_EVENT_HANDLER_VERSION = 3;
export const MARKETING_REWARD_WORKFLOW_EVENT_HANDLER_VERSION = 4;
export const MARKETING_REWARD_CHECKIN_EVENT_HANDLER_VERSION = 5;
export const MARKETING_REWARD_INVITATION_AUTHORITY_HANDLER_VERSION = 6;

function sourceEventInsert(
  event: Pick<MarketingRewardSourceEvent, "id" | "orgId" | "userId">,
  handlerVersion: 1 | 2,
  input: SQL,
  acceptedConnection: SQL,
): SQL {
  // A DB-free INSERT...SELECT composes with source publication CTEs. The
  // existing job table retains the fact even when delivery is not configured.
  return sql`INSERT INTO ${backgroundJobs}
    (id, kind, handler_version, user_id, org_id, input, available_at, created_at, updated_at)
    SELECT ${event.id}::uuid, ${MARKETING_REWARD_EVENT_JOB_KIND}, ${handlerVersion},
      ${event.userId}, ${event.orgId},
      ${input},
      timezone('UTC', clock_timestamp()), timezone('UTC', clock_timestamp()), timezone('UTC', clock_timestamp())
    FROM (${acceptedConnection}) AS source_connection
    RETURNING ${backgroundJobs.id}`;
}

/** The owning OAuth statement supplies only its actually accepted account IDs. */
export function marketingRewardOAuthEventInsert(
  event: Omit<MarketingRewardOAuthEvent, "version" | "type" | "connectionId">,
  acceptedConnection: SQL,
): SQL {
  const input = { version: 1, type: "connector.oauth-authorized", ...event };
  return sourceEventInsert(
    event,
    MARKETING_REWARD_EVENT_HANDLER_VERSION,
    sql`${JSON.stringify(input)}::jsonb || jsonb_build_object('connectionId', source_connection.id::text)`,
    acceptedConnection,
  );
}

/** Version 2 is invisible to outgoing cron readers that only accept OAuth. */
export function marketingRewardLinkEventInsert(
  event: Omit<MarketingRewardLinkEvent, "version" | "linkId" | "workspaceId">,
  acceptedSource: SQL,
): SQL {
  const input = {
    version: 2,
    id: event.id,
    environment: event.environment,
    type: event.type,
    occurredAt: event.occurredAt,
    orgId: event.orgId,
    userId: event.userId,
  };
  const source =
    event.type === "imessage.identity-linked"
      ? sql`jsonb_build_object('linkId', source_connection.id::text)`
      : sql`jsonb_build_object('workspaceId', source_connection.id::text)`;
  return sourceEventInsert(
    event,
    MARKETING_REWARD_LINK_EVENT_HANDLER_VERSION,
    sql`${JSON.stringify(input)}::jsonb || ${source}`,
    acceptedSource,
  );
}

/** Copy attribution from the winning persisted transition, never caller fields. */
export function marketingRewardInvitationEventInsert(
  event: Pick<
    MarketingRewardInvitationEvent,
    "id" | "environment" | "type" | "occurredAt"
  >,
  acceptedSource: SQL,
): SQL {
  const input = {
    version: 3,
    id: event.id,
    environment: event.environment,
    type: event.type,
    occurredAt: event.occurredAt,
  };
  const invitee =
    event.type === "invitation.accepted"
      ? sql`jsonb_build_object('inviteeUserId', source_invitation.invitee_user_id)`
      : sql`'{}'::jsonb`;
  return sql`INSERT INTO ${backgroundJobs}
    (id, kind, handler_version, user_id, org_id, input, available_at, created_at, updated_at)
    SELECT ${event.id}::uuid, ${MARKETING_REWARD_EVENT_JOB_KIND}, ${MARKETING_REWARD_INVITATION_EVENT_HANDLER_VERSION},
      source_invitation.actor_user_id, source_invitation.org_id,
      ${JSON.stringify(input)}::jsonb || jsonb_build_object(
        'orgId', source_invitation.org_id, 'userId', source_invitation.actor_user_id,
        'claimId', source_invitation.id::text, 'sourceKey', source_invitation.source_key,
        'invitationId', source_invitation.invitation_id
      ) || ${invitee},
      timezone('UTC', clock_timestamp()), timezone('UTC', clock_timestamp()), timezone('UTC', clock_timestamp())
    FROM (${acceptedSource}) AS source_invitation
    RETURNING ${backgroundJobs.id}`;
}
