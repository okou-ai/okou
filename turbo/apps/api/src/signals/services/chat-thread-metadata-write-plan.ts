import { randomUUID } from "node:crypto";
import type { ModelSettingsPatch } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import {
  chatThreadEvents,
  chatThreadEventSequences,
} from "@okouai/db/schema/chat-thread-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { sql, type SQL } from "drizzle-orm";

interface MetadataEventInput {
  readonly kind: "renamed" | "model_selection_updated" | "service_tier_updated";
  readonly eventId?: string;
  readonly title?: string | null;
  readonly modelSettingsPatch?: ModelSettingsPatch;
}

/** Merge ordinary preference data against the actual UPDATE target, not a pre-read map. */
export function metadataModelSettingsPatchSql(patch: ModelSettingsPatch): SQL {
  return sql`jsonb_set(
    ${chatThreads.modelSettings}, ARRAY[${patch.model}]::text[],
    COALESCE(${chatThreads.modelSettings} -> ${patch.model}, '{}'::jsonb)
      || jsonb_build_object('effort', ${patch.effort}::text), true
  )`;
}

const metadataResultSql = sql`SELECT
  id AS "threadId", agent_id AS "agentId", left(title, 500) AS title,
  COALESCE(length(title) > 500, false) AS "titleTruncated",
  selected_model AS "selectedModel", model_settings AS "modelSettings",
  codex_service_tier AS "codexServiceTier", updated_at::text AS "updatedAt"
FROM updated`;

/** One actual root UPDATE, one natural sequence reservation, ordered event rows. */
export function metadataCommitWithEventsSql(args: {
  readonly updated: SQL;
  readonly userId: string;
  readonly orgId: string;
  readonly events: readonly MetadataEventInput[];
}): SQL {
  if (args.events.length === 0) {
    return sql`WITH updated AS (${args.updated}) ${metadataResultSql}`;
  }
  const count = sql.param(
    args.events.length,
    chatThreadEventSequences.lastSeqId,
  );
  const eventValues = args.events.map((event, index) => {
    return sql`(
      ${sql.param(index + 1, chatThreadEventSequences.lastSeqId)}::bigint,
      ${event.eventId ?? randomUUID()}::uuid,
      ${event.kind}::chat_thread_event_kind,
      ${event.title ?? null}::text,
      ${event.modelSettingsPatch === undefined ? null : JSON.stringify(event.modelSettingsPatch)}::jsonb
    )`;
  });
  return sql`WITH updated AS (${args.updated}),
  reserved AS (
    INSERT INTO ${chatThreadEventSequences} (user_id, org_id, last_seq_id)
    SELECT ${args.userId}, ${args.orgId}, ${count} FROM updated
    ON CONFLICT (user_id, org_id) DO UPDATE
    SET last_seq_id = ${chatThreadEventSequences.lastSeqId} + EXCLUDED.last_seq_id
    RETURNING last_seq_id
  ), inserted AS (
    INSERT INTO ${chatThreadEvents} (
      id, user_id, org_id, seq_id, chat_thread_id, kind, agent_id,
      reassigned_agent_id, title, pin_order, muted, selected_model,
      model_settings, model_settings_patch, service_tier, computer_use_host_id,
      cloud_browser_enabled, created_at
    )
    SELECT event.id, ${args.userId}, ${args.orgId},
      reserved.last_seq_id - ${count} + event.ordinal,
      updated.id, event.kind, updated.agent_id,
      NULL, event.title, NULL, NULL,
      CASE WHEN event.kind = 'model_selection_updated' THEN updated.selected_model ELSE NULL END,
      NULL, event.model_settings_patch,
      CASE WHEN event.kind = 'service_tier_updated' AND updated.codex_service_tier = 'fast'
        THEN 'priority' ELSE NULL END,
      NULL, false, updated.updated_at
    FROM updated CROSS JOIN reserved CROSS JOIN (
      VALUES ${sql.join(eventValues, sql`, `)}
    ) AS event(ordinal, id, kind, title, model_settings_patch)
    ORDER BY event.ordinal
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  ) ${metadataResultSql}`;
}
