import { command, computed, state, type Command } from "ccstate";
import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { cloudBrowserEnabledByDefault$ } from "../cloud-browser-preference.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { onRef } from "../utils.ts";
import { createPresentationTemplatePreviewSignals } from "./presentation-template-preview.ts";
import { createAvatarTemplatePickerSignals } from "./avatar-template-picker.ts";
import { createImportedPresentationTemplateSignals } from "./presentation-template-library.ts";
import { createModelPickerMenuSignals } from "./model-picker-menu.ts";
import type { VideoRunOptionsPatch } from "./video-run-options.ts";

// ---------------------------------------------------------------------------
// Composer UI state — search, dialogs, loading indicators
// ---------------------------------------------------------------------------

// -- New-thread computer access selection -----------------------------------

// A thread reaches at most one computer, so the composer holds a single
// selection rather than two flags that have to clear each other.
type NewThreadComputerAccess =
  | { readonly kind: "none" }
  | { readonly kind: "cloudBrowser" }
  | { readonly kind: "computerUse"; readonly hostId: string };

async function computerAccessFromSavedCloudBrowserDefault(
  cloudBrowserEnabled: Promise<boolean>,
): Promise<NewThreadComputerAccess> {
  return (await cloudBrowserEnabled)
    ? { kind: "cloudBrowser" }
    : { kind: "none" };
}

// Like the composer's model selection: `null` means the user has not picked
// anything for the current draft and the default applies, while a value is the
// user's own choice — including an explicit "no computer at all".
const internalNewThreadComputerAccess$ = state<NewThreadComputerAccess | null>(
  null,
);

export const newThreadCloudBrowserEnabled$ = computed(
  (get): boolean | Promise<boolean> => {
    const selection = get(internalNewThreadComputerAccess$);
    if (selection !== null) {
      return selection.kind === "cloudBrowser";
    }
    const preferenceEnabled =
      get(featureSwitch$)[FeatureSwitchKey.ChatPreference] ?? false;
    return preferenceEnabled ? get(cloudBrowserEnabledByDefault$) : true;
  },
);

export const newThreadComputerUseHostId$ = computed((get): string | null => {
  const selection = get(internalNewThreadComputerAccess$);
  return selection?.kind === "computerUse" ? selection.hostId : null;
});

export const newThreadComputerAccess$ = computed(
  (get): NewThreadComputerAccess | Promise<NewThreadComputerAccess> => {
    const selection = get(internalNewThreadComputerAccess$);
    if (selection !== null) {
      return selection;
    }
    const cloudBrowserEnabled = get(newThreadCloudBrowserEnabled$);
    if (typeof cloudBrowserEnabled === "boolean") {
      return cloudBrowserEnabled ? { kind: "cloudBrowser" } : { kind: "none" };
    }
    return computerAccessFromSavedCloudBrowserDefault(cloudBrowserEnabled);
  },
);

export const setNewThreadComputerUseHostId$ = command(
  ({ set }, hostId: string | null) => {
    set(
      internalNewThreadComputerAccess$,
      hostId === null ? { kind: "none" } : { kind: "computerUse", hostId },
    );
  },
);

export const setNewThreadCloudBrowserEnabled$ = command(
  ({ set }, enabled: boolean) => {
    set(
      internalNewThreadComputerAccess$,
      enabled ? { kind: "cloudBrowser" } : { kind: "none" },
    );
  },
);

// Sending starts the next draft from scratch, so the selection goes back to the
// default instead of pinning the sent thread's choice.
export const resetNewThreadComputerAccess$ = command(({ set }) => {
  set(internalNewThreadComputerAccess$, null);
});

// -- Model picker open state ------------------------------------------------

export interface OpenTemplatePickerDialogOptions {
  readonly category: string;
  readonly referenceValue: GenerationTemplateRequest | null;
}

export type OpenTemplatePickerDialogCommand = Command<
  void,
  [OpenTemplatePickerDialogOptions]
>;

type MediaModelCategory = "image" | "video";

