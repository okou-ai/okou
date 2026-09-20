import { fetchResource } from "../../lib/resource-fetch.ts";
import { command, computed, state, type Command } from "ccstate";
import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { PresentationTemplateItem } from "@okouai/core/presentation-template-items";
import { cloudBrowserEnabledByDefault$ } from "../cloud-browser-preference.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { onRef, tapError } from "../utils.ts";
import type { TemplatePreviewRuntime } from "./template-preview-runtime.ts";
import {
  parsePresentationPreviewDraft,
  previewPresentationHtml,
  type PresentationPreviewDraft,
} from "../../views/okou-page/presentation-html-preview.ts";
import { readableAttachmentResourceUrl } from "../../views/okou-page/attachment-url.ts";
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

export interface TemplateCardHtmlPreviewState {
  readonly slug: string;
  readonly embedUrl: string;
  readonly themeId: string;
  readonly loading: boolean;
  readonly frameUrl: string | null;
  readonly slideCount: number;
}

export interface OpenTemplatePickerDialogOptions {
  readonly category: string;
  readonly referenceValue: GenerationTemplateRequest | null;
}

export type OpenTemplatePickerDialogCommand = Command<
  void,
  [OpenTemplatePickerDialogOptions]
>;

interface TemplateCardHoverState {
  readonly slug: string;
  readonly index: number;
}

interface TemplateDetailHtmlPreviewState {
  readonly slug: string;
  readonly embedUrl: string;
  readonly themeId: string;
  readonly themeCss: string;
  readonly index: number;
  readonly loading: boolean;
  readonly frameLoaded: boolean;
  readonly frameUrl: string | null;
  readonly previousFrameSlideIndex: number | null;
  readonly previousFrameUrl: string | null;
  readonly slideCount: number;
}

interface PresentationTemplateDetailSelection {
  readonly embedUrl: string;
  readonly index: number;
  readonly slug: string;
  readonly themeCss: string;
  readonly themeId: string;
}

interface PresentationTemplateDetailSelectionParams {
  readonly index: number;
  readonly item: PresentationTemplateItem;
  readonly runtime: TemplatePreviewRuntime;
  readonly themeCss: string;
  readonly themeId: string;
}

interface LoadedTemplateDetailFrame {
  readonly slideIndex: number;
  readonly url: string;
}

function presentationTemplateDetailSlideCount(
  item: PresentationTemplateItem,
): number {
  return Math.max(item.slideCount ?? item.previewImages.length, 1);
}

function presentationTemplateDetailPreviewState(params: {
  readonly draft: PresentationPreviewDraft;
  readonly item: PresentationTemplateItem;
  readonly selection: PresentationTemplateDetailSelection;
}): TemplateDetailHtmlPreviewState {
  const slide =
    params.draft.slides[
      Math.min(params.selection.index, params.draft.slides.length - 1)
    ];
  if (slide === undefined) {
    throw new Error("Presentation template preview draft has no slides");
  }
  const frameUrl = URL.createObjectURL(
    new Blob(
      [
        previewPresentationHtml({
          activeSlideId: slide.id,
          additionalHeadStyle: params.selection.themeCss,
          html: params.draft.html,
        }),
      ],
      { type: "text/html;charset=utf-8" },
    ),
  );
  return {
    slug: params.item.slug,
    embedUrl: params.item.embedUrl,
    themeId: params.selection.themeId,
    themeCss: params.selection.themeCss,
    index: params.selection.index,
    loading: false,
    frameLoaded: false,
    frameUrl,
    previousFrameSlideIndex: null,
    previousFrameUrl: null,
    slideCount: params.draft.slides.length,
  };
}

function previousTemplateDetailFrame(
  current: TemplateDetailHtmlPreviewState | null,
): LoadedTemplateDetailFrame | null {
  if (current?.frameLoaded && current.frameUrl !== null) {
    return { slideIndex: current.index, url: current.frameUrl };
  }
  if (
    current?.previousFrameUrl !== null &&
    current?.previousFrameUrl !== undefined &&
    current.previousFrameSlideIndex !== null
  ) {
    return {
      slideIndex: current.previousFrameSlideIndex,
      url: current.previousFrameUrl,
    };
  }
  return null;
}

