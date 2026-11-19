import { command } from "ccstate";
import type {
  Suggestion,
  SuggestionOption,
} from "@okouai/api-contracts/contracts/feed";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import { defaultAgentId$ } from "../agent.ts";
import { rootSignal$ } from "../root-signal.ts";
import { navigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import {
  ensureDraft$,
  resumeThreadDraftHandoff$,
} from "../chat-page/create-chat-thread.ts";
import { sendNewThreadWithoutNavigation$ } from "../chat-page/optimistic-chat-thread-page.ts";
import {
  agentSuggestionEntries$,
  type AgentSuggestionEntry,
  linkAgentSuggestionThread$,
  restoreAgentSuggestion$,
  settleAgentSuggestion$,
} from "./agent-suggestion-session.ts";
import { createRestoredAttachment } from "./chat-draft.ts";
import {
  createMessageDocumentSnapshot,
  messageDocumentToPrompt,
} from "./user-message-document-codec.ts";
import { suggestionContextPart } from "@okouai/api-contracts/contracts/suggestion-context";
import type {
  UserMessageDocument,
  ComposerDraft,
} from "@okouai/api-contracts/contracts/chat-threads";

async function suggestionDraftVersion(draft: ComposerDraft): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(draft)),
      ),
    ),
  )
    .map((byte) => {
      return byte.toString(16).padStart(2, "0");
    })
    .join("");
}

/** The saved background as one quote whose note carries the member's direction. */
function suggestionContextDocument(
  item: Suggestion,
  contextVersion: string,
  attachmentIds: readonly string[],
  draftId: string,
  text: string,
): UserMessageDocument {
  const background =
    item.content.customOption.draft.draftUserMessage?.parts.find((part) => {
      return part.type === "feedback";
    });
  if (background?.type !== "feedback") {
    throw new Error("Missing suggestion background");
  }
  return {
    version: 1,
    parts: [
      suggestionContextPart({
        draftId,
        suggestionId: item.id,
        optionId: "custom",
        titleSnapshot: item.content.title,
        rationaleSnapshot: item.content.rationale,
        contextVersion,
        attachmentIds: [...attachmentIds],
      }),
      { ...background, note: [{ type: "text", text }] },
    ],
  };
}

function showSuggestionSent(): void {
  toast.success(
    i18n.t(($) => {
      return $.chat.agentSuggestions.sent;
    }),
  );
}

/** A card owns its draft and nonce, so browsing and explicit retries keep them. */
const sendCustomAgentSuggestion$ = command(
  async (
    { get, set },
    entry: AgentSuggestionEntry,
    text: string,
    pageSignal: AbortSignal,
  ) => {
    const submittedText = get(entry.customText$);
    const signal = get(rootSignal$);
    const agentId = await get(defaultAgentId$);
    signal.throwIfAborted();
    if (!agentId) {
      throw new Error("Suggestion target is unavailable");
    }
    const item = entry.item;
    const files = item.content.customOption.draft.draftAttachments ?? [];
    const version = await suggestionDraftVersion(
      item.content.customOption.draft,
    );
    signal.throwIfAborted();
    const document = suggestionContextDocument(
      item,
      version,
      files.map((file) => {
        return file.id;
      }),
      entry.customDraftId,
      text,
    );
    const prompt = messageDocumentToPrompt(document);
    if (prompt === null) {
      throw new Error("Invalid suggestion background");
    }
    await set(
      entry.customDraft.seed$,
      {
        content: prompt,
        userMessage: document,
        generationTemplate: undefined,
        attachments: files.map(createRestoredAttachment),
      },
      signal,
    );
    signal.throwIfAborted();
    await set(
      sendNewThreadWithoutNavigation$,
      {
        agentId,
        title: item.content.title,
        draft: entry.customDraft,
        preserveAgentDraft: true,
        prompt,
        generationTemplate: undefined,
        editorDocument: createMessageDocumentSnapshot(document),
        onOptimisticSend: (threadId) => {
          // Custom-context sends invoke this only after durable acceptance.
          set(
            settleAgentSuggestion$,
            entry,
            { type: "sent", threadId },
            pageSignal,
          );
          // A new page visit can edit the shared draft while this send is pending.
          if (get(entry.customText$) === submittedText) {
            set(entry.setCustomText$, "");
          }
          showSuggestionSent();
        },
      },
      signal,
    );
  },
);

