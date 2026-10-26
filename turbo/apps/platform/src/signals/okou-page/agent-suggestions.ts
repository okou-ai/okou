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
import {
  ensureDraft$,
  resumeThreadDraftHandoff$,
} from "../chat-page/create-chat-thread.ts";
import { ensureAgentDraft$ } from "./agent-draft.ts";

export const agentSuggestionsEnabled$ = computed(async (get) => {
  if (!get(featureSwitch$)[FeatureSwitchKey.ProactiveAgent]) {
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
    if (!get(featureSwitch$)[FeatureSwitchKey.ProactiveAgent]) {
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
 * Consume the suggestion on the server, then remove it from the panel.
 * Dismissing stops here; using a suggestion adds its content to a draft. Resolves to
 * the consumed suggestion, or to null when it was already consumed here or
 * elsewhere.
 */
const consumeAgentSuggestion$ = command(
  async ({ get, set }, item: Suggestion, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (get(consumedIds$).includes(item.id)) {
      return null;
    }
    const result = await accept(
      get(apiClient$)(suggestionsContract).consume({
        params: { id: item.id },
        body: {},
        fetchOptions: { signal },
      }),
      [200, 409],
      signal,
    );
    set(consumedIds$, (ids) => {
      return [...ids, item.id];
    });
    signal.throwIfAborted();
    set(reload$);
    return result.status === 200 ? result.body : null;
  },
);
const applyAgentSuggestionDraft$ = command(
  async ({ set }, item: Suggestion, agentId: string, signal: AbortSignal) => {
    const target =
      item.threadId === null ? set(ensureAgentDraft$, agentId) : null;
    const draft =
      item.threadId !== null
        ? set(ensureDraft$, item.threadId)
        : set(ensureAgentDraft$, agentId).draft;
    await set(draft.prependComposerDraft$, item.draft, signal);
    if (item.threadId !== null) {
      await set(resumeThreadDraftHandoff$, item.threadId, signal);
      signal.throwIfAborted();
      set(detachedNavigateTo$, ROUTES.chat, {
        pathParams: { threadId: item.threadId },
      });
      return;
    }
    if (!target) {
      throw new Error("Suggestion target is unavailable");
    }
    await set(target.load$, signal);
    signal.throwIfAborted();
    set(detachedNavigateTo$, ROUTES.agentChat, {
      pathParams: { agentId },
    });
  },
);

export const startAgentSuggestion$ = command(
  async (
    { get, set },
    item: Suggestion,
    pageSignal: AbortSignal,
  ): Promise<void> => {
    pageSignal.throwIfAborted();
    const signal = get(rootSignal$);
    // Resolve the new-thread destination before consuming. The accepted result
    // can change the target, so both new and existing cards need this identity.
    const agentId = await get(defaultAgentId$);
    signal.throwIfAborted();
    if (!agentId) {
      throw new Error("Suggestion target is unavailable");
    }
    const selected = await set(consumeAgentSuggestion$, item, signal);
    if (!selected) {
      return;
    }
    // Existing threads already have an authoritative ID. Install their draft
    // before any destination metadata or saved-draft request can fail.
    await set(applyAgentSuggestionDraft$, selected, agentId, signal);
  },
);

export const dismissAgentSuggestion$ = consumeAgentSuggestion$;
