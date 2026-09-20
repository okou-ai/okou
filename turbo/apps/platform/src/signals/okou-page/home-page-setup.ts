import { command } from "ccstate";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import { defaultAgentId$ } from "../agent.ts";
import { setupAgentsPage$ } from "../agents-page/agents-page-setup.ts";
import { parseTemplatePickerEntryCategory } from "./template-picker-entry.ts";

export const setupHomePage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    // Redirect bare / to the default agent's chat. Keep prompt deep links intact
    // so paid-onboarding handoffs can prefill the chat composer on arrival.
    // ?queue= is also forwarded so the queue drawer opens on arrival.
    const defaultAgentId = await get(defaultAgentId$);
    signal.throwIfAborted();
    if (!defaultAgentId) {
      await set(setupAgentsPage$, signal);
      return;
    }
    const params = get(searchParams$);
    const prompt = params.get("prompt");
    const queue = params.get("queue");
    const settings = params.get("settings");
    const billingView = params.get("billingView");
    const templatePicker = parseTemplatePickerEntryCategory(
      params.get("templatePicker"),
    );
    const forwardParams = new URLSearchParams();
    if (prompt) {
      forwardParams.set("prompt", prompt);
    }
    if (queue) {
      forwardParams.set("queue", queue);
    }
    if (settings) {
      forwardParams.set("settings", settings);
    }
    if (billingView) {
      forwardParams.set("billingView", billingView);
    }
    if (templatePicker) {
      forwardParams.set("templatePicker", templatePicker);
    }
    set(detachedNavigateTo$, "/agents/:agentId/chat", {
      pathParams: { agentId: defaultAgentId },
      searchParams: forwardParams.size > 0 ? forwardParams : undefined,
      replace: true,
    });
  },
);
