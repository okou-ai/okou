import { command } from "ccstate";
import { createElement } from "react";
import { AgentChatPage } from "../../views/okou-page/agent-chat-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import {
  searchParams$,
  updateSearchParams$,
  detachedNavigateTo$,
} from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { currentAgentId$, defaultAgentId$, agents$ } from "../agent.ts";
import { setChatAgentId$ } from "../agent-chat.ts";
import { setTalkDraft$, talkDraft$ } from "./chat-draft.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { reloadTagline$, resetChatPageModelSelection$ } from "./chat-page.ts";
import { ensureAgentDraft$, type EnsuredAgentDraft } from "./agent-draft.ts";
import {
  agentChatComposerSignals$,
  setAgentComposerContext$,
} from "./agent-composer-signals.ts";
import { openQueueDrawer$ } from "../queue-page/queue-drawer-state.ts";
import { checkUnifiedSettingsParam$ } from "./settings/settings-dialog.ts";
import { setupAgentChatKeyboardShortcuts$ } from "./agent-chat-keyboard.ts";
import { subscribeHomeTaskRecommendations$ } from "./home-task-recommendations.ts";
import { parseTemplatePickerEntryCategory } from "./template-picker-entry.ts";
import { i18n } from "../../i18n/index.ts";

export const setupAgentChatPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const agentId = get(currentAgentId$);

    if (!agentId) {
      throw new Error("Chat page requires an active agent, but none found");
    }

    set(setChatAgentId$, agentId);
    const agentDraft: EnsuredAgentDraft = set(ensureAgentDraft$, agentId);
    set(setAgentComposerContext$, { agentId, agentDraft });
    set(get(agentChatComposerSignals$).voice.setup$, signal);
    set(setTalkDraft$, agentDraft.draft);
    set(reloadTagline$);
    set(resetChatPageModelSelection$);
    set(updatePage$, createElement(AgentChatPage), "sidebar");

    await set(hideAppSkeleton$, signal);

    const agents = await get(agents$);
    signal.throwIfAborted();
    const agent = agents.find((candidate) => {
      return candidate.agentId === agentId;
    });
    if (!agent) {
      // The URL names an agent this user cannot reach: it was deleted, it
      // belongs to another organization, or it is private to someone else.
      // Recover onto a usable surface the way the home route already does,
      // instead of leaving the user behind the bootstrap skeleton.
      const defaultAgentId = await get(defaultAgentId$);
      signal.throwIfAborted();

      // The stored default is never validated against the visible agents, so
      // trust it only when this already-loaded list contains it. A default
      // equal to `agentId` fails the same check, because `agentId` is absent
      // from the list. Otherwise fall back to any visible agent.
      const defaultAgentIsVisible = agents.some((candidate) => {
        return candidate.agentId === defaultAgentId;
      });
      const fallbackAgentId = defaultAgentIsVisible
        ? defaultAgentId
        : agents[0]?.agentId;

      if (fallbackAgentId) {
        set(detachedNavigateTo$, ROUTES.agentChat, {
          pathParams: { agentId: fallbackAgentId },
          searchParams: get(searchParams$),
          replace: true,
        });
        return;
      }

      // No visible agent at all. Home degrades to the agents surface only when
      // no default is recorded; while an unreachable default is still recorded
      // it would navigate straight back here, so go to that surface directly.
      set(detachedNavigateTo$, defaultAgentId ? ROUTES.agents : ROUTES.home, {
        searchParams: get(searchParams$),
        replace: true,
      });
      return;
    }

    set(
      updateDocumentTitle$,
      agent.displayName ??
        i18n.t(($) => {
          return $.chat.documentTitle;
        }),
    );
    set(setupAgentChatKeyboardShortcuts$, signal);
    // The recommendation refresh belongs to the page, not to the card that
    // renders it: the loop must stop when the route does, and a component that
    // unmounts while the set is empty would otherwise never restart it.
    set(subscribeHomeTaskRecommendations$, signal);

    await set(checkUnifiedSettingsParam$, signal);

    const params = get(searchParams$);
    const prompt = params.get("prompt");
    const queue = params.get("queue");
    const templatePicker = parseTemplatePickerEntryCategory(
      params.get("templatePicker"),
    );
    if (agentDraft && !prompt) {
      await set(agentDraft.load$, signal);
    }
    if (prompt) {
      const targetDraft = agentDraft?.draft ?? get(talkDraft$);
      set(targetDraft.clear$);
      set(targetDraft.setInput$, prompt);
      set(get(agentChatComposerSignals$).editor.focus$);
      const next = new URLSearchParams(params);
      next.delete("prompt");
      set(updateSearchParams$, next);
    }
    if (templatePicker) {
      const composerSignals = get(agentChatComposerSignals$);
      set(composerSignals.template.setTemplatePickerSearch$, "");
      set(composerSignals.template.clearPresentationTemplatePreviews$);
      set(composerSignals.template.setTemplatePickerReferenceValue$, null);
      set(composerSignals.template.setTemplatePickerCategory$, templatePicker);
      set(composerSignals.template.setTemplatePickerOpen$, true);
      const next = new URLSearchParams(get(searchParams$));
      next.delete("templatePicker");
      set(updateSearchParams$, next);
    }
    if (queue === "1") {
      set(openQueueDrawer$);
    }
  },
);
