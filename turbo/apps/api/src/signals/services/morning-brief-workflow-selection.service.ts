import {
  INTERNAL_TEST_MORNING_BRIEF_DEFINITION_NAME,
  MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
  MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
  isMorningBriefDefinitionName,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import { officialWorkflowCatalogState } from "@okouai/db/schema/official-workflow-catalog";
import { workflows } from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { command } from "ccstate";
import { and, eq, exists, isNotNull } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import {
  readAcceptedOfficialWorkflowCatalog$,
  readAcceptedOfficialWorkflowRevision$,
} from "./official-workflow-catalog-read.service";
import { observedWorkflowAutomationCondition } from "./workflow-automation-snapshot";
import type { AutomationRow } from "./workflow-automation-enqueue.service";
import {
  loadProactivePreferences$,
  type ProactiveWorkflowOwner,
} from "./proactive-workflows-eligibility.service";

// Temporary AgentSuggestion rollout (#39591). At GA, move the test instructions
// into morning-brief, converge installations back to that definition, retire
// internal-test-morning-brief, and remove these selection commands and callers.
export const selectedMorningBriefDefinition$ = command(
  async (
    { set },
    owner: ProactiveWorkflowOwner,
    signal: AbortSignal,
  ): Promise<string> => {
    const proactive = await set(loadProactivePreferences$, owner, signal);
    signal.throwIfAborted();
    return proactive.suggestions.active
      ? INTERNAL_TEST_MORNING_BRIEF_DEFINITION_NAME
      : MORNING_BRIEF_OFFICIAL_DEFINITION_NAME;
  },
);

/** Select before a schedule or Debug trigger; preserve installation and thread identities. */
export const selectDueMorningBriefWorkflow$ = command(
  async (
    { set },
    args: {
      readonly automation: AutomationRow;
      readonly workflowName: string;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly automation: AutomationRow;
    readonly workflowName: string;
  } | null> => {
    if (!isMorningBriefDefinitionName(args.workflowName)) {
      throw new Error(
        "Morning Brief selection requires an Official Morning Brief",
      );
    }
    const automation = args.automation;
    const name = await set(
      selectedMorningBriefDefinition$,
      {
        orgId: automation.orgId,
        userId: automation.ownerUserId,
      },
      signal,
    );
    if (name === args.workflowName) {
      return args;
    }
    const catalog = await set(readAcceptedOfficialWorkflowCatalog$, signal);
    const definition = catalog?.payload.definitions.find((entry) => {
      return entry.name === name;
    });
    if (!catalog || !definition || definition.lifecycle !== "active") {
      return null;
    }
    const revision = await set(
      readAcceptedOfficialWorkflowRevision$,
      {
        name,
        revision: definition.revision,
      },
      signal,
    );
    if (!revision) {
      throw new Error(`Accepted Morning Brief revision is missing: ${name}`);
    }
    const blueprint = revision.definition.blueprints.find((entry) => {
      return entry.key === MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY;
    });
    // The rollout changes the skill, never its schedule contract. A different
    // Blueprint requires ordinary reconciliation instead of rewriting settings.
    if (
      !blueprint ||
      blueprint.fingerprint !== automation.officialAppliedFingerprint
    ) {
      return null;
    }
    const db = set(writeDb$);
    const columns = workflowAutomationColumns();
    const source = db.$with("selected_morning_brief_source").as(
      db
        .update(workflowAutomations)
        .set({ updatedAt: nowDate() })
        .where(
          and(
            observedWorkflowAutomationCondition(automation),
            eq(workflowAutomations.enabled, true),
            isNotNull(workflowAutomations.nextRunAt),
            exists(
              db
                .select({ id: workflows.id })
                .from(workflows)
                .where(
                  and(
                    eq(workflows.id, automation.workflowId),
                    eq(workflows.orgId, automation.orgId),
                    eq(workflows.ownerUserId, automation.ownerUserId),
                    eq(workflows.officialDefinitionName, args.workflowName),
                    eq(workflows.officialInstallationState, "installed"),
                  ),
                ),
            ),
            exists(
              db
                .select({
                  releaseId: officialWorkflowCatalogState.acceptedReleaseId,
                })
                .from(officialWorkflowCatalogState)
                .where(
                  eq(
                    officialWorkflowCatalogState.acceptedReleaseId,
                    catalog.releaseId,
                  ),
                ),
            ),
          ),
        )
        .returning({
          ...columns,
          observedUpdatedAt: columns.observedUpdatedAt.as("observedUpdatedAt"),
          observedXmin: columns.observedXmin.as("observedXmin"),
        }),
    );
    const switched = db.$with("selected_morning_brief_workflow").as(
      db
        .update(workflows)
        .set({ name, officialDefinitionName: name, updatedAt: nowDate() })
        .from(source)
        .where(
          and(
            eq(workflows.id, source.workflowId),
            eq(workflows.officialDefinitionName, args.workflowName),
          ),
        )
        .returning({ id: workflows.id }),
    );
    // Both writes commit together. Queue admission consumes the returned source
    // observation, so a plan prepared before this definition change cannot win
    // after waiting on the same automation row. A claimed occurrence stays put.
    const [selected] = await db
      .with(source, switched)
      .select()
      .from(source)
      .where(exists(db.select({ id: switched.id }).from(switched)));
    signal.throwIfAborted();
    return selected ? { automation: selected, workflowName: name } : null;
  },
);