/**
 * Tracks whether the composer is wide enough for the desktop popover layout.
 * Both layouts show the same picker; the flag only decides whether the popover
 * is modal, since a phone-sized popup covers the page behind it anyway.
 */
function createDesktopModelPickerLayoutSignals() {
  const internalDesktopModelPickerLayout$ = state(false);
  const desktopModelPickerLayout$ = computed((get) => {
    return get(internalDesktopModelPickerLayout$);
  });
  const desktopModelPickerLifecycleRef$ = onRef(
    command(({ set }, _element: HTMLElement, signal: AbortSignal) => {
      const mediaQuery = window.matchMedia("(min-width: 640px)");
      const syncLayout = () => {
        set(internalDesktopModelPickerLayout$, mediaQuery.matches);
      };
      mediaQuery.addEventListener("change", syncLayout);
      signal.addEventListener("abort", () => {
        mediaQuery.removeEventListener("change", syncLayout);
      });
      syncLayout();
    }),
  );
  return { desktopModelPickerLayout$, desktopModelPickerLifecycleRef$ };
}

function createBasicComposerUiSignals() {
  const { desktopModelPickerLayout$, desktopModelPickerLifecycleRef$ } =
    createDesktopModelPickerLayoutSignals();
  const internalModelPickerOpen$ = state(false);
  const menu = createModelPickerMenuSignals();
  // Every viewport drives this from the same category strip. Null means the
  // chat models. It survives close the way the old composer track kept its
  // expanded category -- the video options chip and the temporary-model notice
  // both read it to tell which model the composer is pointed at.
  const internalMediaModelCategory$ = state<MediaModelCategory | null>(null);
  const modelPickerOpen$ = computed((get) => {
    return get(internalModelPickerOpen$);
  });
  const setModelPickerOpen$ = command(({ set }, open: boolean) => {
    set(internalModelPickerOpen$, open);
    if (!open) {
      set(menu.reset$);
    }
  });
  const mediaModelCategory$ = computed((get) => {
    return get(internalMediaModelCategory$);
  });
  const setMediaModelCategory$ = command(
    ({ set }, category: MediaModelCategory | null) => {
      set(internalMediaModelCategory$, category);
    },
  );
  return {
    model: {
      menu,
      modelPickerOpen$,
      setModelPickerOpen$,
      mediaModelCategory$,
      setMediaModelCategory$,
      desktopModelPickerLayout$,
      desktopModelPickerLifecycleRef$,
    },
  };
}

/**
 * Parameters for the next video this composer generates. Run-scoped by design:
 * they travel with the message and are never written anywhere, so they start
 * over with the composer rather than following the thread.
 */
function createVideoRunOptionsUiSignals() {
  // Keep the summary compact until the user opens the settings panel.
  const internalVideoOptionsOpen$ = state(false);
  const internalVideoRunOptions$ = state<VideoRunOptionsPatch>({});
  const videoOptionsOpen$ = computed((get) => {
    return get(internalVideoOptionsOpen$);
  });
  const setVideoOptionsOpen$ = command(({ set }, open: boolean) => {
    set(internalVideoOptionsOpen$, open);
  });
  const videoRunOptions$ = computed((get) => {
    return get(internalVideoRunOptions$);
  });
  const setVideoRunOptions$ = command(({ set }, next: VideoRunOptionsPatch) => {
    set(internalVideoRunOptions$, next);
  });
  const resetVideoRunOptions$ = command(({ set }) => {
    set(internalVideoOptionsOpen$, false);
    set(internalVideoRunOptions$, {});
  });
  return {
    videoOptionsOpen$,
    setVideoOptionsOpen$,
    videoRunOptions$,
    setVideoRunOptions$,
    resetVideoRunOptions$,
  };
}

