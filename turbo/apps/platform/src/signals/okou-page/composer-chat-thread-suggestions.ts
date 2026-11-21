import { projects$ } from "../projects/projects.ts";
import { computed, type Computed } from "ccstate";
import { eventDrivenChatThreads$ } from "../chat-page/chat-thread-event-sourcing.ts";
import type {
  ChatThreadSuggestionRange,
  ComposerChatThreadSuggestion,
} from "./chat-thread-suggestion-domain.ts";

const MAX_VISIBLE_CHAT_THREAD_SUGGESTIONS = 25;

export interface ComposerChatThreadSuggestionResult {
  readonly query: string | null;
  readonly chatThreads: readonly ComposerChatThreadSuggestion[];
}

export function createComposerChatThreadSuggestions(
  activeRange$: Computed<ChatThreadSuggestionRange | null>,
): Computed<ComposerChatThreadSuggestionResult> {
  return computed((get): ComposerChatThreadSuggestionResult => {
    const range = get(activeRange$);
    if (!range) {
      return {
        query: null,
        chatThreads: [],
      };
    }

    const query = range.query.toLowerCase();
    const chatThreads: ComposerChatThreadSuggestion[] = get(projects$)
      .filter((p) => {
        return p.name.toLowerCase().includes(query);
      })
      .map((p) => {
        return { id: p.id, title: p.name, project: true };
      });
    for (const thread of get(eventDrivenChatThreads$)) {
      const title = thread.title;
      if (!title || !title.toLowerCase().includes(query)) {
        continue;
      }
      chatThreads.push({
        id: thread.id,
        title,
      });
      if (chatThreads.length >= MAX_VISIBLE_CHAT_THREAD_SUGGESTIONS) {
        break;
      }
    }

    return {
      query: range.query,
      chatThreads,
    };
  });
}
