import { command, computed, state } from "ccstate";
import { presentationTemplatesContract } from "@okouai/api-contracts/client/presentation-templates";
import type {
  PresentationTemplateCatalogEntry,
  PresentationTemplateSummary,
} from "@okouai/api-contracts/contracts/presentation-templates";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import type { SharedDatabaseBridge } from "../../shared-database/bridge.ts";
import { setAblyInvalidationLoop$ } from "../realtime.ts";

const presentationTemplatesVersion$ = state(0);
const presentationTemplatesInitialization$ = state<Promise<boolean> | null>(
  null,
);
const presentationTemplatesInitialized$ = computed((get) => {
  const subscription = get(presentationTemplatesInitialization$);
  if (subscription === null) {
    throw new Error("Presentation template realtime was not initialized");
  }
  return subscription;
});
interface ImportedPresentationTemplateCatalog {
  readonly templates: readonly PresentationTemplateCatalogEntry[];
}

/**
 * The decks this workspace member can use. Their own decks come first, then
 * decks other members made visible to the workspace.
 */
const importedPresentationTemplateCatalog$ = computed(
  async (get): Promise<ImportedPresentationTemplateCatalog> => {
    get(presentationTemplatesVersion$);
    // Authentication and the shared bridge must be ready before the first read.
    // Each subscription refreshes on attachment and after continuity gaps.
    if (!(await get(presentationTemplatesInitialized$))) {
      return { templates: [] };
    }
    const client = get(apiClient$)(presentationTemplatesContract);
    const result = await accept(client.list(), [200], undefined, {
      showErrorToast: false,
    });
    return { templates: result.body };
  },
);

/** Refetch the catalog after a mutation or realtime catch-up. */
const refreshPresentationTemplates$ = command(({ get, set }) => {
  set(presentationTemplatesVersion$, get(presentationTemplatesVersion$) + 1);
});

/**
 * A template is published by the analysis runner, outside any composer or
 * browser mutation. Subscribe once at the authenticated workspace boundary so
 * navigation cannot strand a newly published deck in the thread that started
 * the analysis.
 */
const acquirePresentationTemplateSubscriptions$ = command(
  async (
    { set },
    initialization: Promise<SharedDatabaseBridge | null>,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const bridge = await initialization;
    signal.throwIfAborted();
    if (!bridge) {
      return false;
    }
    for (const scope of ["user", "org"] as const) {
      set(
        setAblyInvalidationLoop$,
        {
          scope,
          topic: "presentationTemplatesChanged",
          invalidations: [refreshPresentationTemplates$],
          options: { runOnSubscribe: true },
        },
        signal,
      );
    }
    return true;
  },
);

export const subscribePresentationTemplatesChanged$ = command(
  (
    { set },
    initialization: Promise<SharedDatabaseBridge | null>,
    signal: AbortSignal,
  ) => {
    const subscription = set(
      acquirePresentationTemplateSubscriptions$,
      initialization,
      signal,
    );
    set(presentationTemplatesInitialization$, subscription);
    return subscription;
  },
);

/** Resolve retained presentation references from existing messages and drafts. */
export function createImportedPresentationTemplateSignals() {
  const loadImportedPresentationTemplates$ = command(
    async (
      { get },
      signal: AbortSignal,
    ): Promise<readonly PresentationTemplateSummary[]> => {
      const catalog = await get(importedPresentationTemplateCatalog$);
      signal.throwIfAborted();
      return catalog.templates.map((template) => {
        return {
          ...template,
          coverUrl: template.previewAssets[0]?.url ?? template.coverUrl,
        };
      });
    },
  );
  return { loadImportedPresentationTemplates$ };
}