function createTemplatePickerDialogSignals() {
  const internalTemplatePickerMounted$ = state(false);
  const internalTemplatePickerOpen$ = state(false);
  const templatePickerMounted$ = computed((get) => {
    return get(internalTemplatePickerMounted$);
  });
  const templatePickerOpen$ = computed((get) => {
    return get(internalTemplatePickerOpen$);
  });
  const setTemplatePickerOpen$ = command(({ set }, open: boolean) => {
    if (open) {
      set(internalTemplatePickerMounted$, true);
    }
    set(internalTemplatePickerOpen$, open);
  });
  const completeTemplatePickerClose$ = command(({ get, set }) => {
    if (get(internalTemplatePickerOpen$)) {
      return;
    }
    set(internalTemplatePickerMounted$, false);
  });

  const internalTemplatePickerReferenceValue$ =
    state<GenerationTemplateRequest | null>(null);
  const templatePickerReferenceValue$ = computed((get) => {
    return get(internalTemplatePickerReferenceValue$);
  });
  const setTemplatePickerReferenceValue$ = command(
    ({ set }, value: GenerationTemplateRequest | null) => {
      set(internalTemplatePickerReferenceValue$, value);
    },
  );

  const internalWebsiteTemplatePreviewId$ = state<string | null>(null);
  const internalWebsiteTemplatePreviewLoaded$ = state(false);
  const internalWebsiteTemplatePreviewOpen$ = state(false);
  const websiteTemplatePreviewId$ = computed((get) => {
    return get(internalWebsiteTemplatePreviewId$);
  });
  const websiteTemplatePreviewLoaded$ = computed((get) => {
    return get(internalWebsiteTemplatePreviewLoaded$);
  });
  const websiteTemplatePreviewOpen$ = computed((get) => {
    return get(internalWebsiteTemplatePreviewOpen$);
  });
  const markWebsiteTemplatePreviewLoaded$ = command(({ set }) => {
    set(internalWebsiteTemplatePreviewLoaded$, true);
  });
  const openWebsiteTemplatePreview$ = command(({ set }, templateId: string) => {
    set(internalWebsiteTemplatePreviewLoaded$, false);
    set(internalWebsiteTemplatePreviewId$, templateId);
    set(internalWebsiteTemplatePreviewOpen$, true);
  });
  const closeWebsiteTemplatePreview$ = command(({ set }) => {
    set(internalWebsiteTemplatePreviewOpen$, false);
  });
  const completeWebsiteTemplatePreviewClose$ = command(({ get, set }) => {
    if (get(internalWebsiteTemplatePreviewOpen$)) {
      return;
    }
    set(internalWebsiteTemplatePreviewLoaded$, false);
    set(internalWebsiteTemplatePreviewId$, null);
  });

  return {
    templatePickerMounted$,
    templatePickerOpen$,
    setTemplatePickerOpen$,
    completeTemplatePickerClose$,
    templatePickerReferenceValue$,
    setTemplatePickerReferenceValue$,
    websiteTemplatePreviewId$,
    websiteTemplatePreviewLoaded$,
    websiteTemplatePreviewOpen$,
    markWebsiteTemplatePreviewLoaded$,
    openWebsiteTemplatePreview$,
    closeWebsiteTemplatePreview$,
    completeWebsiteTemplatePreviewClose$,
  };
}

