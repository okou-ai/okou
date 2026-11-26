import { pageVersion$ } from "../page-signal.ts";
import type { SuggestionImpression } from "../../lib/posthog.ts";
import { command, computed, state, type Command } from "ccstate";
import { feedContract } from "@okouai/api-contracts/client/feed";
import type { FeedSources } from "@okouai/api-contracts/contracts/feed";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitches$ } from "../external/feature-switch.ts";
import { discardApiBootstrapResponse } from "../api-client-base.ts";
import { accept } from "../../lib/accept.ts";
import { setAblyInvalidationLoop$ } from "../realtime.ts";
import { apiClient$ } from "../api-client.ts";
import { authenticatedSessionKey$ } from "../auth.ts";
import { createDeferredPromise, onRef } from "../utils.ts";

const sourceState$ = computed((get) => {
  get(authenticatedSessionKey$);
  return { version$: state(0), summaryVersion$: state(0) };
});

export const forYouSources$ = computed(async (get) => {
  get(get(sourceState$).version$);
  const result = await accept(
    get(apiClient$)(feedContract).sources(),
    [200],
    undefined,
    { showErrorToast: false },
  );
  return result.body;
});

export const forYouSummary$ = computed(async (get) => {
  get(get(sourceState$).summaryVersion$);
  const result = await accept(
    get(apiClient$)(feedContract).summary(),
    [200],
    undefined,
    { showErrorToast: false },
  );
  return result.body;
});

export const forYouEntryVisible$ = computed(async (get) => {
  const switches = await get(featureSwitches$);
  if (!switches[FeatureSwitchKey.HideEmptyForYou]) {
    return true;
  }
  const [result] = await Promise.allSettled([get(forYouSummary$)]);
  if (result.status === "rejected") {
    // An unavailable feed has no row to show or stop on during navigation.
    return false;
  }
  const { firstItem, hasUnread } = result.value;
  // Older summaries only identify unread cards.
  return firstItem === undefined ? hasUnread : firstItem !== null;
});

export const reloadForYouSources$ = command(({ get, set }) => {
  // A feed change can arrive before the chat list reads its Worker summary.
  discardApiBootstrapResponse(
    feedContract.summary.method,
    feedContract.summary.path,
  );
  const state = get(sourceState$);
  set(state.version$, (version) => {
    return version + 1;
  });
  set(state.summaryVersion$, (version) => {
    return version + 1;
  });
});

/** Notifications can arrive while the mobile chat list is off screen. */
export const subscribeForYouSources$ = command(
  ({ set }, signal: AbortSignal) => {
    set(
      setAblyInvalidationLoop$,
      {
        scope: "credential",
        topic: "agentSuggestionsChanged",
        invalidations: [reloadForYouSources$],
      },
      signal,
    );
  },
);

export const updateForYouSource$ = command(
  async (
    { get, set },
    source: keyof FeedSources,
    enabled: boolean,
    signal: AbortSignal,
  ) => {
    await accept(
      get(apiClient$)(feedContract).updateSources({
        body: { [source]: enabled },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    set(reloadForYouSources$);
    await get(forYouSources$);
    signal.throwIfAborted();
  },
);

// The page can replace its feed entry while the same logical card stays active.
export const activeSuggestionImpression$ = computed((get) => {
  get(pageVersion$);
  return state<SuggestionImpression | null>(null);
});

export function createForYouReadRef(
  id: string,
  observe$?: Command<void, [HTMLElement, AbortSignal]>,
) {
  return onRef(
    command(async ({ get, set }, element: HTMLElement, signal: AbortSignal) => {
      const impression$ = get(activeSuggestionImpression$);
      if (get(impression$)?.suggestion_id !== id) {
        set(impression$, null);
      }
      if (observe$) {
        set(observe$, element, signal);
      }
      signal.throwIfAborted();
      if (document.hidden) {
        const visible = createDeferredPromise<void>(signal);
        const onVisibilityChange = () => {
          if (!document.hidden) {
            document.removeEventListener(
              "visibilitychange",
              onVisibilityChange,
            );
            visible.resolve();
          }
        };
        document.addEventListener("visibilitychange", onVisibilityChange, {
          signal,
        });
        await visible.promise;
        signal.throwIfAborted();
      }
      // Only the active, mounted card receives this ref. Reading never chooses
      // an option, dismisses a card or marks the rest of the stack as read.
      await accept(
        get(apiClient$)(feedContract).markRead({
          params: { id },
          fetchOptions: { signal },
        }),
        [200, 404],
        signal,
        { showErrorToast: false },
      );
      signal.throwIfAborted();
      set(get(sourceState$).summaryVersion$, (version) => {
        return version + 1;
      });
    }),
  );
}
