import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { feedItems } from "@okouai/db/schema/feed-item";
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { PreparedAutomationDisabledFeedEvent } from "./automation-disabled-feed-event.service";

/** Physical columns shared by UPDATE RETURNING and the feed event's CTE source. */
export function automationDisableTransitionColumns() {
  return {
    id: workflowAutomations.id,
    orgId: workflowAutomations.orgId,
    ownerUserId: workflowAutomations.ownerUserId,
    workflowId: workflowAutomations.workflowId,
    kind: workflowAutomations.kind,
    scheduleType: workflowAutomations.scheduleType,
    enabled: workflowAutomations.enabled,
    consecutiveFailures: workflowAutomations.consecutiveFailures,
    nextRunAt: workflowAutomations.nextRunAt,
  };
}

/** Only the owning enabled-row failure UPDATE RETURNING may publish an event. */
export function automationDisabledFeedEventInsertSql(
  event: PreparedAutomationDisabledFeedEvent | null,
  source: SQLWrapper,
  admitted: SQL = sql`true`,
): SQL {
  if (event === null) {
    return sql`SELECT ${feedItems.id} FROM ${feedItems} WHERE false`;
  }
  return sql`INSERT INTO ${feedItems}
      (org_id, user_id, id, type, source_type, content, state, created_at, updated_at)
    SELECT feed_transition.org_id, feed_transition.owner_user_id,
      ${event.id}::uuid, 'event', 'platform-event',
      jsonb_build_object(
        'eventType', 'automation-disabled',
        'automationId', feed_transition.id,
        'workflowId', feed_transition.workflow_id,
        'workspaceId', feed_transition.org_id,
        'automationName', ${event.automationName}::text,
        'disabledAt', ${event.disabledAt}::text,
        'consecutiveFailures', feed_transition.consecutive_failures,
        'recoveryScheduled', feed_transition.next_run_at IS NOT NULL
      ),
      jsonb_build_object('status', 'active'),
      ${event.disabledAt}::timestamptz, ${event.disabledAt}::timestamptz
    FROM ${source} AS feed_transition
    WHERE feed_transition.id = ${event.automationId}::uuid
      AND feed_transition.org_id = ${event.orgId}
      AND feed_transition.owner_user_id = ${event.userId}
      AND feed_transition.workflow_id = ${event.workflowId}::uuid
      AND feed_transition.kind = 'schedule'
      AND feed_transition.schedule_type IN ('cron', 'loop')
      AND feed_transition.enabled = false
      AND feed_transition.consecutive_failures > 0
      AND ${admitted}
    ON CONFLICT (org_id, user_id, id) DO NOTHING
    RETURNING id`;
}
