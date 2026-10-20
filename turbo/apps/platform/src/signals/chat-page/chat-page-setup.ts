import { command } from "ccstate";
import { createElement } from "react";
import { ChatThreadPage } from "../../views/okou-page/chat-thread-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { currentChatThreadId$ } from "../agent-chat.ts";
import { hash$, searchParams$ } from "../route.ts";
import {
  SIDEBAR_PARAM,
  setupLeftThread$,
  setupLeftThreadNotFound$,
  setupRightThread$,
  setupRightThreadNotFound$,
  unloadRightThread$,
} from "./chat-thread-panes.ts";
import { createThreadMetaLookup } from "./chat-thread-event-sourcing.ts";
import { recordBootstrapThreadMetadataTiming$ } from "../../lib/posthog.ts";

const resolveLeftThreadMeta$ = createThreadMetaLookup();
const resolveRightThreadMeta$ = createThreadMetaLookup();

function chatEventIdFromHash(hash: string): string | null {
  // Run admission gives the launch input the run ID, so both links use the
  // same event positioning path, including history outside the render window.
  const prefix = ["#event-", "#run-"].find((candidate) => {
    return hash.startsWith(candidate);
  });
  if (!prefix) {
    return null;
  }
  const encodedEventId = hash.slice(prefix.length);
  if (encodedEventId.length === 0) {
    return null;
  }
  return new URLSearchParams(
    `event=${encodedEventId.replaceAll("+", "%2B")}`,
  ).get("event");
}

const setupResolvedLeftThread$ = command(
  async (
    { set },
    threadId: string,
    initialEventId: string | null,
    signal: AbortSignal,
  ): Promise<void> => {
    const resolution = await set(resolveLeftThreadMeta$, threadId, signal);
    signal.throwIfAborted();
    set(recordBootstrapThreadMetadataTiming$, {
      cacheHydrationWaitMs: resolution.cacheHydrationWaitMs,
      cacheMissResolutionMs: resolution.cacheMissResolutionMs,
      resolutionPath: resolution.resolutionPath,
    });
    const { meta } = resolution;
    if (meta) {
      await set(setupLeftThread$, meta, initialEventId, signal);
      return;
    }
    await set(setupLeftThreadNotFound$, threadId, signal);
  },
);

const setupResolvedRightThread$ = command(
  async ({ set }, threadId: string, signal: AbortSignal): Promise<void> => {
    const { meta } = await set(resolveRightThreadMeta$, threadId, signal);
    signal.throwIfAborted();
    if (meta) {
      await set(setupRightThread$, meta, signal);
      return;
    }
    await set(setupRightThreadNotFound$, threadId, signal);
  },
);

const internalSetupChatPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const threadId = get(currentChatThreadId$);
    if (!threadId) {
      throw new Error("threadId is required to load chat page");
    }

    set(updatePage$, createElement(ChatThreadPage), "sidebar");

    const sidebarThreadId = get(searchParams$).get(SIDEBAR_PARAM);
    const initialEventId = chatEventIdFromHash(get(hash$));
    const rightThreadId =
      sidebarThreadId && sidebarThreadId !== threadId ? sidebarThreadId : null;

    await Promise.all([
      set(setupResolvedLeftThread$, threadId, initialEventId, signal),
      rightThreadId
        ? set(setupResolvedRightThread$, rightThreadId, signal)
        : set(unloadRightThread$),
    ]);
    signal.throwIfAborted();
  },
);

export const setupChatPage$ = command(async ({ set }, signal: AbortSignal) => {
  await set(internalSetupChatPage$, signal);
  signal.throwIfAborted();
});
