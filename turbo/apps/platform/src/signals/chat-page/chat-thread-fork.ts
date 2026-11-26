import { command } from "ccstate";
import { i18n } from "../../i18n/index.ts";
import { navigateToNewChat$ } from "../okou-page/nav.ts";
import { ensureDraft$ } from "../okou-page/workspace-draft.ts";
import { ROUTES } from "../route-paths.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { eventDrivenChatThreads$ } from "./chat-thread-event-sourcing.ts";

export const forkChatThread$ = command(
  async ({ get, set }, threadId: string, signal: AbortSignal) => {
    const { draft } = await set(ensureDraft$, signal);
    const thread = get(eventDrivenChatThreads$).find((item) => {
      return item.id === threadId;
    });
    if (!thread) {
      return;
    }
    const titleSnapshot =
      thread.title ||
      i18n.t(($) => {
        return $.chat.newChat;
      });
    // Prepending installs the reference synchronously. Navigate while the new
    // composer takes over loading and reconciling the workspace draft.
    const prepared = set(
      draft.prependComposerDraft$,
      {
        draftUserMessage: {
          version: 1,
          parts: [
            { type: "chat_thread", threadId, titleSnapshot },
            { type: "text", text: " " },
          ],
        },
        draftAttachments: null,
      },
      signal,
    );
    if (thread.projectId) {
      set(detachedNavigateTo$, ROUTES.project, {
        pathParams: { projectId: thread.projectId },
      });
    } else {
      set(navigateToNewChat$, signal);
    }
    await prepared;
  },
);