export const submitCustomAgentSuggestion$ = command(
  ({ get, set }, entry: AgentSuggestionEntry, signal: AbortSignal) => {
    signal.throwIfAborted();
    const text = get(entry.customText$).trim();
    if (!text || get(entry.hidden$)) {
      return;
    }
    const sending = set(sendCustomAgentSuggestion$, entry, text, signal);
    set(entry.customSending$, sending);
    return sending;
  },
);

/**
 * Starts the chosen action in a new thread of the default Agent and keeps
 * home in place. The card is consumed once its input is accepted.
 */
const sendAgentSuggestionOption$ = command(
  async (
    { set },
    entry: AgentSuggestionEntry,
    option: SuggestionOption,
    agentId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const userMessage = option.draft.draftUserMessage;
    if (!userMessage) {
      throw new Error("Missing suggestion composer document");
    }
    const prompt = messageDocumentToPrompt(userMessage);
    if (prompt === null) {
      throw new Error("Invalid suggestion composer document");
    }
    const draft = entry.optionDraft;
    await set(
      draft.seed$,
      {
        content: prompt,
        userMessage,
        generationTemplate: undefined,
        attachments: (option.draft.draftAttachments ?? []).map(
          createRestoredAttachment,
        ),
      },
      signal,
    );
    signal.throwIfAborted();
    const sent = await set(
      sendNewThreadWithoutNavigation$,
      {
        agentId,
        title: entry.item.content.title,
        draft,
        preserveAgentDraft: true,
        prompt,
        generationTemplate: undefined,
        editorDocument: createMessageDocumentSnapshot(userMessage),
        onOptimisticSend: (threadId) => {
          showSuggestionSent();
          set(linkAgentSuggestionThread$, entry, threadId);
        },
      },
      signal,
    );
    if (!sent) {
      // Nothing was sent, so the card stays available for another choice.
      set(restoreAgentSuggestion$, entry);
      return;
    }
    await set(entry.enqueue$, { type: "consume", optionId: option.id }, signal);
  },
);

/**
 * An existing conversation continues in its own composer, where the member
 * joins any running work in that thread.
 */
const openAgentSuggestionThread$ = command(
  async (
    { get, set },
    option: SuggestionOption,
    threadId: string,
    signal: AbortSignal,
  ) => {
    const draft = set(ensureDraft$, threadId);
    // Installing the draft is synchronous; attachment reconciliation and
    // persistence must not delay navigation.
    const installed = set(draft.prependComposerDraft$, option.draft, signal);
    await Promise.all([
      installed,
      set(
        navigateTo$,
        ROUTES.chat,
        {
          pathParams: { threadId },
        },
        signal,
      ),
    ]);
    signal.throwIfAborted();
    // The destination normally loads and persists its handoff. An unavailable
    // target has no composer, so retain the prepared draft through that path too.
    if (get(draft.composerDraftHandoff$)) {
      await set(resumeThreadDraftHandoff$, threadId, signal);
    }
  },
);

export const startAgentSuggestion$ = command(
  async (
    { get, set },
    suggestionId: string,
    optionId: string,
    pageSignal: AbortSignal,
  ): Promise<void> => {
    const [entries, agentId] = await Promise.all([
      get(agentSuggestionEntries$),
      get(defaultAgentId$),
    ]);
    pageSignal.throwIfAborted();
    const entry = entries.find((candidate) => {
      return candidate.item.id === suggestionId;
    });
    if (!entry || get(entry.hidden$)) {
      return;
    }
    const option = entry.item.content.options.find((candidate) => {
      return candidate.id === optionId;
    });
    if (!option) {
      throw new Error("Suggestion option is unavailable");
    }
    if (!agentId) {
      throw new Error("Suggestion target is unavailable");
    }
    // The send and the recorded choice outlive the home visit.
    const signal = get(rootSignal$);
    if (option.threadId === null) {
      // The card moves below the waiting ones at once and links its thread
      // when the send publishes it.
      set(
        settleAgentSuggestion$,
        entry,
        { type: "sent", threadId: null },
        pageSignal,
      );
      const sending = set(
        sendAgentSuggestionOption$,
        entry,
        option,
        agentId,
        signal,
      );
      set(entry.sending$, sending);
      await sending;
      return;
    }
    set(entry.hidden$, true);
    // The loaded card owns this visit's choice and draft. Recording the choice
    // cannot replace it with a later server version or hold the card in place.
    await Promise.all([
      set(entry.enqueue$, { type: "consume", optionId }, signal),
      set(openAgentSuggestionThread$, option, option.threadId, signal),
    ]);
  },
);
