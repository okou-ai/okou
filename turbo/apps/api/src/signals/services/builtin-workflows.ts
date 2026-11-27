import { createHash } from "node:crypto";
import {
  officialWorkflowArchivedSnapshotSchema,
  type OfficialWorkflowArchivedSnapshot,
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
import {
  MORNING_BRIEF_INSTRUCTION,
  PROACTIVE_SUGGESTIONS_INSTRUCTION,
} from "./proactive-task-instructions";
import { PROACTIVE_LEARNING_INSTRUCTION } from "./proactive-nightly-instructions";

function scheduledWorkflow(args: {
  name: string;
  displayName: string;
  description: string;
  blueprintKey: string;
  fingerprint: string;
  prompt: string;
  contentBundle: ContentBundle;
}) {
  return {
    ...args,
    lifecycle: "retired" as const,
    revision: createHash("sha256").update(args.prompt).digest("hex"),
  };
}

// Fingerprints identify the deployed schedules. The CDN archives contain only SKILL.md frontmatter.
const LEGACY_BUILTIN_WORKFLOWS = Object.freeze([
  scheduledWorkflow({
    name: PROACTIVE_LEARNING_DEFINITION_NAME,
    displayName: "Proactive Learning",
    description:
      "Update your user profile overnight with your role, responsibilities, goals and working preferences.",
    blueprintKey: PROACTIVE_LEARNING_BLUEPRINT_KEY,
    fingerprint:
      "dfd58b0122a505440175639a7ab76871c3e8a4c7bfbe842753a7ded06bcc196d",
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
    fingerprint:
      "02cb482747ad41c9cbf4ccf05315dc1ee1e66d0f66c333c95c495832902fb052",
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
    fingerprint:
      "6cc0bf31fb219dc5fb3019832bc4ccbadac6f883f998c00e11c9a4ba62fbe8ba",
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
  return LEGACY_BUILTIN_WORKFLOWS.find((workflow) => {
    return workflow.name === canonicalName;
  });
}

/** Compatibility representation of the single built-in cron in API responses and installation records. */
export function builtinCronBindings(cronExpression: string) {
  return [{ key: "cron", value: cronExpression }];
}

/** Built-ins use deployed code. Historical installations own their last readable snapshot. */
export function installedOfficialWorkflow(source: {
  readonly officialDefinitionName: string | null;
  readonly archivedOfficialSnapshot: OfficialWorkflowArchivedSnapshot | null;
}) {
  const builtin =
    source.archivedOfficialSnapshot === null
      ? builtInWorkflow(source.officialDefinitionName)
      : undefined;
  if (builtin) {
    return {
      lifecycle: builtin.lifecycle,
      workflow: {
        displayName: builtin.displayName,
        description: builtin.description,
        instruction: "",
        files: [],
      },
      exportInstruction: builtin.prompt,
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
  const { workflow } = snapshot.revision.definition;
  return {
    lifecycle: snapshot.lifecycle,
    workflow,
    exportInstruction: workflow.instruction,
  };
}
