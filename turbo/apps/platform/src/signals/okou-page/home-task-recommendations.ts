import { command, computed, state } from "ccstate";
import {
  HOME_TASK_RECOMMENDATION_REFRESH_MS,
  homeTaskRecommendationsContract,
  homeTaskRecommendationsResponseSchema,
  type HomeTaskRecommendation,
} from "@okouai/api-contracts/contracts/home-task-recommendations";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept } from "../../lib/accept.ts";
import { currentChatAgentId$ } from "../agent-chat.ts";
import { apiClient$ } from "../api-client.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { setLoop } from "../utils.ts";
import { agentChatComposerSignals$ } from "./agent-composer-signals.ts";

const MIN_POLL_INTERVAL_MS = 60_000;
const reloadVersion$ = state(0);

export const homeTaskRecommendationsEnabled$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.HomeTaskRecommendations] ?? false;
});

export interface HomeTaskRecommendationSet {
  readonly agentId: string;
  readonly recommendations: readonly HomeTaskRecommendation[];
}

/** Cards are requested and identified by the Agent currently owning the page. */
export const homeTaskRecommendations$ = computed(
  async (get): Promise<HomeTaskRecommendationSet | null> => {
    get(reloadVersion$);
    if (!get(homeTaskRecommendationsEnabled$)) {
      return null;
    }
    const agentId = await get(currentChatAgentId$);
    if (!agentId) {
      return null;
    }
    const response = await accept(
      get(apiClient$)(homeTaskRecommendationsContract).list({
        query: { agentId },
      }),
      [200, 401, 403],
      undefined,
      { showErrorToast: false },
    );
    if (response.status !== 200) {
      return null;
    }
    const data = homeTaskRecommendationsResponseSchema.parse(response.body);
    return data.recommendations.length > 0
      ? { agentId, recommendations: data.recommendations }
      : null;
  },
);

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
 * Put the recommendation in the appropriate composer and stop there.
 *
 * New-chat cards already live beside that Agent's new-chat composer. Existing
 * cards navigate to their owned thread with a one-shot draft handoff. Neither
 * branch invokes a send command.
 */
export const startHomeTaskRecommendation$ = command(
  async (
    { get, set },
    args: {
      readonly agentId: string;
      readonly recommendation: HomeTaskRecommendation;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    if (args.recommendation.target.kind === "existing-thread") {
      set(detachedNavigateTo$, ROUTES.chat, {
        pathParams: { threadId: args.recommendation.target.threadId },
        searchParams: new URLSearchParams({
          prompt: args.recommendation.prompt,
        }),
      });
      return;
    }

    const currentAgentId = await get(currentChatAgentId$);
    signal.throwIfAborted();
    if (currentAgentId !== args.agentId) {
      set(detachedNavigateTo$, ROUTES.agentChat, {
        pathParams: { agentId: args.agentId },
        searchParams: new URLSearchParams({
          prompt: args.recommendation.prompt,
        }),
      });
      return;
    }
    const composer = get(agentChatComposerSignals$);
    set(composer.draft.setDraftInput$, args.recommendation.prompt);
    set(composer.editor.focus$);
  },
);
