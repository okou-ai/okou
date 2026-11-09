import { command, computed, state } from "ccstate";
import type {
  Suggestion,
  SuggestionOption,
} from "@okouai/api-contracts/contracts/suggestions";
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
import { createAgentDraftSignals } from "./agent-draft.ts";
import { resetSignal } from "../utils.ts";
import {
  agentSuggestionEntries$,
  type AgentSuggestionEntry,
  linkAgentSuggestionThread$,
  restoreAgentSuggestion$,
  settleAgentSuggestion$,
  advanceHomeSuggestion$,
} from "./agent-suggestion-session.ts";
import { createInPlaceAgentComposerSignals } from "./agent-composer-signals.ts";
import { createRestoredAttachment } from "./chat-draft.ts";
import type { ComposerSignals } from "./composer-signals.ts";
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
): UserMessageDocument {
  const background = item.customOption.draft.draftUserMessage?.parts.find(
    (part) => {
      return part.type === "feedback";
    },
  );
  if (background?.type !== "feedback") {
    throw new Error("Missing suggestion background");
  }
  return {
    version: 1,
    parts: [
      suggestionContextPart({
        draftId: crypto.randomUUID(),
        suggestionId: item.id,
        optionId: "custom",
        titleSnapshot: item.title,
        rationaleSnapshot: item.rationale,
        contextVersion,
        attachmentIds: [...attachmentIds],
      }),
      { ...background, note: [] },
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

interface SuggestionComposerSession {
  readonly entry: AgentSuggestionEntry;
  readonly agentId: string;
  /** Ends this dialog once the composer's send is accepted. */
  readonly onOptimisticSend: (threadId: string) => void;
}

const internalSuggestionComposer$ = state<SuggestionComposerSession | null>(
  null,
);
const resetSuggestionComposer$ = resetSignal();

/**
 * One unsaved default-Agent composer per open custom-direction dialog, so the
 * Agent's own draft is neither read nor replaced.
 */
const suggestionComposerGraph$ = computed((get) => {
  const session = get(internalSuggestionComposer$);
  if (!session) {
    return null;
  }
  const agentDraft = createAgentDraftSignals(session.agentId);
  return {
    draft: agentDraft.draft,
    composer: createInPlaceAgentComposerSignals(
      session.agentId,
      agentDraft,
      session.onOptimisticSend,
    ),
  };
});

/** The card whose custom direction is being written in its dialog. */
export const agentSuggestionComposerItem$ = computed((get) => {
  return get(internalSuggestionComposer$)?.entry.item ?? null;
});

export const closeAgentSuggestionComposer$ = command(({ set }) => {
  set(resetSuggestionComposer$);
  set(internalSuggestionComposer$, null);
});

/**
 * The API consumes the card when it accepts the custom follow-up, before the
 * optimistic thread is published; the list then moves the card below the
 * waiting ones as a link to that thread.
 */
const finishAgentSuggestionComposer$ = command(
  (
    { get, set },
    session: SuggestionComposerSession,
    threadId: string,
    pageSignal: AbortSignal,
  ): void => {
    if (get(internalSuggestionComposer$) === session) {
      set(closeAgentSuggestionComposer$);
    }
    showSuggestionSent();
    set(
      settleAgentSuggestion$,
      session.entry,
      { type: "sent", threadId },
      pageSignal,
    );
    if (!pageSignal.aborted) {
      set(advanceHomeSuggestion$, session.entry);
    }
  },
);

/**
 * Opens the custom direction composer for the default Agent over home and
 * installs the card's background before the composer mounts. The session owns
 * its completion: an accepted send closes the dialog and settles the card.
 */
export const openAgentSuggestionComposer$ = command(
  async (
    { get, set },
    suggestionId: string,
    pageSignal: AbortSignal,
  ): Promise<ComposerSignals> => {
    const signal = set(resetSuggestionComposer$, pageSignal);
    const [agentId, entries] = await Promise.all([
      get(defaultAgentId$),
      get(agentSuggestionEntries$),
    ]);
    signal.throwIfAborted();
    const entry = entries.find((card) => {
      return card.item.id === suggestionId && !get(card.hidden$);
    });
    if (!agentId || !entry) {
      throw new Error("Suggestion target is unavailable");
    }
    const item = entry.item;
    const contextVersion = await suggestionDraftVersion(
      item.customOption.draft,
    );
    signal.throwIfAborted();
    const files = item.customOption.draft.draftAttachments ?? [];
    const document = suggestionContextDocument(
      item,
      contextVersion,
      files.map((file) => {
        return file.id;
      }),
    );
    const content = messageDocumentToPrompt(document);
    if (content === null) {
      throw new Error("Invalid suggestion background");
    }
    const session: SuggestionComposerSession = {
      entry,
      agentId,
      onOptimisticSend: (threadId) => {
        set(finishAgentSuggestionComposer$, session, threadId, pageSignal);
      },
    };
    set(internalSuggestionComposer$, session);
    // Leaving home or opening another card's dialog ends this session.
    signal.addEventListener(
      "abort",
      () => {
        if (get(internalSuggestionComposer$) === session) {
          set(internalSuggestionComposer$, null);
        }
      },
      { once: true },
    );
    const graph = get(suggestionComposerGraph$);
    if (!graph) {
      throw new Error("Suggestion composer is unavailable");
    }
    set(graph.composer.setup$, signal);
    await set(
      graph.draft.seed$,
      {
        content,
        userMessage: document,
        generationTemplate: undefined,
        attachments: files.map(createRestoredAttachment),
      },
      signal,
    );
    signal.throwIfAborted();
    return graph.composer;
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
    const option = entry.item.options.find((candidate) => {
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
