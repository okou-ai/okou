import type { SuggestionPreset } from "@okouai/api-contracts/validators/chat-threads";
import { withoutPresentationPreferenceContext } from "@okouai/api-contracts/contracts/presentation-preference-context";
import {
  captureSuggestionCard,
  type SuggestionDirection,
} from "../../lib/posthog.ts";
import { command, computed, state } from "ccstate";
import type {
  Suggestion,
  SuggestionOption,
} from "@okouai/api-contracts/contracts/feed";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";

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
  type AgentSuggestionEntry,
  type SuggestionDirectionSession,
  suggestionDirectionSession$,
  linkAgentSuggestionThread$,
  restoreAgentSuggestion$,
  settleAgentSuggestion$,
} from "./agent-suggestion-session.ts";
import { createInPlaceChatComposerSignals } from "./workspace-composer-signals.ts";
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

const resolveDirectionThreadMeta$ = createThreadMetaLookup();
const internalDirectionComposer$ = state<Promise<ComposerSignals> | null>(null);
const resetDirection$ = resetSignal();

export const suggestionDirectionComposer$ = computed((get) => {
  return get(internalDirectionComposer$);
});

const closeSuggestionDirection$ = command(({ get, set }) => {
  set(resetDirection$);
  set(internalDirectionComposer$, null);
  set(get(suggestionDirectionSession$), null);
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
      readonly newThread: boolean;
    },
    pageSignal: AbortSignal,
  ): void => {
    const { threadId, submission } = sent;
    if (get(get(suggestionDirectionSession$)) === session) {
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
    if (sent.newThread) {
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
  async (
    { set },
    session: SuggestionDirectionSession,
    pageSignal: AbortSignal,
    signal: AbortSignal,
  ): Promise<ComposerSignals> => {
    const item = session.entry.item;
    const { threadId } = item.content.customOption;
    // Resolve the selected card's target even when the local chat list has not
    // loaded it. A missing thread gets a new conversation.
    const thread =
      threadId === null
        ? null
        : (await set(resolveDirectionThreadMeta$, threadId, signal)).meta;
    signal.throwIfAborted();
    const finish = (sentThreadId: string, submission: ComposerSubmission) => {
      set(
        finishSuggestionDirection$,
        session,
        { threadId: sentThreadId, submission, newThread: thread === null },
        pageSignal,
      );
    };
    let composer: ComposerSignals;
    if (threadId !== null && thread) {
      const graph = createInPlaceThreadComposerSignals(
        threadId,
        (submission) => {
          finish(threadId, submission);
        },
      );
      composer = graph.composer;
      await set(graph.setup$, signal);
    } else {
      composer = createInPlaceChatComposerSignals(finish, item.content.title);
      set(composer.setup$, signal);
    }
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
      composer.draft.seed$,
      {
        content,
        userMessage: document,
        suggestionDirection: {
          ...session.impression,
          direction_type: "custom",
        },
        generationTemplate: undefined,
        attachments: files.map(createRestoredAttachment),
      },
      signal,
    );
    signal.throwIfAborted();
    return composer;
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
    const impression = set(entry.show$);
    captureSuggestionCard({
      eventName: "suggestion_card_action_clicked",
      properties: { ...impression, action: "open_custom" },
    });
    const signal = set(resetDirection$, pageSignal);
    set(internalDirectionComposer$, null);
    signal.throwIfAborted();
    if (get(entry.hidden$)) {
      return;
    }
    // A list can arrive while the selected card's target is being resolved.
    const session: SuggestionDirectionSession = { entry, impression };
    set(get(suggestionDirectionSession$), session);
    // Leaving the page or opening another card's editor ends this session.
    signal.addEventListener(
      "abort",
      () => {
        if (get(get(suggestionDirectionSession$)) === session) {
          set(get(suggestionDirectionSession$), null);
          set(internalDirectionComposer$, null);
        }
      },
      { once: true },
    );
    const prepared = set(
      prepareDirectionComposer$,
      session,
      pageSignal,
      signal,
    );
    set(internalDirectionComposer$, prepared);
    await prepared;
  },
);

/**
 * Starts the chosen action in a new chat and keeps
 * home in place. The card is consumed once its input is accepted.
 */
const sendAgentSuggestionOption$ = command(
  async (
    { set },
    entry: AgentSuggestionEntry,
    option: SuggestionOption,
    direction: SuggestionDirection,
    signal: AbortSignal,
  ): Promise<void> => {
    const preparedMessage = option.draft.draftUserMessage;
    if (!preparedMessage) {
      throw new Error("Missing suggestion composer document");
    }
    const userMessage = withoutPresentationPreferenceContext(preparedMessage);
    const prompt = messageDocumentToPrompt(userMessage);
    if (prompt === null) {
      throw new Error("Invalid suggestion composer document");
    }
    const draft = entry.optionDraft;
    await set(
      draft.seed$,
      {
        content: prompt,
        suggestionDirection: direction,
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
        title: entry.item.content.title,
        draft,
        preserveWorkspaceDraft: true,
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
    preset: SuggestionPreset,
    threadId: string,
    signal: AbortSignal,
  ) => {
    const draft = set(ensureDraft$, threadId);
    // Installing the draft is synchronous; attachment reconciliation and
    // persistence must not delay navigation.
    const installed = set(
      draft.prependComposerDraft$,
      { ...option.draft, suggestionPreset: preset },
      signal,
    );
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
    entry: AgentSuggestionEntry,
    option: SuggestionOption,
    position: number,
    pageSignal: AbortSignal,
  ): Promise<void> => {
    pageSignal.throwIfAborted();
    if (get(entry.hidden$)) {
      return;
    }
    const preset = {
      ...set(entry.show$),
      option_id: option.id,
      option_position: position,
    };
    captureSuggestionCard({
      eventName: "suggestion_card_action_clicked",
      properties: { ...preset, action: "select_option" },
    });
    const direction = { ...preset, direction_type: "preset" as const };
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
        direction,
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
      set(entry.enqueue$, { type: "consume", optionId: option.id }, signal),
      set(openAgentSuggestionThread$, option, preset, option.threadId, signal),
    ]);
  },
);
