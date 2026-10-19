import { createHash } from "node:crypto";
import { command } from "ccstate";
import { and, asc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  PROACTIVE_SUGGESTIONS_BLUEPRINT_KEY,
  PROACTIVE_SUGGESTIONS_DEFINITION_NAME,
} from "@okouai/api-contracts/contracts/proactive-suggestions";
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
  loadProactiveSuggestionsEligibility$,
  type ProactiveSuggestionsOwner,
} from "./proactive-suggestions-eligibility.service";
import {
  readAcceptedOfficialWorkflowCatalog$,
  readAcceptedOfficialWorkflowRevision$,
} from "./official-workflow-catalog-read.service";
import { resolveBlueprint } from "./official-workflow-installation.service";
import { calculateNextRun } from "./time-automation";

const log = logger("ProactiveSuggestions");
const installedSchema = z.object({ id: z.uuid() });

function ownerMinute(owner: ProactiveSuggestionsOwner): number {
  return (
    Number.parseInt(
      createHash("sha256")
        .update(`${owner.orgId}/${owner.userId}`)
        .digest("hex")
        .slice(0, 8),
      16,
    ) % 60
  );
}

/** The source preference is business intent, never a worker claim or lease. */
function proactiveSuggestionsOwnerEnabledSql(
  owner: ProactiveSuggestionsOwner,
  agentId: string,
) {
  return sql`EXISTS (
    SELECT 1 FROM org_members_metadata AS preference
    JOIN org_metadata AS organization ON organization.org_id = preference.org_id
    JOIN agents AS primary_agent ON primary_agent.id = organization.default_agent_id AND primary_agent.org_id = organization.org_id
    WHERE preference.org_id = ${owner.orgId} AND preference.user_id = ${owner.userId}
      AND preference.proactive_suggestions_enabled = true
      AND primary_agent.id = ${agentId}::uuid
      AND (primary_agent.visibility = 'public' OR primary_agent.owner = ${owner.userId})
  )`;
}

const loadProactiveSuggestionsSchedule$ = command(
  async ({ set }, owner: ProactiveSuggestionsOwner, signal: AbortSignal) => {
    const catalog = await set(readAcceptedOfficialWorkflowCatalog$, signal);
    const definition = catalog?.payload.definitions.find((item) => {
      return item.name === PROACTIVE_SUGGESTIONS_DEFINITION_NAME;
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
      throw new Error("Accepted Proactive Suggestions revision is missing");
    }
    const blueprint = revision.definition.blueprints.find((item) => {
      return item.key === PROACTIVE_SUGGESTIONS_BLUEPRINT_KEY;
    });
    if (!blueprint) {
      throw new Error("Proactive Suggestions hourly Blueprint is missing");
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
        "Proactive Suggestions requires its hourly cron Blueprint",
      );
    }
    const cron = resolved.blueprint.createRequest.schedule.cronExpression;
    return { catalog, definition, blueprint, bindings, cron };
  },
);

/** Materialize this fixed Official schedule atomically, without legacy installer transactions. */
export const ensureProactiveSuggestionsWorkflow$ = command(
  async (
    { get, set },
    owner: ProactiveSuggestionsOwner,
    retry: boolean,
    signal: AbortSignal,
  ) => {
    const eligibility = await set(
      loadProactiveSuggestionsEligibility$,
      owner,
      signal,
    );
    const member =
      eligibility.available &&
      eligibility.enabled &&
      eligibility.agentId !== null
        ? await loadCurrentMembershipId(get(clerk$), owner, signal)
        : null;
    const eligible =
      eligibility.available &&
      eligibility.enabled &&
      member !== null &&
      eligibility.agentId !== null;
    const database = set(writeDb$);
    const ownedWorkflows = database
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.orgId, owner.orgId),
          eq(workflows.ownerUserId, owner.userId),
          eq(
            workflows.officialDefinitionName,
            PROACTIVE_SUGGESTIONS_DEFINITION_NAME,
          ),
          eligible && eligibility.agentId !== null
            ? ne(workflows.agentId, eligibility.agentId)
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
    if (!eligible || eligibility.agentId === null) {
      return;
    }

    const schedule = await set(
      loadProactiveSuggestionsSchedule$,
      owner,
      signal,
    );
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
        WHERE ${proactiveSuggestionsOwnerEnabledSql(owner, eligibility.agentId)}
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
        ...(retry ? { consecutiveFailures: 0 } : {}),
        updatedAt: at,
      })
      .where(
        and(
          eq(workflowAutomations.workflowId, installed.id),
          eq(workflowAutomations.officialBlueprintKey, blueprint.key),
          retry
            ? eq(workflowAutomations.enabled, false)
            : eq(workflowAutomations.officialIntendedEnabled, false),
          proactiveSuggestionsOwnerEnabledSql(owner, eligibility.agentId),
        ),
      );
    signal.throwIfAborted();
  },
);

/** Each owner has one stable minute shard; keyset pages do not require a second progress store. */
export const reconcileProactiveSuggestions$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const minute = nowDate().getUTCMinutes();
    let cursor: ProactiveSuggestionsOwner | undefined;
    while (true) {
      const candidates = await get(db$)
        .select({
          orgId: orgMembersMetadata.orgId,
          userId: orgMembersMetadata.userId,
        })
        .from(orgMembersMetadata)
        .where(
          and(
            sql`(${orgMembersMetadata.proactiveSuggestionsEnabled} = true OR EXISTS (
              SELECT 1 FROM workflows AS proactive_workflow WHERE proactive_workflow.org_id = ${orgMembersMetadata.orgId}
                AND proactive_workflow.owner_user_id = ${orgMembersMetadata.userId}
                AND proactive_workflow.official_definition_name = ${PROACTIVE_SUGGESTIONS_DEFINITION_NAME}
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
          set(ensureProactiveSuggestionsWorkflow$, owner, false, signal),
          signal,
        );
        if (!result.ok) {
          log.error("Could not reconcile proactive suggestions", {
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
