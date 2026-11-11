import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { userNotifications } from "@okouai/db/schema/user-notification";
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { escapeText } from "entities";
import type { PreparedAutomationDisabledNotification } from "./automation-disabled-notification.service";

/** Physical columns shared by UPDATE RETURNING and the notification's CTE source. */
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

function escapeMarkdownText(value: string): string {
  return escapeText(value).replaceAll(
    /([\\`*_{}[\]()#+.!|~-])/g,
    String.raw`\$1`,
  );
}

/** The source must be an enabled-row failure UPDATE RETURNING, never a stored-row scan. */
export function automationDisabledNotificationInsertSql(
  notification: PreparedAutomationDisabledNotification | null,
  source: SQLWrapper,
  admitted: SQL = sql`true`,
): SQL {
  if (notification === null) {
    return sql`SELECT ${userNotifications.id} FROM ${userNotifications} WHERE false`;
  }
  const name = escapeMarkdownText(notification.automationName);
  const title = "Scheduled automation automatically disabled";
  const summary = `“${notification.automationName}” was automatically disabled after consecutive execution failures.`;
  const introduction = `“${name}” was automatically disabled after `;
  // Keep Markdown state-neutral; readers localize impact from recoveryScheduled.
  const details = ` consecutive execution failures.\n\nReview the automation for its current status.\n\nDisabled at: ${notification.disabledAt}`;
  return sql`INSERT INTO ${userNotifications}
      (user_id, title, summary, payload, delivery_key)
    SELECT notification_transition.owner_user_id,
      ${title}, ${summary},
      jsonb_build_object(
        'type', 'rich_text',
        'markdown', ${introduction} || notification_transition.consecutive_failures::text || ${details},
        'automationDisabled', jsonb_build_object(
          'automationId', notification_transition.id,
          'workflowId', notification_transition.workflow_id,
          'workspaceId', notification_transition.org_id,
          'automationName', ${notification.automationName}::text,
          'disabledAt', ${notification.disabledAt}::text,
          'consecutiveFailures', notification_transition.consecutive_failures,
          'recoveryScheduled', notification_transition.next_run_at IS NOT NULL
        )
      ),
      ${notification.deliveryKey}
    FROM ${source} AS notification_transition
    WHERE notification_transition.id = ${notification.automationId}::uuid
      AND notification_transition.org_id = ${notification.orgId}
      AND notification_transition.owner_user_id = ${notification.userId}
      AND notification_transition.workflow_id = ${notification.workflowId}::uuid
      AND notification_transition.kind = 'schedule'
      AND notification_transition.schedule_type IN ('cron', 'loop')
      AND notification_transition.enabled = false
      AND notification_transition.consecutive_failures > 0
      AND ${admitted}
    ON CONFLICT (user_id, delivery_key) DO NOTHING
    RETURNING id`;
}
