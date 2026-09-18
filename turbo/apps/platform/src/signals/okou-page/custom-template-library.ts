import { command, computed, state } from "ccstate";
import {
  userTemplatesContract,
  type UpdateUserTemplateBody,
  type UserTemplateCatalogEntry,
  type UserTemplateDetail,
  type UserTemplateKind,
} from "@okouai/api-contracts/contracts/user-templates";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { retryTransientLoad, waitForOperation } from "../utils.ts";

const catalogVersion$ = state(0);

/**
 * Every custom template this workspace member can reach: their own, plus the
 * ones colleagues made visible to the organization. The API already returns plain
 * recency order, so nothing is re-sorted here — ownership is read from each
 * row rather than expressed as position.
 */
export const customTemplateCatalog$ = computed(
  async (get): Promise<readonly UserTemplateCatalogEntry[]> => {
    get(catalogVersion$);
    // A member without the feature has no catalog, and the routes refuse them
    // anyway. Answering here rather than at each reader is what keeps the
    // composer honest: the selected-template chip resolves against this on
    // every render, for every member, so a reader-side guard would still have
    // to subscribe — and subscribing is what issues the request.
    if (get(featureSwitch$)[FeatureSwitchKey.CustomTemplates] !== true) {
      return [];
    }
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

/**
 * Where a kind is read.
 *
 * A deck is a column of page images, which this panel can already scroll, so
 * it takes the panel over. A document and an illustration are each one file
 * read at whatever size suits it — someone else's viewer for the document, the
 * picture itself for the illustration — so both want a viewport of their own
 * and open a dialog over the catalog instead.
 *
 * Every kind answers here rather than one being what the others fall through
 * to, so a kind added to `USER_TEMPLATE_KINDS` fails this switch until someone
 * says where clicking its tile leads. Without it a new kind opens nothing and
 * the tile reads as broken.
 */
export function customTemplateSurface(
  kind: UserTemplateKind,
): "panel" | "dialog" {
  switch (kind) {
    case "presentation": {
      return "panel";
    }
    case "document":
    case "illustration": {
      return "dialog";
    }
  }
}

/**
 * The open template, with the kind that decides where it opens.
 *
 * The kind travels with the id rather than being read back from the catalog,
 * because the surface has to be chosen in the same frame as the click: waiting
 * for the detail request to say which would render one surface first and then
 * replace it.
 */
interface OpenCustomTemplate {
  readonly templateId: string;
  readonly kind: UserTemplateKind;
}

const internalOpenTemplate$ = state<OpenCustomTemplate | null>(null);

export const openCustomTemplateId$ = computed((get) => {
  return get(internalOpenTemplate$)?.templateId ?? null;
});

export const openCustomTemplateKind$ = computed((get) => {
  return get(internalOpenTemplate$)?.kind ?? null;
});

export const openCustomTemplate$ = command(
  ({ set }, template: OpenCustomTemplate) => {
    set(internalOpenTemplate$, template);
  },
);

export const closeCustomTemplate$ = command(({ set }) => {
  set(internalOpenTemplate$, null);
});

/**
 * The open template's pages. The catalog carries a cover but not the rest, so
 * the detail request only happens once something is actually opened.
 */
export const openCustomTemplateDetail$ = computed(
  async (get): Promise<UserTemplateDetail | null> => {
    const templateId = get(openCustomTemplateId$);
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

/**
 * One save, start to finish. The caller's loadable is what decides whether the
 * editor is still accepting input, so this resolves only once the surfaces that
 * editor can see are carrying the new value — the catalog behind the panel, and
 * the detail the editor itself reads. Resolving at the PATCH would reopen the
 * field on the title the server has already replaced, which is the edit the
 * member would then be correcting.
 */
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
    // Only the template still on screen has an editor waiting on its readback.
    // A visibility change made from a card, or a rename the member walked away
    // from, has no such reader — and waiting for a detail nobody is showing
    // would keep a save open on a request that is never made.
    if (get(openCustomTemplateId$) === args.templateId) {
      await waitForOperation(get(openCustomTemplateDetail$), signal);
      signal.throwIfAborted();
    }
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
    if (get(openCustomTemplateId$) === templateId) {
      set(internalOpenTemplate$, null);
    }
    await set(reloadAndAwaitCustomTemplates$, signal);
  },
);

/** Opening the picker always starts from a clean list and no open template. */
export const resetCustomTemplatePicker$ = command(({ set }) => {
  set(internalSearchQuery$, "");
  set(internalOpenTemplate$, null);
  set(reloadCustomTemplates$);
});
