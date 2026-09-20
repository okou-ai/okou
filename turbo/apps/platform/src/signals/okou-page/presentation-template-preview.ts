import { command, computed, state } from "ccstate";
import {
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  type PresentationTemplateItem,
} from "@okouai/core/presentation-template-items";
import { fetchResource } from "../../lib/resource-fetch.ts";
import { readableAttachmentResourceUrl } from "../../views/okou-page/attachment-url.ts";
import {
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
  const thumbnails$ = computed(async (get) => {
    const themeCss = get(themeCss$);
    const template = await get(template$);
    return (
      template?.draft.slides.slice(0, 15).map((slide) => {
        return previewPresentationHtml({
          activeSlideId: slide.id,
          additionalHeadStyle: themeCss,
          html: template.draft.html,
          sourceUrl: template.item.embedUrl,
        });
      }) ?? []
    );
  });
  const select$ = command(({ set }, selection: SelectTemplatePreview) => {
    set(internalTemplateId$, selection.item.slug);
    set(internalSelection$, {
      index: selection.index,
      themeId: selection.themeId,
      themeCss: selection.themeCss,
    });
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
    thumbnails$,
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
    openedTemplateHtml$: opened.html$,
    openedTemplateThumbnails$: opened.thumbnails$,
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
