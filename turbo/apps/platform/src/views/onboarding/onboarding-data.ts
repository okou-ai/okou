import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import {
  ONBOARDING_WORKFLOW_SPECS,
  type OnboardingWorkflowCategoryId,
  type OnboardingWorkflowId,
  type OnboardingWorkflowSpec,
} from "./onboarding-workflow-specs.ts";
import type { TFunction } from "i18next";
import type { OnboardingChoice } from "../../signals/onboarding/onboarding-state.ts";
import type { AssistantName } from "../../signals/branding.ts";

interface OnboardingMakeOption {
  readonly id: OnboardingChoice;
  readonly title: string;
  readonly description: string;
  readonly imageUrl: string | null;
}

const ONBOARDING_MAKE_OPTION_IDS = [
  "slack",
  "workflow",
  "presentation",
  "images",
  "website",
  "explore",
] as const satisfies readonly OnboardingChoice[];

const ONBOARDING_MAKE_OPTION_IMAGES: Readonly<
  Record<OnboardingChoice, string | null>
> = {
  slack: null,
  workflow:
    "https://static.okou.io/web/assets/onboarding/v2-choice-workflow-default_80x80.png",
  presentation:
    "https://static.okou.io/web/assets/onboarding/v2-choice-presentation_80x80.png",
  images:
    "https://static.okou.io/web/assets/onboarding/v2-choice-images_80x80.png",
  website:
    "https://static.okou.io/web/assets/onboarding/v2-choice-website_80x80.png",
  explore:
    "https://static.okou.io/web/assets/onboarding/v2-choice-explore_80x80.png",
};

export function onboardingMakeOptions(
  t: TFunction<"common">,
): readonly OnboardingMakeOption[] {
  return ONBOARDING_MAKE_OPTION_IDS.map((id) => {
    const imageUrl = ONBOARDING_MAKE_OPTION_IMAGES[id];
    return {
      id,
      title: t(($) => {
        return $.onboarding.make.options[id].title;
      }),
      description: t(($) => {
        return $.onboarding.make.options[id].description;
      }),
      imageUrl,
    };
  });
}

export interface OnboardingWorkflow {
  readonly id: OnboardingWorkflowId;
  readonly categoryId: OnboardingWorkflowCategoryId;
  readonly title: string;
  readonly description: string;
  readonly prompt: string;
  readonly connectorSlugs: readonly ConnectorSlug[];
  readonly requiredConnectorSlugs: readonly ConnectorSlug[];
  readonly scenario: string;
  readonly detailSteps: readonly { title: string; description: string }[];
}

export interface OnboardingWorkflowCategory {
  readonly id: OnboardingWorkflowCategoryId;
  readonly title: string;
  readonly description: string;
  readonly workflows: readonly OnboardingWorkflow[];
}

const WORKFLOW_CATEGORY_IDS = [
  "everyone",
  "engineering",
  "product",
  "data",
  "marketing",
  "sales",
  "support",
  "ceo",
  "operations",
] as const satisfies readonly OnboardingWorkflowCategoryId[];

const WORKFLOW_STEP_KEYS = ["one", "two", "three"] as const;

function workflowOptionalConnectorSlugs(
  spec: OnboardingWorkflowSpec,
): readonly ConnectorSlug[] {
  return spec.optionalConnectorSlugs ?? [];
}

function workflowPromptForAssistant(
  spec: OnboardingWorkflowSpec,
  title: string,
  assistantName: AssistantName,
): string {
  const optionalConnectorSlugs = workflowOptionalConnectorSlugs(spec);
  const connectorLine =
    spec.requiredConnectorSlugs.length === 0
      ? "No connectors are required. Use the built-in capabilities named in the template behavior."
      : optionalConnectorSlugs.length > 0
        ? `Connectors: ${spec.requiredConnectorSlugs.join(", ")} required; ${optionalConnectorSlugs.join(", ")} optional.`
        : `Connectors: ${spec.requiredConnectorSlugs.join(", ")} required.`;
  return [
    "# Workflow Template Context",
    "",
    `The user selected the built-in onboarding workflow template: ${title} (workflow-template:${spec.id}).`,
    `Use the workflow-setup skill to help the user create or remix a workflow for this ${assistantName} agent.`,
    "Do not execute an existing workflow. This template is only context for creating or updating a workflow.",
    "Save the reusable workflow draft as soon as the template behavior is clear. Do not wait for connector setup or automation details.",
    "Keep the draft without an automation until the user confirms any missing trigger and safety choices.",
    "",
    "Template behavior:",
    `- ${spec.prompt}`,
    "",
    connectorLine,
    "",
    "Create the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger, scope, destination, or safety detail. Do not inspect connector setup until a workflow or automation command reports that it is required.",
  ].join("\n");
}

