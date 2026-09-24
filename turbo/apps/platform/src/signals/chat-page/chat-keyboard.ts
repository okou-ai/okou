import { command } from "ccstate";
import { isEditableTarget, matchShortcut } from "@okouai/ui";
import {
  currentLeftThread$,
  currentRightThread$,
  loadLeftThread$,
  loadRightThread$,
} from "./chat-thread-panes.ts";
import type { ChatPanelSignals } from "./chat-panel-signals.ts";
import {
  pinChatThread$,
  setChatThreadArchived$,
  unpinChatThread$,
} from "./chat-event.ts";
import {
  clearChatThreadEmojiFromThreadMeta$,
  openRenameChatThreadDialogFromThreadMeta$,
  setChatThreadEmojiFromThreadMeta$,
  type RenameChatThreadDialogRequest,
} from "./chat-thread-rename.ts";
import { chatThreadMetaMap$ } from "./chat-thread-event-sourcing.ts";
import { CHAT_THREAD_EMOJI_OPTIONS } from "./chat-thread-title.ts";
import { onRef } from "../utils.ts";
import { openChatThreadEmojiMenu$ } from "../okou-page/sidebar-state.ts";
import {
  currentChatThreadId$,
  currentChatThreadNavigationList$,
} from "../agent-chat.ts";
import { rootSignal$ } from "../root-signal.ts";
import {
  setupGlobalShortcut,
  type GlobalShortcutBindings,
} from "../../lib/setup-global-shortcut.ts";
import { COMPOSER_VOICE_INPUT_SHORTCUT } from "../../lib/composer-voice-input-shortcut.ts";
import { GLOBAL_KEYBOARD_SHORTCUTS } from "../../lib/global-keyboard-shortcuts.ts";
import { scrollToThread$ } from "./sidebar-chat-thread-scroll.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../external/feature-switch.ts";

type ChatThreadPane = "main" | "side";

type ChatThreadNavigationDirection = "prev" | "next";

function findAdjacentListedThreadId({
  currentThreadId,
  direction,
  excludedThreadId,
  listedThreadIds,
  orderedThreadIds,
}: {
  currentThreadId: string;
  direction: ChatThreadNavigationDirection;
  excludedThreadId: string | null;
  listedThreadIds: readonly string[];
  orderedThreadIds: readonly string[];
}): string | undefined {
  const currentIndex = orderedThreadIds.indexOf(currentThreadId);
  if (currentIndex === -1) {
    return undefined;
  }

  const listed = new Set(listedThreadIds);
  const step = direction === "prev" ? -1 : 1;
  for (
    let index = currentIndex + step;
    index >= 0 && index < orderedThreadIds.length;
    index += step
  ) {
    const candidate = orderedThreadIds[index];
    if (
      candidate !== undefined &&
      candidate !== excludedThreadId &&
      listed.has(candidate)
    ) {
      return candidate;
    }
  }
  return undefined;
}

function isPlainArrowScroll(event: KeyboardEvent): boolean {
  return matchShortcut("arrowup", event) || matchShortcut("arrowdown", event);
}

function containerContainsTarget(
  container: HTMLElement | null,
  target: EventTarget | null,
): boolean {
  return target instanceof Node && container?.contains(target) === true;
}

function isKeyboardScrollBlockedTarget(target: EventTarget | null): boolean {
  if (isEditableTarget(target)) {
    return true;
  }
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.closest('[role="dialog"]') !== null;
}

function isDocumentScrollTarget(root: HTMLElement, target: EventTarget | null) {
  const doc = root.ownerDocument;
  return (
    target === doc || target === doc.body || target === doc.documentElement
  );
}

function isKeyboardScrollAllowedTarget(
  root: HTMLElement,
  target: EventTarget | null,
): boolean {
  if (isKeyboardScrollBlockedTarget(target)) {
    return false;
  }
  return (
    isDocumentScrollTarget(root, target) ||
    (target instanceof Node && root.contains(target))
  );
}

function resolveKeyboardScrollThread(
  leftThread: ChatPanelSignals | null,
  rightThread: ChatPanelSignals | null,
  threadId: string | null,
): ChatPanelSignals | null {
  if (threadId === rightThread?.threadId) {
    return rightThread;
  }
  if (threadId === leftThread?.threadId) {
    return leftThread;
  }
  return leftThread;
}

function containingChatThread(
  target: EventTarget | null,
  leftThread: ChatPanelSignals | null,
  rightThread: ChatPanelSignals | null,
  containerElForThread: (thread: ChatPanelSignals) => HTMLElement | null,
): ChatPanelSignals | null {
  if (
    rightThread &&
    containerContainsTarget(containerElForThread(rightThread), target)
  ) {
    return rightThread;
  }
  if (
    leftThread &&
    containerContainsTarget(containerElForThread(leftThread), target)
  ) {
    return leftThread;
  }
  return null;
}

