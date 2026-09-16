import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
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
import { parseTemplatePickerEntryCategory } from "./template-picker-entry.ts";
import { i18n } from "../../i18n/index.ts";
import {
  applyDesktopRecordingHandoff$,
  desktopRecordingHandoffFeatureEnabled,
  hasDesktopRecordingHandoff,
} from "./desktop-recording-handoff.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";

export const setupAgentChatPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const agentId = get(currentAgentId$);

    if (!agentId) {
      throw new Error("Chat page requires an active agent, but none found");
    }

    set(setChatAgentId$, agentId);
    const agentDraft: EnsuredAgentDraft = set(ensureAgentDraft$, agentId);
    set(setAgentComposerContext$, { agentId, agentDraft });
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
      const defaultAgentId = await get(defaultAgentId$);
      signal.throwIfAborted();
      if (!defaultAgentId || defaultAgentId === agentId) {
        throw new Error("Chat page requires an active agent, but none found");
      }

      set(detachedNavigateTo$, "/agents/:agentId/chat", {
        pathParams: { agentId: defaultAgentId },
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

    await set(checkUnifiedSettingsParam$, signal);

    const params = get(searchParams$);
    const prompt = params.get("prompt");
    const queue = params.get("queue");
    const featureSwitches = get(featureSwitch$);
    const templatePicker = parseTemplatePickerEntryCategory(
      params.get("templatePicker"),
      featureSwitches[FeatureSwitchKey.IntroVideo] === true,
    );
    const desktopRecordingHandoff =
      desktopRecordingHandoffFeatureEnabled(featureSwitches) &&
      hasDesktopRecordingHandoff(params);
    if (agentDraft && !prompt && !desktopRecordingHandoff) {
      await set(agentDraft.load$, signal);
    }
    if (prompt) {
      const targetDraft = agentDraft?.draft ?? get(talkDraft$);
      set(targetDraft.clear$);
      set(targetDraft.setInput$, prompt);
      const next = new URLSearchParams(params);
      next.delete("prompt");
      set(updateSearchParams$, next);
    }
    if (desktopRecordingHandoff) {
      const targetDraft = agentDraft?.draft ?? get(talkDraft$);
      await set(
        applyDesktopRecordingHandoff$,
        targetDraft,
        get(searchParams$),
        signal,
      );
    }
    if (templatePicker) {
      const composerSignals = get(agentChatComposerSignals$);
      set(composerSignals.template.setTemplatePickerSearch$, "");
      set(composerSignals.template.setTemplatePickerPreviewSlug$, null);
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
