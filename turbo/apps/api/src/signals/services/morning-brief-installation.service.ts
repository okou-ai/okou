import { randomUUID } from "node:crypto";
import { MORNING_BRIEF_OFFICIAL_DEFINITION_NAME } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { isValidTimeZone } from "@okouai/core/timezone";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { isUniqueViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { settle } from "../utils";
import { builtInWorkflow } from "./builtin-workflows";
import type { MorningBriefMemberIdentity } from "./morning-brief-enrollment-data.service";
import { morningBriefCronExpression } from "./official-workflow-owner-schedule";
import { calculateNextRun } from "./time-automation";

export const loadMorningBriefTimezone$ = command(
  async (
    { get },
    args: MorningBriefMemberIdentity,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = get(db$);
    const [row] = await db
      .select({ timezone: orgMembersMetadata.timezone })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, args.orgId),
          eq(orgMembersMetadata.userId, args.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    const timezone = row?.timezone;
    return timezone && isValidTimeZone(timezone) ? timezone : null;
  },
);

/** Claim the current opt-in and publish its schedule together. Delivery creates the actual chat thread. */
export const installMorningBrief$ = command(
  async ({ set }, owner: MorningBriefMemberIdentity, signal: AbortSignal) => {
    const timezone = await set(loadMorningBriefTimezone$, owner, signal);
    signal.throwIfAborted();
    if (timezone === null) {
      return false;
    }
    const name = MORNING_BRIEF_OFFICIAL_DEFINITION_NAME;
    const builtin = builtInWorkflow(name);
    if (!builtin) {
      throw new Error("Missing Morning Brief definition");
    }
    const { blueprint } = builtin;
    const workflowId = randomUUID();
    const at = nowDate();
    const cron = morningBriefCronExpression(owner);
    const nextRunAt = calculateNextRun(cron, timezone, at);
    const query = sql`
      WITH chosen AS (
        UPDATE morning_brief_enrollments AS e
        SET state = 'completed', workflow_id = ${workflowId}::uuid, last_error = NULL, updated_at = ${at}
        WHERE e.org_id = ${owner.orgId} AND e.user_id = ${owner.userId} AND e.state = 'pending'
          AND EXISTS (SELECT 1 FROM org_members_metadata m
            WHERE m.org_id = e.org_id AND m.user_id = e.user_id AND m.timezone = ${timezone})
        RETURNING e.workflow_id, e.org_id, e.user_id
      ), installed AS (
        INSERT INTO workflows (id, org_id, owner_user_id, name, visibility, official_definition_name,
          official_installation_state, created_by, updated_by, created_at, updated_at)
        SELECT workflow_id, org_id, user_id, ${name}, 'private', ${name}, 'installed', user_id, user_id, ${at}, ${at}
        FROM chosen RETURNING id, org_id, owner_user_id
      ), scheduled AS (
        INSERT INTO workflow_automations (org_id, workflow_id, owner_user_id, kind, schedule_type,
          cron_expression, timezone, enabled, next_run_at, official_blueprint_key, official_applied_fingerprint,
          official_reconciliation_status, official_parameter_bindings, official_intended_enabled, created_at, updated_at)
        SELECT org_id, id, owner_user_id, 'schedule', 'cron', ${cron}, ${timezone}, true, ${nextRunAt},
          ${blueprint.key}, ${blueprint.fingerprint}, 'current',
          jsonb_build_array(jsonb_build_object('key', 'cron', 'value', ${cron}::text)), true, ${at}, ${at}
        FROM installed
      )
      INSERT INTO workflow_user_automation_threads (org_id, user_id, workflow_id)
      SELECT org_id, owner_user_id, id FROM installed
    `;
    const installation = await settle(
      (async () => {
        const { rowCount } = await set(writeDb$).execute(query);
        return rowCount === 1;
      })(),
      signal,
    );
    if (!installation.ok) {
      // A concurrent or legacy installer already owns this member's slot. Its IDs win.
      if (
        isUniqueViolation(
          installation.error,
          "idx_workflows_official_owner_definition_unique",
        ) ||
        isUniqueViolation(
          installation.error,
          "idx_workflows_morning_brief_owner_unique",
        )
      ) {
        return false;
      }
      throw installation.error;
    }
    return installation.value;
  },
);
