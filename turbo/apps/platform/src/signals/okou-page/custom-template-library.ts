import { command, computed, state } from "ccstate";
import { userTemplatesContract } from "@okouai/api-contracts/client/user-templates";
import type {
  UpdateUserTemplateBody,
  UserTemplateCatalogEntry,
  UserTemplateDetail,
  UserTemplateKind,
  UserTemplateSummary,
} from "@okouai/api-contracts/contracts/user-templates";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { authenticatedSessionKey$ } from "../auth.ts";
import { setAblyInvalidationLoop$ } from "../realtime.ts";
import { rootVersion$ } from "../root-signal.ts";

const catalogVersion$ = state(0);

type ConfirmedTemplateChange = Pick<
  UserTemplateSummary,
  "id" | "title" | "visibility" | "updatedAt"
> | null;

/**
 * Only server-confirmed changes, owned by this authenticated app session.
 * Metadata cannot replace preview assets, and a successful deletion must not
 * be undone by an older catalog response. A new identity or app root releases
 * these records; they do not retain catalogs, images or detail resources.
 */
const confirmedTemplateChangesState$ = computed((get) => {
  get(authenticatedSessionKey$);
  get(rootVersion$);
  return state<ReadonlyMap<string, ConfirmedTemplateChange>>(new Map());
});

/** Also project onto retained view data while its next request is pending. */
export const projectCustomTemplate$ = computed((get) => {
  const changes = get(get(confirmedTemplateChangesState$));
  return <T extends UserTemplateSummary>(template: T): T | null => {
    const change = changes.get(template.id);
    if (change === null) {
      return null;
    }
    if (
      change === undefined ||
      Date.parse(change.updatedAt) < Date.parse(template.updatedAt)
    ) {
      return template;
    }
    return { ...template, ...change };
  };
});

/**
 * Every custom template this workspace member can reach: their own, plus the
 * ones colleagues made visible to the organization. The API already returns plain
 * recency order, so nothing is re-sorted here — ownership is read from each
 * row rather than expressed as position.
 */
const serverCustomTemplateCatalog$ = computed(
  async (get): Promise<readonly UserTemplateCatalogEntry[]> => {
    get(catalogVersion$);
    const client = get(apiClient$)(userTemplatesContract);
    const result = await accept(client.list(), [200]);
    return result.body;
  },
);

export const customTemplateCatalog$ = computed(
  async (get): Promise<readonly UserTemplateCatalogEntry[]> => {
    const project = get(projectCustomTemplate$);
    return (await get(serverCustomTemplateCatalog$)).flatMap((template) => {
      const projected = project(template);
      return projected === null ? [] : [projected];
    });
  },
);

/**
 * Read the catalog once, when a selection needs it. The composer resolves a
 * chosen template here instead of subscribing while it renders. The task
 * shelves subscribe only while shown.
 */
export const loadCustomTemplateCatalog$ = command(
  async (
    { get },
    signal: AbortSignal,
  ): Promise<readonly UserTemplateCatalogEntry[]> => {
    const catalog = await get(customTemplateCatalog$);
    signal.throwIfAborted();
    return catalog;
  },
);

/** Invalidate the catalog after a mutation or resource notification. */
export const reloadCustomTemplates$ = command(({ get, set }) => {
  set(catalogVersion$, get(catalogVersion$) + 1);
});

/**
 * Follow the catalog while this tab is not the one changing it.
 *
 * A template is published by the run that analysed the file, not by the
 * composer that sent it there, so the member who imports a file has no
 * mutation of their own to refresh on: without this, the catalog they open is
 * the one that was read before their analysis started, and the template they
 * just made is missing until they reopen its recommendation shelf.
 *
 * The topic is the one the user template routes already publish for every
 * publish, repackage, update and delete — on the organization channel while
 * the row is visible to the organization and on the user channel otherwise —
 * so both scopes are subscribed. Its name predates this catalog and says
 * presentation; what it reports is that a server-owned template catalog
 * changed, and renaming it is a change of its own.
 *
 * `runOnSubscribe` closes the window between the first read of the catalog and
 * the subscription attaching, which is the window a publish would otherwise
 * have to land in to be missed until the next mutation.
 */
export const subscribeCustomTemplatesChanged$ = command(
  ({ set }, signal: AbortSignal): void => {
    for (const scope of ["user", "org"] as const) {
      set(
        setAblyInvalidationLoop$,
        {
          scope,
          topic: "presentationTemplatesChanged",
          invalidations: [reloadCustomTemplates$],
          options: { runOnSubscribe: true },
        },
        signal,
      );
    }
  },
);

