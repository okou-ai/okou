import { command, computed } from "ccstate";
import { apiClient$ } from "../api-client.ts";
import { searchParams$ } from "../route.ts";
import { textToMessageDocument } from "../okou-page/user-message-document-codec.ts";
import { sendChatEvent } from "./chat-event-api.ts";
import {
  chatActionIdMatches,
  type ChatActionContext,
} from "./chat-action-context.ts";

export interface ChatActionCallback {
  readonly callbackPrompt: string | null;
  readonly threadId: string | null;
}

export interface ChatActionCallbackIds {
  readonly clientEventId: string;
  readonly chatThreadSortEventId: string;
}

export function chatActionCallbackFromUrl(
  url: URL,
  context: ChatActionContext,
): ChatActionCallback | null {
  const callbackPrompt = url.searchParams.get("callbackPrompt");
  const threadId = url.searchParams.get("threadId");
  if (callbackPrompt === null && threadId === null) {
    return { callbackPrompt: null, threadId: null };
  }
  if (
    callbackPrompt === null ||
    callbackPrompt.trim() === "" ||
    threadId === null ||
    !chatActionIdMatches(threadId, context.threadId)
  ) {
    return null;
  }
  return {
    callbackPrompt,
    threadId: context.threadId,
  };
}

export const routeChatActionCallback$ = computed((get) => {
  const params = get(searchParams$);
  return {
    callbackPrompt: params.get("callbackPrompt"),
    threadId: params.get("threadId"),
  } satisfies ChatActionCallback;
});

export const runChatActionCallback$ = command(
  async (
    { get },
    args: {
      readonly threadId: string;
      readonly agentId: string;
      readonly callbackPrompt: string;
      readonly callbackIds?: ChatActionCallbackIds;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const userMessage = textToMessageDocument(args.callbackPrompt);
    if (!userMessage) {
      throw new Error("Failed to serialize callback user message");
    }
    await sendChatEvent(
      get(apiClient$),
      {
        agentId: args.agentId,
        threadId: args.threadId,
        prompt: args.callbackPrompt,
        hasTextContent: true,
        userMessage,
        clientEventId: args.callbackIds?.clientEventId ?? crypto.randomUUID(),
        chatThreadSortEventId:
          args.callbackIds?.chatThreadSortEventId ?? crypto.randomUUID(),
      },
      signal,
    );
  },
);