function templateDetailFrameUrls(
  preview: TemplateDetailHtmlPreviewState | null,
): ReadonlySet<string> {
  const frameUrls = new Set<string>();
  if (preview?.frameUrl !== null && preview?.frameUrl !== undefined) {
    frameUrls.add(preview.frameUrl);
  }
  if (
    preview?.previousFrameUrl !== null &&
    preview?.previousFrameUrl !== undefined
  ) {
    frameUrls.add(preview.previousFrameUrl);
  }
  return frameUrls;
}

function revokeUnusedTemplateDetailFrameUrls(
  frameUrls: ReadonlySet<string>,
  retainedFrameUrls: ReadonlySet<string>,
): void {
  for (const frameUrl of frameUrls) {
    if (!retainedFrameUrls.has(frameUrl)) {
      URL.revokeObjectURL(frameUrl);
    }
  }
}

async function loadPresentationTemplateHtmlPreview(
  params: {
    readonly item: PresentationTemplateItem;
  },
  signal: AbortSignal,
): Promise<PresentationPreviewDraft | null> {
  const response = await fetchResource(
    readableAttachmentResourceUrl(params.item.embedUrl),
    {
      mode: "cors",
    },
    signal,
  );
  if (!response.ok) {
    throw new Error(`Failed to load template HTML (${response.status})`);
  }
  const draft = parsePresentationPreviewDraft(await response.text());
  return draft.slides.length > 0 ? draft : null;
}

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

  const internalTemplatePickerPreviewSlug$ = state<string | null>(null);
  const templatePickerPreviewSlug$ = computed((get) => {
    return get(internalTemplatePickerPreviewSlug$);
  });
  const setTemplatePickerPreviewSlug$ = command(
    ({ set }, slug: string | null) => {
      set(internalTemplatePickerPreviewSlug$, slug);
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
      templatePickerPreviewSlug$,
      setTemplatePickerPreviewSlug$,
      setTemplatePickerPresentationScrollTop$,
      restoreTemplatePickerPresentationScroll$,
      illustrationVariantIndex$,
      setIllustrationVariantIndex$,
      ...avatarTemplates,
    },
    internalTemplatePickerPreviewSlug$,
  };
}

function createOpenTemplatePickerDialogCommand(
  dialog: ReturnType<typeof createTemplatePickerDialogSignals>,
  list: ReturnType<typeof createTemplatePickerListSignals>,
): OpenTemplatePickerDialogCommand {
  return command(({ set }, options: OpenTemplatePickerDialogOptions): void => {
    set(list.signals.setTemplatePickerSearch$, "");
    set(list.signals.setTemplatePickerPreviewSlug$, null);
    set(dialog.setTemplatePickerReferenceValue$, options.referenceValue);
    set(list.signals.setTemplatePickerCategory$, options.category);
    set(dialog.setTemplatePickerOpen$, true);
  });
}

