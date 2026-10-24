import { command } from "ccstate";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import type { ProactiveWorkflowKind } from "@okouai/api-contracts/contracts/proactive";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { workflows } from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { parseRawRows } from "../../lib/db-raw-rows";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { clerk$ } from "../external/clerk";
import { db$, writeDb$ } from "../external/db";
import { settle } from "../utils";
import { loadCurrentMembershipId } from "./morning-brief-membership.service";
import {
  loadProactiveWorkflowsEligibility$,
  type ProactiveWorkflowOwner,
} from "./proactive-workflows-eligibility.service";
import {
  PROACTIVE_WORKFLOW_DEFINITIONS,
  RETIRED_PROACTIVE_DEFINITION_NAME,
} from "./proactive-workflow-definitions";
import {
  readAcceptedOfficialWorkflowCatalog$,
  readAcceptedOfficialWorkflowRevision$,
} from "./official-workflow-catalog-read.service";
import { resolveBlueprint } from "./official-workflow-installation.service";
import { calculateNextRun } from "./time-automation";
import { officialScheduleOwnerHash } from "./official-workflow-owner-schedule";
import { proactiveWorkflowOwnerEnabledSql } from "./proactive-workflow-owner";
import { proactiveNightlyCron } from "./proactive-nightly-schedule";
import { userJobs } from "@okouai/db/schema/user-job";
import { runnableJobCondition } from "./user-jobs-query";
import { wakeProactiveJobs$ } from "./proactive-jobs-wake.service";
import { synchronizeOfficialWorkflowThread$ } from "./official-workflow-thread.service";

const log = logger("ProactiveWorkflows");
const installedSchema = z.object({ id: z.uuid() });

function ownerMinute(owner: ProactiveWorkflowOwner): number {
  return officialScheduleOwnerHash(owner) % 60;
}

const loadProactiveSchedule$ = command(
  async (
    { set },
    owner: ProactiveWorkflowOwner,
    kind: ProactiveWorkflowKind,
    timezone: string,
    signal: AbortSignal,
  ) => {
    const source = PROACTIVE_WORKFLOW_DEFINITIONS[kind];
    const catalog = await set(readAcceptedOfficialWorkflowCatalog$, signal);
    const definition = catalog?.payload.definitions.find((item) => {
      return item.name === source.name;
    });
    if (!catalog || !definition || definition.lifecycle !== "active") {
      return;
    }
    const revision = await set(
      readAcceptedOfficialWorkflowRevision$,
      { name: definition.name, revision: definition.revision },
      signal,
    );
    if (!revision) {
      throw new Error(
        `Accepted proactive workflow revision is missing: ${source.name}`,
      );
    }
    const blueprint = revision.definition.blueprints.find((item) => {
      return item.key === source.blueprintKey;
    });
    if (!blueprint) {
      throw new Error(
        `Proactive workflow hourly Blueprint is missing: ${source.name}`,
      );
    }
    const bindings =
      kind === "jobs"
        ? []
        : [
            {
              key: "cron",
              value:
                kind === "learning" || kind === "planning"
                  ? proactiveNightlyCron(kind, owner)
                  : `${ownerMinute(owner)} * * * *`,
            },
          ];
    const resolved = resolveBlueprint(
      blueprint,
      { blueprintKey: blueprint.key, bindings },
      timezone,
    );
    if (
      !resolved.ok ||
      resolved.blueprint.createRequest.kind !== "schedule" ||
      (resolved.blueprint.createRequest.schedule.type !== "cron" &&
        resolved.blueprint.createRequest.schedule.type !== "loop")
    ) {
      throw new Error("Proactive workflows require a cron or loop Blueprint");
    }
    const schedule = resolved.blueprint.createRequest.schedule;
    return { catalog, definition, blueprint, bindings, schedule };
  },
);

