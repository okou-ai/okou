import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { command } from "ccstate";
import { createElement } from "react";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import { HomeChatPage } from "../../views/okou-page/home-chat-page.tsx";

import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { ensureDraft$ } from "../okou-page/workspace-draft.ts";
import {
  workspaceChatComposerSignals$,
  setWorkspaceComposerContext$,
} from "../okou-page/workspace-composer-signals.ts";
import { setupProjectPageKeyboardShortcuts$ } from "../okou-page/chat-keyboard.ts";
import { setTalkDraft$ } from "../okou-page/chat-draft.ts";
import { resetChatPageModelSelection$ } from "../okou-page/chat-page.ts";
import { updatePage$ } from "../react-router.ts";
import { selectedProjectId$ } from "./project-navigation.ts";
import { hydrateProjects$, projects$ } from "./projects.ts";

/**
 * The Project composer opens the workspace draft and starts new chats in this Project.
 */
export const setupProjectPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const projectId = get(selectedProjectId$);
    signal.throwIfAborted();
    if (!projectId) {
      throw new Error("A Project page requires a Project");
    }
    const workspaceDraft = await set(ensureDraft$, signal);
    set(setWorkspaceComposerContext$, { workspaceDraft, projectId });
    set(get(workspaceChatComposerSignals$).setup$, signal);
    set(setTalkDraft$, workspaceDraft.draft);
    set(resetChatPageModelSelection$);
    set(updatePage$, createElement(HomeChatPage, { project: true }), "sidebar");
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
      set(detachedNavigateTo$, ROUTES.home, { replace: true });
      return;
    }
    set(updateDocumentTitle$, project.name);
    await set(workspaceDraft.load$, signal);
  },
);
