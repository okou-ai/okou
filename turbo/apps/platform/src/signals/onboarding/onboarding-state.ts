import { command, computed, state } from "ccstate";
import { sessionStorageSignals } from "../external/session-storage.ts";

export type OnboardingChoice =
  | "slack"
  | "workflow"
  | "presentation"
  | "video"
  | "images"
  | "website"
  | "explore";

export type OnboardingRouteStep =
  | "make"
  | "workflow-picker"
  | "workflow-run"
  | "presentation-template"
  | "presentation-run"
  | "image-template"
  | "image-run"
  | "video-template"
  | "video-run";

export interface OnboardingDraft {
  readonly choice: OnboardingChoice | null;
  readonly categoryId: string | null;
  readonly workflowId: string | null;
  readonly workflowNote: string;
  readonly presentationTemplateSlug: string | null;
  readonly presentationNote: string;
  readonly imageTemplateSlug: string | null;
  readonly imageNote: string;
  readonly videoTemplateSlug: string | null;
  readonly videoNote: string;
  readonly prompt: string;
}

interface OnboardingCheckoutDraft {
  readonly userId: string;
  readonly prompt: string;
  readonly note: string;
}

export const ONBOARDING_CHECKOUT_STATE_PARAM = "onboarding_checkout_state";

const ONBOARDING_CHECKOUT_STATE_STORAGE_KEY = "vm0:onboarding:checkout-state";
const ONBOARDING_CHECKOUT_PROMPT_STORAGE_KEY = "vm0:onboarding:checkout-prompt";
const ONBOARDING_CHECKOUT_NOTE_STORAGE_KEY = "vm0:onboarding:checkout-note";
const ONBOARDING_CHECKOUT_OWNER_STORAGE_KEY = "vm0:onboarding:checkout-owner";
const onboardingCheckoutStateStorage = sessionStorageSignals(
  ONBOARDING_CHECKOUT_STATE_STORAGE_KEY,
);
const onboardingCheckoutPromptStorage = sessionStorageSignals(
  ONBOARDING_CHECKOUT_PROMPT_STORAGE_KEY,
);
const onboardingCheckoutNoteStorage = sessionStorageSignals(
  ONBOARDING_CHECKOUT_NOTE_STORAGE_KEY,
);
const onboardingCheckoutOwnerStorage = sessionStorageSignals(
  ONBOARDING_CHECKOUT_OWNER_STORAGE_KEY,
);

interface OnboardingUiState {
  readonly workflowPreviewId: string | null;
  readonly presentationPreviewSlug: string | null;
  readonly presentationSlideIndex: number;
  readonly imageVariantBySlug: Readonly<Record<string, number>>;
}

type OnboardingDraftUpdate = Partial<{
  -readonly [Key in keyof OnboardingDraft]: OnboardingDraft[Key];
}>;

function emptyOnboardingDraft(): OnboardingDraft {
  return {
    choice: null,
    categoryId: null,
    workflowId: null,
    workflowNote: "",
    presentationTemplateSlug: null,
    presentationNote: "",
    imageTemplateSlug: null,
    imageNote: "",
    videoTemplateSlug: null,
    videoNote: "",
    prompt: "",
  };
}

function emptyOnboardingUiState(): OnboardingUiState {
  return {
    workflowPreviewId: null,
    presentationPreviewSlug: null,
    presentationSlideIndex: 0,
    imageVariantBySlug: {},
  };
}

export const storeOnboardingCheckoutDraft$ = command(
  ({ set }, draft: OnboardingCheckoutDraft): string => {
    const stateId = crypto.randomUUID();
    set(onboardingCheckoutStateStorage.set$, stateId);
    set(onboardingCheckoutPromptStorage.set$, draft.prompt);
    set(onboardingCheckoutNoteStorage.set$, draft.note);
    set(onboardingCheckoutOwnerStorage.set$, draft.userId);
    return stateId;
  },
);

export const readOnboardingCheckoutDraft$ = command(
  (
    { get },
    searchParams: URLSearchParams,
    userId: string,
  ): OnboardingCheckoutDraft | null => {
    const stateId = searchParams.get(ONBOARDING_CHECKOUT_STATE_PARAM);
    if (
      !stateId ||
      get(onboardingCheckoutStateStorage.get$) !== stateId ||
      get(onboardingCheckoutOwnerStorage.get$) !== userId
    ) {
      return null;
    }

    const prompt = get(onboardingCheckoutPromptStorage.get$);
    const note = get(onboardingCheckoutNoteStorage.get$);
    if (prompt === null || note === null) {
      return null;
    }

    return { userId, prompt, note };
  },
);

