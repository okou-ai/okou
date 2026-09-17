import { command, computed, state } from "ccstate";
import type { IndustryId } from "../../views/onboarding-sources-first/onboarding-sources-first-data.ts";

/**
 * Source-first onboarding draft. The screens are frontend-only for now: the
 * connector step drives the live connector catalog, everything else is held
 * here until the onboarding state endpoints land.
 */

export type SourcesFirstFlow = "owner" | "member";

export type SourcesFirstStep =
  | "sources"
  | "industry"
  | "team"
  | "experience"
  | "subscription"
  | "skills"
  | "slack";

export type SlackSetupStatus = "disconnected" | "installed" | "connected";

export type SubscriptionProvider = "codex" | "claudeCode";

export interface SourcesFirstDraft {
  readonly industry: IndustryId | null;
  readonly invites: readonly string[];
  readonly experienced: boolean;
  readonly provider: SubscriptionProvider;
  readonly providerConnected: boolean;
  readonly importedWorkflowName: string | null;
  readonly slackStatus: SlackSetupStatus;
  readonly slackWorkspace: string;
  /** Edited copy of the matched starting prompt, kept when the dialog closes. */
  readonly startingPromptDraft: string;
  /** `industry:source` the draft was generated from, so a later change re-seeds it. */
  readonly startingPromptKey: string;
}

function emptyDraft(): SourcesFirstDraft {
  return {
    industry: null,
    invites: [],
    experienced: false,
    provider: "codex",
    providerConnected: false,
    importedWorkflowName: null,
    slackStatus: "disconnected",
    slackWorkspace: "",
    startingPromptDraft: "",
    startingPromptKey: "",
  };
}

const internalDraft$ = state<SourcesFirstDraft>(emptyDraft());

/**
 * Owner runs the full flow; a member invited into an existing org skips the
 * invite and Slack steps, matching the admin-only rule the Get started quests
 * already use.
 */
const internalFlow$ = state<SourcesFirstFlow>("owner");

/** Transient screen state: this flow has no React-local state by convention. */
export interface SourcesFirstUi {
  readonly searchOpen: boolean;
  readonly inviteEmail: string;
  /** File name waiting for import confirmation, null when no file is chosen. */
  readonly pendingSkillName: string | null;
  readonly welcomeOpen: boolean;
}

const internalUi$ = state<SourcesFirstUi>({
  searchOpen: false,
  inviteEmail: "",
  pendingSkillName: null,
  welcomeOpen: false,
});

export const sourcesFirstUi$ = computed((get) => {
  return get(internalUi$);
});

export const updateSourcesFirstUi$ = command(
  ({ set }, patch: Partial<SourcesFirstUi>) => {
    set(internalUi$, (current) => {
      return { ...current, ...patch };
    });
  },
);

export const sourcesFirstFlow$ = computed((get) => {
  return get(internalFlow$);
});

export const setSourcesFirstFlow$ = command(
  ({ set }, flow: SourcesFirstFlow) => {
    set(internalFlow$, flow);
  },
);

export const sourcesFirstDraft$ = computed((get) => {
  return get(internalDraft$);
});

export const updateSourcesFirstDraft$ = command(
  (
    { set },
    patch: Partial<{
      -readonly [Key in keyof SourcesFirstDraft]: SourcesFirstDraft[Key];
    }>,
  ) => {
    set(internalDraft$, (current) => {
      return { ...current, ...patch };
    });
  },
);

export const resetSourcesFirstDraft$ = command(({ set }) => {
  set(internalDraft$, emptyDraft());
});

const OWNER_BASE_STEPS = [
  "sources",
  "industry",
  "team",
  "experience",
] as const satisfies readonly SourcesFirstStep[];

const MEMBER_BASE_STEPS = [
  "sources",
  "industry",
  "experience",
] as const satisfies readonly SourcesFirstStep[];

/**
 * Step order for one run. Members skip invite and Slack; the experienced branch
 * adds the subscription and skills steps before Slack.
 */
export function sourcesFirstSteps(
  flow: SourcesFirstFlow,
  experienced: boolean,
): readonly SourcesFirstStep[] {
  const base = flow === "owner" ? OWNER_BASE_STEPS : MEMBER_BASE_STEPS;
  const experiencedSteps: readonly SourcesFirstStep[] = experienced
    ? ["subscription", "skills"]
    : [];
  const slackStep: readonly SourcesFirstStep[] =
    flow === "owner" ? ["slack"] : [];
  return [...base, ...experiencedSteps, ...slackStep];
}

export function sourcesFirstStepIndex(
  step: SourcesFirstStep,
  flow: SourcesFirstFlow,
  experienced: boolean,
): number {
  const steps = sourcesFirstSteps(flow, experienced);
  const index = steps.indexOf(step);
  return index === -1 ? 0 : index;
}

/** The step before `step`, or null when it is the first one. */
export function previousSourcesFirstStep(
  step: SourcesFirstStep,
  flow: SourcesFirstFlow,
  experienced: boolean,
): SourcesFirstStep | null {
  const steps = sourcesFirstSteps(flow, experienced);
  const index = steps.indexOf(step);
  return index > 0 ? (steps[index - 1] ?? null) : null;
}

/** The step after `step`, or null when the flow is finished. */
export function nextSourcesFirstStep(
  step: SourcesFirstStep,
  flow: SourcesFirstFlow,
  experienced: boolean,
): SourcesFirstStep | null {
  const steps = sourcesFirstSteps(flow, experienced);
  const index = steps.indexOf(step);
  return index === -1 ? null : (steps[index + 1] ?? null);
}