function paneForThread(
  leftThread: ChatPanelSignals | null,
  rightThread: ChatPanelSignals | null,
  thread: ChatPanelSignals | null,
): ChatThreadPane | null {
  if (!thread) {
    return null;
  }
  if (thread.threadId === rightThread?.threadId) {
    return "side";
  }
  if (thread.threadId === leftThread?.threadId) {
    return "main";
  }
  return null;
}

function setupKeyboardScrollPrepareListener(
  {
    activeThreadId,
    containingThread,
    currentLeftThread,
    currentRightThread,
    doc,
    prepareScroll,
    root,
  }: {
    activeThreadId: () => string | null;
    containingThread: (target: EventTarget | null) => ChatPanelSignals | null;
    currentLeftThread: () => ChatPanelSignals | null;
    currentRightThread: () => ChatPanelSignals | null;
    doc: Document;
    prepareScroll: (thread: ChatPanelSignals) => void;
    root: HTMLElement;
  },
  signal: AbortSignal,
): void {
  doc.addEventListener(
    "keydown",
    (event) => {
      if (event.defaultPrevented) {
        return;
      }
      if (
        !isPlainArrowScroll(event) ||
        !isKeyboardScrollAllowedTarget(root, event.target)
      ) {
        return;
      }
      const thread = resolveKeyboardScrollThread(
        currentLeftThread(),
        currentRightThread(),
        containingThread(event.target)?.threadId ?? activeThreadId(),
      );
      if (thread) {
        prepareScroll(thread);
      }
    },
    { signal },
  );
}

interface ChatPageShortcutActions {
  canToggleThreadState: (event: KeyboardEvent) => boolean;
  clearEmoji: () => void | Promise<void>;
  openEmojiMenu: () => void | Promise<void>;
  renameThread: (event: KeyboardEvent) => void | Promise<void>;
  navigateNext: () => void | Promise<void>;
  navigatePrev: () => void | Promise<void>;
  scrollBottom: () => void | Promise<void>;
  scrollTop: () => void | Promise<void>;
  setEmoji: (emoji: string) => void | Promise<void>;
  toggleVoiceInput: () => void | Promise<void>;
  toggleThreadPin: (event: KeyboardEvent) => void | Promise<void>;
  toggleThreadArchive: (event: KeyboardEvent) => void | Promise<void>;
}

interface ChatPageShortcutSetup {
  doc: Document;
  focusedThread: () => ChatPanelSignals | null;
  navigateFocusedThread: (direction: "prev" | "next") => void | Promise<void>;
}

function menuThreadId(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) {
    return null;
  }
  return (
    target.closest<HTMLElement>("[data-chat-thread-menu-thread-id]")?.dataset
      .chatThreadMenuThreadId ?? null
  );
}

function setupChatPageGlobalShortcutListener(
  {
    actions,
    doc,
  }: {
    actions: ChatPageShortcutActions;
    doc: Document;
  },
  signal: AbortSignal,
): void {
  setupGlobalShortcut(createChatPageShortcutBindings(actions), signal, {
    doc,
  });
}

const setFocusedThreadEmoji$ = command(
  async (
    { set },
    args: {
      thread: ChatPanelSignals;
      emoji: string;
    },
    signal: AbortSignal,
  ) => {
    await set(
      setChatThreadEmojiFromThreadMeta$,
      {
        threadId: args.thread.threadId,
        emoji: args.emoji,
      },
      signal,
    );
  },
);

const clearFocusedThreadEmoji$ = command(
  async ({ set }, args: { thread: ChatPanelSignals }, signal: AbortSignal) => {
    await set(
      clearChatThreadEmojiFromThreadMeta$,
      {
        threadId: args.thread.threadId,
      },
      signal,
    );
  },
);

