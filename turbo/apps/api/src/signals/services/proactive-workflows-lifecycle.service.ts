import { proactiveDispatchPhase$ } from "./proactive-dispatch-ownership.service";
import { setStandalonePreferences$ } from "./proactive-dispatch-state.service";
import { command } from "ccstate";
import {
  and,
  asc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  notExists,
  not,
  type SQL,
  or,
  sql,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import type { ProactiveWorkflowKind } from "@okouai/api-contracts/contracts/proactive";
import { isValidTimeZone } from "@okouai/core/timezone";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { workflows } from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { clerk$ } from "../external/clerk";
import { db$, writeDb$ } from "../external/db";
import { settle } from "../utils";
import { loadCurrentMembershipId } from "./morning-brief-membership.service";
import {
  loadProactivePreferences$,
  type ProactiveWorkflowOwner,
} from "./proactive-workflows-eligibility.service";
import {
  PROACTIVE_WORKFLOW_DEFINITIONS,
  RETIRED_PROACTIVE_DEFINITION_NAMES,
} from "./proactive-workflow-definitions";
import { calculateNextRun } from "./time-automation";
import { hourlySuggestionsCron } from "./official-workflow-owner-schedule";
import {
  inactiveProactiveAutomationCondition,
  proactiveWorkflowOwnerEnabledSql,
} from "./proactive-workflow-owner";
import { proactiveNightlyCron } from "./proactive-nightly-schedule";
import { builtInWorkflow, builtinCronBindings } from "./builtin-workflows";

const log = logger("ProactiveWorkflows");

function proactiveSchedule(
  owner: ProactiveWorkflowOwner,
  kind: ProactiveWorkflowKind,
  timezone: string,
) {
  const source = PROACTIVE_WORKFLOW_DEFINITIONS[kind];
  const builtin = builtInWorkflow(source.name);
  if (!builtin) {
    throw new Error(`Missing built-in Workflow: ${source.name}`);
  }
  if (!isValidTimeZone(timezone)) {
    throw new Error("Proactive schedules require a valid timezone");
  }
  const cron =
    kind === "learning"
      ? proactiveNightlyCron(owner)
      : hourlySuggestionsCron(owner);
  return { builtin, cron };
}

const synchronizeProactiveSchedule$ = command(
  async (
    { set },
    args: {
      readonly owner: ProactiveWorkflowOwner;
      readonly blueprintKey: string;
      readonly fingerprint: string;
      readonly kind: ProactiveWorkflowKind;
      readonly cron: string;
      readonly timezone: string;
      readonly nextRunAt: Date | null;
      readonly at: Date;
    },
    signal: AbortSignal,
  ) => {
    const database = set(writeDb$);
    const ownedWorkflow = database
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.orgId, args.owner.orgId),
          eq(workflows.ownerUserId, args.owner.userId),
          eq(
            workflows.officialDefinitionName,
            PROACTIVE_WORKFLOW_DEFINITIONS[args.kind].name,
          ),
        ),
      );
    const automation = workflowAutomations;
    const resume = sql`(${automation.officialIntendedEnabled} IS FALSE OR
      (NOT ${automation.enabled} AND ${automation.officialReconciliationStatus} <> 'current' AND ${automation.consecutiveFailures} < 3))`;
    const changedCadence = or(
      sql`${automation.timezone} IS DISTINCT FROM ${args.timezone}`,
      sql`${automation.cronExpression} IS DISTINCT FROM ${args.cron}`,
    );
    await database
      .update(automation)
      .set({
        cronExpression: args.cron,
        timezone: args.timezone,
        officialAppliedFingerprint: args.fingerprint,
        officialReconciliationStatus: "current",
        officialIntendedEnabled: true,
        enabled: sql`${automation.enabled} OR ${resume}`,
        // A disabled failure retry and an in-flight occurrence own their existing slot.
        nextRunAt: sql`CASE WHEN ${resume} OR (${changedCadence} AND ${automation.enabled} AND ${automation.nextRunAt} IS NOT NULL)
        THEN ${sql.param(args.nextRunAt, automation.nextRunAt)}::timestamp ELSE ${automation.nextRunAt} END`,
        updatedAt: args.at,
      })
      .where(
        and(
          inArray(automation.workflowId, ownedWorkflow),
          eq(automation.officialBlueprintKey, args.blueprintKey),
          eq(automation.kind, "schedule"),
          eq(automation.scheduleType, "cron"),
          proactiveWorkflowOwnerEnabledSql(
            args.owner,
            args.kind === "learning" ? args.timezone : undefined,
          ),
          or(
            eq(automation.officialIntendedEnabled, false),
            sql`${automation.officialReconciliationStatus} IS DISTINCT FROM 'current'`,
            sql`${automation.officialAppliedFingerprint} IS DISTINCT FROM ${args.fingerprint}`,
            changedCadence,
          ),
        ),
      );
    signal.throwIfAborted();
  },
);