function createTemplateCardSignals() {
  const internalTemplateCardHover$ = state<TemplateCardHoverState | null>(null);
  const templateCardHover$ = computed((get) => {
    return get(internalTemplateCardHover$);
  });
  const setTemplateCardHover$ = command(
    ({ set }, value: TemplateCardHoverState | null) => {
      set(internalTemplateCardHover$, value);
    },
  );

  const internalTemplateCardHtmlPreview$ =
    state<TemplateCardHtmlPreviewState | null>(null);
  const templateCardHtmlPreview$ = computed((get) => {
    return get(internalTemplateCardHtmlPreview$);
  });
  const setTemplateCardHtmlPreview$ = command(
    ({ set }, value: TemplateCardHtmlPreviewState | null) => {
      set(internalTemplateCardHtmlPreview$, value);
    },
  );

  const internalTemplateCardLoadedHtmlFrameUrls$ = state<
    Readonly<Record<string, string>>
  >({});
  const templateCardLoadedHtmlFrameUrls$ = computed((get) => {
    return get(internalTemplateCardLoadedHtmlFrameUrls$);
  });
  const setTemplateCardLoadedHtmlFrameUrl$ = command(
    ({ get, set }, key: string, frameUrl: string) => {
      set(internalTemplateCardLoadedHtmlFrameUrls$, {
        ...get(internalTemplateCardLoadedHtmlFrameUrls$),
        [key]: frameUrl,
      });
    },
  );

  const clearTemplateCardHtmlPreviewFrames$ = command(({ get, set }) => {
    const activeFrameUrl = get(internalTemplateCardHtmlPreview$)?.frameUrl;
    const frameUrls = new Set(
      Object.values(get(internalTemplateCardLoadedHtmlFrameUrls$)),
    );
    if (activeFrameUrl !== null && activeFrameUrl !== undefined) {
      frameUrls.add(activeFrameUrl);
    }
    for (const frameUrl of frameUrls) {
      URL.revokeObjectURL(frameUrl);
    }
    set(internalTemplateCardHtmlPreview$, null);
    set(internalTemplateCardLoadedHtmlFrameUrls$, {});
  });

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
      templateCardHover$,
      setTemplateCardHover$,
      templateCardHtmlPreview$,
      setTemplateCardHtmlPreview$,
      templateCardLoadedHtmlFrameUrls$,
      setTemplateCardLoadedHtmlFrameUrl$,
      templateCardThemeIdBySlug$,
      setTemplateCardThemeId$,
    },
    internalTemplateCardHover$,
    clearTemplateCardHtmlPreviewFrames$,
  };
}

function createTemplateDetailStateSignals() {
  const internalTemplateDetailHtmlPreview$ =
    state<TemplateDetailHtmlPreviewState | null>(null);
  const templateDetailHtmlPreview$ = computed((get) => {
    return get(internalTemplateDetailHtmlPreview$);
  });
  const replaceTemplateDetailHtmlPreview$ = command(
    ({ get, set }, value: TemplateDetailHtmlPreviewState | null) => {
      const current = get(internalTemplateDetailHtmlPreview$);
      if (value === null) {
        revokeUnusedTemplateDetailFrameUrls(
          templateDetailFrameUrls(current),
          new Set(),
        );
        set(internalTemplateDetailHtmlPreview$, null);
        return;
      }

      const previousFrame = previousTemplateDetailFrame(current);
      const retainedFrameUrls = new Set<string>();
      if (value.frameUrl !== null) {
        retainedFrameUrls.add(value.frameUrl);
      }
      if (previousFrame !== null) {
        retainedFrameUrls.add(previousFrame.url);
      }
      revokeUnusedTemplateDetailFrameUrls(
        templateDetailFrameUrls(current),
        retainedFrameUrls,
      );
      set(internalTemplateDetailHtmlPreview$, {
        ...value,
        previousFrameSlideIndex: previousFrame?.slideIndex ?? null,
        previousFrameUrl: previousFrame?.url ?? null,
      });
    },
  );

  const settlePresentationTemplateDetailPreviewFrame$ = command(
    ({ get, set }, frameUrl: string): void => {
      const current = get(internalTemplateDetailHtmlPreview$);
      if (current?.frameUrl !== frameUrl) {
        return;
      }
      if (current.previousFrameUrl !== null) {
        URL.revokeObjectURL(current.previousFrameUrl);
      }
      set(internalTemplateDetailHtmlPreview$, {
        ...current,
        frameLoaded: true,
        previousFrameSlideIndex: null,
        previousFrameUrl: null,
      });
    },
  );

  return {
    signals: {
      templateDetailHtmlPreview$,
      settlePresentationTemplateDetailPreviewFrame$,
    },
    internalTemplateDetailHtmlPreview$,
    replaceTemplateDetailHtmlPreview$,
  };
}

