import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  suggestionsContract,
  type Suggestion,
} from "@okouai/api-contracts/contracts/suggestions";
import { accept } from "../../lib/accept.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { defaultAgentId$ } from "../agent.ts";
import { currentChatAgentId$ } from "../agent-chat.ts";
import { apiClient$ } from "../api-client.ts";
import { setAblyInvalidationLoop$ } from "../realtime.ts";
import { rootSignal$ } from "../root-signal.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { ensureDraft$ } from "../chat-page/create-chat-thread.ts";
import { ensureAgentDraft$ } from "./agent-draft.ts";
import { agentChatComposerSignals$ } from "./agent-composer-signals.ts";

export const agentSuggestionsEnabled$ = computed(async (get) => {
  if (!get(featureSwitch$)[FeatureSwitchKey.AgentSuggestion]) {
    return false;
  }
  const [current, primary] = await Promise.all([
    get(currentChatAgentId$),
    get(defaultAgentId$),
  ]);
  return primary !== null && current === primary;
});
const revision$ = state(0);
const consumedIds$ = state<readonly string[]>([]);
// The panel shows one suggestion at a time. A position rather than an id, so
// consuming the card on screen brings up the one after it, and consuming the
// last one falls back to the one before.
const index$ = state(0);
export const agentSuggestionIndex$ = computed((get) => {
  return get(index$);
});
export const showAgentSuggestion$ = command(({ set }, index: number) => {
  set(index$, index);
});
const agentSuggestions$ = computed(async (get) => {
  get(revision$);
  if (!(await get(agentSuggestionsEnabled$))) {
    return [];
  }
  // Suggestions are an optional entry on the home page, so a failed read
  // hides the tab instead of raising a toast over the composer.
  const result = await accept(
    get(apiClient$)(suggestionsContract).list({}),
    [200, 403],
    undefined,
    { showErrorToast: false },
  );
  return result.status === 200 ? result.body.suggestions : [];
});
export const visibleAgentSuggestions$ = computed(async (get) => {
  const consumed = get(consumedIds$);
  return (await get(agentSuggestions$)).filter((item) => {
    return !consumed.includes(item.id);
  });
});
const reload$ = command(({ set }) => {
  set(revision$, (value) => {
    return value + 1;
  });
});
export const enterAgentSuggestions$ = command(({ set }) => {
  set(index$, 0);
  set(consumedIds$, []);
  set(reload$);
});
export const subscribeAgentSuggestions$ = command(
  ({ get, set }, signal: AbortSignal) => {
    if (!get(featureSwitch$)[FeatureSwitchKey.AgentSuggestion]) {
      return;
    }
    set(
      setAblyInvalidationLoop$,
      {
        scope: "credential",
        topic: "agentSuggestionsChanged",
        invalidations: [reload$],
        options: { runOnSubscribe: true },
      },
      signal,
    );
  },
);
/**
 * Hides the suggestion at once and consumes it on the server. Dismissing a
 * suggestion is this alone; starting one goes on to open its draft. Resolves to
 * the consumed suggestion, or to null when it was already consumed here or
 * elsewhere.
 */
export const consumeAgentSuggestion$ = command(
  async ({ get, set }, item: Suggestion, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (get(consumedIds$).includes(item.id)) {
      return null;
    }
    set(consumedIds$, (ids) => {
      return [...ids, item.id];
    });
    const result = await accept(
      get(apiClient$)(suggestionsContract).consume({
        params: { id: item.id },
        body: {},
        fetchOptions: { signal },
      }),
      [200, 409],
    );
    signal.throwIfAborted();
    set(reload$);
    return result.status === 200 ? result.body : null;
  },
);
export const startAgentSuggestion$ = command(
  async ({ get, set }, item: Suggestion, signal: AbortSignal) => {
    const handoffSignal = get(rootSignal$);
    const selected = await set(consumeAgentSuggestion$, item, signal);
    if (selected === null) {
      return;
    }
    // Draft reconciliation and persistence survive the navigation they initiate.
    if (selected.threadId !== null) {
      const draft = set(ensureDraft$, selected.threadId);
      await set(draft.prependComposerDraft$, selected.draft, handoffSignal);
      signal.throwIfAborted();
      set(detachedNavigateTo$, ROUTES.chat, {
        pathParams: { threadId: selected.threadId },
      });
      return;
    }
    const primary = await get(defaultAgentId$);
    signal.throwIfAborted();
    handoffSignal.throwIfAborted();
    if (!primary) {
      throw new Error("Primary Agent is unavailable");
    }
    const target = set(ensureAgentDraft$, primary);
    await set(
      target.draft.prependComposerDraft$,
      selected.draft,
      handoffSignal,
    );
    signal.throwIfAborted();
    await set(target.load$, handoffSignal);
    signal.throwIfAborted();
    set(get(agentChatComposerSignals$).editor.focus$);
  },
);
