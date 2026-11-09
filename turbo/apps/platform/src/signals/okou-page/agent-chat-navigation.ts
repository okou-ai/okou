import { command } from "ccstate";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { singleAgentEnabled$ } from "../single-agent.ts";

interface AgentChatNavigation {
  readonly searchParams?: URLSearchParams;
  readonly replace?: boolean;
}

/**
 * Opens an agent's chat page. My Okou has one chat page at `/`, which always
 * chats with the default agent, so the agent only picks the page without it.
 */
export const navigateToAgentChat$ = command(
  ({ get, set }, agentId: string, options: AgentChatNavigation = {}) => {
    if (get(singleAgentEnabled$)) {
      set(detachedNavigateTo$, ROUTES.home, options);
      return;
    }
    set(detachedNavigateTo$, ROUTES.agentChat, {
      ...options,
      pathParams: { agentId },
    });
  },
);