const disableInactiveProactiveWorkflows$ = command(
  async (
    { set },
    owner: ProactiveWorkflowOwner,
    context: {
      agentId: string | null;
      kinds: ProactiveWorkflowKind[];
      eligible: boolean;
    },
    signal: AbortSignal,
  ) => {
    const { agentId, kinds, eligible } = context;
    const database = set(writeDb$);
    const ownedWorkflows = database
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.orgId, owner.orgId),
          eq(workflows.ownerUserId, owner.userId),
          inArray(workflows.officialDefinitionName, [
            ...Object.values(PROACTIVE_WORKFLOW_DEFINITIONS).map((item) => {
              return item.name;
            }),
            RETIRED_PROACTIVE_DEFINITION_NAME,
          ]),
          eligible && agentId !== null
            ? or(
                ne(workflows.agentId, agentId),
                notInArray(
                  workflows.officialDefinitionName,
                  kinds.map((kind) => {
                    return PROACTIVE_WORKFLOW_DEFINITIONS[kind].name;
                  }),
                ),
              )
            : undefined,
        ),
      );
    await database
      .update(workflowAutomations)
      .set({
        enabled: false,
        nextRunAt: null,
        officialIntendedEnabled: false,
        updatedAt: nowDate(),
      })
      .where(
        and(
          inArray(workflowAutomations.workflowId, ownedWorkflows),
          or(
            eq(workflowAutomations.enabled, true),
            eq(workflowAutomations.officialIntendedEnabled, true),
          ),
        ),
      );
    signal.throwIfAborted();
  },
);

const synchronizeProactiveJobThreads$ = command(
  async ({ set }, owner: ProactiveWorkflowOwner, signal: AbortSignal) => {
    const database = set(writeDb$);
    const existing = await database
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.orgId, owner.orgId),
          eq(workflows.ownerUserId, owner.userId),
          inArray(workflows.officialDefinitionName, [
            RETIRED_PROACTIVE_DEFINITION_NAME,
            PROACTIVE_WORKFLOW_DEFINITIONS.jobs.name,
          ]),
        ),
      );
    signal.throwIfAborted();
    for (const workflow of existing) {
      await set(
        synchronizeOfficialWorkflowThread$,
        { ...owner, workflowId: workflow.id },
        signal,
      );
    }
  },
);

const synchronizeProactiveSchedule$ = command(
  async (
    { set },
    args: {
      readonly owner: ProactiveWorkflowOwner;
      readonly agentId: string;
      readonly workflowId: string;
      readonly blueprintKey: string;
      readonly kind: ProactiveWorkflowKind;
      readonly cron: string | null;
      readonly timezone: string;
      readonly nextRunAt: Date | null;
      readonly at: Date;
    },
    signal: AbortSignal,
  ) => {
    const database = set(writeDb$);
    await database
      .update(workflowAutomations)
      .set({
        enabled: true,
        officialIntendedEnabled: true,
        ...(args.kind === "jobs" ? { consecutiveFailures: 0 } : {}),
        nextRunAt: args.nextRunAt,
        updatedAt: args.at,
      })
      .where(
        and(
          eq(workflowAutomations.workflowId, args.workflowId),
          eq(workflowAutomations.officialBlueprintKey, args.blueprintKey),
          eq(workflowAutomations.officialIntendedEnabled, false),
          proactiveWorkflowOwnerEnabledSql(args.owner, args.agentId, args.kind),
        ),
      );
    signal.throwIfAborted();
    if (args.kind === "learning" || args.kind === "planning") {
      await database
        .update(workflowAutomations)
        .set({
          cronExpression: args.cron,
          timezone: args.timezone,
          nextRunAt: args.nextRunAt,
          updatedAt: args.at,
        })
        .where(
          and(
            eq(workflowAutomations.workflowId, args.workflowId),
            eq(workflowAutomations.officialBlueprintKey, args.blueprintKey),
            or(
              sql`${workflowAutomations.timezone} IS DISTINCT FROM ${args.timezone}`,
              sql`${workflowAutomations.cronExpression} IS DISTINCT FROM ${args.cron}`,
            ),
            proactiveWorkflowOwnerEnabledSql(
              args.owner,
              args.agentId,
              args.kind,
            ),
          ),
        );
      signal.throwIfAborted();
    }
  },
);

