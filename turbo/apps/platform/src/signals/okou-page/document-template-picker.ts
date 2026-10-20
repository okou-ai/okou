import { onRef } from "../utils.ts";
import { command, computed, state } from "ccstate";
import {
  DOCUMENT_TEMPLATE_ITEMS,
  findDocumentTemplateItem,
  type DocumentTemplateCategory,
} from "@okouai/core/document-template-items";

/**
 * The picker's filter: every document, the member's own, or one built-in
 * purpose. Custom is a filter like the others rather than a section above
 * them, the same model the composer's document shelf uses.
 */
type DocumentTemplatePickerCategory =
  DocumentTemplateCategory | "all" | "custom";

export function createDocumentTemplateSignals() {
  const category$ = state<DocumentTemplatePickerCategory>("all");
  const previewId$ = state<string | null>(null);
  const previewPage$ = state(0);
  const scrollTop$ = state(0);
  const returnFocusId$ = state<string | null>(null);
  const imageFailures$ = state<ReadonlySet<string>>(new Set());
  const documentImageFailures$ = computed((get) => {
    return get(imageFailures$);
  });
  const failDocumentImage$ = command(({ get, set }, url: string) => {
    set(imageFailures$, new Set([...get(imageFailures$), url]));
  });
  const retryDocumentImage$ = command(({ get, set }, url: string) => {
    set(
      imageFailures$,
      new Set(
        [...get(imageFailures$)].filter((item) => {
          return item !== url;
        }),
      ),
    );
  });
  const documentCategory$ = computed((get) => {
    return get(category$);
  });
  const documentPreview$ = computed((get) => {
    const id = get(previewId$);
    return id === null ? undefined : findDocumentTemplateItem(id);
  });
  const documentPreviewPage$ = computed((get) => {
    return get(previewPage$);
  });
  const setDocumentPreviewPage$ = command(({ get, set }, page: number) => {
    const item = get(documentPreview$);
    if (item && page >= 0 && page < item.previewPages.length) {
      set(previewPage$, page);
    }
  });
  const documentItems$ = computed((get) => {
    const category = get(category$);
    // Custom lists the member's own documents only; the pane renders those.
    return category === "custom"
      ? []
      : DOCUMENT_TEMPLATE_ITEMS.filter((item) => {
          return category === "all" || item.category === category;
        });
  });
  const setDocumentCategory$ = command(
    ({ set }, value: DocumentTemplatePickerCategory) => {
      set(category$, value);
      set(scrollTop$, 0);
    },
  );
  const openDocumentPreview$ = command(({ set }, id: string) => {
    set(previewId$, id);
    set(previewPage$, 0);
  });
  const closeDocumentPreview$ = command(({ get, set }) => {
    set(returnFocusId$, get(previewId$));
    set(previewId$, null);
  });
  const saveDocumentScroll$ = command(({ set }, value: number) => {
    set(scrollTop$, value);
  });
  const focusDocumentPreviewRef$ = onRef<HTMLButtonElement>(
    command((_, element: HTMLButtonElement) => {
      // The list trigger unmounts when its preview opens; continue at Back.
      element.focus({ preventScroll: true });
    }),
  );
  const restoreDocumentScroll$ = onRef<HTMLDivElement>(
    command(({ get, set }, element: HTMLDivElement) => {
      element.scrollTop = get(scrollTop$);
      const id = get(returnFocusId$);
      if (id !== null) {
        element
          .querySelector<HTMLButtonElement>(
            `[data-document-template-preview="${id}"]`,
          )
          ?.focus({ preventScroll: true });
        set(returnFocusId$, null);
      }
    }),
  );
  return {
    documentCategory$,
    documentPreview$,
    documentPreviewPage$,
    setDocumentPreviewPage$,
    focusDocumentPreviewRef$,
    documentItems$,
    documentImageFailures$,
    failDocumentImage$,
    retryDocumentImage$,
    setDocumentCategory$,
    openDocumentPreview$,
    closeDocumentPreview$,
    saveDocumentScroll$,
    restoreDocumentScroll$,
  };
}
