import { command, computed, state } from "ccstate";
import {
  userTemplatesContract,
  type UpdateUserTemplateBody,
  type UserTemplateCatalogEntry,
  type UserTemplateDetail,
} from "@okouai/api-contracts/contracts/user-templates";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { retryTransientLoad, waitForOperation } from "../utils.ts";

const catalogVersion$ = state(0);

/**
 * Every custom template this workspace member can reach: their own, plus the
 * ones colleagues made visible to the organization. The API already returns plain
 * recency order, so nothing is re-sorted here — ownership is read from each
 * row rather than expressed as position.
 */
const customTemplateCatalog$ = computed(
  async (get): Promise<readonly UserTemplateCatalogEntry[]> => {
    get(catalogVersion$);
    const client = get(apiClient$)(userTemplatesContract);
    const result = await retryTransientLoad(() => {
      return accept(client.list(), [200]);
    });
    return result.body;
  },
);

/** Refetch after a mutation, or after the user asks to try again. */
export const reloadCustomTemplates$ = command(({ get, set }) => {
  set(catalogVersion$, get(catalogVersion$) + 1);
});

const reloadAndAwaitCustomTemplates$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    set(reloadCustomTemplates$);
    await waitForOperation(get(customTemplateCatalog$), signal);
    signal.throwIfAborted();
  },
);

const internalSearchQuery$ = state("");

export const customTemplateSearchQuery$ = computed((get) => {
  return get(internalSearchQuery$);
});

export const setCustomTemplateSearchQuery$ = command(
  ({ set }, query: string) => {
    set(internalSearchQuery$, query);
  },
);

/**
 * Title and source file name, matched case-insensitively on the already loaded
 * catalog. The file name is in scope because people remember what they called
 * the file long after they have renamed the template, and matching it also
 * makes the format searchable without a format filter existing.
 */
function matchesCustomTemplateQuery(
  template: UserTemplateCatalogEntry,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return true;
  }
  return (
    template.title.toLowerCase().includes(needle) ||
    template.sourceFilename.toLowerCase().includes(needle)
  );
}

export const visibleCustomTemplates$ = computed(
  async (get): Promise<readonly UserTemplateCatalogEntry[]> => {
    const templates = await get(customTemplateCatalog$);
    const query = get(internalSearchQuery$);
    return templates.filter((template) => {
      return matchesCustomTemplateQuery(template, query);
    });
  },
);

const internalOpenTemplateId$ = state<string | null>(null);

export const openCustomTemplateId$ = computed((get) => {
  return get(internalOpenTemplateId$);
});

export const openCustomTemplate$ = command(({ set }, templateId: string) => {
  set(internalOpenTemplateId$, templateId);
});

export const closeCustomTemplate$ = command(({ set }) => {
  set(internalOpenTemplateId$, null);
});

/**
 * The open template's pages. The catalog carries a cover but not the rest, so
 * the detail request only happens once something is actually opened.
 */
export const openCustomTemplateDetail$ = computed(
  async (get): Promise<UserTemplateDetail | null> => {
    const templateId = get(internalOpenTemplateId$);
    if (templateId === null) {
      return null;
    }
    get(catalogVersion$);
    const client = get(apiClient$)(userTemplatesContract);
    const result = await retryTransientLoad(() => {
      return accept(client.get({ params: { templateId } }), [200]);
    });
    return result.body;
  },
);

export const updateCustomTemplate$ = command(
  async (
    { get, set },
    args: {
      readonly templateId: string;
      readonly body: UpdateUserTemplateBody;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(apiClient$)(userTemplatesContract);
    await accept(
      client.update({
        params: { templateId: args.templateId },
        body: args.body,
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    await set(reloadAndAwaitCustomTemplates$, signal);
  },
);

/**
 * Deleting drops the record only. The source file and its page images are
 * ordinary uploads that may be referenced elsewhere, so the API deliberately
 * leaves them in storage.
 */
export const deleteCustomTemplate$ = command(
  async ({ get, set }, templateId: string, signal: AbortSignal) => {
    const client = get(apiClient$)(userTemplatesContract);
    await accept(
      client.delete({
        params: { templateId },
        fetchOptions: { signal },
      }),
      [204],
    );
    signal.throwIfAborted();
    if (get(internalOpenTemplateId$) === templateId) {
      set(internalOpenTemplateId$, null);
    }
    await set(reloadAndAwaitCustomTemplates$, signal);
  },
);

/** Opening the picker always starts from a clean list and no open template. */
export const resetCustomTemplatePicker$ = command(({ set }) => {
  set(internalSearchQuery$, "");
  set(internalOpenTemplateId$, null);
  set(reloadCustomTemplates$);
});
