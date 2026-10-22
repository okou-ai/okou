import { command, computed, state, type Command, type Computed } from "ccstate";
import type { ChatThreadDraft } from "@okouai/api-contracts/contracts/chat-threads";
import {
  createRestoredAttachment,
  type DraftSignals,
} from "../okou-page/chat-draft.ts";
import {
  draftToEditorDoc,
  messageDocumentToPrompt,
  userMessageDraftAttachments,
  type RestoredDraftState,
} from "../okou-page/user-message-document-codec.ts";

function userMessageDraftState(
  threadDraft: ChatThreadDraft,
): RestoredDraftState | null {
  const document = threadDraft.draftUserMessage;
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
      ? userMessageDraftAttachments(
          document,
          threadDraft.draftAttachments ?? [],
        )
      : [],
  };
}

export function createThreadDraftLoad(
  threadDraft$: Computed<Promise<ChatThreadDraft | null>>,
  draft: DraftSignals,
  save$: Command<Promise<void>, [AbortSignal]>,
): Command<Promise<void>, [AbortSignal]> {
  const hasLocalDraft$ = computed((get) => {
    return (
      get(draft.hasLocalInput$) ||
      get(draft.generationTemplate$) !== undefined ||
      get(draft.attachments$).length > 0
    );
  });
  const persistencePending$ = state(false);
  const finishHandoff$ = command(
    async (
      { get, set },
      restored: RestoredDraftState | null,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      set(persistencePending$, true);
      const [finished] = await Promise.allSettled([
        get(draft.composerDraftHandoff$)
          ? set(draft.finishComposerDraftHandoff$, restored, signal)
          : set(draft.reconcileComposerDraft$, signal),
      ]);
      signal.throwIfAborted();
      // Preserve confirmed removals and marks even if rebuilding a copy fails.
      // The serializer rejects unresolved originals rather than saving a subset.
      const [saved] = await Promise.allSettled([set(save$, signal)]);
      signal.throwIfAborted();
      if (saved?.status === "fulfilled") {
        set(persistencePending$, false);
      }
      if (finished?.status === "rejected") {
        throw finished.reason;
      }
      if (saved?.status === "rejected") {
        throw saved.reason;
      }
    },
  );
  const load$ = command(async ({ get, set }, signal: AbortSignal) => {
    const handoff = get(draft.composerDraftHandoff$);
    if (!handoff && get(persistencePending$)) {
      await set(finishHandoff$, null, signal);
      return;
    }
    if (get(hasLocalDraft$) && !handoff) {
      return;
    }
    if (handoff && !handoff.needsRemoteMerge) {
      await set(finishHandoff$, null, signal);
      return;
    }
    const threadDraft = await get(threadDraft$);
    signal.throwIfAborted();

    if (get(draft.composerDraftHandoff$)) {
      await set(
        finishHandoff$,
        threadDraft ? userMessageDraftState(threadDraft) : null,
        signal,
      );
      return;
    }

    if (!threadDraft || get(hasLocalDraft$)) {
      return;
    }

    const restoredDraft = userMessageDraftState(threadDraft);
    if (!restoredDraft) {
      return;
    }
    const hasDraft =
      restoredDraft.content.length > 0 ||
      restoredDraft.userMessage !== null ||
      restoredDraft.attachments.length > 0;
    if (hasDraft) {
      const restoredAttachments = restoredDraft.attachments.map(
        createRestoredAttachment,
      );
      const removedUnavailableAttachments = await set(
        draft.seed$,
        {
          content: restoredDraft.content,
          userMessage: restoredDraft.userMessage,
          generationTemplate: undefined,
          attachments: restoredAttachments,
        },
        signal,
      );
      if (removedUnavailableAttachments) {
        await set(save$, signal);
      }
    }
  });
  return load$;
}
