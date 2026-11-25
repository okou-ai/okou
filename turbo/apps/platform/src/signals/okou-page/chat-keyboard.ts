import { command } from "ccstate";
import { workspaceChatComposerSignals$ } from "./workspace-composer-signals.ts";
import { COMPOSER_VOICE_INPUT_SHORTCUT } from "../../lib/composer-voice-input-shortcut.ts";
import { setupGlobalShortcut } from "../../lib/setup-global-shortcut.ts";
import {
  FOR_YOU_ENTRY_KEY,
  NEW_CHAT_ENTRY_KEY,
  navigateChatList$,
} from "../chat-page/chat-list-navigation.ts";
import { projectRowKey } from "../chat-page/chat-thread-list-rows.ts";

/**
 * Moves a main-pane page to its neighbours in the chat list. `currentKey` is
 * the page's own entry or Project key. A page outside the list has nothing
 * above it, so it leaves the upward keys to the focused control and only
 * enters the list downward.
 */
const setupChatListNavigationShortcuts$ = command(
  ({ set }, currentKey: string | null, signal: AbortSignal) => {
    function navigate(direction: "prev" | "next") {
      return set(
        navigateChatList$,
        { currentKey, direction, pane: "main", excludedThreadId: null },
        signal,
      );
    }
    setupGlobalShortcut(
      {
        ...(currentKey === null
          ? {}
          : {
              "mod+shift+arrowup": {
                allowInEditableTarget: true,
                run: () => {
                  return navigate("prev");
                },
              },
            }),
        "mod+shift+arrowdown": {
          allowInEditableTarget: true,
          run: () => {
            return navigate("next");
          },
        },
      },
      signal,
    );
  },
);

export const setupChatKeyboardShortcuts$ = command(
  ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    setupGlobalShortcut(
      {
        [COMPOSER_VOICE_INPUT_SHORTCUT]: {
          allowInEditableTarget: true,
          run: () => {
            set(get(workspaceChatComposerSignals$).voice.toggle$);
          },
        },
      },
      signal,
    );
    set(setupChatListNavigationShortcuts$, NEW_CHAT_ENTRY_KEY, signal);
  },
);

export const setupProjectPageKeyboardShortcuts$ = command(
  ({ get, set }, projectId: string, signal: AbortSignal) => {
    setupGlobalShortcut(
      {
        [COMPOSER_VOICE_INPUT_SHORTCUT]: {
          allowInEditableTarget: true,
          run: () => {
            set(get(workspaceChatComposerSignals$).voice.toggle$);
          },
        },
      },
      signal,
    );
    // A Project page is the Project's own position in the chat list.
    set(setupChatListNavigationShortcuts$, projectRowKey(projectId), signal);
  },
);

export const setupForYouPageKeyboardShortcuts$ = command(
  ({ set }, signal: AbortSignal) => {
    set(setupChatListNavigationShortcuts$, FOR_YOU_ENTRY_KEY, signal);
  },
);