/** Materialize this fixed Official schedule atomically, without legacy installer transactions. */
export const ensureProactiveWorkflows$ = command(
  async ({ get, set }, owner: ProactiveWorkflowOwner, signal: AbortSignal) => {
    const eligibility = await set(
      loadProactiveWorkflowsEligibility$,
      owner,
      signal,
    );
    const kinds = (
      Object.keys(PROACTIVE_WORKFLOW_DEFINITIONS) as ProactiveWorkflowKind[]
    ).filter((kind) => {
      return eligibility[kind].active;
    });
    const member =
      kinds.length > 0 && eligibility.agentId !== null
        ? await loadCurrentMembershipId(get(clerk$), owner, signal)
        : null;
    const eligible =
      kinds.length > 0 && member !== null && eligibility.agentId !== null;
    await set(
      disableInactiveProactiveWorkflows$,
      owner,
      { agentId: eligibility.agentId, kinds, eligible },
      signal,
    );
    const database = set(writeDb$);
    if (eligibility.jobs.available) {
      await set(synchronizeProactiveJobThreads$, owner, signal);
    }
    if (!eligible || eligibility.agentId === null) {
      return;
    }
    for (const kind of kinds) {
      const timezone =
        kind === "learning" || kind === "planning"
          ? eligibility.timezone
          : "UTC";
      if (timezone === null) {
        continue;
      }
      const schedule = await set(
        loadProactiveSchedule$,
        owner,
        kind,
        timezone,
        signal,
      );
      if (!schedule) {
        continue;
      }
      const { catalog, definition, blueprint, bindings } = schedule;
      const cron =
        schedule.schedule.type === "cron"
          ? schedule.schedule.cronExpression
          : null;
      const interval =
        schedule.schedule.type === "loop"
          ? schedule.schedule.intervalSeconds
          : null;
      const at = nowDate();
      const next = cron === null ? null : calculateNextRun(cron, timezone, at);
      const rows = parseRawRows(
        installedSchema,
        await database.execute(sql`
      WITH installed AS (
        INSERT INTO workflows (org_id, agent_id, owner_user_id, name, visibility, instruction, display_name, description,
          official_definition_name, official_installation_state, created_by, updated_by, created_at, updated_at)
        SELECT ${owner.orgId}, ${eligibility.agentId}::uuid, ${owner.userId}, ${definition.name}, 'private', NULL, NULL, NULL,
          ${definition.name}, 'installed', ${owner.userId}, ${owner.userId}, ${at}, ${at}
        WHERE ${proactiveWorkflowOwnerEnabledSql(owner, eligibility.agentId, kind)}
          AND EXISTS (SELECT 1 FROM official_workflow_catalog_state WHERE accepted_release_id = ${catalog.releaseId})
        ON CONFLICT (org_id, agent_id, owner_user_id, official_definition_name) WHERE official_definition_name IS NOT NULL
        DO UPDATE SET updated_at = EXCLUDED.updated_at
        RETURNING id
      ), scheduled AS (
        INSERT INTO workflow_automations (org_id, workflow_id, owner_user_id, kind, schedule_type, cron_expression, interval_seconds,
          timezone, enabled, next_run_at, official_blueprint_key, official_applied_fingerprint,
          official_reconciliation_status, official_parameter_bindings, official_intended_enabled)
        SELECT ${owner.orgId}, id, ${owner.userId}, 'schedule', ${schedule.schedule.type}, ${cron}, ${interval}, ${timezone}, true, ${next},
          ${blueprint.key}, ${blueprint.fingerprint}, 'current', ${JSON.stringify(bindings)}::jsonb, true FROM installed
        ON CONFLICT (workflow_id, official_blueprint_key) WHERE official_blueprint_key IS NOT NULL DO NOTHING
        RETURNING id, workflow_id
      ), identified AS (
        INSERT INTO official_workflow_automation_identities (id, workflow_id, automation_id, blueprint_key, state)
        SELECT id, workflow_id, id, ${blueprint.key}, 'active' FROM scheduled
        RETURNING id
      ) SELECT id FROM installed
    `),
      );
      signal.throwIfAborted();
      const installed = rows[0];
      if (!installed) {
        continue;
      }
      await set(
        synchronizeProactiveSchedule$,
        {
          owner,
          agentId: eligibility.agentId,
          workflowId: installed.id,
          blueprintKey: blueprint.key,
          kind,
          cron,
          timezone,
          nextRunAt: next,
          at,
        },
        signal,
      );
      if (kind === "jobs") {
        await set(wakeProactiveJobs$, owner, signal);
      }
    }
  },
);

