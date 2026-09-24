import type { Root } from "hast";
import { command } from "ccstate";
import { detachedNavigateTo$ } from "../route.ts";
import { toast } from "@okouai/ui/components/ui/sonner";
import { navigateToChat$ } from "../okou-page/nav.ts";
import { currentChatThreadId$, chatThreads$ } from "../agent-chat.ts";
import {
  chatThreadArchiveContract,
  chatThreadByIdContract,
  chatThreadPinContract,
  chatThreadUnpinContract,
  chatThreadRenameContract,
  type ChatEventUsagePayload,
  type FeedbackNotePart,
  type UserMessageDocument,
  type UserMessagePart,
} from "@okouai/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { settle } from "../utils.ts";
import { i18n } from "../../i18n/index.ts";
import { firstChatThreadPinOrder } from "@okouai/core/chat-thread-pin-order";
import {
  eventDrivenChatThreads$,
  registerOptimisticChatThreadEvent$,
} from "./chat-thread-event-sourcing.ts";
import type { ChatEvent } from "./chat-event-types.ts";
import type { AgentReferenceSignals } from "./agent-reference-signals.ts";
import type { ArtifactSignals } from "./artifact-card-signals.ts";

type UserMessagePartOfType<T extends UserMessagePart["type"]> = Extract<
  UserMessagePart,
  { type: T }
>;
type FeedbackNotePartOfType<T extends FeedbackNotePart["type"]> = Extract<
  FeedbackNotePart,
  { type: T }
>;
type UserMessageSourcePart = UserMessagePartOfType<"source">;
type UserMessageAgentSourcePart = Extract<
  UserMessageSourcePart,
  { kind: "agent" }
>;
type UserMessageExternalSourcePart = Exclude<
  UserMessageSourcePart,
  UserMessageAgentSourcePart
>;

export type UserMessageFeedbackNoteRenderPart =
  | {
      readonly type: "text";
      readonly part: FeedbackNotePartOfType<"text">;
    }
  | {
      readonly type: "chat_thread";
      readonly part: FeedbackNotePartOfType<"chat_thread">;
    }
  | {
      readonly type: "agent";
      readonly part: FeedbackNotePartOfType<"agent">;
      readonly signals: AgentReferenceSignals;
    }
  | {
      readonly type: "template";
      readonly part: FeedbackNotePartOfType<"template">;
    };

export type UserMessageRenderPart =
  | {
      readonly type: "text";
      readonly part: UserMessagePartOfType<"text">;
    }
  | {
      readonly type: "chat_thread";
      readonly part: UserMessagePartOfType<"chat_thread">;
    }
  | {
      readonly type: "agent";
      readonly part: UserMessagePartOfType<"agent">;
      readonly signals: AgentReferenceSignals;
    }
  | {
      readonly type: "template";
      readonly part: UserMessagePartOfType<"template">;
    }
  | {
      readonly type: "source";
      readonly kind: "agent";
      readonly part: UserMessageAgentSourcePart;
      readonly signals: AgentReferenceSignals;
    }
  | {
      readonly type: "source";
      readonly kind: "external";
      readonly part: UserMessageExternalSourcePart;
    }
  | {
      readonly type: "automation";
      readonly part: UserMessagePartOfType<"automation">;
    }
  | {
      readonly type: "goal";
      readonly part: UserMessagePartOfType<"goal">;
    }
  | {
      readonly type: "file";
      readonly part: UserMessagePartOfType<"file">;
      readonly signals: ArtifactSignals;
    }
  | {
      readonly type: "feedback";
      readonly part: UserMessagePartOfType<"feedback">;
      readonly note: readonly UserMessageFeedbackNoteRenderPart[];
    }
  | {
      readonly type: "model";
      readonly part: UserMessagePartOfType<"model">;
    };

export interface UserMessageRenderDocument {
  readonly document: UserMessageDocument;
  readonly parts: readonly UserMessageRenderPart[];
}

export type EnrichedChatEvent = ChatEvent & {
  /** The parsed body, present once the event entered the render window. */
  tree: Root | undefined;
  /** The current rich body failed to load and can be retried locally. */
  richContentError: boolean;
  isQueued: boolean;
  /** The user's submission time, preserved across delivery replacement events. */
  inputCreatedAt?: string;
  userMessageRenderDocument: UserMessageRenderDocument | undefined;
};

/** A group of consecutive events with the same role. */
export interface ChatEventGroup {
  beginEventId: string;
  role: "user" | "assistant";
  events: EnrichedChatEvent[];
  usage?: ChatEventUsagePayload;
}

// ---------------------------------------------------------------------------
// Delete thread
// ---------------------------------------------------------------------------

