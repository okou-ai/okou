import { onRef } from "../utils.ts";
import { command, computed, state } from "ccstate";
import { findDocumentTemplateItem } from "@okouai/core/document-template-items";

export function createDocumentTemplateSignals() {
  const previewId$ = state<string | null>(null);
  const previewPage$ = state(0);
  const imageFailures$ = state<ReadonlySet<string>>(new Set());
  const documentImageFailures$ = computed((get) => {
    return get(imageFailures$);
  });
  const failDocumentImage$ = command(({ get, set }, url: string) => {
    set(imageFailures$, new Set([...get(imageFailures$), url]));
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
  const openDocumentPreview$ = command(({ set }, id: string) => {
    set(previewId$, id);
    set(previewPage$, 0);
  });
  const closeDocumentPreview$ = command(({ set }) => {
    set(previewId$, null);
  });
  const focusDocumentPreviewRef$ = onRef<HTMLButtonElement>(
    command((_, element: HTMLButtonElement) => {
      element.focus({ preventScroll: true });
    }),
  );
  return {
    documentPreview$,
    documentPreviewPage$,
    setDocumentPreviewPage$,
    focusDocumentPreviewRef$,
    documentImageFailures$,
    failDocumentImage$,
    openDocumentPreview$,
    closeDocumentPreview$,
  };
}
