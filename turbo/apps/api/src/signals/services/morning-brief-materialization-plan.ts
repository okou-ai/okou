import { MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { isValidTimeZone } from "@okouai/core/timezone";
import { morningBriefNativeSchedules } from "@okouai/db/schema/morning-brief-native-schedule";
import {
  workflowAutomations,
  workflows,
  workflowUserAutomationThreads,
} from "@okouai/db/schema/workflow";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { pgTimestampWithoutTimezoneToDateSchema } from "../../lib/db-raw-rows";
import type { MorningBriefMemberIdentity } from "./morning-brief-enrollment-data.service";
import { morningBriefSelectedWorkflowSql } from "./morning-brief-preference-sql";
import { calculateNextRun } from "./time-automation";

export const morningBriefMaterializationRow = z.object({
  workflowId: z.string(),
  agentId: z.string(),
  installationState: z.string().nullable(),
  automationId: z.string().nullable(),
  automationCount: z.number(),
  kind: z.string().nullable(),
  scheduleType: z.string().nullable(),
  blueprintKey: z.string().nullable(),
  reconciliationStatus: z.string().nullable(),
  resultEmailEnabled: z.boolean().nullable(),
  enabled: z.boolean().nullable(),
  cronExpression: z.string().nullable(),
  timezone: z.string().nullable(),
  nextRunAt: pgTimestampWithoutTimezoneToDateSchema.nullable(),
  chatThreadId: z.string().nullable(),
});

export function morningBriefMaterializationSql(
  owner: MorningBriefMemberIdentity,
) {
  return sql`WITH selected AS (${morningBriefSelectedWorkflowSql(owner)})
    SELECT ${workflows.id} AS "workflowId", ${workflows.agentId} AS "agentId",
      ${workflows.officialInstallationState} AS "installationState",
      ${workflowAutomations.id} AS "automationId", count(${workflowAutomations.id}) OVER ()::int AS "automationCount",
      ${workflowAutomations.kind} AS kind, ${workflowAutomations.scheduleType} AS "scheduleType",
      ${workflowAutomations.officialBlueprintKey} AS "blueprintKey",
      ${workflowAutomations.officialReconciliationStatus} AS "reconciliationStatus",
      ${workflowAutomations.officialResultEmailEnabled} AS "resultEmailEnabled",
      ${workflowAutomations.enabled} AS enabled, ${workflowAutomations.cronExpression} AS "cronExpression",
      ${workflowAutomations.timezone} AS timezone, ${workflowAutomations.nextRunAt}::text AS "nextRunAt",
      ${workflowUserAutomationThreads.chatThreadId} AS "chatThreadId"
    FROM selected JOIN ${workflows} ON ${workflows.id} = selected."workflowId"
    LEFT JOIN ${workflowAutomations} ON ${workflowAutomations.workflowId} = ${workflows.id}
      AND ${workflowAutomations.orgId} = ${owner.orgId} AND ${workflowAutomations.ownerUserId} = ${owner.userId}
    LEFT JOIN ${workflowUserAutomationThreads} ON ${workflowUserAutomationThreads.workflowId} = ${workflows.id}
      AND ${workflowUserAutomationThreads.orgId} = ${owner.orgId} AND ${workflowUserAutomationThreads.userId} = ${owner.userId}
    LIMIT 1`;
}

export function morningBriefMaterializationValues(args: {
  readonly owner: MorningBriefMemberIdentity;
  readonly membershipId: string;
  readonly observed: z.infer<typeof morningBriefMaterializationRow> | undefined;
  readonly existing:
    | typeof morningBriefNativeSchedules.$inferSelect
    | undefined;
  readonly at: Date;
}): typeof morningBriefNativeSchedules.$inferInsert | undefined {
  const row = args.observed;
  if (
    !row ||
    row.installationState !== "installed" ||
    row.automationCount !== 1 ||
    row.automationId === null ||
    row.kind !== "schedule" ||
    row.scheduleType !== "cron" ||
    row.blueprintKey !== MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY ||
    row.reconciliationStatus !== "current" ||
    row.resultEmailEnabled !== true ||
    row.enabled === null ||
    row.timezone === null ||
    !isValidTimeZone(row.timezone)
  ) {
    return undefined;
  }
  const nextRunAt = !row.enabled
    ? null
    : args.existing === undefined
      ? row.nextRunAt
      : row.cronExpression === null
        ? null
        : calculateNextRun(row.cronExpression, row.timezone, args.at);
  return {
    ...args.owner,
    membershipId: args.membershipId,
    enabled: row.enabled,
    cronExpression: row.cronExpression,
    timezone: row.timezone,
    nextRunAt,
    scheduleOwner: nextRunAt === null ? null : "legacy",
    phase: "legacy",
    target: "legacy",
    ownerEpoch: args.existing === undefined ? 1 : args.existing.ownerEpoch + 1,
    agentId: row.agentId,
    chatThreadId: row.chatThreadId,
    legacyWorkflowId: row.workflowId,
    legacyAutomationId: row.automationId,
    materializedAt: args.at,
    updatedAt: args.at,
    drainingEpoch: null,
    drainDeadlineAt: null,
    drainUnresolvedReason: null,
  };
}
