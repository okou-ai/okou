import { command, computed, state, type Computed } from "ccstate";
import {
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  type PresentationTemplateItem,
} from "@okouai/core/presentation-template-items";
import { fetchResource } from "../../lib/resource-fetch.ts";
import { onDomEventFn, onRef } from "../utils.ts";
import { readableAttachmentResourceUrl } from "../../views/okou-page/attachment-url.ts";
import {
  applyPresentationPreviewThemeStyle,
  parsePresentationPreviewDraft,
  previewPresentationHtml,
} from "../../views/okou-page/presentation-html-preview.ts";

interface TemplatePreviewSelection {
  readonly index: number;
  readonly themeId: string;
  readonly themeCss: string;
}

interface SelectTemplatePreview extends TemplatePreviewSelection {
  readonly item: PresentationTemplateItem;
}

function applyFrameTheme(frame: HTMLIFrameElement, themeCss: string): void {
  const frameDocument = frame.contentDocument;
  if (frameDocument !== null) {
    applyPresentationPreviewThemeStyle(frameDocument, themeCss);
  }
}

/**
 * The frames showing a template's slides, and the theme they are painted in.
 * A frame takes the current theme each time its document loads, and
 * `repaint$` restyles every mounted frame in place when the theme changes.
 */
function createThemedFrameSignals(themeCss$: Computed<string>) {
  const frames$ = state<ReadonlySet<HTMLIFrameElement>>(new Set());
  const setFrameRef$ = onRef(
    command(({ get, set }, frame: HTMLIFrameElement, signal: AbortSignal) => {
      frame.addEventListener(
        "load",
        onDomEventFn(() => {
          applyFrameTheme(frame, get(themeCss$));
        }),
        { signal },
      );
      set(frames$, (frames) => {
        return new Set(frames).add(frame);
      });
      signal.addEventListener("abort", () => {
        set(frames$, (frames) => {
          const next = new Set(frames);
          next.delete(frame);
          return next;
        });
      });
    }),
  );
  const repaint$ = command(({ get }, themeCss: string) => {
    for (const frame of get(frames$)) {
      applyFrameTheme(frame, themeCss);
    }
  });
  return { setFrameRef$, repaint$ };
}

function createTemplatePreviewSignals() {
  const internalTemplateId$ = state<string | null>(null);
  const internalSelection$ = state<TemplatePreviewSelection | null>(null);
  const templateId$ = computed((get) => {
    return get(internalTemplateId$);
  });
  const item$ = computed((get) => {
    const id = get(templateId$);
    return (
      PRESENTATION_TEMPLATE_PICKER_ITEMS.find((item) => {
        return item.slug === id;
      }) ?? null
    );
  });
  const selection$ = computed((get) => {
    const item = get(item$);
    const selection = get(internalSelection$);
    return item && selection
      ? { ...selection, slug: item.slug, embedUrl: item.embedUrl }
      : null;
  });

  // Only the selected template controls loading. Slide and theme changes reuse
  // this computed's result without retaining previously visited templates.
  const template$ = computed(async (get) => {
    const item = get(item$);
    if (item === null) {
      return null;
    }
    const response = await fetchResource(
      readableAttachmentResourceUrl(item.embedUrl),
      { mode: "cors" },
    );
    if (!response.ok) {
      throw new Error(`Failed to load template HTML (${response.status})`);
    }
    const draft = parsePresentationPreviewDraft(await response.text());
    if (draft.slides.length === 0) {
      throw new Error("Presentation template preview has no slides");
    }
    return { item, draft };
  });
  const html$ = computed(async (get) => {
    const selection = get(selection$);
    const template = await get(template$);
    if (selection === null || template === null) {
      return null;
    }
    const slide =
      template.draft.slides[
        Math.min(selection.index, template.draft.slides.length - 1)
      ];
    if (slide === undefined) {
      throw new Error("Presentation template preview slide is missing");
    }
    return previewPresentationHtml({
      activeSlideId: slide.id,
      additionalHeadStyle: selection.themeCss,
      html: template.draft.html,
      sourceUrl: template.item.embedUrl,
    });
  });
  const themeCss$ = computed((get) => {
    return get(internalSelection$)?.themeCss ?? "";
  });
  // One document per slide, without a theme. A theme is applied to the frames
  // showing them in place (`setThemedFrameRef$`), so switching it repaints
  // the slides instead of reloading every frame.
  const slideDocuments$ = computed(async (get) => {
    const template = await get(template$);
    return (
      template?.draft.slides.map((slide) => {
        return {
          id: slide.id,
          html: previewPresentationHtml({
            activeSlideId: slide.id,
            html: template.draft.html,
            sourceUrl: template.item.embedUrl,
          }),
        };
      }) ?? []
    );
  });
  const themedFrames = createThemedFrameSignals(themeCss$);
  const select$ = command(({ set }, selection: SelectTemplatePreview) => {
    set(internalTemplateId$, selection.item.slug);
    set(internalSelection$, {
      index: selection.index,
      themeId: selection.themeId,
      themeCss: selection.themeCss,
    });
    set(themedFrames.repaint$, selection.themeCss);
  });
  const clear$ = command(({ set }) => {
    set(internalTemplateId$, null);
    set(internalSelection$, null);
  });
  return {
    templateId$,
    template$,
    selection$,
    html$,
    slideDocuments$,
    setThemedFrameRef$: themedFrames.setFrameRef$,
    select$,
    clear$,
  };
}

export function createPresentationTemplatePreviewSignals() {
  const opened = createTemplatePreviewSignals();
  const preview = createTemplatePreviewSignals();
  const openPresentationTemplate$ = command(
    ({ set }, selection: SelectTemplatePreview) => {
      set(opened.select$, selection);
      set(preview.clear$);
    },
  );
  const clearPresentationTemplatePreviews$ = command(({ set }) => {
    set(opened.clear$);
    set(preview.clear$);
  });
  return {
    openedTemplateId$: opened.templateId$,
    openedTemplate$: opened.template$,
    openedTemplateSelection$: opened.selection$,
    openedTemplateSlideDocuments$: opened.slideDocuments$,
    setOpenedTemplateFrameRef$: opened.setThemedFrameRef$,
    openPresentationTemplate$,
    selectOpenedTemplate$: opened.select$,
    closeOpenedTemplate$: opened.clear$,
    previewTemplateId$: preview.templateId$,
    previewTemplate$: preview.template$,
    previewTemplateSelection$: preview.selection$,
    previewTemplateHtml$: preview.html$,
    selectPreviewTemplate$: preview.select$,
    clearPreviewTemplate$: preview.clear$,
    clearPresentationTemplatePreviews$,
  };
}
