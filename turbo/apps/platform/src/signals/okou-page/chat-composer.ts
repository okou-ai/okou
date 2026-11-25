import { createDocumentTemplateSignals } from "./document-template-preview.ts";
import { command, computed, state } from "ccstate";
import { onRef } from "../utils.ts";
import {
  createPresentationTemplatePreviewSignals,
  type SelectTemplatePreview,
} from "./presentation-template-preview.ts";
import { createImportedPresentationTemplateSignals } from "./presentation-template-library.ts";
import {
  cancelDeleteCustomTemplate$,
  closeCustomTemplate$,
  deleteCustomTemplate$ as deleteCustomTemplateRecord$,
  openCustomTemplate$,
} from "./custom-template-library.ts";

// A thread reaches at most one computer, so the composer holds a single
// selection rather than two flags that have to clear each other.
type NewThreadComputerAccess =
  | { readonly kind: "none" }
  | { readonly kind: "cloudBrowser" }
  | { readonly kind: "computerUse"; readonly hostId: string };

// Like the composer's model selection: `null` means the user has not picked
// anything for the current draft and the default applies, while a value is the
// user's own choice — including an explicit "no computer at all".
const internalNewThreadComputerAccess$ = state<NewThreadComputerAccess | null>(
  null,
);

export const newThreadCloudBrowserEnabled$ = computed(
  (get): boolean | undefined => {
    const selection = get(internalNewThreadComputerAccess$);
    return selection === null ? undefined : selection.kind === "cloudBrowser";
  },
);

export const newThreadComputerUseHostId$ = computed((get): string | null => {
  const selection = get(internalNewThreadComputerAccess$);
  return selection?.kind === "computerUse" ? selection.hostId : null;
});

