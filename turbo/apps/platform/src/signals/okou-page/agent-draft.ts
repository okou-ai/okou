import { command, computed, state, type Command } from "ccstate";
import {
  agentDraftContract,
  agentDraftResponseSchema,
} from "@okouai/api-contracts/contracts/agent-draft";
import type {
  PersistedAttachment,
  UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { debounceCommand } from "../command-scheduling.ts";
import { collectSuccessfulAttachmentInfos } from "../chat-page/resolve-draft-attachments.ts";
import { resetSignal } from "../utils.ts";
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

interface AgentDraftEntry {
  readonly draft: DraftSignals;
  readonly load$: Command<Promise<void>, [AbortSignal]>;
  readonly queueDraftSync$: Command<Promise<void>, [AbortSignal]>;
  readonly cancelDraftSync$: Command<void, []>;
  readonly flushDraftClear$: Command<Promise<void>, [AbortSignal]>;
}

export type EnsuredAgentDraft = AgentDraftEntry;

const agentDraftCache$ = state(new Map<string, AgentDraftEntry>());

function userMessageAgentDraftState(args: {
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

function createAgentDraftSync(agentId: string, draft: DraftSignals) {
  const draftSyncReset$ = resetSignal();

  const patchDraft$ = command(
    async ({ get }, payload: DraftPersistencePayload, signal: AbortSignal) => {
      const client = get(apiClient$)(agentDraftContract);
      await accept(
        client.patch({
          params: { id: agentId },
          body: {
            draftUserMessage: payload.userMessage,
            draftAttachments: payload.attachments,
          },
          fetchOptions: { signal },
        }),
        [200, 204],
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

export function createAgentDraftSignals(agentId: string): EnsuredAgentDraft {
  const draft = createDraftSignals();
  const sync = createAgentDraftSync(agentId, draft);
  const load$ = createAgentDraftLoad(agentId, draft, sync.queueDraftSync$);
  return { draft, load$, ...sync };
}

export const ensureAgentDraft$ = command(
  ({ get, set }, agentId: string): EnsuredAgentDraft => {
    const cache = get(agentDraftCache$);
    const existing = cache.get(agentId);
    if (existing) {
      return existing;
    }

    const created = createAgentDraftSignals(agentId);
    const entry: AgentDraftEntry = {
      draft: created.draft,
      load$: created.load$,
      queueDraftSync$: created.queueDraftSync$,
      cancelDraftSync$: created.cancelDraftSync$,
      flushDraftClear$: created.flushDraftClear$,
    };
    const next = new Map(cache);
    next.set(agentId, entry);
    set(agentDraftCache$, next);
    return created;
  },
);

function createAgentDraftLoad(
  agentId: string,
  draft: DraftSignals,
  queueDraftSync$: AgentDraftEntry["queueDraftSync$"],
): AgentDraftEntry["load$"] {
  const revision$ = state(0);
  const serverDraft$ = computed(async (get) => {
    get(revision$);
    const result = await accept(
      get(apiClient$)(agentDraftContract).get({ params: { id: agentId } }),
      [200],
    );
    return userMessageAgentDraftState(
      agentDraftResponseSchema.parse(result.body),
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
    const handoff = get(draft.recommendationHandoff$);
    if (hasLocalDraft() && !handoff) {
      return;
    }
    if (handoff && !handoff.needsRemoteMerge) {
      if (await set(draft.finishRecommendationHandoff$, null, signal)) {
        await set(queueDraftSync$, signal);
      }
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

    if (get(draft.recommendationHandoff$)) {
      if (
        await set(draft.finishRecommendationHandoff$, restoredDraft, signal)
      ) {
        await set(queueDraftSync$, signal);
      }
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

    const removedUnavailableAttachments = await set(
      draft.seed$,
      {
        content: restoredDraft.content,
        userMessage: restoredDraft.userMessage,
        generationTemplate: undefined,
        attachments: restoredDraft.attachments.map(createRestoredAttachment),
      },
      signal,
    );
    if (removedUnavailableAttachments) {
      await set(queueDraftSync$, signal);
    }
  });
  return load$;
}

export const clearAgentDraftById$ = command(
  async ({ set }, agentId: string, signal: AbortSignal) => {
    const entry = set(ensureAgentDraft$, agentId);
    set(entry.draft.clear$);
    await set(entry.flushDraftClear$, signal);
  },
);
