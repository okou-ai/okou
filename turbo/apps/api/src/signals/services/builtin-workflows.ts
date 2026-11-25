import { createHash } from "node:crypto";
import {
  officialWorkflowArchivedSnapshotSchema,
  type OfficialWorkflowArchivedSnapshot,
  type OfficialWorkflowAcceptedBlueprint,
  type OfficialWorkflowAcceptedRevision,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";
import type { ContentBundle } from "@okouai/api-contracts/contracts/content-bundle";
import {
  MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
  INTERNAL_TEST_MORNING_BRIEF_DEFINITION_NAME,
  MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import {
  PROACTIVE_SUGGESTIONS_DEFINITION_NAME,
  PROACTIVE_SUGGESTIONS_BLUEPRINT_KEY,
} from "@okouai/api-contracts/contracts/proactive-suggestions";
import {
  PROACTIVE_LEARNING_DEFINITION_NAME,
  PROACTIVE_LEARNING_BLUEPRINT_KEY,
} from "@okouai/api-contracts/contracts/proactive";
import { canonicalJsonString } from "../../lib/canonical-json";
import {
  MORNING_BRIEF_INSTRUCTION,
  PROACTIVE_SUGGESTIONS_INSTRUCTION,
} from "./builtin-workflow-instructions";
import { PROACTIVE_LEARNING_INSTRUCTION } from "./proactive-nightly-instructions";

function scheduledWorkflow(args: {
  name: string;
  displayName: string;
  description: string;
  blueprintKey: string;
  defaultCron: string;
  timezone?: string;
  prompt: string;
  contentBundle: ContentBundle;
}) {
  const { name, displayName, description, prompt, contentBundle } = args;
  const parameters: OfficialWorkflowAcceptedBlueprint["parameters"] = [
    {
      key: "cron",
      required: true,
      type: "string",
      format: "text",
      default: args.defaultCron,
    },
  ];
  const desiredState: OfficialWorkflowAcceptedBlueprint["desiredState"] = {
    kind: "schedule",
    schedule: {
      type: "cron",
      cronExpression: { parameter: "cron" },
      ...(args.timezone && { timezone: args.timezone }),
    },
  };
  // Keep the fingerprint already recorded on installed automations.
  const fingerprint = createHash("sha256")
    .update(canonicalJsonString({ parameters, desiredState }))
    .digest("hex");
  const blueprint = {
    key: args.blueprintKey,
    parameters,
    desiredState,
    fingerprint,
  };
  const revisionId = createHash("sha256").update(prompt).digest("hex");
  const definition = {
    name,
    lifecycle: "active" as const,
    revision: revisionId,
    contentBundle,
  };
  const revision: OfficialWorkflowAcceptedRevision = {
    definition: {
      schemaVersion: 3,
      name,
      revision: revisionId,
      workflow: { displayName, description, instruction: "", files: [] },
      blueprints: [blueprint],
    },
    contentBundle,
  };
  return { definition, revision, blueprint, prompt };
}

// These content-addressed CDN archives contain only SKILL.md frontmatter.
export const BUILTIN_WORKFLOWS = Object.freeze([
  scheduledWorkflow({
    name: PROACTIVE_LEARNING_DEFINITION_NAME,
    displayName: "Proactive Learning",
    description:
      "Update your user profile overnight with your role, responsibilities, goals and working preferences.",
    blueprintKey: PROACTIVE_LEARNING_BLUEPRINT_KEY,
    defaultCron: "0 2 * * *",
    prompt: PROACTIVE_LEARNING_INSTRUCTION,
    contentBundle: {
      sha256:
        "845eb3cb5bbe04aecd35614e0c544554dfcbed541271acf94e68f3eee7d3bcd8",
      archiveBytes: 206,
    },
  }),
  scheduledWorkflow({
    name: PROACTIVE_SUGGESTIONS_DEFINITION_NAME,
    displayName: "Proactive Suggestions",
    description:
      "Check connected sources hourly and maintain useful next steps on your home page.",
    blueprintKey: PROACTIVE_SUGGESTIONS_BLUEPRINT_KEY,
    defaultCron: "0 * * * *",
    timezone: "UTC",
    prompt: PROACTIVE_SUGGESTIONS_INSTRUCTION,
    contentBundle: {
      sha256:
        "db19039e23a28ec47daf232103bb0531839871fe81900b2201c7b6ad7ff1d935",
      archiveBytes: 189,
    },
  }),
  scheduledWorkflow({
    name: MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
    displayName: "Morning Brief",
    description:
      "Summarize today's email, GitHub, calendar, connected Slack activity from the past 24 hours, and recent Chat priorities.",
    blueprintKey: MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
    defaultCron: "0 7 * * *",
    prompt: MORNING_BRIEF_INSTRUCTION,
    contentBundle: {
      sha256:
        "3a0c19bdb76af11b8a0e7d6979b8fcb1d3c3c5798deb197d82d7926d3557e8b0",
      archiveBytes: 223,
    },
  }),
]);

export function builtInWorkflow(name: string | null) {
  // An existing legacy installation or queued event may still carry this name.
  const canonicalName =
    name === INTERNAL_TEST_MORNING_BRIEF_DEFINITION_NAME
      ? MORNING_BRIEF_OFFICIAL_DEFINITION_NAME
      : name;
  return BUILTIN_WORKFLOWS.find(({ definition }) => {
    return definition.name === canonicalName;
  });
}

export function builtInWorkflowBundleUrl(sha256: string) {
  return BUILTIN_WORKFLOWS.some(({ definition }) => {
    return definition.contentBundle.sha256 === sha256;
  })
    ? `https://static.vm0.io/workflows/builtin-skills/${sha256}.tar.gz`
    : undefined;
}

/** Built-ins use deployed code. Historical installations own their last readable snapshot. */
export function installedOfficialWorkflow(source: {
  readonly officialDefinitionName: string | null;
  readonly archivedOfficialSnapshot: OfficialWorkflowArchivedSnapshot | null;
}) {
  const builtin = builtInWorkflow(source.officialDefinitionName);
  if (builtin) {
    return {
      lifecycle: builtin.definition.lifecycle,
      revision: builtin.revision,
    };
  }
  if (source.archivedOfficialSnapshot === null) {
    return null;
  }
  const snapshot = officialWorkflowArchivedSnapshotSchema.parse(
    source.archivedOfficialSnapshot,
  );
  if (snapshot.revision.definition.name !== source.officialDefinitionName) {
    throw new Error(
      "Archived Official Workflow does not match its installation",
    );
  }
  return snapshot;
}
