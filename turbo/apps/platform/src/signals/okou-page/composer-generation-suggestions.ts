import { command, computed, state, type Computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import { featureSwitch$ } from "../external/feature-switch.ts";
import type { DraftSignals } from "./chat-draft.ts";
import type {
  ComposerCreateSignals,
  PresentationSlideCount,
} from "./composer-create.ts";
import type { ComposerTaskChipsSignals } from "./composer-task-chips.ts";
import type {
  ComposerTemplateAttachment,
  WorkflowComposerSignals,
} from "./tiptap-workflow-composer.ts";
import {
  detectComposerGenerationIntents,
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
  readonly templateId: string;
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
    selectedIntent$: state<{
      readonly session: number;
      readonly intent: ComposerGenerationIntent;
    } | null>(null),
  };
}
type RecommendationState = ReturnType<typeof createRecommendationState>;

function dismissGenerationIntents(
  previous: RecommendationState["dismissed$"]["init"],
  session: number,
  intents: readonly ComposerGenerationIntent[],
) {
  const earlier = previous?.session === session ? previous.intents : [];
  return {
    session,
    intents: [...new Set([...earlier, ...intents])],
  };
}

function recommendationPreferences(settings: RecommendationState) {
  const { slideCount$, imageAspectRatio$ } = settings;
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
    selectedIntent$,
  } = settings;
  const apply$ = command(({ get, set }) => {
    const intent = get(panelIntent$);
    if (!intent) {
      return;
    }
    const previous = get(appliedSelection$);
    set(tasks.openTask$, intent);
    set(composer.focus$);
    if (intent === "presentation") {
      set(create.setPresentationSlideCount$, get(slideCount$));
    }
    set(applied$, {
      intent,
      revision: get(create.selectionRevision$),
      imageAspectRatio: get(imageAspectRatio$),
      templateId: previous?.templateId ?? crypto.randomUUID(),
    });
    set(
      dismissed$,
      dismissGenerationIntents(get(dismissed$), get(draft.inputSession$), [
        intent,
      ]),
    );
    set(editing$, false);
  });
  const selectTemplate$ = command(
    (
      { get, set },
      template: GenerationTemplateRequest,
      attachment: ComposerTemplateAttachment,
    ) => {
      // Apply before insertion: the new inline template deliberately suppresses suggestions.
      set(apply$);
      const applied = get(appliedSelection$);
      if (!applied) {
        return;
      }
      set(
        composer.setGenerationSuggestionTemplate$,
        applied.templateId,
        template,
        attachment,
      );
    },
  );
  const change$ = command(({ get, set }) => {
    const applied = get(appliedSelection$);
    if (!applied) {
      return;
    }
    set(slideCount$, get(create.presentationSlideCount$));
    set(imageAspectRatio$, applied.imageAspectRatio);
    set(editing$, true);
  });
  const additionalInfo$ = createGenerationAdditionalInfo(
    create,
    appliedSelection$,
  );
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
      set(selectedIntent$, null);
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

function createGenerationAdditionalInfo(
  create: ComposerCreateSignals,
  appliedSelection$: Computed<AppliedGenerationSuggestion | null>,
) {
  return computed((get) => {
    const applied = get(appliedSelection$);
    if (applied?.intent === "website") {
      return "Create a website.";
    }
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
  const { applied$, editing$, dismissed$, selectedIntent$ } = settings;
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
  const panelIntents$ = computed((get): readonly ComposerGenerationIntent[] => {
    if (
      !get(enabled$) ||
      get(composer.isComposing$) ||
      get(composer.activeSlashRange$) ||
      get(composer.activeChatThreadSuggestionRange$)
    ) {
      return [];
    }
    const applied = get(appliedSelection$);
    if (applied) {
      return get(editing$) ? [applied.intent] : [];
    }
    // A manual task or template always wins, even if the text mentions another type.
    if (
      get(tasks.task$) !== null ||
      get(draft.generationTemplate$) ||
      get(composer.templateRequests$).length > 0
    ) {
      return [];
    }
    const dismissed = get(dismissed$);
    return detectComposerGenerationIntents(get(draft.input$)).filter(
      (intent) => {
        return !(
          dismissed?.session === get(draft.inputSession$) &&
          dismissed.intents.includes(intent)
        );
      },
    );
  });
  const panelIntent$ = computed((get): ComposerGenerationIntent | null => {
    const intents = get(panelIntents$);
    const selected = get(selectedIntent$);
    return selected?.session === get(draft.inputSession$) &&
      intents.includes(selected.intent)
      ? selected.intent
      : (intents[0] ?? null);
  });
  const selectIntent$ = command(
    ({ get, set }, intent: ComposerGenerationIntent) => {
      if (get(panelIntents$).includes(intent)) {
        set(selectedIntent$, { session: get(draft.inputSession$), intent });
      }
    },
  );
  const dismiss$ = command(({ get, set }) => {
    set(
      dismissed$,
      dismissGenerationIntents(
        get(dismissed$),
        get(draft.inputSession$),
        get(panelIntents$),
      ),
    );
    set(editing$, false);
  });
  return {
    enabled$,
    panelIntents$,
    panelIntent$,
    selectIntent$,
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
