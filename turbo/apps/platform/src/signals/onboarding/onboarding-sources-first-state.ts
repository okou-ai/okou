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
  persistedStartingPromptOutputSchema,
  type OnboardingOutputFormat,
  type StartingPromptOutput,
} from "./onboarding-output-format.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import { ROUTES, type RoutePath } from "../route-paths.ts";
import { jsonParseOr } from "../utils.ts";

/**
 * Source-first onboarding draft. Unsaved answers survive a browser refresh in
 * local storage, scoped to the current user and organization. Connections
 * keep their own server-backed state; their transient UI status
 * belongs to this application start.
 */

export type SourcesFirstFlow = "owner" | "member";

const sourcesFirstStepSchema = zEnum([
  "sources",
  "industry",
  "experience",
  "skills",
  "slack",
  "capabilities",
  "ready",
]);

export type SourcesFirstStep = zInfer<typeof sourcesFirstStepSchema>;

export const SOURCES_FIRST_STEP_ROUTES: Readonly<
  Record<SourcesFirstStep, RoutePath>
> = {
  industry: ROUTES.onboarding,
  sources: ROUTES.onboardingSources,
  capabilities: ROUTES.onboardingCapabilities,
  experience: ROUTES.onboardingExperience,
  skills: ROUTES.onboardingSkills,
  slack: ROUTES.onboardingSlack,
  ready: ROUTES.onboardingReady,
};

export type SubscriptionProvider = OnboardingSubscriptionProvider;

/** The other places a mention works, offered beside Slack on the same step. */
export type ChatChannelId = "telegram" | "imessage" | "teams" | "discord";

export interface SourcesFirstDraft {
  readonly industry: OnboardingIndustry | null;
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
  /** Selected format, kept separate from the task until submission. */
  readonly startingPromptOutput: StartingPromptOutput | null;
  /** The durable context-generation job started when the source step continues. */
  readonly recommendationJobId: string | null;
  /** Client wall-clock time when that generation attempt began; identifies it. */
  readonly recommendationStartedAt: number | null;
}

function emptyDraft(): SourcesFirstDraft {
  return {
    industry: null,
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
  // Existing browser drafts can still point at the retired invitation step.
  step: zEnum([...sourcesFirstStepSchema.options, "team"]),
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
  startingPromptOutput: persistedStartingPromptOutputSchema
    .nullable()
    .default(null),
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
  const text = saved.startingPromptDraft;
  const range = saved.startingPromptOutput;
  // Only a valid recorded range owns format text; all other text stays editable.
  const output =
    range && range.start <= range.end && range.end <= text.length
      ? range
      : null;
  return {
    ...emptyDraft(),
    industry: saved.industry,
    experienced: saved.experienced,
    provider: saved.provider,
    startingPromptDraft: output
      ? text.slice(0, output.start) + text.slice(output.end)
      : text,
    startingPromptKey: saved.startingPromptKey,
    startingPromptOutput: output
      ? { format: output.format, suffix: text.slice(output.start, output.end) }
      : null,
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
      ? step.data.step === "team"
        ? "experience"
        : step.data.step
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
 * Keep workspace role for funnel telemetry; both roles use the same steps.
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
  readonly importPromptShown: boolean;
}

const internalUi$ = state<SourcesFirstUi>({
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
    // Keep the version-2 wire format readable by older app builds. Runtime
    // state and the textarea contain only the task; restore splits them again.
    const persistedPrompt =
      next.startingPromptDraft + (next.startingPromptOutput?.suffix ?? "");
    set(
      draftStorage.set$,
      JSON.stringify({
        version: 2,
        ...identity,
        industry: next.industry,
        experienced: next.experienced,
        provider: next.provider,
        startingPromptDraft: persistedPrompt,
        startingPromptKey: next.startingPromptKey,
        startingPromptOutput: next.startingPromptOutput
          ? {
              format: next.startingPromptOutput.format,
              start: next.startingPromptDraft.length,
              end: persistedPrompt.length,
            }
          : null,
        recommendationJobId: next.recommendationJobId,
        recommendationStartedAt: next.recommendationStartedAt,
      }),
    );
  },
);

export const editStartingPrompt$ = command(
  ({ set }, next: string, promptKey: string): void => {
    set(updateSourcesFirstDraft$, {
      startingPromptKey: promptKey,
      startingPromptDraft: next,
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
    const suffix = format ? `\n\n${instruction}` : "";
    // A format must never truncate the user's task or exceed the persisted limit.
    if (text.length + suffix.length > STARTING_PROMPT_MAX_LENGTH) {
      return;
    }
    set(updateSourcesFirstDraft$, {
      startingPromptKey: promptKey,
      startingPromptDraft: text,
      startingPromptOutput: format ? { format, suffix } : null,
    });
  },
);

/** A subscription adds Skills; everyone chooses Capabilities before the first task. */
export function sourcesFirstSteps(
  provider: SubscriptionProvider | null,
): readonly SourcesFirstStep[] {
  return [
    "industry",
    "sources",
    "experience",
    ...(provider === null ? [] : ["skills" as const]),
    "slack",
    "capabilities",
    "ready",
  ];
}

/** Progress markers: one per step of this run. */
export function sourcesFirstProgress(
  step: SourcesFirstStep,
  provider: SubscriptionProvider | null,
): { readonly current: number; readonly total: number } {
  const steps = sourcesFirstSteps(provider);
  const index = steps.indexOf(step);
  return { current: (index === -1 ? 0 : index) + 1, total: steps.length };
}

/** The step before `step`, or null when it is the first one. */
export function previousSourcesFirstStep(
  step: SourcesFirstStep,
  provider: SubscriptionProvider | null,
): SourcesFirstStep | null {
  const steps = sourcesFirstSteps(provider);
  const index = steps.indexOf(step);
  return index > 0 ? (steps[index - 1] ?? null) : null;
}

/** The step after `step`, or null when the flow is finished. */
export function nextSourcesFirstStep(
  step: SourcesFirstStep,
  provider: SubscriptionProvider | null,
): SourcesFirstStep | null {
  const steps = sourcesFirstSteps(provider);
  const index = steps.indexOf(step);
  return index === -1 ? null : (steps[index + 1] ?? null);
}
