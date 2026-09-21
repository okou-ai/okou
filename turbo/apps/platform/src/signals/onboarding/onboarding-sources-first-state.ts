import { command, computed, state } from "ccstate";
import type { IndustryId } from "../../views/onboarding-sources-first/onboarding-sources-first-data.ts";

/**
 * Source-first onboarding draft. The connector step drives the live connector
 * catalog and the invite step records what the invitation API answered;
 * everything else is held here until the onboarding state endpoints land.
 *
 * One application start owns this draft, because a Store lives exactly that
 * long: switching Clerk session or organization replaces the document, so the
 * draft cannot reach another user or workspace. Re-entering the flow within
 * one start continues the same run and keeps its answers, which is also what
 * the back button relies on.
 */

export type SourcesFirstFlow = "owner" | "member";

export type SourcesFirstStep =
  | "sources"
  | "industry"
  | "team"
  | "experience"
  | "skills"
  | "slack"
  | "ready";

export type SlackSetupStatus = "disconnected" | "installed" | "connected";

export type SubscriptionProvider = "codex" | "claudeCode";

/** The other places a mention works, offered beside Slack on the same step. */
export type ChatChannelId = "telegram" | "imessage" | "teams";

/**
 * Where one address stands with the invitation API: in flight, accepted by the
 * API, or refused by it. Nothing but an API answer makes an address invited.
 */
export type SourcesFirstInviteStatus = "pending" | "invited" | "failed";

export interface SourcesFirstInvite {
  readonly email: string;
  readonly status: SourcesFirstInviteStatus;
  /** Why the invitation was refused, as the API put it; null otherwise. */
  readonly failure: string | null;
}

export interface SourcesFirstDraft {
  readonly industry: IndustryId | null;
  /** One entry per address this run tried, with what the API answered. */
  readonly invites: readonly SourcesFirstInvite[];
  /** Null until the step is answered, so nothing is pre-chosen for the user. */
  readonly experienced: boolean | null;
  readonly provider: SubscriptionProvider | null;
  readonly providerConnected: boolean;
  readonly importedWorkflowName: string | null;
  readonly slackStatus: SlackSetupStatus;
  readonly slackWorkspace: string;
  /** Channels picked beside Slack; each still waits for its own install. */
  readonly chatChannels: readonly ChatChannelId[];
  /** Edited copy of the matched starting prompt, kept across step changes. */
  readonly startingPromptDraft: string;
  /** `industry:source` the draft was generated from, so a later change re-seeds it. */
  readonly startingPromptKey: string;
}

function emptyDraft(): SourcesFirstDraft {
  return {
    industry: null,
    invites: [],
    experienced: null,
    provider: null,
    providerConnected: false,
    importedWorkflowName: null,
    slackStatus: "disconnected",
    slackWorkspace: "",
    chatChannels: [],
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

/**
 * One `onboarding-start` per application start, beside the draft it belongs
 * to: Back/Forward, a guard redirect and re-entering the flow all run a step
 * setup again, and Marketing counts runs of the flow rather than step views.
 */
const internalStartEventSent$ = state(false);

/** Claims this run's single `onboarding-start`; true only for the first caller. */
export const claimSourcesFirstStartEvent$ = command(({ get, set }): boolean => {
  if (get(internalStartEventSent$)) {
    return false;
  }
  set(internalStartEventSent$, true);
  return true;
});

/** Transient screen state: this flow has no React-local state by convention. */
interface SourcesFirstUi {
  readonly searchOpen: boolean;
  /** What the catalog search is filtered by, kept while its dialog is open. */
  readonly searchQuery: string;
  readonly inviteEmail: string;
  /** File name waiting for import confirmation, null when no file is chosen. */
  readonly pendingSkillName: string | null;
}

const internalUi$ = state<SourcesFirstUi>({
  searchOpen: false,
  searchQuery: "",
  inviteEmail: "",
  pendingSkillName: null,
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

const OWNER_BASE_STEPS = [
  "industry",
  "sources",
  "team",
  "experience",
] as const satisfies readonly SourcesFirstStep[];

const MEMBER_BASE_STEPS = [
  "industry",
  "sources",
  "experience",
] as const satisfies readonly SourcesFirstStep[];

/**
 * Step order for one run. Members skip invite and Slack; answering the AI
 * experience question with a plan adds the skills step before Slack.
 */
export function sourcesFirstSteps(
  flow: SourcesFirstFlow,
  experienced: boolean | null,
): readonly SourcesFirstStep[] {
  const base = flow === "owner" ? OWNER_BASE_STEPS : MEMBER_BASE_STEPS;
  const experiencedSteps: readonly SourcesFirstStep[] =
    experienced === true ? ["skills"] : [];
  const slackStep: readonly SourcesFirstStep[] =
    flow === "owner" ? ["slack"] : [];
  return [...base, ...experiencedSteps, ...slackStep, "ready"];
}

/** Progress markers: one per step of this run. */
export function sourcesFirstProgress(
  step: SourcesFirstStep,
  flow: SourcesFirstFlow,
  experienced: boolean | null,
): { readonly current: number; readonly total: number } {
  const steps = sourcesFirstSteps(flow, experienced);
  const index = steps.indexOf(step);
  return { current: (index === -1 ? 0 : index) + 1, total: steps.length };
}

/** The step before `step`, or null when it is the first one. */
export function previousSourcesFirstStep(
  step: SourcesFirstStep,
  flow: SourcesFirstFlow,
  experienced: boolean | null,
): SourcesFirstStep | null {
  const steps = sourcesFirstSteps(flow, experienced);
  const index = steps.indexOf(step);
  return index > 0 ? (steps[index - 1] ?? null) : null;
}

/** The step after `step`, or null when the flow is finished. */
export function nextSourcesFirstStep(
  step: SourcesFirstStep,
  flow: SourcesFirstFlow,
  experienced: boolean | null,
): SourcesFirstStep | null {
  const steps = sourcesFirstSteps(flow, experienced);
  const index = steps.indexOf(step);
  return index === -1 ? null : (steps[index + 1] ?? null);
}
