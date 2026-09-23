import { command, computed, state } from "ccstate";
import {
  onboardingIndustrySchema,
  onboardingSubscriptionProviderSchema,
  type OnboardingRecommendation,
  type OnboardingSubscriptionProvider,
} from "@okouai/api-contracts/contracts/onboarding";
import type { OnboardingIndustry } from "@okouai/core/onboarding-industry";
import { z } from "zod";
import { localStorageSignals } from "../external/local-storage.ts";
import { jsonParseOr } from "../utils.ts";

/**
 * Source-first onboarding draft. Unsaved answers survive a browser refresh in
 * local storage, scoped to the current user and organization. Connections and
 * invitations keep their own server-backed state; their transient UI status
 * belongs to this application start.
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

export type SubscriptionProvider = OnboardingSubscriptionProvider;

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

export type SourcesFirstRecommendationStatus =
  | "idle"
  | "starting"
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "timed-out";

export interface SourcesFirstDraft {
  readonly industry: OnboardingIndustry | null;
  /** One entry per address this run tried, with what the API answered. */
  readonly invites: readonly SourcesFirstInvite[];
  /** Null until the step is answered, so nothing is pre-chosen for the user. */
  readonly experienced: boolean | null;
  /**
   * The plan the answer names. Whether it is connected is the account's
   * answer, read from `/api/me/model-providers`, never held here.
   */
  readonly provider: SubscriptionProvider | null;
  /** Edited copy of the matched starting prompt, kept across step changes. */
  readonly startingPromptDraft: string;
  /** The displayed seed the edit belongs to; any non-empty key owns later text. */
  readonly startingPromptKey: string;
  /** The durable context-generation job started when the source step continues. */
  readonly recommendationJobId: string | null;
  /** Client wall-clock time when that generation attempt began. */
  readonly recommendationStartedAt: number | null;
  readonly recommendationStatus: SourcesFirstRecommendationStatus;
  /** Only the final, schema-validated recommendation; raw source data never enters the browser. */
  readonly recommendation: OnboardingRecommendation | null;
}

function emptyDraft(): SourcesFirstDraft {
  return {
    industry: null,
    invites: [],
    experienced: null,
    provider: null,
    startingPromptDraft: "",
    startingPromptKey: "",
    recommendationJobId: null,
    recommendationStartedAt: null,
    recommendationStatus: "idle",
    recommendation: null,
  };
}

interface SourcesFirstDraftIdentity {
  readonly orgId: string;
  readonly userId: string;
}

const persistedDraftIdentitySchema = z.object({
  orgId: z.string().min(1),
  userId: z.string().min(1),
});

const persistedDraftSchema = persistedDraftIdentitySchema.extend({
  version: z.literal(2),
  industry: onboardingIndustrySchema.nullable(),
  experienced: z.boolean().nullable(),
  provider: onboardingSubscriptionProviderSchema.nullable(),
  startingPromptDraft: z.string().max(1000),
  startingPromptKey: z.string(),
  recommendationJobId: z.uuid().nullable(),
  recommendationStartedAt: z.number().finite().nonnegative().nullable(),
});

type PersistedSourcesFirstDraft = z.infer<typeof persistedDraftSchema>;

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
  const recommendationStatus: SourcesFirstRecommendationStatus =
    saved.recommendationJobId !== null
      ? "pending"
      : saved.recommendationStartedAt === null
        ? "idle"
        : "starting";
  return {
    ...emptyDraft(),
    industry: saved.industry,
    experienced: saved.experienced,
    provider: saved.provider,
    startingPromptDraft: saved.startingPromptDraft,
    startingPromptKey: saved.startingPromptKey,
    recommendationJobId: saved.recommendationJobId,
    recommendationStartedAt: saved.recommendationStartedAt,
    recommendationStatus,
  };
}

export const sourcesFirstDraftStorage = localStorageSignals(
  "onboarding:sources-first-draft",
);
const draftStorage = sourcesFirstDraftStorage;
const internalDraftIdentity$ = state<SourcesFirstDraftIdentity | null>(null);
const internalDraft$ = state<SourcesFirstDraft>(emptyDraft());

/** Restore before a page checks whether the selected plan adds the skills step. */
export const restoreSourcesFirstDraft$ = command(
  ({ get, set }, identity: SourcesFirstDraftIdentity): void => {
    const active = get(internalDraftIdentity$);
    if (active?.orgId === identity.orgId && active.userId === identity.userId) {
      return;
    }

    const saved = savedDraftForIdentity(get(draftStorage.get$), identity);
    set(internalDraftIdentity$, identity);
    set(internalDraft$, restoredDraft(saved));
  },
);

export const clearSourcesFirstDraft$ = command(({ get, set }): void => {
  const identity = get(internalDraftIdentity$);
  if (identity === null) {
    set(internalDraft$, emptyDraft());
    return;
  }
  const raw = get(draftStorage.get$);
  const parsed = persistedDraftIdentitySchema.safeParse(
    raw === null ? null : jsonParseOr<unknown>(raw, null),
  );
  if (
    parsed.success &&
    parsed.data.orgId === identity.orgId &&
    parsed.data.userId === identity.userId
  ) {
    set(draftStorage.clear$);
  }
  set(internalDraft$, emptyDraft());
});

/** Clear a deleted user's onboarding draft without touching another account's. */
export const clearSourcesFirstDraftForUser$ = command(
  ({ get, set }, userId: string): void => {
    const raw = get(draftStorage.get$);
    const parsed = persistedDraftIdentitySchema.safeParse(
      raw === null ? null : jsonParseOr<unknown>(raw, null),
    );
    if (parsed.success && parsed.data.userId === userId) {
      set(draftStorage.clear$);
    }
    if (get(internalDraftIdentity$)?.userId === userId) {
      set(internalDraftIdentity$, null);
      set(internalDraft$, emptyDraft());
    }
  },
);

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
  readonly inviteEmail: string;
}

const internalUi$ = state<SourcesFirstUi>({
  inviteEmail: "",
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
        recommendationJobId: next.recommendationJobId,
        recommendationStartedAt: next.recommendationStartedAt,
      }),
    );
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
 * experience question with a selected plan adds the skills step before Slack.
 */
export function sourcesFirstSteps(
  flow: SourcesFirstFlow,
  provider: SubscriptionProvider | null,
): readonly SourcesFirstStep[] {
  const base = flow === "owner" ? OWNER_BASE_STEPS : MEMBER_BASE_STEPS;
  const skillSteps: readonly SourcesFirstStep[] =
    provider === null ? [] : ["skills"];
  const slackStep: readonly SourcesFirstStep[] =
    flow === "owner" ? ["slack"] : [];
  return [...base, ...skillSteps, ...slackStep, "ready"];
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
