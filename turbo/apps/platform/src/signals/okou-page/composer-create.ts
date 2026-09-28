import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
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
  media: { readonly image: boolean },
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
  const mode$ = computed((get) => {
    return get(enabled$) ? get(internalMode$) : null;
  });
  const setMode$ = command(({ get, set }, mode: ComposerCreateMode | null) => {
    if (!get(enabled$)) {
      return;
    }
    set(internalMode$, mode);
    set(composer.closeSuggestionMenu$);
    set(ui.model.setModelPickerOpen$, false);
    set(ui.model.setMediaModelCategory$, mode === "image" ? "image" : null);
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
    setMode$,
    selectCommand$,
    presentationSlideCount$,
    setPresentationSlideCount$,
  };
}

export type ComposerCreateSignals = ReturnType<
  typeof createComposerCreateSignals
>;
