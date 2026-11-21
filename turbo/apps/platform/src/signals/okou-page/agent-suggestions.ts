import { command, computed, state } from "ccstate";
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
import { resetSignal } from "../utils.ts";
import { createThreadMetaLookup } from "../chat-page/chat-thread-event-sourcing.ts";
import {
  createInPlaceThreadComposerSignals,
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
import { createInPlaceAgentComposerSignals } from "./agent-composer-signals.ts";
import { createRestoredAttachment } from "./chat-draft.ts";
import type {
  ComposerSignals,
  ComposerSubmission,
} from "./composer-signals.ts";
import {
  createMessageDocumentSnapshot,
  messageDocumentToPrompt,
} from "./user-message-document-codec.ts";
import {
  suggestionContextPart,
  suggestionFeedbacks,
} from "@okouai/api-contracts/contracts/suggestion-context";
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

/**
 * The saved background as one quote that waits for the member's direction.
 * The card's quote keeps one identity, so replaying an unknown outcome resolves
 * to the same follow-up.
 */
function suggestionContextDocument(
  item: Suggestion,
  contextVersion: string,
  attachmentIds: readonly string[],
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
        draftId: item.id,
        suggestionId: item.id,
        optionId: "custom",
        titleSnapshot: item.content.title,
        rationaleSnapshot: item.content.rationale,
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

interface SuggestionThreadTarget {
  readonly kind: "thread";
  readonly id: string;
}

/**
 * A custom direction continues the chat the card names, or starts a new chat
 * when the card names none or that chat is no longer available.
 */
type SuggestionDirectionTarget =
  { readonly kind: "new"; readonly agentId: string } | SuggestionThreadTarget;

interface SuggestionDirectionSession {
  readonly entry: AgentSuggestionEntry;
  readonly target: SuggestionDirectionTarget;
  /** Closes the composer and settles the card once a send is accepted. */
  readonly finish: (threadId: string, submission: ComposerSubmission) => void;
}

const internalDirectionSession$ = state<SuggestionDirectionSession | null>(
  null,
);
const resolveDirectionThreadMeta$ = createThreadMetaLookup();
const internalDirectionComposer$ = state<Promise<ComposerSignals> | null>(null);
const resetDirection$ = resetSignal();

/**
 * One unsaved composer for the card's target, so neither the default Agent's
 * draft nor the target thread's saved draft is read or replaced.
 */
const directionGraph$ = computed((get) => {
  const session = get(internalDirectionSession$);
  if (!session) {
    return null;
  }
  const { target } = session;
  if (target.kind === "new") {
    return {
      kind: target.kind,
      composer: createInPlaceAgentComposerSignals(
        target.agentId,
        (threadId, submission) => {
          session.finish(threadId, submission);
        },
        session.entry.item.content.title,
      ),
    };
  }
  return {
    kind: target.kind,
    ...createInPlaceThreadComposerSignals(target.id, (submission) => {
      session.finish(target.id, submission);
    }),
  };
});

export const suggestionDirectionItemId$ = computed((get) => {
  return get(internalDirectionSession$)?.entry.item.id ?? null;
});

export const suggestionDirectionComposer$ = computed((get) => {
  return get(internalDirectionComposer$);
});

const closeSuggestionDirection$ = command(({ set }) => {
  set(resetDirection$);
  set(internalDirectionComposer$, null);
  set(internalDirectionSession$, null);
});

/**
 * An accepted send closes the composer and moves the card below the waiting ones
 * as a link to the chat that received it. The API consumes the card when it
 * accepts the follow-up.
 */
const finishSuggestionDirection$ = command(
  (
    { get, set },
    session: SuggestionDirectionSession,
    sent: {
      readonly threadId: string;
      readonly submission: ComposerSubmission;
    },
    pageSignal: AbortSignal,
  ): void => {
    const { threadId, submission } = sent;
    if (get(internalDirectionSession$) === session) {
      set(closeSuggestionDirection$);
    }
    const document = submission.editorDocument.toMessageDocument();
    if (
      !document ||
      !suggestionFeedbacks(document).some(({ context }) => {
        return context.suggestionId === session.entry.item.id;
      })
    ) {
      return;
    }
    if (session.target.kind === "new") {
      showSuggestionSent();
    } else {
      toast.success(
        i18n.t(($) => {
          return $.chat.agentSuggestions.sentToChat;
        }),
      );
    }
    set(
      settleAgentSuggestion$,
      session.entry,
      { type: "sent", threadId },
      pageSignal,
    );
  },
);

/** Installs the card's background before the target's composer mounts. */
const prepareDirectionComposer$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<ComposerSignals> => {
    const session = get(internalDirectionSession$);
    const graph = get(directionGraph$);
    if (!session || !graph) {
      throw new Error("Suggestion direction is unavailable");
    }
    if (graph.kind === "new") {
      set(graph.composer.setup$, signal);
    } else {
      await set(graph.setup$, signal);
    }
    const item = session.entry.item;
    const files = item.content.customOption.draft.draftAttachments ?? [];
    const contextVersion = await suggestionDraftVersion(
      item.content.customOption.draft,
    );
    signal.throwIfAborted();
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
    await set(
      graph.composer.draft.seed$,
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
 * Opens the custom direction editor for a card. The card decides where the
 * member's direction goes: the chat it names, or a new chat of the default
 * Agent when it names none or that chat is gone.
 */
export const openSuggestionDirection$ = command(
  async (
    { get, set },
    entry: AgentSuggestionEntry,
    pageSignal: AbortSignal,
  ): Promise<void> => {
    const signal = set(resetDirection$, pageSignal);
    set(internalDirectionComposer$, null);
    const agentId = await get(defaultAgentId$);
    signal.throwIfAborted();
    if (!agentId) {
      throw new Error("Suggestion target is unavailable");
    }
    const { threadId } = entry.item.content.customOption;
    // Only the thread source can say the named chat is gone; a chat the local
    // list has not loaded yet still receives the direction.
    const thread =
      threadId === null
        ? null
        : (await set(resolveDirectionThreadMeta$, threadId, signal)).meta;
    signal.throwIfAborted();
    if (get(entry.hidden$)) {
      return;
    }
    const session: SuggestionDirectionSession = {
      entry,
      target:
        threadId !== null && thread
          ? {
              kind: "thread",
              id: threadId,
            }
          : { kind: "new", agentId },
      finish: (sentThreadId, submission) => {
        set(
          finishSuggestionDirection$,
          session,
          { threadId: sentThreadId, submission },
          pageSignal,
        );
      },
    };
    set(internalDirectionSession$, session);
    // Leaving the page or opening another card's editor ends this session.
    signal.addEventListener(
      "abort",
      () => {
        if (get(internalDirectionSession$) === session) {
          set(internalDirectionSession$, null);
          set(internalDirectionComposer$, null);
        }
      },
      { once: true },
    );
    const prepared = set(prepareDirectionComposer$, signal);
    set(internalDirectionComposer$, prepared);
    await prepared;
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
    set(closeSuggestionDirection$);
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