function onboardingWorkflow(
  id: OnboardingWorkflowId,
  categoryId: OnboardingWorkflowCategoryId,
  t: TFunction<"common">,
  assistantName: AssistantName,
): OnboardingWorkflow {
  const spec = ONBOARDING_WORKFLOW_SPECS[categoryId].find((candidate) => {
    return candidate.id === id;
  });
  if (!spec) {
    throw new Error(`Missing onboarding workflow template: ${id}`);
  }
  const title = t(($) => {
    return $.onboarding.workflows[id].title;
  });
  const optionalConnectorSlugs = workflowOptionalConnectorSlugs(spec);
  return {
    id,
    categoryId,
    title,
    description: t(($) => {
      return $.onboarding.workflows[id].description;
    }),
    prompt: workflowPromptForAssistant(spec, title, assistantName),
    connectorSlugs: [...spec.requiredConnectorSlugs, ...optionalConnectorSlugs],
    requiredConnectorSlugs: spec.requiredConnectorSlugs,
    scenario: t(($) => {
      return $.onboarding.workflows[id].scenario;
    }),
    detailSteps: WORKFLOW_STEP_KEYS.map((stepKey) => {
      return {
        title: t(($) => {
          return $.onboarding.workflows[id].steps[stepKey].title;
        }),
        description: t(($) => {
          return $.onboarding.workflows[id].steps[stepKey].description;
        }),
      };
    }),
  };
}

export function onboardingWorkflowCategories(
  t: TFunction<"common">,
  assistantName: AssistantName,
): readonly OnboardingWorkflowCategory[] {
  return WORKFLOW_CATEGORY_IDS.map((id) => {
    return {
      id,
      title: t(($) => {
        return $.onboarding.categories[id].title;
      }),
      description: t(($) => {
        return $.onboarding.categories[id].description;
      }),
      workflows: ONBOARDING_WORKFLOW_SPECS[id].map((spec) => {
        return onboardingWorkflow(spec.id, id, t, assistantName);
      }),
    };
  });
}

export const CUSTOM_WORKFLOW_ID = "custom-workflow";

function onboardingWorkflowIdentity(workflowIdValue: string | null): {
  readonly id: OnboardingWorkflowId;
  readonly categoryId: OnboardingWorkflowCategoryId;
} | null {
  if (!workflowIdValue || workflowIdValue === CUSTOM_WORKFLOW_ID) {
    return null;
  }
  for (const categoryId of WORKFLOW_CATEGORY_IDS) {
    for (const spec of ONBOARDING_WORKFLOW_SPECS[categoryId]) {
      if (spec.id === workflowIdValue) {
        return { id: spec.id, categoryId };
      }
    }
  }
  return null;
}

/** The connectors a workflow asks for, required first, without its copy. */
export function onboardingWorkflowConnectorSlugs(
  workflowIdValue: string | null,
): readonly ConnectorSlug[] {
  const identity = onboardingWorkflowIdentity(workflowIdValue);
  const spec = identity
    ? ONBOARDING_WORKFLOW_SPECS[identity.categoryId].find((candidate) => {
        return candidate.id === identity.id;
      })
    : undefined;
  return spec
    ? [...spec.requiredConnectorSlugs, ...workflowOptionalConnectorSlugs(spec)]
    : [];
}

export function hasOnboardingWorkflow(workflowIdValue: string | null): boolean {
  return onboardingWorkflowIdentity(workflowIdValue) !== null;
}

export function findOnboardingWorkflow(
  workflowIdValue: string | null,
  t: TFunction<"common">,
  assistantName: AssistantName,
): OnboardingWorkflow | null {
  const identity = onboardingWorkflowIdentity(workflowIdValue);
  if (!identity) {
    return null;
  }
  return onboardingWorkflow(identity.id, identity.categoryId, t, assistantName);
}

export function buildWorkflowPrompt(
  workflow: OnboardingWorkflow,
  note: string,
): string {
  const trimmedNote = note.trim();
  if (!trimmedNote) {
    return workflow.prompt;
  }
  return `${workflow.prompt}\n\nAdditional context:\n${trimmedNote}`;
}

export function buildCustomWorkflowPrompt(
  note: string,
  assistantName: AssistantName,
): string {
  const trimmedNote = note.trim();
  if (!trimmedNote) {
    return "";
  }
  return trimmedNote.startsWith("@")
    ? trimmedNote
    : `@${assistantName} ${trimmedNote}`;
}