function createTemplatePickerListSignals() {
  const avatarTemplates = createAvatarTemplatePickerSignals();
  // Null until an entry point names a category, so the picker can open on the
  // one the member's own switches lead the nav with.
  const internalTemplatePickerCategory$ = state<string | null>(null);
  const templatePickerCategory$ = computed((get) => {
    return get(internalTemplatePickerCategory$);
  });
  const setTemplatePickerCategory$ = command(({ set }, category: string) => {
    set(internalTemplatePickerCategory$, category);
  });

  const internalTemplatePickerSearch$ = state("");
  const templatePickerSearch$ = computed((get) => {
    return get(internalTemplatePickerSearch$);
  });
  const setTemplatePickerSearch$ = command(({ set }, value: string) => {
    set(internalTemplatePickerSearch$, value);
  });

  // Selected persona pill in the workflow template tab ("all" or a category from
  // WORKFLOW_TEMPLATE_CATEGORIES). Mirrors the ideation gallery's pill filter.
  const internalTemplatePickerWorkflowCategory$ = state("all");
  const templatePickerWorkflowCategory$ = computed((get) => {
    return get(internalTemplatePickerWorkflowCategory$);
  });
  const setTemplatePickerWorkflowCategory$ = command(
    ({ set }, category: string) => {
      set(internalTemplatePickerWorkflowCategory$, category);
    },
  );

  const internalTemplatePickerPresentationScrollTop$ = state(0);
  const setTemplatePickerPresentationScrollTop$ = command(
    ({ set }, scrollTop: number) => {
      set(internalTemplatePickerPresentationScrollTop$, scrollTop);
    },
  );
  const restoreTemplatePickerPresentationScroll$ = command(
    ({ get }, node: HTMLElement) => {
      node.scrollTop = get(internalTemplatePickerPresentationScrollTop$);
    },
  );

  // Inline illustration cards show a hero image plus a variant thumbnail strip.
  // Several cards are visible at once, so the active variant index is tracked per
  // illustration style slug rather than as a single shared value.
  const internalIllustrationVariantIndex$ = state<
    Readonly<Record<string, number>>
  >({});
  const illustrationVariantIndex$ = computed((get) => {
    return get(internalIllustrationVariantIndex$);
  });
  const setIllustrationVariantIndex$ = command(
    ({ get, set }, slug: string, index: number) => {
      set(internalIllustrationVariantIndex$, {
        ...get(internalIllustrationVariantIndex$),
        [slug]: index,
      });
    },
  );

  return {
    signals: {
      templatePickerCategory$,
      setTemplatePickerCategory$,
      templatePickerSearch$,
      setTemplatePickerSearch$,
      templatePickerWorkflowCategory$,
      setTemplatePickerWorkflowCategory$,
      setTemplatePickerPresentationScrollTop$,
      restoreTemplatePickerPresentationScroll$,
      illustrationVariantIndex$,
      setIllustrationVariantIndex$,
      ...avatarTemplates,
    },
  };
}

function createOpenTemplatePickerDialogCommand(
  dialog: ReturnType<typeof createTemplatePickerDialogSignals>,
  list: ReturnType<typeof createTemplatePickerListSignals>,
  previews: ReturnType<typeof createPresentationTemplatePreviewSignals>,
): OpenTemplatePickerDialogCommand {
  return command(({ set }, options: OpenTemplatePickerDialogOptions): void => {
    set(list.signals.setTemplatePickerSearch$, "");
    set(previews.clearPresentationTemplatePreviews$);
    set(dialog.setTemplatePickerReferenceValue$, options.referenceValue);
    set(list.signals.setTemplatePickerCategory$, options.category);
    set(dialog.setTemplatePickerOpen$, true);
  });
}

function createTemplateCardSignals() {
  const internalTemplateCardThemeIdBySlug$ = state<
    Readonly<Record<string, string>>
  >({});
  const templateCardThemeIdBySlug$ = computed((get) => {
    return get(internalTemplateCardThemeIdBySlug$);
  });
  const setTemplateCardThemeId$ = command(
    ({ get, set }, slug: string, themeId: string) => {
      const next = {
        ...get(templateCardThemeIdBySlug$),
        [slug]: themeId,
      };
      set(internalTemplateCardThemeIdBySlug$, next);
    },
  );

  return {
    signals: {
      templateCardThemeIdBySlug$,
      setTemplateCardThemeId$,
    },
  };
}

export function createComposerUiSignals() {
  const basic = createBasicComposerUiSignals();
  const dialog = createTemplatePickerDialogSignals();
  const list = createTemplatePickerListSignals();
  const cards = createTemplateCardSignals();
  const previews = createPresentationTemplatePreviewSignals();
  const importedPresentationTemplates =
    createImportedPresentationTemplateSignals();

  return {
    model: basic.model,
    videoOptions: createVideoRunOptionsUiSignals(),
    openTemplatePickerDialog$: createOpenTemplatePickerDialogCommand(
      dialog,
      list,
      previews,
    ),
    template: {
      ...dialog,
      ...list.signals,
      ...cards.signals,
      ...previews,
      ...importedPresentationTemplates,
    },
  };
}

export type ComposerUiSignalGroups = ReturnType<typeof createComposerUiSignals>;
