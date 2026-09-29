import { sql } from "drizzle-orm";
import type {
  MorningBriefLegacyLineage,
  MorningBriefNativeScheduleRow,
} from "./morning-brief-native-schedule.service";

export interface LegacyMorningBriefSettlement {
  readonly enabled: boolean;
  readonly cronExpression: string | null;
  readonly timezone: string;
  readonly nextRunAt: Date | null;
  readonly at: Date;
}

/** Final values of a legacy settlement, including explicit native revocation. */
export function settleLegacyMorningBriefSql(
  lineage: MorningBriefLegacyLineage,
  current: MorningBriefNativeScheduleRow,
  args: LegacyMorningBriefSettlement,
) {
  const revokes = args.enabled !== current.enabled;
  const nextRunAt = args.enabled ? args.nextRunAt : null;
  return sql`
    WITH updated AS (
      UPDATE morning_brief_native_schedules SET enabled = ${args.enabled},
        cron_expression = ${args.cronExpression}, timezone = ${args.timezone},
        owner_epoch = ${current.ownerEpoch + (revokes ? 1 : 0)},
        next_run_at = ${nextRunAt}, schedule_owner = ${nextRunAt === null ? null : "legacy"},
        updated_at = ${args.at}
      WHERE org_id = ${lineage.orgId} AND user_id = ${lineage.userId}
        AND owner_epoch = ${current.ownerEpoch} AND phase = 'legacy'
        AND legacy_workflow_id = ${lineage.workflowId}::uuid
        AND legacy_automation_id = ${lineage.automationId}::uuid
      RETURNING owner_epoch
    ), revoked AS (
      UPDATE morning_brief_native_occurrences SET state = 'settled', outcome = 'revoked',
        settled_at = ${args.at}, lease_token = NULL, lease_expires_at = NULL,
        deferred_until = NULL, delivery_pending = false, updated_at = ${args.at}
      WHERE ${revokes} AND org_id = ${lineage.orgId} AND user_id = ${lineage.userId}
        AND owner_epoch = ${current.ownerEpoch} AND settled_at IS NULL
        AND EXISTS (SELECT 1 FROM updated)
    ) SELECT 1 FROM updated
  `;
}
