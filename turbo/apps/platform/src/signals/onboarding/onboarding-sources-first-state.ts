import { command, computed, state } from "ccstate";
import {
  onboardingIndustrySchema,
  onboardingSubscriptionProviderSchema,
} from "@okouai/api-contracts/validators/onboarding";
import type { OnboardingSubscriptionProvider } from "@okouai/api-contracts/contracts/onboarding";
import type { OnboardingIndustry } from "@okouai/core/onboarding-industry";
import {
  boolean,
  literal,
  number,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import {
  STARTING_PROMPT_MAX_LENGTH,
  startingPromptOutputSchema,
  editedStartingPromptOutput,
  withStartingPromptOutput,
  type OnboardingOutputFormat,
  type StartingPromptOutput,
} from "./onboarding-output-format.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import { ROUTES, type RoutePath } from "../route-paths.ts";
import { jsonParseOr, onRef } from "../utils.ts";

/**
 * Source-first onboarding draft. Unsaved answers survive a browser refresh in
 * local storage, scoped to the current user and organization. Connections and
 * invitations keep their own server-backed state; their transient UI status
 * belongs to this application start.
 */

export type SourcesFirstFlow = "owner" | "member";

const sourcesFirstStepSchema = zEnum([
  "sources",
  "industry",
  "team",
  "experience",
  "skills",
  "slack",
  "ready",
]);

export type SourcesFirstStep = zInfer<typeof sourcesFirstStepSchema>;

export const SOURCES_FIRST_STEP_ROUTES: Readonly<
  Record<SourcesFirstStep, RoutePath>
> = {
  industry: ROUTES.onboarding,
  sources: ROUTES.onboardingSources,
  team: ROUTES.onboardingTeam,
  experience: ROUTES.onboardingExperience,
  skills: ROUTES.onboardingSkills,
  slack: ROUTES.onboardingSlack,
  ready: ROUTES.onboardingReady,
};

export type SubscriptionProvider = OnboardingSubscriptionProvider;

/** The other places a mention works, offered beside Slack on the same step. */
export type ChatChannelId = "telegram" | "imessage" | "teams" | "discord";

/**
 * The invitation API result for an address. Request lifecycle belongs to
 * the command loadable; only an API answer makes an address invited.
 */
export type SourcesFirstInviteStatus = "invited" | "failed";

export interface SourcesFirstInvite {
  readonly email: string;
  readonly status: SourcesFirstInviteStatus;
  /** Why the invitation was refused, as the API put it; null otherwise. */
  readonly failure: string | null;
}

export interface SourcesFirstDraft {
  readonly industry: OnboardingIndustry | null;
  /** One entry per address this run tried, with what the API answered. */
  readonly invites: readonly SourcesFirstInvite[];
  /** Null until the step is answered, so nothing is pre-chosen for the user. */
  readonly experienced: boolean | null;
  /**
   * The plan the answer names. Whether it is connected is the account's
   * answer, read from `/api/me/3rd-party-subscriptions`, never held here.
   */
  readonly provider: SubscriptionProvider | null;
  /** Edited copy of the matched starting prompt, kept across step changes. */
  readonly startingPromptDraft: string;
  /** The displayed seed the edit belongs to; any non-empty key owns later text. */
  readonly startingPromptKey: string;
  /** The editable output paragraph inside startingPromptDraft, never a hidden instruction. */
  readonly startingPromptOutput: StartingPromptOutput | null;
  /** The durable context-generation job started when the source step continues. */
  readonly recommendationJobId: string | null;
  /** Client wall-clock time when that generation attempt began; identifies it. */
  readonly recommendationStartedAt: number | null;
}

function emptyDraft(): SourcesFirstDraft {
  return {
    industry: null,
    invites: [],
    experienced: null,
    provider: null,
    startingPromptDraft: "",
    startingPromptKey: "",
    startingPromptOutput: null,
    recommendationJobId: null,
    recommendationStartedAt: null,
  };
}

interface SourcesFirstDraftIdentity {
  readonly orgId: string;
  readonly userId: string;
}

const persistedDraftIdentitySchema = object({
  orgId: string().min(1),
  userId: string().min(1),
});

const persistedStepSchema = persistedDraftIdentitySchema.extend({
  step: sourcesFirstStepSchema,
});

const persistedDraftSchema = persistedDraftIdentitySchema.extend({
  version: literal(2),
  industry: onboardingIndustrySchema.nullable(),
  experienced: boolean().nullable(),
  provider: onboardingSubscriptionProviderSchema.nullable(),
  startingPromptDraft: string().max(STARTING_PROMPT_MAX_LENGTH),
  startingPromptKey: string(),
  // Selection metadata is optional in version-2 drafts; the complete prompt
  // remains authoritative when no format has been recorded.
  startingPromptOutput: startingPromptOutputSchema.nullable().default(null),
  recommendationJobId: uuid().nullable(),
  recommendationStartedAt: number().finite().nonnegative().nullable(),
});

type PersistedSourcesFirstDraft = zInfer<typeof persistedDraftSchema>;

function savedDraftForIdentity(
  raw: string | null,
  identity: SourcesFirstDraftIdentity,
): PersistedSourcesFirstDraft | null {
  if (raw === null) {
    return null;
  }
  const parsed = persistedDraftSchema.safeParse(
    jsonParseOr<unknown>(raw, null),
  );
  if (!parsed.success) {
    return null;
  }
  if (
    parsed.data.orgId !== identity.orgId ||
    parsed.data.userId !== identity.userId
  ) {
    return null;
  }
  return parsed.data;
}

function restoredDraft(
  saved: PersistedSourcesFirstDraft | null,
): SourcesFirstDraft {
  if (saved === null) {
    return emptyDraft();
  }
  return {
    ...emptyDraft(),
    industry: saved.industry,
    experienced: saved.experienced,
    provider: saved.provider,
    startingPromptDraft: saved.startingPromptDraft,
    startingPromptKey: saved.startingPromptKey,
    startingPromptOutput: saved.startingPromptOutput,
    recommendationJobId: saved.recommendationJobId,
    recommendationStartedAt: saved.recommendationStartedAt,
  };
}

const draftStorage = localStorageSignals("onboarding:sources-first-draft");
const stepStorage = localStorageSignals("onboarding:sources-first-step");
const onboardingStorages = [draftStorage, stepStorage] as const;
const internalDraftIdentity$ = state<SourcesFirstDraftIdentity | null>(null);
const internalDraft$ = state<SourcesFirstDraft>(emptyDraft());

/**
 * Restore answers and return the saved step once per identity/app lifetime.
 * Only the entry page resumes it; explicit step URLs and Back keep their target.
 */
export const restoreSourcesFirstDraft$ = command(
  (
    { get, set },
    identity: SourcesFirstDraftIdentity,
  ): SourcesFirstStep | null => {
    const active = get(internalDraftIdentity$);
    if (active?.orgId === identity.orgId && active.userId === identity.userId) {
      return null;
    }

    const saved = savedDraftForIdentity(get(draftStorage.get$), identity);
    set(internalDraftIdentity$, identity);
    set(internalDraft$, restoredDraft(saved));
    const step = persistedStepSchema.safeParse(
      jsonParseOr<unknown>(get(stepStorage.get$) ?? "null", null),
    );
    return step.success &&
      step.data.orgId === identity.orgId &&
      step.data.userId === identity.userId
      ? step.data.step
      : null;
  },
);

export const saveSourcesFirstStep$ = command(
  ({ get, set }, step: SourcesFirstStep): void => {
    const identity = get(internalDraftIdentity$);
    if (identity !== null) {
      set(stepStorage.set$, JSON.stringify({ ...identity, step }));
    }
  },
);

export const clearSourcesFirstDraft$ = command(({ get, set }): void => {
  const identity = get(internalDraftIdentity$);
  if (identity !== null) {
    for (const storage of onboardingStorages) {
      const raw = get(storage.get$);
      const parsed = persistedDraftIdentitySchema.safeParse(
        raw === null ? null : jsonParseOr<unknown>(raw, null),
      );
      if (
        parsed.success &&
        parsed.data.orgId === identity.orgId &&
        parsed.data.userId === identity.userId
      ) {
        set(storage.clear$);
      }
    }
  }
  set(internalDraftIdentity$, null);
  set(internalDraft$, emptyDraft());
});

/**
 * Owner runs the full flow; a member invited into an existing org runs the
 * same steps except the invite, which only an admin can send.
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
  readonly inviteEmail: string;
  /** The field was left since it last changed, so its address is final. */
  readonly inviteEmailLeft: boolean;
  readonly importPromptShown: boolean;
}

