import { singleAgentEnabled$ } from "../single-agent.ts";
import { projects$ } from "../projects/projects.ts";
import { computed, type Computed } from "ccstate";
import { agents$ } from "../agent.ts";
import { eventDrivenChatThreads$ } from "../chat-page/chat-thread-event-sourcing.ts";
import type { ComposerAgentSuggestion } from "./composer-agent-suggestion-domain.ts";
import type {
  ChatThreadSuggestionRange,
  ComposerChatThreadSuggestion,
} from "./chat-thread-suggestion-domain.ts";

const MAX_DEFAULT_AGENT_SUGGESTIONS = 3;
const MAX_VISIBLE_CHAT_THREAD_SUGGESTIONS = 25;

export interface ComposerChatThreadSuggestionResult {
  readonly agentId: string | null;
  readonly query: string | null;
  readonly agents: readonly ComposerAgentSuggestion[];
  readonly chatThreads: readonly ComposerChatThreadSuggestion[];
}

export function createComposerChatThreadSuggestions(
  activeRange$: Computed<ChatThreadSuggestionRange | null>,
  agentId$: Computed<Promise<string | null>>,
): Computed<Promise<ComposerChatThreadSuggestionResult>> {
  return computed(async (get): Promise<ComposerChatThreadSuggestionResult> => {
    const range = get(activeRange$);
    if (!range) {
      return {
        agentId: null,
        query: null,
        agents: [],
        chatThreads: [],
      };
    }

    const agentId = await get(agentId$);
    if (!agentId) {
      return {
        agentId: null,
        query: range.query,
        agents: [],
        chatThreads: [],
      };
    }

    const query = range.query.toLowerCase();
    const allAgents = await get(agents$);
    const agentAvatarUrls = new Map(
      allAgents.map((agent) => {
        return [agent.agentId, agent.avatarUrl] as const;
      }),
    );
    const agentSuggestions: ComposerAgentSuggestion[] = [];
    for (const agent of allAgents) {
      const name = agent.displayName ?? agent.agentId;
      if (agent.agentId === agentId || !name.toLowerCase().includes(query)) {
        continue;
      }
      agentSuggestions.push({
        id: agent.agentId,
        name,
        avatarUrl: agent.avatarUrl,
      });
      if (
        range.query.length === 0 &&
        agentSuggestions.length === MAX_DEFAULT_AGENT_SUGGESTIONS
      ) {
        break;
      }
    }

    const chatThreads: ComposerChatThreadSuggestion[] = get(projects$)
      .filter((p) => {
        return p.name.toLowerCase().includes(query);
      })
      .map((p) => {
        return { id: p.id, title: p.name, avatarUrl: null, project: true };
      });
    for (const thread of get(eventDrivenChatThreads$)) {
      const title = thread.title;
      if (!title || !title.toLowerCase().includes(query)) {
        continue;
      }
      chatThreads.push({
        id: thread.id,
        title,
        avatarUrl: agentAvatarUrls.get(thread.agentId) ?? null,
      });
      if (chatThreads.length >= MAX_VISIBLE_CHAT_THREAD_SUGGESTIONS) {
        break;
      }
    }

    return {
      agentId,
      query: range.query,
      agents: get(singleAgentEnabled$) ? [] : agentSuggestions,
      chatThreads,
    };
  });
}