function createTemplatePreviewResourceSignals(
  list: ReturnType<typeof createTemplatePickerListSignals>,
  cards: ReturnType<typeof createTemplateCardSignals>,
  detail: ReturnType<typeof createTemplateDetailStateSignals>,
) {
  const releaseTemplatePickerPreviewResources$ = command(
    ({ set }, runtime: TemplatePreviewRuntime) => {
      const preview = runtime.presentation;
      preview.detailRequestToken = null;
      for (const animationFrame of preview.pendingSlideAnimationFrames.values()) {
        window.cancelAnimationFrame(animationFrame);
      }
      preview.pendingSlideAnimationFrames.clear();
      preview.pendingSlideIndexes.clear();
      preview.activeIndexes.clear();
      preview.activeTokens.clear();
      set(cards.clearTemplateCardHtmlPreviewFrames$);
      set(cards.internalTemplateCardHover$, null);
      set(detail.replaceTemplateDetailHtmlPreview$, null);
      set(list.internalTemplatePickerPreviewSlug$, null);
    },
  );

  const ownTemplatePickerPreviewResources$ = command(
    ({ set }, runtime: TemplatePreviewRuntime, signal: AbortSignal): void => {
      const preview = runtime.presentation;
      if (preview.previewOwnerSignal === signal) {
        return;
      }
      preview.previewOwnerSignal = signal;
      signal.addEventListener(
        "abort",
        () => {
          if (preview.previewOwnerSignal !== signal) {
            return;
          }
          preview.previewOwnerSignal = null;
          set(releaseTemplatePickerPreviewResources$, runtime);
        },
        { once: true },
      );
    },
  );

  return {
    releaseTemplatePickerPreviewResources$,
    ownTemplatePickerPreviewResources$,
  };
}

function createApplyPresentationTemplateDetailSelectionSignal(
  detail: ReturnType<typeof createTemplateDetailStateSignals>,
) {
  return command(
    (
      { set },
      runtime: TemplatePreviewRuntime,
      item: PresentationTemplateItem,
      selection: PresentationTemplateDetailSelection,
    ) => {
      const draft = runtime.presentation.drafts.get(item.embedUrl);
      if (draft !== undefined) {
        set(
          detail.replaceTemplateDetailHtmlPreview$,
          presentationTemplateDetailPreviewState({
            draft,
            item,
            selection,
          }),
        );
        return;
      }

      const failed = runtime.presentation.failed.has(item.embedUrl);
      set(detail.replaceTemplateDetailHtmlPreview$, {
        slug: item.slug,
        embedUrl: item.embedUrl,
        themeId: selection.themeId,
        themeCss: selection.themeCss,
        index: selection.index,
        loading: !failed,
        frameLoaded: false,
        frameUrl: null,
        previousFrameSlideIndex: null,
        previousFrameUrl: null,
        slideCount: presentationTemplateDetailSlideCount(item),
      });
    },
  );
}

function createOpenPresentationTemplateDetailPreviewSignal(
  list: ReturnType<typeof createTemplatePickerListSignals>,
  detail: ReturnType<typeof createTemplateDetailStateSignals>,
  resources: ReturnType<typeof createTemplatePreviewResourceSignals>,
  applySelection$: ReturnType<
    typeof createApplyPresentationTemplateDetailSelectionSignal
  >,
) {
  return command(
    async (
      { get, set },
      params: PresentationTemplateDetailSelectionParams,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      const cache = params.runtime.presentation;
      set(resources.ownTemplatePickerPreviewResources$, params.runtime, signal);
      const token = Symbol(params.item.embedUrl);
      const selection: PresentationTemplateDetailSelection = {
        embedUrl: params.item.embedUrl,
        index: params.index,
        slug: params.item.slug,
        themeCss: params.themeCss,
        themeId: params.themeId,
      };
      cache.detailRequestToken = token;
      set(applySelection$, params.runtime, params.item, selection);
      set(list.internalTemplatePickerPreviewSlug$, params.item.slug);

      if (
        cache.drafts.has(params.item.embedUrl) ||
        cache.failed.has(params.item.embedUrl)
      ) {
        return;
      }

      let pendingLoad = cache.pendingLoads.get(params.item.embedUrl);
      if (pendingLoad === undefined) {
        pendingLoad = loadPresentationTemplateHtmlPreview(
          {
            item: params.item,
          },
          signal,
        );
        cache.pendingLoads.set(params.item.embedUrl, pendingLoad);
      }

      const result = await tapError(
        pendingLoad.finally(() => {
          if (cache.pendingLoads.get(params.item.embedUrl) === pendingLoad) {
            cache.pendingLoads.delete(params.item.embedUrl);
          }
        }),
      );
      signal.throwIfAborted();

      if (result === undefined || result === null) {
        cache.failed.add(params.item.embedUrl);
      } else {
        cache.drafts.set(params.item.embedUrl, result);
      }

      if (cache.detailRequestToken !== token) {
        return;
      }
      const activeDetail = get(detail.internalTemplateDetailHtmlPreview$);
      if (
        activeDetail === null ||
        activeDetail.embedUrl !== params.item.embedUrl ||
        activeDetail.slug !== params.item.slug
      ) {
        return;
      }
      set(applySelection$, params.runtime, params.item, {
        embedUrl: activeDetail.embedUrl,
        index: activeDetail.index,
        slug: activeDetail.slug,
        themeCss: activeDetail.themeCss,
        themeId: activeDetail.themeId,
      });
    },
  );
}

