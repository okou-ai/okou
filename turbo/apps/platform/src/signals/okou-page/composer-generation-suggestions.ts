import { command, computed, state, type Computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import { featureSwitch$ } from "../external/feature-switch.ts";
import type { DraftSignals } from "./chat-draft.ts";
import type {
  ComposerCreateMode,
  ComposerCreateSignals,
  PresentationSlideCount,
} from "./composer-create.ts";
import type { ComposerTaskChipsSignals } from "./composer-task-chips.ts";
import type {
  ComposerTemplateAttachment,
  WorkflowComposerSignals,
} from "./tiptap-workflow-composer.ts";
import {
  detectComposerGenerationIntent,
  type ComposerGenerationIntent,
} from "./composer-generation-intent.ts";

export const GENERATION_IMAGE_ASPECT_RATIOS = [
  "auto",
  "1:1",
  "16:9",
  "9:16",
] as const;
export type GenerationImageAspectRatio =
  (typeof GENERATION_IMAGE_ASPECT_RATIOS)[number];

interface AppliedGenerationSuggestion {
  readonly intent: ComposerGenerationIntent;
  readonly revision: number;
  readonly imageAspectRatio: GenerationImageAspectRatio;
  readonly template: GenerationTemplateRequest | undefined;
}

function createRecommendationState() {
  return {
    dismissed$: state<{
      readonly session: number;
      readonly intents: readonly ComposerGenerationIntent[];
    } | null>(null),
    editing$: state(false),
    applied$: state<AppliedGenerationSuggestion | null>(null),
    slideCount$: state<PresentationSlideCount>("8-12"),
    imageAspectRatio$: state<GenerationImageAspectRatio>("auto"),
    reportOutput$: state<"document" | "presentation" | null>(null),
  };
}
type RecommendationState = ReturnType<typeof createRecommendationState>;

function dismissGenerationIntent(
  previous: RecommendationState["dismissed$"]["init"],
  session: number,
  intent: ComposerGenerationIntent,
) {
  const intents = previous?.session === session ? previous.intents : [];
  return {
    session,
    intents: intents.includes(intent) ? intents : [...intents, intent],
  };
}

function recommendationPreferences(settings: RecommendationState) {
  const { slideCount$, imageAspectRatio$, reportOutput$ } = settings;
  return {
    slideCount$: computed((get) => {
      return get(slideCount$);
    }),
    setSlideCount$: command(({ set }, value: PresentationSlideCount) => {
      set(slideCount$, value);
    }),
    imageAspectRatio$: computed((get) => {
      return get(imageAspectRatio$);
    }),
    setImageAspectRatio$: command(
      ({ set }, value: GenerationImageAspectRatio) => {
        set(imageAspectRatio$, value);
      },
    ),
    reportOutput$: computed((get) => {
      return get(reportOutput$);
    }),
    setReportOutput$: command(({ set }, value: "document" | "presentation") => {
      set(reportOutput$, value);
    }),
  };
}

function createApplicationSignals({
  draft,
  composer,
  create,
  tasks,
  settings,
  panelIntent$,
  appliedSelection$,
}: {
  readonly draft: DraftSignals;
  readonly composer: WorkflowComposerSignals;
  readonly create: ComposerCreateSignals;
  readonly tasks: ComposerTaskChipsSignals;
  readonly settings: RecommendationState;
  readonly panelIntent$: Computed<ComposerGenerationIntent | null>;
  readonly appliedSelection$: Computed<AppliedGenerationSuggestion | null>;
}) {
  const {
    applied$,
    dismissed$,
    editing$,
    slideCount$,
    imageAspectRatio$,
    reportOutput$,
  } = settings;
  const apply$ = command(({ get, set }, mode?: ComposerCreateMode) => {
    const intent = get(panelIntent$);
    if (!intent) {
      return;
    }
    const selectedMode =
      mode ?? (intent === "report" ? get(reportOutput$) : intent);
    if (!selectedMode) {
      return;
    }
    const previous = get(appliedSelection$);
    const changingFormat = get(create.mode$) !== selectedMode;
    if (changingFormat && previous?.template) {
      // Changing an explicitly applied report format replaces only our own template.
      set(composer.updateTemplate$, previous.template, null);
    }
    set(tasks.openTask$, selectedMode);
    if (selectedMode === "presentation") {
      set(create.setPresentationSlideCount$, get(slideCount$));
    }
    set(applied$, {
      intent,
      revision: get(create.selectionRevision$),
      imageAspectRatio: get(imageAspectRatio$),
      template: changingFormat ? undefined : previous?.template,
    });
    set(
      dismissed$,
      dismissGenerationIntent(
        get(dismissed$),
        get(draft.inputSession$),
        intent,
      ),
    );
    set(editing$, false);
  });
  const selectTemplate$ = command(
    (
      { get, set },
      template: GenerationTemplateRequest,
      attachment: ComposerTemplateAttachment,
      mode: ComposerCreateMode,
    ) => {
      // Apply before insertion: the new inline template deliberately suppresses suggestions.
      set(apply$, mode);
      const applied = get(appliedSelection$);
      if (!applied) {
        return;
      }
      if (
        !applied.template ||
        !set(composer.updateTemplate$, applied.template, {
          request: template,
          attachment,
        })
      ) {
        set(composer.insertTemplate$, template, attachment);
      }
      set(applied$, { ...applied, template });
    },
  );
  const change$ = command(({ get, set }) => {
    const applied = get(appliedSelection$);
    if (!applied) {
      return;
    }
    set(slideCount$, get(create.presentationSlideCount$));
    set(imageAspectRatio$, applied.imageAspectRatio);
    set(
      reportOutput$,
      get(create.mode$) === "presentation" ? "presentation" : "document",
    );
    set(editing$, true);
  });
  const additionalInfo$ = createImagePreferenceInfo(create, appliedSelection$);
  const completeSubmission$ = command(
    ({ get, set }, selection: AppliedGenerationSuggestion | null) => {
      if (selection === null || get(appliedSelection$) !== selection) {
        return;
      }
      // Recommendation-owned selections are one-message settings. Manual modes retain their lifetime.
      set(tasks.selectTask$, null);
      set(applied$, null);
      set(editing$, false);
      set(dismissed$, null);
      set(slideCount$, "8-12");
      set(imageAspectRatio$, "auto");
      set(reportOutput$, null);
    },
  );
  return {
    apply$,
    selectTemplate$,
    change$,
    additionalInfo$,
    completeSubmission$,
  };
}

function createImagePreferenceInfo(
  create: ComposerCreateSignals,
  appliedSelection$: Computed<AppliedGenerationSuggestion | null>,
) {
  return computed((get) => {
    const applied = get(appliedSelection$);
    if (
      get(create.mode$) !== "image" ||
      !applied ||
      applied.imageAspectRatio === "auto"
    ) {
      return undefined;
    }
    return [
      "# Image generation preferences",
      `- Preferred aspect ratio: ${applied.imageAspectRatio}`,
      "Use a matching supported image size. If the selected model or template cannot use this ratio, explain the limitation rather than silently ignoring it.",
      "Where this run's message asks for a different aspect ratio, the message wins.",
    ].join("\n");
  });
}

/** Recommendations are previews. Only apply/select commands enter create mode. */
export function createComposerGenerationSuggestions(
  draft: DraftSignals,
  composer: WorkflowComposerSignals,
  create: ComposerCreateSignals,
  tasks: ComposerTaskChipsSignals,
  forwardComposer: boolean,
) {
  const settings = createRecommendationState();
  const { applied$, editing$, dismissed$ } = settings;
  const enabled$ = computed((get) => {
    return (
      !forwardComposer &&
      get(featureSwitch$)[FeatureSwitchKey.ComposerGenerationSuggestions]
    );
  });
  const appliedSelection$ = computed((get) => {
    const applied = get(applied$);
    return applied && applied.revision === get(create.selectionRevision$)
      ? applied
      : null;
  });
  const panelIntent$ = computed((get): ComposerGenerationIntent | null => {
    if (
      !get(enabled$) ||
      get(composer.isComposing$) ||
      get(composer.activeSlashRange$) ||
      get(composer.activeChatThreadSuggestionRange$)
    ) {
      return null;
    }
    const applied = get(appliedSelection$);
    if (applied) {
      return get(editing$) ? applied.intent : null;
    }
    // A manual task or template always wins, even if the text mentions another type.
    if (
      get(tasks.task$) !== null ||
      get(draft.generationTemplate$) ||
      get(composer.templateRequests$).length > 0
    ) {
      return null;
    }
    const intent = detectComposerGenerationIntent(get(draft.input$));
    const dismissed = get(dismissed$);
    return intent &&
      !(
        dismissed?.session === get(draft.inputSession$) &&
        dismissed.intents.includes(intent)
      )
      ? intent
      : null;
  });
  const dismiss$ = command(({ get, set }) => {
    const intent = get(panelIntent$);
    if (intent) {
      set(
        dismissed$,
        dismissGenerationIntent(
          get(dismissed$),
          get(draft.inputSession$),
          intent,
        ),
      );
    }
    set(editing$, false);
  });
  return {
    enabled$,
    panelIntent$,
    appliedSelection$,
    dismiss$,
    ...recommendationPreferences(settings),
    ...createApplicationSignals({
      draft,
      composer,
      create,
      tasks,
      settings,
      panelIntent$,
      appliedSelection$,
    }),
  };
}

export type ComposerGenerationSuggestionsSignals = ReturnType<
  typeof createComposerGenerationSuggestions
>;