const clearOnboardingCheckoutDraft$ = command(({ set }) => {
  set(onboardingCheckoutStateStorage.clear$);
  set(onboardingCheckoutPromptStorage.clear$);
  set(onboardingCheckoutNoteStorage.clear$);
  set(onboardingCheckoutOwnerStorage.clear$);
});

export const clearOnboardingCheckoutDraftForUser$ = command(
  ({ get, set }, userId: string) => {
    if (get(onboardingCheckoutOwnerStorage.get$) === userId) {
      set(clearOnboardingCheckoutDraft$);
    }
  },
);

const internalOnboardingDraft$ = state<OnboardingDraft>(emptyOnboardingDraft());
const internalOnboardingUi$ = state<OnboardingUiState>(
  emptyOnboardingUiState(),
);

export const onboardingDraft$ = computed((get) => {
  return get(internalOnboardingDraft$);
});

export const onboardingUi$ = computed((get) => {
  return get(internalOnboardingUi$);
});

export const updateOnboardingDraft$ = command(
  ({ set }, patch: OnboardingDraftUpdate) => {
    set(internalOnboardingDraft$, (current) => {
      return { ...current, ...patch };
    });
  },
);

export const resetOnboardingDraft$ = command(({ set }) => {
  set(clearOnboardingCheckoutDraft$);
  set(internalOnboardingDraft$, emptyOnboardingDraft());
});

export const updateOnboardingUi$ = command(
  ({ set }, patch: Partial<OnboardingUiState>) => {
    set(internalOnboardingUi$, (current) => {
      return { ...current, ...patch };
    });
  },
);

export const setOnboardingImageVariant$ = command(
  ({ set }, slug: string, index: number) => {
    set(internalOnboardingUi$, (current) => {
      return {
        ...current,
        imageVariantBySlug: {
          ...current.imageVariantBySlug,
          [slug]: index,
        },
      };
    });
  },
);

const resetOnboardingUi$ = command(({ set }) => {
  set(internalOnboardingUi$, emptyOnboardingUiState());
});

function onboardingChoice(value: string | null): OnboardingChoice | null {
  if (
    value === "slack" ||
    value === "workflow" ||
    value === "presentation" ||
    value === "video" ||
    value === "images" ||
    value === "website" ||
    value === "explore"
  ) {
    return value;
  }
  return null;
}

function onboardingRouteText(
  searchParams: URLSearchParams,
  checkoutDraft: OnboardingCheckoutDraft | null,
): {
  readonly prompt: string | null;
  readonly note: string | null;
} {
  return {
    prompt: searchParams.get("prompt") ?? checkoutDraft?.prompt ?? null,
    note: searchParams.get("onboarding_note") ?? checkoutDraft?.note ?? null,
  };
}

export const hydrateOnboardingRoute$ = command(
  (
    { get, set },
    step: OnboardingRouteStep,
    searchParams: URLSearchParams,
    userId: string,
  ) => {
    set(resetOnboardingUi$);
    const choice = onboardingChoice(searchParams.get("choice"));
    if (step === "make" && !choice) {
      set(resetOnboardingDraft$);
    }

    const current = get(internalOnboardingDraft$);
    const routeText = onboardingRouteText(
      searchParams,
      set(readOnboardingCheckoutDraft$, searchParams, userId),
    );
    const categoryId = searchParams.get("category");
    const workflowId = searchParams.get("workflow");
    const templateSlug =
      searchParams.get("onboarding_template") ?? searchParams.get("template");
    const patch: OnboardingDraftUpdate = {
      ...(choice ? { choice } : {}),
      ...(routeText.prompt !== null ? { prompt: routeText.prompt } : {}),
    };

    if (step === "workflow-picker" || step === "workflow-run") {
      patch.choice = "workflow";
      patch.categoryId = categoryId ?? current.categoryId;
      patch.workflowId = workflowId ?? current.workflowId;
    }
    if (step === "presentation-template" || step === "presentation-run") {
      patch.choice = "presentation";
      patch.presentationTemplateSlug =
        templateSlug ?? current.presentationTemplateSlug;
    }
    if (step === "image-template" || step === "image-run") {
      patch.choice = "images";
      patch.imageTemplateSlug = templateSlug ?? current.imageTemplateSlug;
    }
    if (step === "video-template" || step === "video-run") {
      patch.choice = "video";
      patch.videoTemplateSlug = templateSlug ?? current.videoTemplateSlug;
      if (routeText.note !== null) {
        patch.videoNote = routeText.note;
      }
    }

    set(updateOnboardingDraft$, patch);
  },
);
