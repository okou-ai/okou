import { composerDraftSchema } from "@okouai/api-contracts/validators/chat-threads";
import { command, computed, state, type Command } from "ccstate";
import { currentOrgInfo$, currentUserInfo$ } from "../auth.ts";
import { composerDraftContract } from "@okouai/api-contracts/client/composer-draft";
import type {
  PersistedAttachment,
  UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { collectSuccessfulAttachmentInfos } from "../chat-page/resolve-draft-attachments.ts";
import { debounceCommand, resetSignal, withCleanup } from "../utils.ts";
import {
  createDraftSignals,
  createRestoredAttachment,
  type DraftSignals,
} from "./chat-draft.ts";
import {
  buildDraftPersistencePayload,
  type DraftPersistencePayload,
} from "./draft-persistence.ts";
import {
  draftToEditorDoc,
  messageDocumentToPrompt,
  userMessageDraftAttachments,
  type RestoredDraftState,
} from "./user-message-document-codec.ts";

const DRAFT_SYNC_DEBOUNCE_MS = 500;

export interface WorkspaceDraftEntry {
  readonly draft: DraftSignals;
  readonly load$: Command<Promise<void>, [AbortSignal]>;
  readonly queueDraftSync$: Command<Promise<void>, [AbortSignal]>;
  readonly cancelDraftSync$: Command<void, []>;
  readonly flushDraftClear$: Command<Promise<void>, [AbortSignal]>;
}

const workspaceDraftCache$ = state(new Map<string, WorkspaceDraftEntry>());

function userMessageWorkspaceDraftState(args: {
  readonly draftUserMessage?: UserMessageDocument | null;
  readonly draftAttachments: PersistedAttachment[] | null;
}): RestoredDraftState | null {
  const document = args.draftUserMessage ?? null;
  if (draftToEditorDoc(document) === null) {
    return null;
  }
  const content = document ? messageDocumentToPrompt(document) : "";
  if (content === null) {
    return null;
  }
  return {
    content,
    userMessage: document,
    attachments: document
      ? userMessageDraftAttachments(document, args.draftAttachments ?? [])
      : [],
  };
}

function createWorkspaceDraftSync(draft: DraftSignals) {
  const draftSyncReset$ = resetSignal();

  const patchDraft$ = command(
    async ({ get }, payload: DraftPersistencePayload, signal: AbortSignal) => {
      const client = get(apiClient$)(composerDraftContract);
      await accept(
        client.patch({
          body: {
            draftUserMessage: payload.userMessage,
            draftAttachments: payload.attachments,
          },
          fetchOptions: { signal },
        }),
        [204],
        signal,
      );
    },
  );

  const syncDraft$ = command(async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();

    const draftAttachments = get(draft.attachments$);
    const infos = await Promise.allSettled(
      draftAttachments.map((attachment) => {
        return get(attachment.fileInfo$);
      }),
    );
    signal.throwIfAborted();
    // A failed lookup is not evidence that a saved reference disappeared.
    // Do not overwrite the authoritative draft with an unresolved subset.
    const unresolved = infos.find((info) => {
      return info.status === "rejected";
    });
    if (unresolved?.status === "rejected") {
      throw unresolved.reason;
    }
    const attachments = collectSuccessfulAttachmentInfos(
      draftAttachments,
      infos,
    ).map((result) => {
      const annotations = get(result.attachment.annotations$);
      const annotatedFileId = get(result.attachment.annotatedFileId$);
      return {
        id: result.info.id,
        url: result.info.url,
        filename: result.attachment.filename,
        contentType: result.info.contentType,
        size: result.attachment.size,
        ...(annotatedFileId ? { annotatedFileId } : {}),
        ...(annotations ? { annotations } : {}),
      };
    });
    const payload = buildDraftPersistencePayload({
      input: get(draft.input$),
      editorDocument: set(draft.readEditorDocument$),
      restoredUserMessage: set(draft.peekRestoredUserMessage$),
      generationTemplate: get(draft.generationTemplate$),
      attachments,
    });

    await set(patchDraft$, payload, signal);
  });

  const debouncedSyncDraft$ = debounceCommand(
    syncDraft$,
    DRAFT_SYNC_DEBOUNCE_MS,
  );

  const queueDraftSync$ = command(async ({ set }, signal: AbortSignal) => {
    const debouncedSignal = set(draftSyncReset$, signal);
    await set(debouncedSyncDraft$, debouncedSignal);
  });

  const cancelDraftSync$ = command(({ set }) => {
    set(draftSyncReset$);
  });

  const flushDraftClear$ = command(async ({ set }, signal: AbortSignal) => {
    set(draftSyncReset$);
    await set(patchDraft$, { userMessage: null, attachments: null }, signal);
  });

  return { queueDraftSync$, cancelDraftSync$, flushDraftClear$ };
}

