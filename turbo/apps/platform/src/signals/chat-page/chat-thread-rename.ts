import { command } from "ccstate";
import { chatThreadMetaMap$ } from "./chat-thread-event-sourcing.ts";
import { openRenameChatThreadDialog$ } from "../okou-page/sidebar-state.ts";
import { renameChatThread$ } from "./chat-event.ts";
import {
  applyChatThreadEmoji,
  removeChatThreadEmoji,
} from "./chat-thread-title.ts";

export interface RenameChatThreadDialogRequest {
  readonly threadId: string;
  readonly title?: string | null;
  readonly agentId?: string | null;
}

export const openRenameChatThreadDialogFromThreadMeta$ = command(
  ({ set }, request: RenameChatThreadDialogRequest, _signal: AbortSignal) => {
    set(openRenameChatThreadDialog$, {
      threadId: request.threadId,
      title: request.title,
      agentId: request.agentId,
    });
  },
);

export const openRenameChatThreadDialogForThreadId$ = command(
  ({ get, set }, threadId: string, signal: AbortSignal) => {
    const meta = get(chatThreadMetaMap$).get(threadId) ?? null;
    set(
      openRenameChatThreadDialogFromThreadMeta$,
      {
        threadId,
        title: meta?.title,
        agentId: meta?.agentId,
      },
      signal,
    );
  },
);

export const setChatThreadEmojiFromThreadMeta$ = command(
  async (
    { get, set },
    {
      threadId,
      emoji,
      title,
    }: { threadId: string; emoji: string; title?: string | null },
    signal: AbortSignal,
  ) => {
    const meta = get(chatThreadMetaMap$).get(threadId) ?? null;
    const currentTitle = title !== undefined ? title : meta?.title;
    await set(
      renameChatThread$,
      {
        threadId,
        title: applyChatThreadEmoji(currentTitle, emoji),
        agentId: meta?.agentId,
      },
      signal,
    );
  },
);

export const clearChatThreadEmojiFromThreadMeta$ = command(
  async (
    { get, set },
    { threadId, title }: { threadId: string; title?: string | null },
    signal: AbortSignal,
  ) => {
    const meta = get(chatThreadMetaMap$).get(threadId) ?? null;
    const currentTitle = title !== undefined ? title : meta?.title;
    const nextTitle = removeChatThreadEmoji(currentTitle);
    if (!nextTitle) {
      return;
    }
    await set(
      renameChatThread$,
      { threadId, title: nextTitle, agentId: meta?.agentId },
      signal,
    );
  },
);
