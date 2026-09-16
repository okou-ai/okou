import { command } from "ccstate";
import { welcomeChatThreadsContract } from "@okouai/api-contracts/contracts/welcome-chat-threads";
import { accept } from "../../../lib/accept.ts";
import { apiClient$ } from "../../api-client.ts";
import { catchUpChatThreadEventSource$ } from "../../chat-page/chat-thread-event-sourcing.ts";
import { navigateToChat$ } from "../nav.ts";
import { closeSettingsModal$ } from "./settings-dialog.ts";

/**
 * Create the welcome chat from Settings > Debug. The caller passes the
 * Settings action signal, so dismissal cancels the request and the list
 * catch-up together. Each click is a new deliberate action with its own id.
 */
export const createWelcomeThread$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const result = await accept(
      get(apiClient$)(welcomeChatThreadsContract).create({
        body: { clientThreadId: crypto.randomUUID() },
        fetchOptions: { signal },
      }),
      [201],
      signal,
    );
    // Recover the ordinary list even when the creation notification was lost.
    await set(catchUpChatThreadEventSource$, signal);
    signal.throwIfAborted();
    set(closeSettingsModal$);
    set(navigateToChat$, result.body.id);
  },
);
