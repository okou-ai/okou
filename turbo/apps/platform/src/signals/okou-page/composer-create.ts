import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { findVideoTemplateItem } from "@okouai/core/video-template-items";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { i18n } from "../../i18n/index.ts";
import type { WorkflowComposerSignals } from "./tiptap-workflow-composer.ts";
import type { ComposerUiSignalGroups } from "./chat-composer.ts";

const COMPOSER_CREATE_MODES = ["presentation", "video", "image"] as const;

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

export function composerCreateModeLabel(mode: ComposerCreateMode): string {
  switch (mode) {
    case "image": {
      return i18n.t(($) => {
        return $.chat.composer.create.image;
      });
    }
    case "video": {
      return i18n.t(($) => {
        return $.chat.composer.create.video;
      });
    }
    case "presentation": {
      return i18n.t(($) => {
        return $.chat.composer.create.presentation;
      });
    }
  }
}

export function composerCreateModeName(mode: ComposerCreateMode): string {
  switch (mode) {
    case "presentation": {
      return i18n.t(($) => {
        return $.artifacts.kinds.presentation;
      });
    }
    case "image": {
      return i18n.t(($) => {
        return $.artifacts.kinds.image;
      });
    }
    case "video": {
      return i18n.t(($) => {
        return $.artifacts.kinds.video;
      });
    }
  }
}

export function composerCreateModeDescription(
  mode: ComposerCreateMode,
): string {
  switch (mode) {
    case "presentation": {
      return i18n.t(($) => {
        return $.chat.composer.create.presentationDescription;
      });
    }
    case "video": {
      return i18n.t(($) => {
        return $.chat.composer.create.videoDescription;
      });
    }
    case "image": {
      return i18n.t(($) => {
        return $.chat.composer.create.imageDescription;
      });
    }
  }
}

export function composerCreatePlaceholder(mode: ComposerCreateMode): string {
  switch (mode) {
    case "image": {
      return i18n.t(($) => {
        return $.chat.composer.create.imagePlaceholder;
      });
    }
    case "video": {
      return i18n.t(($) => {
        return $.chat.composer.create.videoPlaceholder;
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
  const pickerId = `composer-create-picker-${crypto.randomUUID()}`;
  const modes = COMPOSER_CREATE_MODES.filter((mode) => {
    return (
      (mode !== "image" || media.image) && (mode !== "video" || media.video)
    );
  });
  const internalMode$ = state<ComposerCreateMode | null>(null);
  const internalPickerOpen$ = state(false);
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
    const mode = get(internalMode$);
    if (mode === "video" && get(hasOtherTemplate$)) {
      return null;
    }
    return get(enabled$) ? mode : null;
  });
  const creativeVideo$ = computed((get) => {
    const mode = get(mode$);
    if (
      !media.video ||
      get(hasOtherTemplate$) ||
      (mode !== null && mode !== "video")
    ) {
      return false;
    }
    return get(composer.templateRequests$).length > 0 || mode === "video";
  });
  const pickerOpen$ = computed((get) => {
    return get(enabled$) && get(internalPickerOpen$);
  });
  const setMode$ = command(({ get, set }, mode: ComposerCreateMode | null) => {
    if (!get(enabled$)) {
      return;
    }
    const wasCreativeVideo = get(creativeVideo$);
    set(internalPickerOpen$, false);
    set(internalMode$, mode);
    set(composer.closeSuggestionMenu$);
    set(ui.model.setModelPickerOpen$, false);
    set(
      ui.model.setMediaModelCategory$,
      mode === "image" || mode === "video" ? mode : null,
    );
    if (wasCreativeVideo && mode !== "video") {
      set(ui.videoOptions.setVideoOptionsOpen$, false);
    }
    if (mode !== "presentation") {
      set(setPresentationSlideCount$, "8-12");
    }
    set(composer.focus$);
  });
  const setPickerOpen$ = command(({ get, set }, open: boolean) => {
    if (!get(enabled$)) {
      return;
    }
    set(internalPickerOpen$, open);
    if (open) {
      set(composer.closeSuggestionMenu$);
      set(ui.model.setModelPickerOpen$, false);
      if (get(creativeVideo$)) {
        set(ui.videoOptions.setVideoOptionsOpen$, false);
      }
    } else {
      set(composer.focus$);
    }
  });
  const selectCommand$ = command(({ get, set }, mode: ComposerCreateMode) => {
    if (!get(enabled$)) {
      return;
    }
    const range = get(composer.activeSlashRange$);
    if (range) {
      const head = composer.editor.state.selection.head;
      composer.editor.commands.deleteRange({
        from: head - (range.end - range.start),
        to: head,
      });
    }
    set(setMode$, mode);
  });
  return {
    enabled$,
    modes,
    mode$,
    creativeVideo$,
    pickerId,
    pickerOpen$,
    setPickerOpen$,
    setMode$,
    selectCommand$,
    presentationSlideCount$,
    setPresentationSlideCount$,
  };
}

export type ComposerCreateSignals = ReturnType<
  typeof createComposerCreateSignals
>;