const internalUi$ = state<SourcesFirstUi>({
  inviteEmail: "",
  inviteEmailLeft: false,
  importPromptShown: false,
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
    { get, set },
    patch: Partial<{
      -readonly [Key in keyof SourcesFirstDraft]: SourcesFirstDraft[Key];
    }>,
  ) => {
    const next = { ...get(internalDraft$), ...patch };
    if (patch.startingPromptKey === "") {
      next.startingPromptOutput = null;
    }
    set(internalDraft$, next);
    const identity = get(internalDraftIdentity$);
    if (identity === null) {
      return;
    }
    set(
      draftStorage.set$,
      JSON.stringify({
        version: 2,
        ...identity,
        industry: next.industry,
        experienced: next.experienced,
        provider: next.provider,
        startingPromptDraft: next.startingPromptDraft,
        startingPromptKey: next.startingPromptKey,
        startingPromptOutput: next.startingPromptOutput,
        recommendationJobId: next.recommendationJobId,
        recommendationStartedAt: next.recommendationStartedAt,
      }),
    );
  },
);

const startingPromptInput$ = state<HTMLTextAreaElement | null>(null);

export const setStartingPromptInput$ = onRef(
  command(({ set }, element: HTMLTextAreaElement, signal: AbortSignal) => {
    set(startingPromptInput$, element);
    signal.addEventListener("abort", () => {
      set(startingPromptInput$, null);
    });
  }),
);

