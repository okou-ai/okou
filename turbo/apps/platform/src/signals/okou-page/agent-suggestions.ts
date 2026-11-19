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
import { chatThreadMetaMap$ } from "../chat-page/chat-thread-event-sourcing.ts";
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
  readonly agentId: string;
  readonly title: string | null;
}

/** A custom direction starts a new chat or continues a chat the card names. */
export type SuggestionDirectionTarget =
  { readonly kind: "new"; readonly agentId: string } | SuggestionThreadTarget;

/** Chats the card's actions continue or reference, in the order they name them. */
function relatedThreadIds(item: Suggestion): readonly string[] {
  const ids = new Set<string>();
  for (const option of item.content.options) {
    if (option.threadId) {
      ids.add(option.threadId);
    }
  }
  for (const option of item.content.options) {
    for (const part of option.draft.draftUserMessage?.parts ?? []) {
      if (part.type === "chat_thread") {
        ids.add(part.threadId);
      }
    }
  }
  return [...ids];
}

interface SuggestionDirectionSession {
  readonly entry: AgentSuggestionEntry;
  readonly agentId: string;
  /** Ends the dialog and settles the card once a send is accepted. */
  readonly finish: (
    target: SuggestionDirectionTarget,
    threadId: string,
  ) => void;
}

const internalDirectionSession$ = state<SuggestionDirectionSession | null>(
  null,
);
const internalDirectionTarget$ = state<SuggestionDirectionTarget | null>(null);
const internalDirectionComposer$ = state<Promise<ComposerSignals> | null>(null);
const resetDirection$ = resetSignal();
const resetDirectionTarget$ = resetSignal();

/**
 * One unsaved composer per chosen target, so neither the default Agent's
 * draft nor the target thread's saved draft is read or replaced.
 */
const directionGraph$ = computed((get) => {
  const session = get(internalDirectionSession$);
  const target = get(internalDirectionTarget$);
  if (!session || !target) {
    return null;
  }
  if (target.kind === "new") {
    return {
      kind: target.kind,
      composer: createInPlaceAgentComposerSignals(
        target.agentId,
        (threadId) => {
          session.finish(target, threadId);
        },
        session.entry.item.content.title,
      ),
    };
  }
  return {
    kind: target.kind,
    ...createInPlaceThreadComposerSignals(target.id, target.agentId, () => {
      session.finish(target, target.id);
    }),
  };
});

/** The card whose custom direction is being written, and where it can go. */
export const suggestionDirection$ = computed((get) => {
  const session = get(internalDirectionSession$);
  if (!session) {
    return null;
  }
  const threads = get(chatThreadMetaMap$);
  return {
    agentId: session.agentId,
    threads: relatedThreadIds(session.entry.item).flatMap(
      (id): SuggestionThreadTarget[] => {
        const meta = threads.get(id);
        return meta
          ? [{ kind: "thread", id, agentId: meta.agentId, title: meta.title }]
          : [];
      },
    ),
  };
});

export const suggestionDirectionTarget$ = computed((get) => {
  return get(internalDirectionTarget$);
});

export const suggestionDirectionComposer$ = computed((get) => {
  return get(internalDirectionComposer$);
});

/** Returns the open dialog to its choice of target. */
export const resetSuggestionDirectionTarget$ = command(({ set }) => {
  set(resetDirectionTarget$);
  set(internalDirectionTarget$, null);
  set(internalDirectionComposer$, null);
});

export const closeSuggestionDirection$ = command(({ set }) => {
  set(resetDirection$);
  set(resetSuggestionDirectionTarget$);
  set(internalDirectionSession$, null);
});

/**
 * An accepted send ends the dialog and moves the card below the waiting ones
 * as a link to the chat that received it. The API consumes the card when it
 * accepts the follow-up.
 */
const finishSuggestionDirection$ = command(
  (
    { get, set },
    session: SuggestionDirectionSession,
    target: SuggestionDirectionTarget,
    threadId: string,
    pageSignal: AbortSignal,
  ): void => {
    if (get(internalDirectionSession$) === session) {
      set(closeSuggestionDirection$);
    }
    if (target.kind === "new") {
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

/** Opens the composer of `target` for the card in the open dialog. */
export const chooseSuggestionDirectionTarget$ = command(
  async (
    { get, set },
    target: SuggestionDirectionTarget,
    parentSignal: AbortSignal,
  ): Promise<ComposerSignals> => {
    if (!get(internalDirectionSession$)) {
      throw new Error("Suggestion direction is unavailable");
    }
    const signal = set(resetDirectionTarget$, parentSignal);
    set(internalDirectionTarget$, target);
    const prepared = set(prepareDirectionComposer$, signal);
    set(internalDirectionComposer$, prepared);
    return await prepared;
  },
);

/**
 * Opens the custom direction dialog for a card. A card without related chats
 * goes straight to a new chat of the default Agent; otherwise the member first
 * chooses between a new chat and one of those chats.
 */
export const openSuggestionDirection$ = command(
  async (
    { get, set },
    entry: AgentSuggestionEntry,
    pageSignal: AbortSignal,
  ): Promise<void> => {
    const signal = set(resetDirection$, pageSignal);
    set(resetSuggestionDirectionTarget$);
    const agentId = await get(defaultAgentId$);
    signal.throwIfAborted();
    if (!agentId) {
      throw new Error("Suggestion target is unavailable");
    }
    if (get(entry.hidden$)) {
      return;
    }
    const session: SuggestionDirectionSession = {
      entry,
      agentId,
      finish: (target, threadId) => {
        set(finishSuggestionDirection$, session, target, threadId, pageSignal);
      },
    };
    set(internalDirectionSession$, session);
    // Leaving the page or opening another card's dialog ends this session.
    signal.addEventListener(
      "abort",
      () => {
        if (get(internalDirectionSession$) === session) {
          set(internalDirectionSession$, null);
          set(resetSuggestionDirectionTarget$);
        }
      },
      { once: true },
    );
    if (get(suggestionDirection$)?.threads.length === 0) {
      await set(
        chooseSuggestionDirectionTarget$,
        { kind: "new", agentId },
        signal,
      );
    }
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