/** Materialize this fixed Official schedule atomically, without legacy installer transactions. */
export const ensureProactiveWorkflows$ = command(
  async ({ get, set }, owner: ProactiveWorkflowOwner, signal: AbortSignal) => {
    const eligibility = await set(loadProactivePreferences$, owner, signal);
    if ((await set(proactiveDispatchPhase$, signal)) !== "automation") {
      await set(
        setStandalonePreferences$,
        {
          owner: owner,
          tasks: ["suggestions", "learning"],
          enabled: eligibility.suggestions,
          timezone: eligibility.timezone,
        },
        signal,
      );
      return;
    }
    const kinds = (
      Object.keys(PROACTIVE_WORKFLOW_DEFINITIONS) as ProactiveWorkflowKind[]
    ).filter((kind) => {
      return eligibility[kind];
    });
    const member =
      kinds.length > 0
        ? await loadCurrentMembershipId(get(clerk$), owner, signal)
        : null;
    const eligible = kinds.length > 0 && member !== null;
    const database = set(writeDb$);
    await database
      .update(workflowAutomations)
      .set({
        enabled: false,
        officialIntendedEnabled: false,
        nextRunAt: null,
        updatedAt: nowDate(),
      })
      .where(
        and(
          inactiveProactiveAutomationCondition(owner, eligible ? kinds : []),
          eligibility.suggestions
            ? proactiveWorkflowOwnerEnabledSql(owner, eligibility.timezone)
            : not(proactiveWorkflowOwnerEnabledSql(owner)),
        ),
      );
    signal.throwIfAborted();
    if (!eligible) {
      return;
    }
    for (const kind of kinds) {
      const timezone = kind === "learning" ? eligibility.timezone : "UTC";
      if (timezone === null) {
        continue;
      }
      const { builtin, cron } = proactiveSchedule(owner, kind, timezone);
      const at = nowDate();
      const next = calculateNextRun(cron, timezone, at);
      await database.execute(sql`
      WITH created AS (
        INSERT INTO workflows (org_id, owner_user_id, name, visibility, instruction, display_name, description,
          official_definition_name, created_by, updated_by, created_at, updated_at)
        SELECT ${owner.orgId}, ${owner.userId}, ${builtin.name}, 'private', NULL, NULL, NULL,
          ${builtin.name}, ${owner.userId}, ${owner.userId}, ${at}, ${at}
        WHERE ${proactiveWorkflowOwnerEnabledSql(owner, kind === "learning" ? timezone : undefined)}
        ON CONFLICT (org_id, owner_user_id, official_definition_name) WHERE official_definition_name IS NOT NULL
        DO NOTHING RETURNING id
      ), installed AS (
        SELECT id FROM created
        UNION ALL
        SELECT id FROM workflows
        WHERE org_id = ${owner.orgId} AND owner_user_id = ${owner.userId}
          AND official_definition_name = ${builtin.name}
          AND ${proactiveWorkflowOwnerEnabledSql(owner, kind === "learning" ? timezone : undefined)}
      )
      INSERT INTO workflow_automations (org_id, workflow_id, owner_user_id, kind, schedule_type, cron_expression, interval_seconds,
        timezone, enabled, next_run_at, official_blueprint_key, official_applied_fingerprint,
        official_reconciliation_status, official_parameter_bindings, official_intended_enabled)
      SELECT ${owner.orgId}, id, ${owner.userId}, 'schedule', 'cron', ${cron}, NULL, ${timezone}, true, ${next},
        ${builtin.blueprintKey}, ${builtin.fingerprint}, 'current', ${JSON.stringify(builtinCronBindings(cron))}::jsonb, true FROM installed
      ON CONFLICT (workflow_id, official_blueprint_key) WHERE official_blueprint_key IS NOT NULL DO NOTHING
    `);
      signal.throwIfAborted();
      await set(
        synchronizeProactiveSchedule$,
        {
          owner,
          blueprintKey: builtin.blueprintKey,
          fingerprint: builtin.fingerprint,
          kind,
          cron,
          timezone,
          nextRunAt: next,
          at,
        },
        signal,
      );
    }
  },
);

