import { command } from "ccstate";
import { agentChatComposerSignals$ } from "./agent-composer-signals.ts";
import { COMPOSER_VOICE_INPUT_SHORTCUT } from "../../lib/composer-voice-input-shortcut.ts";
import { setupGlobalShortcut } from "../../lib/setup-global-shortcut.ts";
import { projectFoldShortcutBindings } from "../../lib/project-fold-shortcuts.ts";
import {
  navigateChatList$,
  setCurrentChatListProjectExpanded$,
} from "../chat-page/chat-list-navigation.ts";
import { projectRowKey } from "../chat-page/chat-thread-list-rows.ts";

export const setupAgentChatKeyboardShortcuts$ = command(
  ({ get, set }, signal: AbortSignal) => {
    setupGlobalShortcut(
      {
        [COMPOSER_VOICE_INPUT_SHORTCUT]: {
          allowInEditableTarget: true,
          run: () => {
            set(get(agentChatComposerSignals$).voice.toggle$);
          },
        },
        // The new-chat page sits above the list, so moving down enters it.
        "mod+shift+arrowdown": {
          allowInEditableTarget: true,
          run: async () => {
            await set(
              navigateChatList$,
              {
                currentKey: null,
                direction: "next",
                pane: "main",
                excludedThreadId: null,
              },
              signal,
            );
          },
        },
      },
      signal,
    );
  },
);

export const setupProjectPageKeyboardShortcuts$ = command(
  ({ get, set }, projectId: string, signal: AbortSignal) => {
    function navigate(direction: "prev" | "next") {
      return set(
        navigateChatList$,
        {
          currentKey: projectRowKey(projectId),
          direction,
          pane: "main",
          excludedThreadId: null,
        },
        signal,
      );
    }
    setupGlobalShortcut(
      {
        [COMPOSER_VOICE_INPUT_SHORTCUT]: {
          allowInEditableTarget: true,
          run: () => {
            set(get(agentChatComposerSignals$).voice.toggle$);
          },
        },
        // A Project page is the Project's own position in the chat list.
        "mod+shift+arrowup": {
          allowInEditableTarget: true,
          run: () => {
            return navigate("prev");
          },
        },
        "mod+shift+arrowdown": {
          allowInEditableTarget: true,
          run: () => {
            return navigate("next");
          },
        },
        ...projectFoldShortcutBindings((expanded) => {
          return set(
            setCurrentChatListProjectExpanded$,
            { currentKey: projectRowKey(projectId), expanded },
            signal,
          );
        }),
      },
      signal,
    );
  },
);