export function createWorkspaceDraftSignals(): WorkspaceDraftEntry {
  const draft = createDraftSignals();
  const sync = createWorkspaceDraftSync(draft);
  const load$ = createWorkspaceDraftLoad(draft, sync.queueDraftSync$);
  return { draft, load$, ...sync };
}

export const ensureDraft$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<WorkspaceDraftEntry> => {
    const [org, user] = await Promise.all([
      get(currentOrgInfo$),
      get(currentUserInfo$),
    ]);
    signal.throwIfAborted();
    const scope = JSON.stringify([org?.id, user?.id]);
    const cache = get(workspaceDraftCache$);
    const existing = cache.get(scope);
    if (existing) {
      return existing;
    }

    const created = createWorkspaceDraftSignals();
    const entry: WorkspaceDraftEntry = {
      draft: created.draft,
      load$: created.load$,
      queueDraftSync$: created.queueDraftSync$,
      cancelDraftSync$: created.cancelDraftSync$,
      flushDraftClear$: created.flushDraftClear$,
    };
    const next = new Map(cache);
    next.set(scope, entry);
    set(workspaceDraftCache$, next);
    return created;
  },
);

function createWorkspaceDraftHandoffSync(
  draft: DraftSignals,
  queueDraftSync$: WorkspaceDraftEntry["queueDraftSync$"],
) {
  return command(
    async (
      { get, set },
      restored: RestoredDraftState | null,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      if (!get(draft.composerDraftHandoff$)) {
        return;
      }
      // Finishing consumes and applies the handoff before its first await.
      // Persist that domain change even if attachment reconciliation rejects.
      // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
      await withCleanup(
        set(draft.finishComposerDraftHandoff$, restored, signal),
        () => {
          if (!signal.aborted) {
            return set(queueDraftSync$, signal);
          }
          return undefined;
        },
      );
    },
  );
}

function createWorkspaceDraftLoad(
  draft: DraftSignals,
  queueDraftSync$: WorkspaceDraftEntry["queueDraftSync$"],
): WorkspaceDraftEntry["load$"] {
  const finishHandoff$ = createWorkspaceDraftHandoffSync(
    draft,
    queueDraftSync$,
  );
  const revision$ = state(0);
  const serverDraft$ = computed(async (get) => {
    get(revision$);
    const result = await accept(
      get(apiClient$)(composerDraftContract).get(),
      [200],
    );
    return userMessageWorkspaceDraftState(
      composerDraftSchema.parse(result.body),
    );
  });
  const load$ = command(async ({ get, set }, signal: AbortSignal) => {
    const hasLocalDraft = (): boolean => {
      return (
        get(draft.hasLocalInput$) ||
        get(draft.generationTemplate$) !== undefined ||
        get(draft.attachments$).length > 0
      );
    };
    const handoff = get(draft.composerDraftHandoff$);
    if (hasLocalDraft() && !handoff) {
      return;
    }
    if (handoff && !handoff.needsRemoteMerge) {
      await set(finishHandoff$, null, signal);
      return;
    }

    signal.addEventListener(
      "abort",
      () => {
        set(revision$, (revision) => {
          return revision + 1;
        });
      },
      { once: true },
    );
    const restoredDraft = await get(serverDraft$);
    signal.throwIfAborted();

    if (get(draft.composerDraftHandoff$)) {
      await set(finishHandoff$, restoredDraft, signal);
      return;
    }

    // The composer is interactive while the remote draft loads. Preserve any
    // input the user added after the request started instead of replacing it
    // with the older server snapshot.
    if (hasLocalDraft()) {
      return;
    }

    if (!restoredDraft) {
      return;
    }
    const hasServerDraft =
      restoredDraft.content.length > 0 ||
      restoredDraft.userMessage !== null ||
      restoredDraft.attachments.length > 0;
    if (!hasServerDraft) {
      return;
    }

    const attachments = restoredDraft.attachments.map(createRestoredAttachment);
    // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
    await withCleanup(
      set(
        draft.seed$,
        {
          content: restoredDraft.content,
          userMessage: restoredDraft.userMessage,
          generationTemplate: undefined,
          attachments,
        },
        signal,
      ),
      () => {
        // Save only actual removals, including a user removal during rebuild.
        // A sibling rebuild failure must not strand a confirmed 404 in storage.
        if (
          !signal.aborted &&
          attachments.some((attachment) => {
            return !get(draft.attachments$).includes(attachment);
          })
        ) {
          return set(queueDraftSync$, signal);
        }
        return undefined;
      },
    );
  });
  return load$;
}

export const clearComposerDraft$ = command(
  async ({ set }, signal: AbortSignal) => {
    const entry = await set(ensureDraft$, signal);
    set(entry.draft.clear$);
    await set(entry.flushDraftClear$, signal);
  },
);