/** Repair persisted choices that an interrupted setup or preference update did not apply. */
function proactiveScheduleGaps(ownerHash: SQL) {
  const owned = and(
    eq(workflows.orgId, orgMembersMetadata.orgId),
    eq(workflows.ownerUserId, orgMembersMetadata.userId),
  );
  function schedules(condition: SQL | undefined) {
    return new QueryBuilder()
      .select({ id: workflowAutomations.id })
      .from(workflows)
      .innerJoin(
        workflowAutomations,
        eq(workflowAutomations.workflowId, workflows.id),
      )
      .where(and(owned, condition));
  }
  const suggestions = PROACTIVE_WORKFLOW_DEFINITIONS.suggestions;
  const learning = PROACTIVE_WORKFLOW_DEFINITIONS.learning;
  const enabled = eq(orgMembersMetadata.proactiveSuggestionsEnabled, true);
  const intended = eq(workflowAutomations.officialIntendedEnabled, true);
  function ready(
    kind: ProactiveWorkflowKind,
    cron: SQL,
    timezone: SQL | typeof orgMembersMetadata.timezone,
  ) {
    const definition = PROACTIVE_WORKFLOW_DEFINITIONS[kind];
    const builtin = builtInWorkflow(definition.name);
    if (!builtin) {
      throw new Error(`Missing built-in Workflow: ${definition.name}`);
    }
    return schedules(
      and(
        eq(workflows.officialDefinitionName, definition.name),
        eq(workflowAutomations.officialBlueprintKey, definition.blueprintKey),
        intended,
        eq(workflowAutomations.officialReconciliationStatus, "current"),
        eq(workflowAutomations.officialAppliedFingerprint, builtin.fingerprint),
        eq(workflowAutomations.cronExpression, cron),
        eq(workflowAutomations.timezone, timezone),
      ),
    );
  }
  return or(
    and(
      enabled,
      notExists(
        ready(
          "suggestions",
          sql`(${ownerHash} % 60)::text || ' * * * *'`,
          sql`'UTC'`,
        ),
      ),
    ),
    and(
      enabled,
      isNotNull(orgMembersMetadata.timezone),
      notExists(
        ready(
          "learning",
          sql`(${ownerHash} % 30)::text || ' 2 * * *'`,
          orgMembersMetadata.timezone,
        ),
      ),
    ),
    exists(
      schedules(
        and(
          or(intended, eq(workflowAutomations.enabled, true)),
          or(
            inArray(workflows.officialDefinitionName, [
              ...RETIRED_PROACTIVE_DEFINITION_NAMES,
            ]),
            and(
              sql`${orgMembersMetadata.proactiveSuggestionsEnabled} IS NOT TRUE`,
              inArray(workflows.officialDefinitionName, [
                learning.name,
                suggestions.name,
              ]),
            ),
            and(
              isNull(orgMembersMetadata.timezone),
              eq(workflows.officialDefinitionName, learning.name),
            ),
          ),
        ),
      ),
    ),
  );
}

export const reconcileProactiveWorkflows$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if ((await set(proactiveDispatchPhase$, signal)) !== "automation") {
      return;
    }
    const minute = nowDate().getUTCMinutes();
    const ownerHash = sql`('x' || substr(encode(sha256(convert_to(${orgMembersMetadata.orgId} || '/' || ${orgMembersMetadata.userId}, 'UTF8')), 'hex'), 1, 8))::bit(32)::bigint`;
    let cursor: ProactiveWorkflowOwner | undefined;
    while (true) {
      const candidates = await get(db$)
        .select({
          orgId: orgMembersMetadata.orgId,
          userId: orgMembersMetadata.userId,
        })
        .from(orgMembersMetadata)
        .where(
          and(
            sql`(${ownerHash} % 60) = ${minute}`,
            proactiveScheduleGaps(ownerHash),
            cursor
              ? or(
                  gt(orgMembersMetadata.orgId, cursor.orgId),
                  and(
                    eq(orgMembersMetadata.orgId, cursor.orgId),
                    gt(orgMembersMetadata.userId, cursor.userId),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(asc(orgMembersMetadata.orgId), asc(orgMembersMetadata.userId))
        .limit(100);
      signal.throwIfAborted();
      for (const owner of candidates) {
        const result = await settle(
          set(ensureProactiveWorkflows$, owner, signal),
          signal,
        );
        if (!result.ok) {
          log.error("Could not reconcile proactive workflows", {
            ...owner,
            error: result.error,
          });
        }
      }
      if (candidates.length < 100) {
        return;
      }
      cursor = candidates.at(-1);
    }
  },
);
