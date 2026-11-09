import { singleAgentEnabled$ } from "../single-agent.ts";
import { command } from "ccstate";
import { createElement } from "react";
import { JobDetailPage } from "../../views/team-page/job-detail-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import { currentAgentId$, agents$, defaultAgentId$ } from "../agent.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { setActiveAgent$ } from "../okou-page/job-detail";
import { setChatAgentId$ } from "../agent-chat.ts";
import { i18n } from "../../i18n/index.ts";
import { refreshSsh$ } from "../ssh.ts";
import { watchAgentInstructions$ } from "../okou-page/job-detail/instructions.ts";

export const setupAgentDetailPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const agentId = get(currentAgentId$);
    if (!agentId) {
      throw new Error(
        "Agent detail page requires an active agent, but none found",
      );
    }

    if (get(singleAgentEnabled$) && agentId === (await get(defaultAgentId$))) {
      signal.throwIfAborted();
      const tab = get(searchParams$).get("tab");
      set(
        detachedNavigateTo$,
        tab === "authorization" || tab === null ? "/connectors" : "/",
        {
          searchParams:
            tab === "authorization" || tab === null
              ? undefined
              : new URLSearchParams({ settings: "my-okou" }),
          replace: true,
        },
      );
      return;
    }
    set(refreshSsh$);
    const agents = await get(agents$);
    signal.throwIfAborted();

    const agent = agents.find((candidate) => {
      return candidate.agentId === agentId;
    });
    if (!agent) {
      const defaultAgentId = await get(defaultAgentId$);
      signal.throwIfAborted();
      if (!defaultAgentId || defaultAgentId === agentId) {
        throw new Error(
          "Agent detail page requires an active agent, but none found",
        );
      }
      set(detachedNavigateTo$, "/agents/:agentId", {
        pathParams: { agentId: defaultAgentId },
        searchParams: get(searchParams$),
        replace: true,
      });
      return;
    }

    // Activate the agent to trigger dependent signals (detail, automation, etc.)
    set(setActiveAgent$, agentId);
    set(watchAgentInstructions$, signal);
    set(updatePage$, createElement(JobDetailPage, { key: agentId }), "sidebar");
    set(setChatAgentId$, agentId);
    const displayName =
      agent.displayName ??
      i18n.t(
        ($) => {
          return $.fallbackName;
        },
        { ns: "agents" },
      );
    set(updateDocumentTitle$, displayName);

    signal.throwIfAborted();

    await set(hideAppSkeleton$, signal);
    signal.throwIfAborted();
  },
);