/** Each owner has one stable minute shard; keyset pages do not require a second progress store. */
export const reconcileProactiveWorkflows$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const minute = nowDate().getUTCMinutes();
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
            sql`(${orgMembersMetadata.proactiveSuggestionsEnabled} = true OR ${orgMembersMetadata.proactiveJobsEnabled} = true OR ${orgMembersMetadata.proactiveLearningEnabled} = true OR ${orgMembersMetadata.proactivePlanningEnabled} = true OR EXISTS (
              SELECT 1 FROM workflows AS proactive_workflow WHERE proactive_workflow.org_id = ${orgMembersMetadata.orgId}
                AND proactive_workflow.owner_user_id = ${orgMembersMetadata.userId}
                AND proactive_workflow.official_definition_name IN (${PROACTIVE_WORKFLOW_DEFINITIONS.suggestions.name}, ${RETIRED_PROACTIVE_DEFINITION_NAME}, ${PROACTIVE_WORKFLOW_DEFINITIONS.jobs.name}, ${PROACTIVE_WORKFLOW_DEFINITIONS.learning.name}, ${PROACTIVE_WORKFLOW_DEFINITIONS.planning.name})
            ))`,
            sql`(('x' || substr(encode(sha256(convert_to(${orgMembersMetadata.orgId} || '/' || ${orgMembersMetadata.userId}, 'UTF8')), 'hex'), 1, 8))::bit(32)::bigint % 60) = ${minute}`,
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

/** Runnable Job rows are the durable recovery source between hourly owner shards. */
export const reconcileRunnableProactiveJobs$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    let after: ProactiveWorkflowOwner | undefined;
    while (true) {
      const candidates = await get(db$)
        .selectDistinct({ orgId: userJobs.orgId, userId: userJobs.ownerUserId })
        .from(userJobs)
        .where(
          and(
            runnableJobCondition(),
            sql`EXISTS (SELECT 1 FROM org_members_metadata AS preference WHERE preference.org_id = ${userJobs.orgId} AND preference.user_id = ${userJobs.ownerUserId} AND preference.proactive_action_enabled = true)`,
            sql`NOT EXISTS (
              SELECT 1 FROM workflow_automations AS loop
              JOIN workflows AS installed ON installed.id = loop.workflow_id
              JOIN org_metadata AS organization ON organization.org_id = installed.org_id AND organization.default_agent_id = installed.agent_id
              WHERE installed.org_id = ${userJobs.orgId} AND installed.owner_user_id = ${userJobs.ownerUserId}
                AND installed.official_definition_name = ${PROACTIVE_WORKFLOW_DEFINITIONS.jobs.name}
                AND (loop.next_run_at IS NOT NULL OR loop.enabled = false OR loop.consecutive_failures >= 3
                  OR EXISTS (SELECT 1 FROM agent_runs AS running WHERE running.workflow_automation_id = loop.id AND running.status IN ('pending', 'running'))
                  OR EXISTS (SELECT 1 FROM chat_events AS pending JOIN chat_automation_context AS context ON context.id = pending.context_id WHERE context.automation_id = loop.id AND pending.run_id IS NULL AND pending.event_type = 'input.automation' AND NOT EXISTS (SELECT 1 FROM chat_events AS revoker WHERE revoker.revokes_event_id = pending.id))
                )
            )`,
            after
              ? or(
                  gt(userJobs.orgId, after.orgId),
                  and(
                    eq(userJobs.orgId, after.orgId),
                    gt(userJobs.ownerUserId, after.userId),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(asc(userJobs.orgId), asc(userJobs.ownerUserId))
        .limit(100);
      signal.throwIfAborted();
      for (const owner of candidates) {
        const result = await settle(
          set(ensureProactiveWorkflows$, owner, signal),
          signal,
        );
        if (!result.ok) {
          log.error("Could not reconcile runnable Jobs", {
            ...owner,
            error: result.error,
          });
        }
      }
      if (candidates.length < 100) {
        return;
      }
      after = candidates.at(-1);
    }
  },
);
