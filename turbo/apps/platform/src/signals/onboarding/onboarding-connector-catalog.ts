import { computed } from "ccstate";
import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import {
  ONBOARDING_WORKFLOW_SPECS,
  type OnboardingWorkflowSpec,
} from "../../views/onboarding/onboarding-workflow-specs.ts";
import {
  connectorCatalogBriefs,
  connectorCatalogItemsForSlugs,
} from "../external/connectors.ts";
import { searchParams$ } from "../route.ts";
import { onboardingDraft$ } from "./onboarding-state.ts";

const ONBOARDING_WORKFLOW_SPEC_LIST: readonly OnboardingWorkflowSpec[] =
  Object.values(ONBOARDING_WORKFLOW_SPECS).flat();

function workflowSpecConnectorSlugs(
  spec: OnboardingWorkflowSpec,
): readonly ConnectorSlug[] {
  return [
    ...spec.requiredConnectorSlugs,
    ...(spec.optionalConnectorSlugs ?? []),
  ];
}

/**
 * Icons for every connector the onboarding workflow catalog can draw, in one
 * brief request: the picker, its previews, and the run page's pills all draw
 * from this fixed set.
 */
export const onboardingWorkflowConnectorBriefs$ = connectorCatalogBriefs(
  ONBOARDING_WORKFLOW_SPEC_LIST.flatMap(workflowSpecConnectorSlugs),
);

// The draft changes on every keystroke of the workflow note; resolving the spec
// first keeps the slug list, and so its requests, stable until the chosen
// workflow itself changes.
const onboardingWorkflowRunSpec$ = computed(
  (get): OnboardingWorkflowSpec | null => {
    const { workflowId } = get(onboardingDraft$);
    return (
      ONBOARDING_WORKFLOW_SPEC_LIST.find((candidate) => {
        return candidate.id === workflowId;
      }) ?? null
    );
  },
);

const onboardingWorkflowRunConnectorSlugs$ = computed(
  (get): readonly ConnectorSlug[] => {
    const spec = get(onboardingWorkflowRunSpec$);
    return spec ? workflowSpecConnectorSlugs(spec) : [];
  },
);

/** Full catalog entries for the connectors the chosen workflow sets up. */
export const onboardingWorkflowRunConnectorItems$ =
  connectorCatalogItemsForSlugs(onboardingWorkflowRunConnectorSlugs$);

const onboardingPromptConnectorParam$ = computed((get): string => {
  return get(searchParams$).get("connector") ?? "";
});

const onboardingPromptConnectorSlugs$ = computed(
  (get): readonly ConnectorSlug[] => {
    return get(onboardingPromptConnectorParam$)
      .split(",")
      .flatMap((value) => {
        const parsed = connectorSlugSchema.safeParse(value.trim());
        return parsed.success ? [parsed.data] : [];
      });
  },
);

/** Full catalog entries for the connectors a make-page link asked for. */
export const onboardingPromptConnectorItems$ = connectorCatalogItemsForSlugs(
  onboardingPromptConnectorSlugs$,
);
