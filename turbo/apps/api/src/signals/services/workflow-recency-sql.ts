import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { sql, type SQL } from "drizzle-orm";

/** Merge against the locked UPSERT target, never an application-read snapshot. */
function mergeRecentWorkflows(stored: SQL, accepted: SQL): SQL {
  return sql`(
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'workflowId', recent.workflow_id,
      'lastUsedAt', to_char(recent.last_used_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    ) ORDER BY recent.last_used_at DESC, recent.workflow_id), '[]'::jsonb)
    FROM (
      SELECT entry."workflowId" AS workflow_id,
        max(entry."lastUsedAt") AS last_used_at
      FROM jsonb_to_recordset(${stored} || ${accepted})
        AS entry("workflowId" uuid, "lastUsedAt" timestamptz)
      GROUP BY entry."workflowId"
      ORDER BY last_used_at DESC, workflow_id
      LIMIT 10
    ) AS recent
  )`;
}

/** Use the accepted normal-message input exposed by the inserted CTE. */
export function workflowRecencyFields(workflowIds: readonly string[]) {
  const ids = JSON.stringify(workflowIds);
  const accepted = sql`(
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'workflowId', workflow_id,
      'lastUsedAt', to_char(inserted.created_at,
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    )), '[]'::jsonb)
    FROM inserted CROSS JOIN jsonb_array_elements_text(${ids}::jsonb)
      AS accepted_workflow(workflow_id)
  )`;
  return {
    initial: mergeRecentWorkflows(sql`'[]'::jsonb`, accepted),
    merged: mergeRecentWorkflows(
      sql`${orgMembersMetadata.recentWorkflows}`,
      sql`EXCLUDED.recent_workflows`,
    ),
  };
}
