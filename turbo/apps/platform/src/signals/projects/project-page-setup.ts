import { command } from "ccstate";
import { createElement } from "react";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import { ProjectPage } from "../../views/projects/project-page.tsx";
import { defaultAgentId$ } from "../agent.ts";
import { setChatAgentId$ } from "../agent-chat.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { ensureAgentDraft$ } from "../okou-page/agent-draft.ts";
import {
  agentChatComposerSignals$,
  setAgentComposerContext$,
} from "../okou-page/agent-composer-signals.ts";
import { setupProjectPageKeyboardShortcuts$ } from "../okou-page/agent-chat-keyboard.ts";
import { setTalkDraft$ } from "../okou-page/chat-draft.ts";
import { navigateToAgentChat$ } from "../okou-page/agent-chat-navigation.ts";
import { resetChatPageModelSelection$ } from "../okou-page/chat-page.ts";
import { updatePage$ } from "../react-router.ts";
import { selectedProjectId$ } from "./project-navigation.ts";
import { hydrateProjects$, projects$ } from "./projects.ts";

/**
 * A Project's own page starts new chats inside it, like an Agent's new-chat
 * page. Projects always compose with the default Agent and keep the agent
 * draft for now.
 */
export const setupProjectPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const projectId = get(selectedProjectId$);
    const agentId = await get(defaultAgentId$);
    signal.throwIfAborted();
    if (!projectId || !agentId) {
      throw new Error("A Project page requires a Project and a default Agent");
    }
    set(setChatAgentId$, agentId);
    const agentDraft = set(ensureAgentDraft$, agentId);
    set(setAgentComposerContext$, { agentId, agentDraft, projectId });
    set(get(agentChatComposerSignals$).setup$, signal);
    set(setTalkDraft$, agentDraft.draft);
    set(resetChatPageModelSelection$);
    set(updatePage$, createElement(ProjectPage), "sidebar");
    set(setupProjectPageKeyboardShortcuts$, projectId, signal);
    await set(hideAppSkeleton$, signal);
    signal.throwIfAborted();

    await set(hydrateProjects$, signal);
    signal.throwIfAborted();
    const project = get(projects$).find((item) => {
      return item.id === projectId;
    });
    if (!project) {
      toast.error(
        i18n.t(($) => {
          return $.projects.unavailable;
        }),
      );
      set(navigateToAgentChat$, agentId, { replace: true });
      return;
    }
    set(updateDocumentTitle$, project.name);
    await set(agentDraft.load$, signal);
  },
);