export const editStartingPrompt$ = command(
  ({ get, set }, previous: string, next: string, promptKey: string): void => {
    const draft = get(internalDraft$);
    set(updateSourcesFirstDraft$, {
      startingPromptKey: promptKey,
      startingPromptDraft: next,
      startingPromptOutput: editedStartingPromptOutput(
        previous,
        next,
        draft.startingPromptOutput,
      ),
    });
  },
);

export const selectStartingPromptOutput$ = command(
  (
    { get, set },
    text: string,
    promptKey: string,
    format: OnboardingOutputFormat | null,
    instruction: string,
  ): void => {
    const output = get(internalDraft$).startingPromptOutput;
    if (output?.format === format) {
      return;
    }
    const next = withStartingPromptOutput(text, output, instruction);
    // A format must never truncate the user's task or exceed the persisted limit.
    if (next.text.length > STARTING_PROMPT_MAX_LENGTH) {
      return;
    }
    set(updateSourcesFirstDraft$, {
      startingPromptKey: promptKey,
      startingPromptDraft: next.text,
      startingPromptOutput: format
        ? { format, start: next.start, end: next.end }
        : null,
    });
    // Keep editing at the visible prompt, including when Clear selection unmounts.
    get(startingPromptInput$)?.focus();
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
 * Step order for one run. Members skip the invite; answering the AI
 * experience question with a selected plan adds the skills step after it.
 * Everyone reaches Slack: a member who cannot add it is told to ask an admin
 * and can leave the step with Not now.
 */
export function sourcesFirstSteps(
  flow: SourcesFirstFlow,
  provider: SubscriptionProvider | null,
): readonly SourcesFirstStep[] {
  const base = flow === "owner" ? OWNER_BASE_STEPS : MEMBER_BASE_STEPS;
  const skillSteps: readonly SourcesFirstStep[] =
    provider === null ? [] : ["skills"];
  return [...base, ...skillSteps, "slack", "ready"];
}

/** Progress markers: one per step of this run. */
export function sourcesFirstProgress(
  step: SourcesFirstStep,
  flow: SourcesFirstFlow,
  provider: SubscriptionProvider | null,
): { readonly current: number; readonly total: number } {
  const steps = sourcesFirstSteps(flow, provider);
  const index = steps.indexOf(step);
  return { current: (index === -1 ? 0 : index) + 1, total: steps.length };
}

/** The step before `step`, or null when it is the first one. */
export function previousSourcesFirstStep(
  step: SourcesFirstStep,
  flow: SourcesFirstFlow,
  provider: SubscriptionProvider | null,
): SourcesFirstStep | null {
  const steps = sourcesFirstSteps(flow, provider);
  const index = steps.indexOf(step);
  return index > 0 ? (steps[index - 1] ?? null) : null;
}

/** The step after `step`, or null when the flow is finished. */
export function nextSourcesFirstStep(
  step: SourcesFirstStep,
  flow: SourcesFirstFlow,
  provider: SubscriptionProvider | null,
): SourcesFirstStep | null {
  const steps = sourcesFirstSteps(flow, provider);
  const index = steps.indexOf(step);
  return index === -1 ? null : (steps[index + 1] ?? null);
}