const setupChatPageShortcutActions$ = command(
  (
    { get, set },
    { doc, focusedThread, navigateFocusedThread }: ChatPageShortcutSetup,
    signal: AbortSignal,
  ) => {
    setupChatPageGlobalShortcutListener(
      {
        actions: {
          canToggleThreadState: (event) => {
            return !event.isComposing && event.keyCode !== 229;
          },
          clearEmoji: async () => {
            const thread = focusedThread();
            if (thread) {
              await set(clearFocusedThreadEmoji$, { thread }, signal);
            }
          },
          openEmojiMenu: async () => {
            const thread = focusedThread();
            if (thread) {
              await set(openFocusedThreadEmojiMenu$, { thread }, signal);
            }
          },
          renameThread: async (event) => {
            const thread = focusedThread();
            const threadId =
              menuThreadId(event.target) ??
              thread?.threadId ??
              get(currentChatThreadId$);
            if (threadId) {
              const request = await set(
                renameDialogRequestForThread$,
                thread?.threadId === threadId ? thread : null,
                threadId,
                signal,
              );
              await set(
                openRenameChatThreadDialogFromThreadMeta$,
                request,
                signal,
              );
            }
          },
          navigateNext: () => {
            return navigateFocusedThread("next");
          },
          navigatePrev: () => {
            return navigateFocusedThread("prev");
          },
          scrollBottom: async () => {
            const thread = focusedThread();
            if (thread) {
              await set(scrollCurrentThread$, thread, "bottom", signal);
            }
          },
          scrollTop: async () => {
            const thread = focusedThread();
            if (thread) {
              await set(scrollCurrentThread$, thread, "top", signal);
            }
          },
          setEmoji: async (emoji) => {
            const thread = focusedThread();
            if (thread) {
              await set(setFocusedThreadEmoji$, { thread, emoji }, signal);
            }
          },
          toggleVoiceInput: () => {
            const thread = focusedThread();
            if (thread) {
              set(thread.composer.voice.toggle$);
            }
          },
          toggleThreadPin: async (event) => {
            if (event.repeat) {
              return;
            }
            const thread = focusedThread();
            const threadId = menuThreadId(event.target) ?? thread?.threadId;
            if (threadId) {
              await set(
                get(chatThreadMetaMap$).get(threadId)?.pinnedAt
                  ? unpinChatThread$
                  : pinChatThread$,
                threadId,
                signal,
              );
            }
          },
          toggleThreadArchive: async (event) => {
            if (
              event.repeat ||
              get(featureSwitch$)[FeatureSwitchKey.ChatThreadArchiving] !== true
            ) {
              return;
            }
            const thread = focusedThread();
            const threadId = menuThreadId(event.target) ?? thread?.threadId;
            if (threadId) {
              await set(
                setChatThreadArchived$,
                {
                  threadId,
                  archived: !get(chatThreadMetaMap$).get(threadId)?.archived,
                },
                signal,
              );
            }
          },
        },
        doc,
      },
      signal,
    );
  },
);

const openFocusedThreadEmojiMenu$ = command(
  ({ get, set }, args: { thread: ChatPanelSignals }, _signal: AbortSignal) => {
    const threadMeta = get(args.thread.threadMeta$);
    set(openChatThreadEmojiMenu$, {
      threadId: args.thread.threadId,
      title: threadMeta?.title,
    });
  },
);

const renameDialogRequestForThread$ = command(
  (
    { get },
    thread: ChatPanelSignals | null,
    threadId: string,
    _signal: AbortSignal,
  ): RenameChatThreadDialogRequest => {
    const threadMeta = thread
      ? get(thread.threadMeta$)
      : (get(chatThreadMetaMap$).get(threadId) ?? null);
    return {
      threadId,
      title: threadMeta?.title,
      agentId: threadMeta?.agentId,
    };
  },
);

function createEmojiShortcutBindings({
  clearEmoji,
  setEmoji,
}: {
  clearEmoji: () => void | Promise<void>;
  setEmoji: (emoji: string) => void | Promise<void>;
}): GlobalShortcutBindings {
  return {
    ...(Object.fromEntries(
      CHAT_THREAD_EMOJI_OPTIONS.map((option, index) => {
        return [
          `ctrl+shift+${index + 1}`,
          {
            allowInEditableTarget: true,
            run: async () => {
              await setEmoji(option.emoji);
            },
          },
        ];
      }),
    ) as GlobalShortcutBindings),
    "ctrl+shift+0": {
      allowInEditableTarget: true,
      run: clearEmoji,
    },
  };
}

function createChatPageShortcutBindings({
  canToggleThreadState,
  clearEmoji,
  openEmojiMenu,
  renameThread,
  navigateNext,
  navigatePrev,
  scrollBottom,
  scrollTop,
  setEmoji,
  toggleVoiceInput,
  toggleThreadPin,
  toggleThreadArchive,
}: ChatPageShortcutActions): GlobalShortcutBindings {
  return {
    "shift+f2": {
      allowInEditableTarget: true,
      run: openEmojiMenu,
    },
    [GLOBAL_KEYBOARD_SHORTCUTS.renameChat.binding]: {
      allowInEditableTarget: true,
      run: renameThread,
    },
    "mod+shift+arrowup": {
      allowInEditableTarget: true,
      run: navigatePrev,
    },
    "mod+shift+arrowdown": {
      allowInEditableTarget: true,
      run: navigateNext,
    },
    [GLOBAL_KEYBOARD_SHORTCUTS.toggleChatPin.binding]: {
      allowInEditableTarget: true,
      shouldHandle: canToggleThreadState,
      run: toggleThreadPin,
    },
    [GLOBAL_KEYBOARD_SHORTCUTS.toggleChatArchive.binding]: {
      allowInEditableTarget: true,
      shouldHandle: canToggleThreadState,
      run: toggleThreadArchive,
    },
    [COMPOSER_VOICE_INPUT_SHORTCUT]: {
      allowInEditableTarget: true,
      run: toggleVoiceInput,
    },
    "mod+arrowup": {
      allowInEditableTarget: true,
      run: scrollTop,
    },
    "mod+arrowdown": {
      allowInEditableTarget: true,
      run: scrollBottom,
    },
    ...createEmojiShortcutBindings({ clearEmoji, setEmoji }),
  };
}

