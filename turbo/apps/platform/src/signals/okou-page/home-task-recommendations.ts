import { command, computed, state } from "ccstate";
import {
  HOME_TASK_RECOMMENDATION_REFRESH_MS,
  homeTaskRecommendationsContract,
  homeTaskRecommendationsResponseSchema,
  type HomeTaskRecommendation,
} from "@okouai/api-contracts/contracts/home-task-recommendations";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { sendNewThread$ } from "../chat-page/optimistic-chat-thread-page.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { setLoop } from "../utils.ts";

/**
 * The floor on how often the page re-asks.
 *
 * The server owns the real cadence and reports what is left of it, so this is
 * only a guard against a zero or a stale clock turning the poll into a busy
 * loop. It is deliberately far below the refresh interval: a member who leaves
 * the page open across the window should see the new cards without a reload.
 */
const MIN_POLL_INTERVAL_MS = 60_000;

const reloadVersion$ = state(0);

export const homeTaskRecommendationsEnabled$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.HomeTaskRecommendations] ?? false;
});

/**
 * The member's current home page task cards.
 *
 * `null` means there is nothing to show — the switch is off, the request was
 * refused, or the server had no usable set. The page renders nothing for all
 * three; none of them is a failure the member can act on, so none of them
 * surfaces an error.
 */
export const homeTaskRecommendations$ = computed(
  async (get): Promise<readonly HomeTaskRecommendation[] | null> => {
    get(reloadVersion$);
    if (!get(homeTaskRecommendationsEnabled$)) {
      return null;
    }
    const response = await accept(
      get(apiClient$)(homeTaskRecommendationsContract).list({}),
      [200, 401, 403],
      undefined,
      { showErrorToast: false },
    );
    if (response.status !== 200) {
      return null;
    }
    const data = homeTaskRecommendationsResponseSchema.parse(response.body);
    return data.recommendations.length > 0 ? data.recommendations : null;
  },
);

/**
 * Keep the cards current for as long as the home page is mounted.
 *
 * The poll runs on the published refresh interval rather than on a cadence of
 * its own: the server refuses to regenerate before that window elapses, so a
 * faster client would only pay for requests that return the same cards.
 */
export const subscribeHomeTaskRecommendations$ = command(
  ({ get, set }, signal: AbortSignal): void => {
    if (!get(homeTaskRecommendationsEnabled$)) {
      return;
    }
    setLoop(
      () => {
        set(reloadVersion$, (version) => {
          return version + 1;
        });
        return false;
      },
      Math.max(MIN_POLL_INTERVAL_MS, HOME_TASK_RECOMMENDATION_REFRESH_MS),
      signal,
      { testIntervalMs: 100 },
    );
  },
);

/**
 * Hand the recommended task to a thread of its own.
 *
 * The card's prompt is sent as that thread's first message, so the click
 * starts the work rather than filling the composer with it: the member chose a
 * described task, not a draft to edit.
 */
export const startHomeTaskRecommendation$ = command(
  async (
    { set },
    args: { readonly agentId: string; readonly prompt: string },
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      sendNewThread$,
      {
        agentId: args.agentId,
        prompt: args.prompt,
        generationTemplate: undefined,
      },
      signal,
    );
  },
);