export const newThreadComputerAccess$ = computed(
  (get): NewThreadComputerAccess | null => {
    return get(internalNewThreadComputerAccess$);
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

function createBasicComposerUiSignals() {
  const internalModelPickerOpen$ = state(false);
  const modelPickerOpen$ = computed((get) => {
    return get(internalModelPickerOpen$);
  });
  const setModelPickerOpen$ = command(({ set }, open: boolean) => {
    set(internalModelPickerOpen$, open);
  });
  return { modelPickerOpen$, setModelPickerOpen$ };
}

function createTemplatePreviewReturnFocusSignals() {
  const trigger$ = state<HTMLElement | null>(null);
  const shelf$ = state<HTMLElement | null>(null);
  const capture$ = command(({ set }) => {
    const active = document.activeElement;
    const trigger = active instanceof HTMLElement ? active : null;
    set(trigger$, trigger);
    set(shelf$, trigger?.closest<HTMLElement>("[data-rail-root]") ?? null);
  });
  const setFinalFocus$ = command(({ set }, target: HTMLElement) => {
    set(trigger$, target);
  });
  const finalFocus$ = command(({ get }) => {
    const trigger = get(trigger$);
    if (trigger?.isConnected) {
      return trigger;
    }
    // Deleting a custom template removes its Eye. Restore a surviving shelf
    // control rather than leaving focus on the page body.
    const shelf = get(shelf$);
    return shelf?.isConnected
      ? shelf.querySelector<HTMLElement>(
          'input[type="file"]:not(:disabled), button:not(:disabled)',
        )
      : null;
  });
  return { capture$, setFinalFocus$, finalFocus$ };
}

type TemplatePreviewKind = "presentation" | "document" | "website" | "custom";

function createTemplatePreviewSignals(
  presentation: ReturnType<typeof createPresentationTemplatePreviewSignals>,
  document: ReturnType<typeof createDocumentTemplateSignals>,
) {
  const focus = createTemplatePreviewReturnFocusSignals();
  const kind$ = state<TemplatePreviewKind | null>(null);
  const open$ = state(false);
  const templatePreviewKind$ = computed((get) => {
    return get(kind$);
  });
  const templatePreviewMounted$ = computed((get) => {
    return get(kind$) !== null;
  });
  const templatePreviewOpen$ = computed((get) => {
    return get(open$);
  });
  const websiteId$ = state<string | null>(null);
  const websiteLoaded$ = state(false);
  const websiteTemplatePreviewId$ = computed((get) => {
    return get(websiteId$);
  });
  const websiteTemplatePreviewLoaded$ = computed((get) => {
    return get(websiteLoaded$);
  });
  const markWebsiteTemplatePreviewLoaded$ = command(({ set }) => {
    set(websiteLoaded$, true);
  });
  const openWebsiteTemplatePreview$ = command(({ set }, id: string) => {
    set(websiteId$, id);
    set(websiteLoaded$, false);
  });
  const clearContent$ = command(({ set }) => {
    set(presentation.clearPresentationTemplatePreviews$);
    set(document.closeDocumentPreview$);
    set(closeCustomTemplate$);
    set(cancelDeleteCustomTemplate$);
    set(websiteId$, null);
    set(websiteLoaded$, false);
  });
  const openTemplatePreview$ = command(({ set }, kind: TemplatePreviewKind) => {
    // Capture before a detail's mounted ref moves focus away from its Eye.
    set(focus.capture$);
    set(clearContent$);
    set(kind$, kind);
    set(open$, true);
  });
  const closeTemplatePreview$ = command(({ set }) => {
    set(open$, false);
  });
  const completeTemplatePreviewClose$ = command(({ get, set }) => {
    if (get(open$)) {
      return;
    }
    // The real detail dialog owns exit completion; keep its content mounted
    // until then, including when it was opened without any gallery behind it.
    set(clearContent$);
    set(kind$, null);
  });
  const deleteCustomTemplate$ = command(
    async ({ set }, templateId: string, signal: AbortSignal) => {
      await set(deleteCustomTemplateRecord$, templateId, signal);
      signal.throwIfAborted();
      set(closeTemplatePreview$);
    },
  );
  const focusTemplatePreviewRef$ = onRef<HTMLDivElement>(
    command((_, element: HTMLDivElement) => {
      element.focus({ preventScroll: true });
    }),
  );
  return {
    templatePreviewKind$,
    templatePreviewMounted$,
    templatePreviewOpen$,
    openTemplatePreview$,
    closeTemplatePreview$,
    completeTemplatePreviewClose$,
    templatePreviewFinalFocus$: focus.finalFocus$,
    setTemplatePreviewFinalFocus$: focus.setFinalFocus$,
    focusTemplatePreviewRef$,
    deleteCustomTemplate$,
    websiteTemplatePreviewId$,
    websiteTemplatePreviewLoaded$,
    markWebsiteTemplatePreviewLoaded$,
    openWebsiteTemplatePreview$,
  };
}

function createPresentationTemplateThemeSignals() {
  const themes$ = state<Readonly<Record<string, string>>>({});
  return {
    presentationTemplateThemeIdBySlug$: computed((get) => {
      return get(themes$);
    }),
    setPresentationTemplateTheme$: command(
      ({ get, set }, slug: string, themeId: string) => {
        set(themes$, { ...get(themes$), [slug]: themeId });
      },
    ),
  };
}

export function createComposerUiSignals() {
  const internalAddMenuRestoreFocus$ = state(true);
  const restoreFocus$ = command(({ get }) => {
    return get(internalAddMenuRestoreFocus$);
  });
  const setRestoreFocus$ = command(({ set }, restoreFocus: boolean) => {
    set(internalAddMenuRestoreFocus$, restoreFocus);
  });
  const presentation = createPresentationTemplatePreviewSignals();
  const document = createDocumentTemplateSignals();
  return {
    model: createBasicComposerUiSignals(),
    addMenu: { restoreFocus$, setRestoreFocus$ },
    template: {
      ...createTemplatePreviewSignals(presentation, document),
      ...document,
      ...presentation,
      ...createPresentationTemplateThemeSignals(),
      ...createImportedPresentationTemplateSignals(),
    },
  };
}

export type ComposerUiSignalGroups = ReturnType<typeof createComposerUiSignals>;

type TemplateRecommendationPreview =
  | {
      readonly type: "presentation";
      readonly selection: SelectTemplatePreview;
    }
  | {
      readonly type: "website" | "document";
      readonly templateId: string;
    }
  | {
      readonly type: "custom";
      readonly kind: "presentation" | "document";
      readonly templateId: string;
    };

export function createTemplateRecommendationPreviewCommand(
  template: ComposerUiSignalGroups["template"],
) {
  return command(({ set }, preview: TemplateRecommendationPreview) => {
    set(template.openTemplatePreview$, preview.type);
    switch (preview.type) {
      case "presentation": {
        set(template.openPresentationTemplate$, preview.selection);
        break;
      }
      case "document": {
        set(template.openDocumentPreview$, preview.templateId);
        break;
      }
      case "website": {
        set(template.openWebsiteTemplatePreview$, preview.templateId);
        break;
      }
      case "custom": {
        set(openCustomTemplate$, {
          templateId: preview.templateId,
          kind: preview.kind,
        });
        break;
      }
    }
  });
}
