import { command } from "ccstate";
import { and, asc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
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
import { PROACTIVE_WORKFLOW_DEFINITIONS } from "./proactive-workflow-definitions";
import {
  readAcceptedOfficialWorkflowCatalog$,
  readAcceptedOfficialWorkflowRevision$,
} from "./official-workflow-catalog-read.service";
import { resolveBlueprint } from "./official-workflow-installation.service";
import { calculateNextRun } from "./time-automation";
import { officialScheduleOwnerHash } from "./official-workflow-owner-schedule";

const log = logger("ProactiveWorkflows");
const installedSchema = z.object({ id: z.uuid() });

function ownerMinute(owner: ProactiveWorkflowOwner): number {
  return officialScheduleOwnerHash(owner) % 60;
}

/** The source preference is business intent, never a worker claim or lease. */
export function proactiveWorkflowOwnerEnabledSql(
  owner: ProactiveWorkflowOwner,
  agentId: string,
  kind: ProactiveWorkflowKind,
  actionAvailable: boolean,
) {
  const preference =
    kind === "action"
      ? sql`preference.proactive_action_enabled = true`
      : sql`preference.proactive_suggestions_enabled = true
          AND (${!actionAvailable} OR preference.proactive_action_enabled IS DISTINCT FROM true)`;
  return sql`EXISTS (
    SELECT 1 FROM org_members_metadata AS preference
    JOIN org_metadata AS organization ON organization.org_id = preference.org_id
    JOIN agents AS primary_agent ON primary_agent.id = organization.default_agent_id AND primary_agent.org_id = organization.org_id
    WHERE preference.org_id = ${owner.orgId} AND preference.user_id = ${owner.userId}
      AND ${preference}
      AND primary_agent.id = ${agentId}::uuid
      AND (primary_agent.visibility = 'public' OR primary_agent.owner = ${owner.userId})
  )`;
}

const loadProactiveSchedule$ = command(
  async (
    { set },
    owner: ProactiveWorkflowOwner,
    kind: ProactiveWorkflowKind,
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
    const bindings = [{ key: "cron", value: `${ownerMinute(owner)} * * * *` }];
    const resolved = resolveBlueprint(
      blueprint,
      { blueprintKey: blueprint.key, bindings },
      "UTC",
    );
    if (
      !resolved.ok ||
      resolved.blueprint.createRequest.kind !== "schedule" ||
      resolved.blueprint.createRequest.schedule.type !== "cron"
    ) {
      throw new Error(
        "Proactive workflows require their hourly cron Blueprint",
      );
    }
    const cron = resolved.blueprint.createRequest.schedule.cronExpression;
    return { catalog, definition, blueprint, bindings, cron };
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
    const kind = eligibility.action.active
      ? "action"
      : eligibility.suggestions.active
        ? "suggestions"
        : null;
    const member =
      kind !== null && eligibility.agentId !== null
        ? await loadCurrentMembershipId(get(clerk$), owner, signal)
        : null;
    const eligible =
      kind !== null && member !== null && eligibility.agentId !== null;
    const database = set(writeDb$);
    const ownedWorkflows = database
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.orgId, owner.orgId),
          eq(workflows.ownerUserId, owner.userId),
          inArray(
            workflows.officialDefinitionName,
            Object.values(PROACTIVE_WORKFLOW_DEFINITIONS).map((item) => {
              return item.name;
            }),
          ),
          eligible && eligibility.agentId !== null && kind !== null
            ? or(
                ne(workflows.agentId, eligibility.agentId),
                ne(
                  workflows.officialDefinitionName,
                  PROACTIVE_WORKFLOW_DEFINITIONS[kind].name,
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
    if (!eligible || eligibility.agentId === null || kind === null) {
      return;
    }

    const schedule = await set(loadProactiveSchedule$, owner, kind, signal);
    if (!schedule) {
      return;
    }
    const { catalog, definition, blueprint, bindings, cron } = schedule;
    const at = nowDate();
    const next = calculateNextRun(cron, "UTC", at);
    const rows = parseRawRows(
      installedSchema,
      await database.execute(sql`
      WITH installed AS (
        INSERT INTO workflows (org_id, agent_id, owner_user_id, name, visibility, instruction, display_name, description,
          official_definition_name, official_installation_state, created_by, updated_by, created_at, updated_at)
        SELECT ${owner.orgId}, ${eligibility.agentId}::uuid, ${owner.userId}, ${definition.name}, 'private', NULL, NULL, NULL,
          ${definition.name}, 'installed', ${owner.userId}, ${owner.userId}, ${at}, ${at}
        WHERE ${proactiveWorkflowOwnerEnabledSql(owner, eligibility.agentId, kind, eligibility.action.available)}
          AND EXISTS (SELECT 1 FROM official_workflow_catalog_state WHERE accepted_release_id = ${catalog.releaseId})
        ON CONFLICT (org_id, agent_id, owner_user_id, official_definition_name) WHERE official_definition_name IS NOT NULL
        DO UPDATE SET updated_at = EXCLUDED.updated_at
        RETURNING id
      ), scheduled AS (
        INSERT INTO workflow_automations (org_id, workflow_id, owner_user_id, kind, schedule_type, cron_expression,
          timezone, enabled, next_run_at, official_blueprint_key, official_applied_fingerprint,
          official_reconciliation_status, official_parameter_bindings, official_intended_enabled)
        SELECT ${owner.orgId}, id, ${owner.userId}, 'schedule', 'cron', ${cron}, 'UTC', true, ${next},
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
      return;
    }
    await database
      .update(workflowAutomations)
      .set({
        enabled: true,
        officialIntendedEnabled: true,
        nextRunAt: next,
        updatedAt: at,
      })
      .where(
        and(
          eq(workflowAutomations.workflowId, installed.id),
          eq(workflowAutomations.officialBlueprintKey, blueprint.key),
          eq(workflowAutomations.officialIntendedEnabled, false),
          proactiveWorkflowOwnerEnabledSql(
            owner,
            eligibility.agentId,
            kind,
            eligibility.action.available,
          ),
        ),
      );
    signal.throwIfAborted();
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
            sql`(${orgMembersMetadata.proactiveSuggestionsEnabled} = true OR ${orgMembersMetadata.proactiveActionEnabled} = true OR EXISTS (
              SELECT 1 FROM workflows AS proactive_workflow WHERE proactive_workflow.org_id = ${orgMembersMetadata.orgId}
                AND proactive_workflow.owner_user_id = ${orgMembersMetadata.userId}
                AND proactive_workflow.official_definition_name IN (${PROACTIVE_WORKFLOW_DEFINITIONS.suggestions.name}, ${PROACTIVE_WORKFLOW_DEFINITIONS.action.name})
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
