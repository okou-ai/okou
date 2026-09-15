import { command } from "ccstate";
import { matchShortcut } from "@okouai/ui";
import { currentChatThreadListIds$ } from "../agent-chat.ts";
import { agentChatComposerSignals$ } from "./agent-composer-signals.ts";
import { onDomEventFn } from "../utils.ts";
import { COMPOSER_VOICE_INPUT_SHORTCUT } from "../../lib/composer-voice-input-shortcut.ts";
import { setupGlobalShortcut } from "../../lib/setup-global-shortcut.ts";
import { navigateToChat$ } from "./nav.ts";

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
      },
      signal,
    );
    document.addEventListener(
      "keydown",
      onDomEventFn(async (event: KeyboardEvent) => {
        if (
          event.defaultPrevented ||
          !matchShortcut("mod+shift+arrowdown", event)
        ) {
          return;
        }

        event.preventDefault();
        const [firstThreadId] = await get(currentChatThreadListIds$);
        signal.throwIfAborted();
        if (!firstThreadId) {
          return;
        }
        set(navigateToChat$, firstThreadId);
      }),
      { signal },
    );
  },
);