function createPresentationTemplateDetailNavigationSignals(
  list: ReturnType<typeof createTemplatePickerListSignals>,
  detail: ReturnType<typeof createTemplateDetailStateSignals>,
  applySelection$: ReturnType<
    typeof createApplyPresentationTemplateDetailSelectionSignal
  >,
) {
  const selectPresentationTemplateDetailPreview$ = command(
    ({ get, set }, params: PresentationTemplateDetailSelectionParams) => {
      const activeDetail = get(detail.internalTemplateDetailHtmlPreview$);
      if (
        activeDetail === null ||
        activeDetail.embedUrl !== params.item.embedUrl ||
        activeDetail.slug !== params.item.slug
      ) {
        return;
      }
      set(applySelection$, params.runtime, params.item, {
        embedUrl: params.item.embedUrl,
        index: params.index,
        slug: params.item.slug,
        themeCss: params.themeCss,
        themeId: params.themeId,
      });
    },
  );

  const closePresentationTemplateDetailPreview$ = command(
    ({ set }, runtime: TemplatePreviewRuntime) => {
      runtime.presentation.detailRequestToken = null;
      set(detail.replaceTemplateDetailHtmlPreview$, null);
      set(list.internalTemplatePickerPreviewSlug$, null);
    },
  );

  return {
    selectPresentationTemplateDetailPreview$,
    closePresentationTemplateDetailPreview$,
  };
}

export function createComposerUiSignals() {
  const basic = createBasicComposerUiSignals();
  const dialog = createTemplatePickerDialogSignals();
  const list = createTemplatePickerListSignals();
  const cards = createTemplateCardSignals();
  const detail = createTemplateDetailStateSignals();
  const importedPresentationTemplates =
    createImportedPresentationTemplateSignals();
  const resources = createTemplatePreviewResourceSignals(list, cards, detail);
  const applySelection$ =
    createApplyPresentationTemplateDetailSelectionSignal(detail);
  const openPresentationTemplateDetailPreview$ =
    createOpenPresentationTemplateDetailPreviewSignal(
      list,
      detail,
      resources,
      applySelection$,
    );

  return {
    model: basic.model,
    videoOptions: createVideoRunOptionsUiSignals(),
    openTemplatePickerDialog$: createOpenTemplatePickerDialogCommand(
      dialog,
      list,
    ),
    template: {
      ...dialog,
      ...list.signals,
      ...cards.signals,
      ...detail.signals,
      ...importedPresentationTemplates,
      ...resources,
      loadPresentationTemplateHtmlPreview,
      openPresentationTemplateDetailPreview$,
      ...createPresentationTemplateDetailNavigationSignals(
        list,
        detail,
        applySelection$,
      ),
    },
  };
}

export type ComposerUiSignalGroups = ReturnType<typeof createComposerUiSignals>;