export const chatThreadContainerElement$ = command(
  ({ get }, threadId: string) => {
    const leftThread = get(currentLeftThread$);
    const rightThread = get(currentRightThread$);
    const thread =
      threadId === rightThread?.threadId
        ? rightThread
        : threadId === leftThread?.threadId
          ? leftThread
          : null;
    if (!thread) {
      return null;
    }
    return get(thread.containerEl$);
  },
);

const scrollCurrentThread$ = command(
  async (
    { set },
    thread: ChatPanelSignals,
    position: "top" | "bottom",
    signal: AbortSignal,
  ): Promise<void> => {
    if (position === "top") {
      await set(thread.scrollToTop$, signal);
      return;
    }
    await set(thread.scrollToBottom$, signal);
  },
);

export const setChatKeyboardScrollRoot$ = onRef(
  command(({ get, set }, el: HTMLElement, signal: AbortSignal) => {
    let activeThreadId: string | null = null;
    const doc = el.ownerDocument;

    const containingThread = (target: EventTarget | null) => {
      return containingChatThread(
        target,
        get(currentLeftThread$),
        get(currentRightThread$),
        (thread) => {
          return get(thread.containerEl$);
        },
      );
    };
    const markActiveThread = (event: Event) => {
      activeThreadId = containingThread(event.target)?.threadId ?? null;
    };
    const focusedThread = () => {
      return containingThread(doc.activeElement) ?? get(currentLeftThread$);
    };
    const navigateAdjacentChatThread = async (
      pane: ChatThreadPane,
      direction: "prev" | "next",
    ) => {
      const leftThread = get(currentLeftThread$);
      const rightThread = get(currentRightThread$);
      const currentId =
        pane === "main" ? leftThread?.threadId : rightThread?.threadId;
      if (!currentId) {
        return;
      }
      const otherPaneThreadId =
        pane === "main" ? rightThread?.threadId : leftThread?.threadId;
      const navigation = await get(currentChatThreadNavigationList$);
      const targetId = findAdjacentListedThreadId({
        currentThreadId: currentId,
        direction,
        excludedThreadId: otherPaneThreadId ?? null,
        listedThreadIds: navigation.listedThreadIds,
        orderedThreadIds: navigation.orderedThreadIds,
      });
      if (!targetId) {
        return;
      }
      if (pane === "main") {
        set(loadLeftThread$, targetId);
      } else {
        set(loadRightThread$, targetId);
      }
      await set(
        scrollToThread$,
        {
          threadId: targetId,
          align: direction === "next" ? "bottom" : "top",
        },
        get(rootSignal$),
      );
    };
    const navigateFocusedThread = (direction: "prev" | "next") => {
      const pane = paneForThread(
        get(currentLeftThread$),
        get(currentRightThread$),
        focusedThread(),
      );
      if (!pane) {
        return;
      }
      return navigateAdjacentChatThread(pane, direction);
    };

    el.addEventListener("focusin", markActiveThread, { signal });
    el.addEventListener("pointerdown", markActiveThread, { signal });
    el.addEventListener("pointerover", markActiveThread, { signal });
    set(
      setupChatPageShortcutActions$,
      {
        doc,
        focusedThread,
        navigateFocusedThread,
      },
      signal,
    );
    setupKeyboardScrollPrepareListener(
      {
        containingThread,
        doc,
        root: el,
        activeThreadId() {
          return activeThreadId;
        },
        currentLeftThread() {
          return get(currentLeftThread$);
        },
        currentRightThread() {
          return get(currentRightThread$);
        },
        prepareScroll(thread) {
          const scrollContainer = get(thread.containerEl$)?.querySelector(
            "[data-scroll-container]",
          );
          if (scrollContainer instanceof HTMLElement) {
            scrollContainer.focus({ preventScroll: true });
          }
        },
      },
      signal,
    );
  }),
);
