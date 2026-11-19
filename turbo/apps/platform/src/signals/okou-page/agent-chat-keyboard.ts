import { command } from "ccstate";
import { agentChatComposerSignals$ } from "./agent-composer-signals.ts";
import { COMPOSER_VOICE_INPUT_SHORTCUT } from "../../lib/composer-voice-input-shortcut.ts";
import { setupGlobalShortcut } from "../../lib/setup-global-shortcut.ts";
import {
  FOR_YOU_ENTRY_KEY,
  NEW_CHAT_ENTRY_KEY,
  navigateChatList$,
} from "../chat-page/chat-list-navigation.ts";
import { projectRowKey } from "../chat-page/chat-thread-list-rows.ts";
import { singleAgentEnabled$ } from "../single-agent.ts";

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

export const setupAgentChatKeyboardShortcuts$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const singleAgent = await get(singleAgentEnabled$);
    signal.throwIfAborted();
    setupGlobalShortcut(
      {
        [COMPOSER_VOICE_INPUT_SHORTCUT]: {
          allowInEditableTarget: true,
          run: () => {
            set(get(agentChatComposerSignals$).voice.toggle$);
          },
        },
      },
      signal,
    );
    // My Okou's only chat page is the New chat entry. An agent's chat page
    // without My Okou stands outside the list.
    set(
      setupChatListNavigationShortcuts$,
      singleAgent ? NEW_CHAT_ENTRY_KEY : null,
      signal,
    );
  },
);

export const setupProjectPageKeyboardShortcuts$ = command(
  ({ get, set }, projectId: string, signal: AbortSignal) => {
    setupGlobalShortcut(
      {
        [COMPOSER_VOICE_INPUT_SHORTCUT]: {
          allowInEditableTarget: true,
          run: () => {
            set(get(agentChatComposerSignals$).voice.toggle$);
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