/**
 * The open template, with the kind that decides what looking at it shows.
 *
 * The kind travels with the id rather than being read back from the catalog so
 * that the dialog can open on the click that asked for it: a deck draws the
 * pages it already has and the other kinds draw their source file, and the
 * request that would say which has not answered yet.
 */
interface OpenCustomTemplate {
  readonly templateId: string;
  readonly kind: UserTemplateKind;
}

const internalOpenTemplate$ = state<OpenCustomTemplate | null>(null);

/** Which template is open, for the request that loads it and the guards that
 * clear it. It stays in this module: the dialog asks whether anything is open
 * through the kind beside it, and what to draw through the detail it loads. */
const openCustomTemplateId$ = computed((get) => {
  return get(internalOpenTemplate$)?.templateId ?? null;
});

export const openCustomTemplateKind$ = computed((get) => {
  return get(internalOpenTemplate$)?.kind ?? null;
});

const internalOpenPageIndex$ = state(0);

/** The page an open deck shows on its stage; every opening starts at page 1. */
export const openCustomTemplatePageIndex$ = computed((get) => {
  return get(internalOpenPageIndex$);
});

export const selectCustomTemplatePage$ = command(({ set }, index: number) => {
  set(internalOpenPageIndex$, index);
});

export const openCustomTemplate$ = command(
  ({ set }, template: OpenCustomTemplate) => {
    set(internalOpenTemplate$, template);
    set(internalOpenPageIndex$, 0);
  },
);

export const closeCustomTemplate$ = command(({ set }) => {
  set(internalOpenTemplate$, null);
});

/**
 * The source URL belongs to the open detail rather than the catalog. Realtime
 * changes revalidate it, while the view retains the currently loaded preview.
 */
export const openCustomTemplateDetail$ = computed(
  async (get): Promise<UserTemplateDetail | null> => {
    const templateId = get(openCustomTemplateId$);
    if (templateId === null) {
      return null;
    }
    get(catalogVersion$);
    const client = get(apiClient$)(userTemplatesContract);
    // A delete notification can revalidate the detail before its dialog closes.
    // Load failures appear inline; do not toast a stale preview.
    const result = await accept(
      client.get({ params: { templateId } }),
      [200],
      undefined,
      { showErrorToast: false },
    );
    return result.body;
  },
);

/**
 * The PATCH response is authoritative for this row's metadata. Apply it to the
 * catalog and the open editor without waiting for unrelated catalog or preview
 * requests. Realtime still reconciles external changes with the server.
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
    const changesState = get(confirmedTemplateChangesState$);
    const result = await accept(
      client.update({
        params: { templateId: args.templateId },
        body: args.body,
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(changesState, (changes) => {
      const { id, title, visibility, updatedAt } = result.body;
      const previous = changes.get(id);
      if (
        previous === null ||
        (previous !== undefined &&
          Date.parse(previous.updatedAt) > Date.parse(updatedAt))
      ) {
        return changes;
      }
      return new Map(changes).set(id, { id, title, visibility, updatedAt });
    });
  },
);

/**
 * A removal waiting for the member to confirm it. Deleting is not undoable, so
 * every entry point asks here and the preview confirms once.
 *
 * The title is captured with the request rather than looked up when the
 * question is shown: the template can leave the catalog while it is being
 * asked about, and the question must still name what it would remove.
 */
interface CustomTemplateDeletionRequest {
  readonly id: string;
  readonly title: string;
}

const internalPendingDeletion$ = state<CustomTemplateDeletionRequest | null>(
  null,
);

export const pendingCustomTemplateDeletion$ = computed((get) => {
  return get(internalPendingDeletion$);
});

export const requestDeleteCustomTemplate$ = command(
  ({ set }, request: CustomTemplateDeletionRequest) => {
    set(internalPendingDeletion$, request);
  },
);

export const cancelDeleteCustomTemplate$ = command(({ set }) => {
  set(internalPendingDeletion$, null);
});

/**
 * Deleting drops the record only. The source file and its page images are
 * ordinary uploads that may be referenced elsewhere, so the API deliberately
 * leaves them in storage.
 */
export const deleteCustomTemplate$ = command(
  async ({ get, set }, templateId: string, signal: AbortSignal) => {
    const client = get(apiClient$)(userTemplatesContract);
    const changesState = get(confirmedTemplateChangesState$);
    await accept(
      client.delete({
        params: { templateId },
        fetchOptions: { signal },
      }),
      [204],
    );
    signal.throwIfAborted();
    set(changesState, (changes) => {
      return new Map(changes).set(templateId, null);
    });
    if (get(openCustomTemplateId$) === templateId) {
      set(internalOpenTemplate$, null);
    }
    set(internalPendingDeletion$, null);
    set(reloadCustomTemplates$);
  },
);
