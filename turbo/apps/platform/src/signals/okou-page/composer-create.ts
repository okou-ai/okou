import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { findVideoTemplateItem } from "@okouai/core/video-template-items";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { i18n } from "../../i18n/index.ts";
import type { WorkflowComposerSignals } from "./tiptap-workflow-composer.ts";
import type { ComposerUiSignalGroups } from "./chat-composer.ts";

const COMPOSER_CREATE_MODES = ["presentation", "image"] as const;

export const PRESENTATION_SLIDE_COUNTS = [
  "auto",
  "4-8",
  "8-12",
  "12-16",
  "16-20",
  "20-24",
] as const;

export type PresentationSlideCount = (typeof PRESENTATION_SLIDE_COUNTS)[number];

export type ComposerCreateMode = (typeof COMPOSER_CREATE_MODES)[number];

export function composerCreatePlaceholder(mode: ComposerCreateMode): string {
  switch (mode) {
    case "image": {
      return i18n.t(($) => {
        return $.chat.composer.create.imagePlaceholder;
      });
    }
    case "presentation": {
      return i18n.t(($) => {
        return $.chat.composer.create.presentationPlaceholder;
      });
    }
  }
}

function createNonCreativeTemplateSignal(composer: WorkflowComposerSignals) {
  return computed((get) => {
    return get(composer.templateRequests$).some((template) => {
      return (
        template.type !== "video" ||
        !findVideoTemplateItem(template.selection.stylePresetId)
      );
    });
  });
}

function createPresentationSlideCountSignals() {
  const internalPresentationSlideCount$ = state<PresentationSlideCount>("8-12");
  const presentationSlideCount$ = computed((get) => {
    return get(internalPresentationSlideCount$);
  });
  const setPresentationSlideCount$ = command(
    ({ set }, slideCount: PresentationSlideCount) => {
      set(internalPresentationSlideCount$, slideCount);
    },
  );
  return { presentationSlideCount$, setPresentationSlideCount$ };
}

export function createComposerCreateSignals(
  composer: WorkflowComposerSignals,
  ui: ComposerUiSignalGroups,
  media: { readonly image: boolean; readonly video: boolean },
) {
  const modes = COMPOSER_CREATE_MODES.filter((mode) => {
    return mode !== "image" || media.image;
  });
  const internalMode$ = state<ComposerCreateMode | null>(null);
  const { presentationSlideCount$, setPresentationSlideCount$ } =
    createPresentationSlideCountSignals();
  /**
   * Create modes are infrastructure, not a surface: the two places that pick
   * one are the slash panel and the task chips, and each owns its own switch.
   * Reading both here keeps either surface from depending on the other's
   * rollout, so turning the chips off cannot empty the slash panel.
   */
  const enabled$ = computed((get) => {
    const features = get(featureSwitch$);
    return (
      features[FeatureSwitchKey.ComposerSlashTemplatePanel] ||
      features[FeatureSwitchKey.ComposerTaskChips]
    );
  });
  const hasOtherTemplate$ = createNonCreativeTemplateSignal(composer);
  const mode$ = computed((get) => {
    return get(enabled$) ? get(internalMode$) : null;
  });
  /**
   * Video is no longer a type anyone picks; a video template standing on its
   * own is what states the composer is making one.
   */
  const creativeVideo$ = computed((get) => {
    if (!media.video || get(hasOtherTemplate$) || get(mode$) !== null) {
      return false;
    }
    return get(composer.templateRequests$).length > 0;
  });
  const setMode$ = command(({ get, set }, mode: ComposerCreateMode | null) => {
    if (!get(enabled$)) {
      return;
    }
    const wasCreativeVideo = get(creativeVideo$);
    set(internalMode$, mode);
    set(composer.closeSuggestionMenu$);
    set(ui.model.setModelPickerOpen$, false);
    set(ui.model.setMediaModelCategory$, mode === "image" ? "image" : null);
    if (wasCreativeVideo) {
      set(ui.videoOptions.setVideoOptionsOpen$, false);
    }
    if (mode !== "presentation") {
      set(setPresentationSlideCount$, "8-12");
    }
    set(composer.focus$);
  });
  const selectCommand$ = command(({ get, set }, mode: ComposerCreateMode) => {
    if (!get(enabled$)) {
      return;
    }
    set(composer.clearSlashRange$);
    set(setMode$, mode);
  });
  return {
    enabled$,
    modes,
    mode$,
    creativeVideo$,
    setMode$,
    selectCommand$,
    presentationSlideCount$,
    setPresentationSlideCount$,
  };
}

export type ComposerCreateSignals = ReturnType<
  typeof createComposerCreateSignals
>;