export const deleteChatThread$ = command(
  async ({ get, set }, threadId: string, signal: AbortSignal) => {
    const threads = await get(chatThreads$);
    signal.throwIfAborted();
    const eventId = crypto.randomUUID();
    const existingThread = threads.find((thread) => {
      return thread.id === threadId;
    });
    if (existingThread) {
      set(registerOptimisticChatThreadEvent$, {
        id: eventId,
        kind: "deleted",
        chatThreadId: threadId,
        agentId: existingThread.agentId,
      });
    }

    const client = get(apiClient$)(chatThreadByIdContract);
    await accept(
      client.delete({
        params: { id: threadId },
        query: { eventId },
        fetchOptions: { signal },
      }),
      [204],
    );
    signal.throwIfAborted();

    toast.success(
      i18n.t(($) => {
        return $.chat.toasts.deleted;
      }),
    );

    if (get(currentChatThreadId$) === threadId) {
      const idx = threads.findIndex((t) => {
        return t.id === threadId;
      });
      const remaining = threads.filter((t) => {
        return t.id !== threadId;
      });
      if (remaining.length === 0) {
        set(detachedNavigateTo$, "/");
      } else {
        const nextThread = remaining[idx] ?? remaining[remaining.length - 1];
        set(navigateToChat$, nextThread.id);
      }
    }
  },
);

// ---------------------------------------------------------------------------
// Pin / unpin thread
// ---------------------------------------------------------------------------

export const setChatThreadPinned$ = command(
  async (
    { get, set },
    {
      threadId,
      pinned,
      after,
    }: {
      readonly threadId: string;
      readonly pinned: boolean;
      readonly after?: Promise<void> | null;
    },
    signal: AbortSignal,
  ) => {
    const threads = get(eventDrivenChatThreads$);
    signal.throwIfAborted();
    const eventId = crypto.randomUUID();
    const existingThread = threads.find((thread) => {
      return thread.id === threadId;
    });
    const pinOrder =
      pinned && existingThread
        ? firstChatThreadPinOrder(
            threads.filter((thread) => {
              return (
                thread.agentId === existingThread.agentId &&
                thread.id !== threadId
              );
            }),
          )
        : undefined;
    if (existingThread) {
      set(registerOptimisticChatThreadEvent$, {
        id: eventId,
        pinOrder,
        kind: pinned ? "pinned" : "unpinned",
        chatThreadId: threadId,
        agentId: existingThread.agentId,
      });
    }
    // Render every click immediately, but preserve the order of header saves.
    if (after) {
      await settle(after, signal);
    }
    signal.throwIfAborted();
    if (pinned) {
      const client = get(apiClient$)(chatThreadPinContract);
      await accept(
        client.pin({
          params: { id: threadId },
          query: { eventId, pinOrder },
          fetchOptions: { signal },
        }),
        [204],
      );
    } else {
      const client = get(apiClient$)(chatThreadUnpinContract);
      await accept(
        client.unpin({
          params: { id: threadId },
          query: { eventId },
          fetchOptions: { signal },
        }),
        [204],
      );
    }
  },
);

export const pinChatThread$ = command(
  ({ set }, threadId: string, signal: AbortSignal) => {
    return set(setChatThreadPinned$, { threadId, pinned: true }, signal);
  },
);

export const unpinChatThread$ = command(
  ({ set }, threadId: string, signal: AbortSignal) => {
    return set(setChatThreadPinned$, { threadId, pinned: false }, signal);
  },
);

// ---------------------------------------------------------------------------
// Archive / unarchive thread
// ---------------------------------------------------------------------------

export const setChatThreadArchived$ = command(
  async (
    { get, set },
    {
      threadId,
      archived,
    }: { readonly threadId: string; readonly archived: boolean },
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const eventId = crypto.randomUUID();
    const existingThread = get(eventDrivenChatThreads$).find((thread) => {
      return thread.id === threadId;
    });
    if (existingThread) {
      set(registerOptimisticChatThreadEvent$, {
        id: eventId,
        kind: archived ? "archived" : "unarchived",
        chatThreadId: threadId,
        agentId: existingThread.agentId,
      });
    }
    const client = get(apiClient$)(chatThreadArchiveContract);
    const request = {
      params: { id: threadId },
      query: { eventId },
      fetchOptions: { signal },
    };
    await accept(
      archived ? client.archive(request) : client.unarchive(request),
      [204],
    );
  },
);

// ---------------------------------------------------------------------------
// Rename thread
// ---------------------------------------------------------------------------

export const renameChatThread$ = command(
  async (
    { get, set },
    {
      threadId,
      title,
      agentId,
    }: { threadId: string; title: string; agentId?: string | null },
    signal: AbortSignal,
  ) => {
    const eventId = crypto.randomUUID();
    let optimisticAgentId = agentId?.trim() || null;
    if (!optimisticAgentId) {
      const threads = await get(chatThreads$);
      signal.throwIfAborted();
      optimisticAgentId =
        threads.find((thread) => {
          return thread.id === threadId;
        })?.agentId ?? null;
    }
    if (optimisticAgentId) {
      set(registerOptimisticChatThreadEvent$, {
        id: eventId,
        kind: "renamed",
        chatThreadId: threadId,
        agentId: optimisticAgentId,
        title,
      });
    }

    const client = get(apiClient$)(chatThreadRenameContract);
    signal.throwIfAborted();
    await accept(
      client.rename({
        params: { id: threadId },
        body: { title, eventId },
        fetchOptions: { signal },
      }),
      [204],
    );
    signal.throwIfAborted();
  },
);
