import { hydrateProjects$ } from "../projects/projects.ts";
import { resetProjectUi$ } from "../projects/project-ui.ts";
import {
  loadMarketingHandoff$,
  createMarketingHandoffDraft$,
  finishMarketingHandoff$,
} from "../prompt-page/marketing-handoff.ts";
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

import { setTalkDraft$, talkDraft$ } from "./chat-draft.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import {
  resetChatPageModelSelection$,
  startChatGreetingVisit$,
} from "./chat-page.ts";
import { ensureAgentDraft$, type EnsuredAgentDraft } from "./agent-draft.ts";
import {
  agentChatComposerSignals$,
  setAgentComposerContext$,
} from "./agent-composer-signals.ts";
import { openQueueDrawer$ } from "../queue-page/queue-drawer-state.ts";
import { checkUnifiedSettingsParam$ } from "./settings/settings-dialog.ts";
import { setupAgentChatKeyboardShortcuts$ } from "./agent-chat-keyboard.ts";
import {
  isPwaAgentComposeRequested,
  setPwaAgentComposeRequested$,
} from "./pwa-navigation.ts";
import { parseTemplatePickerEntryCategory } from "./template-picker-entry.ts";
import { i18n } from "../../i18n/index.ts";
import { detach, Reason } from "../utils.ts";
import {
  setAgentPhoneConnectDialogOpen$,
  watchAgentPhoneConnection$,
} from "./agentphone.ts";

const restoreMarketingAgentDraft$ = command(
  async ({ get, set }, agentDraft: EnsuredAgentDraft, signal: AbortSignal) => {
    const params = get(searchParams$);
    const handoff = await set(loadMarketingHandoff$, signal);
    if (!handoff) {
      await set(agentDraft.load$, signal);
      return;
    }
    const imported = await set(
      createMarketingHandoffDraft$,
      handoff.hash,
      signal,
    );
    if (!imported) {
      await set(agentDraft.load$, signal);
      return;
    }
    const targetDraft = agentDraft.draft;
    await set(
      targetDraft.seed$,
      {
        content: handoff.manifest.prompt,
        userMessage: null,
        generationTemplate: undefined,
        attachments: get(imported.attachments$),
      },
      signal,
    );
    signal.throwIfAborted();
    await set(agentDraft.queueDraftSync$, signal);
    signal.throwIfAborted();
    set(finishMarketingHandoff$, handoff);
    const next = new URLSearchParams(params);
    next.delete("handoff");
    set(updateSearchParams$, next);
  },
);

export const setupHomeChatPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const agentDraft: EnsuredAgentDraft = await set(ensureAgentDraft$, signal);
    set(resetProjectUi$);
    set(
      setPwaAgentComposeRequested$,
      isPwaAgentComposeRequested(get(searchParams$)),
    );
    set(setAgentComposerContext$, { agentDraft });
    set(get(agentChatComposerSignals$).setup$, signal);
    set(setTalkDraft$, agentDraft.draft);
    set(startChatGreetingVisit$);
    set(resetChatPageModelSelection$);
    set(setAgentPhoneConnectDialogOpen$, false);
    set(updatePage$, createElement(AgentChatPage), "sidebar");
    // Keep the phone link current while Get started can open its connect
    // dialog here, so a link made from the phone closes it the way it does on
    // the pages that also offer the link. Link status never delays the chat,
    // so the watch runs beside setup.
    detach(
      set(watchAgentPhoneConnection$, signal),
      Reason.Daemon,
      "get started phone link",
    );

    await set(hideAppSkeleton$, signal);

    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.chat.documentTitle;
      }),
    );
    set(setupAgentChatKeyboardShortcuts$, signal);
    await set(hydrateProjects$, signal);
    await set(checkUnifiedSettingsParam$, signal);

    const params = get(searchParams$);
    const prompt = params.get("handoff") ? null : params.get("prompt");
    if (params.get("handoff")) {
      await set(restoreMarketingAgentDraft$, agentDraft, signal);
    }
    const queue = params.get("queue");
    const templatePicker = parseTemplatePickerEntryCategory(
      params.get("templatePicker"),
    );
    if (agentDraft && !prompt && !params.get("handoff")) {
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

export const setupAgentChatPage$ = command(({ get, set }) => {
  // My Okou has one chat page at `/`. Keep deep-link params such as
  // `prompt` and `handoff` so the page there still applies them.
  set(detachedNavigateTo$, ROUTES.home, {
    searchParams: get(searchParams$),
    replace: true,
  });
});
