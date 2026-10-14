import { i18n } from "../../i18n/index.ts";
import { locale$ } from "../locale.ts";
import { onRef } from "../utils.ts";
import { command, computed, state } from "ccstate";
import {
  DOCUMENT_TEMPLATE_ITEMS,
  findDocumentTemplateItem,
  type DocumentTemplateCategory,
} from "@okouai/core/document-template-items";

export function createDocumentTemplateSignals() {
  const search$ = state("");
  const category$ = state<DocumentTemplateCategory | "all">("all");
  const previewId$ = state<string | null>(null);
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
  const documentSearch$ = computed((get) => {
    return get(search$);
  });
  const documentCategory$ = computed((get) => {
    return get(category$);
  });
  const documentPreview$ = computed((get) => {
    const id = get(previewId$);
    return id === null ? undefined : findDocumentTemplateItem(id);
  });
  const documentItems$ = computed((get) => {
    get(locale$);
    const query = get(search$).trim().toLocaleLowerCase();
    const category = get(category$);
    return DOCUMENT_TEMPLATE_ITEMS.filter((item) => {
      return (
        (category === "all" || item.category === category) &&
        `${item.title} ${item.description} ${item.category} ${i18n.t(($) => {
          return $.documentTemplates.categories[item.category];
        })}`
          .toLocaleLowerCase()
          .includes(query)
      );
    });
  });
  const setDocumentSearch$ = command(({ set }, value: string) => {
    set(search$, value);
    set(scrollTop$, 0);
  });
  const setDocumentCategory$ = command(
    ({ set }, value: DocumentTemplateCategory | "all") => {
      set(category$, value);
      set(scrollTop$, 0);
    },
  );
  const openDocumentPreview$ = command(({ set }, id: string) => {
    set(previewId$, id);
  });
  const closeDocumentPreview$ = command(({ get, set }) => {
    set(returnFocusId$, get(previewId$));
    set(previewId$, null);
  });
  const saveDocumentScroll$ = command(({ set }, value: number) => {
    set(scrollTop$, value);
  });
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
    documentSearch$,
    documentCategory$,
    documentPreview$,
    documentItems$,
    documentImageFailures$,
    failDocumentImage$,
    retryDocumentImage$,
    setDocumentSearch$,
    setDocumentCategory$,
    openDocumentPreview$,
    closeDocumentPreview$,
    saveDocumentScroll$,
    restoreDocumentScroll$,
  };
}
