import { command, computed, state } from "ccstate";
import {
  homeTaskRecommendationsContract,
  homeTaskRecommendationsResponseSchema,
  type HomeTaskRecommendation,
} from "@okouai/api-contracts/contracts/home-task-recommendations";
import {
  connectorChangedPayloadSchema,
  homeTaskRecommendationsChangedPayloadSchema,
} from "@okouai/api-contracts/contracts/realtime";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept } from "../../lib/accept.ts";
import { currentChatAgentId$ } from "../agent-chat.ts";
import { apiClient$ } from "../api-client.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { setAblyInvalidationLoop$, setAblyPayloadLoop$ } from "../realtime.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { agentChatComposerSignals$ } from "./agent-composer-signals.ts";

const reloadVersion$ = state(0);

/** Synchronous display fence: stale async results never survive invalidation. */
export const homeTaskRecommendationsRevision$ = computed((get): number => {
  return get(reloadVersion$);
});

export const homeTaskRecommendationsEnabled$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.HomeTaskRecommendations] ?? false;
});

export interface HomeTaskRecommendationSet {
  readonly agentId: string;
  readonly revision: number;
  readonly recommendations: readonly HomeTaskRecommendation[];
}

/** Cards are requested and identified by the Agent currently owning the page. */
export const homeTaskRecommendations$ = computed(
  async (get): Promise<HomeTaskRecommendationSet | null> => {
    const revision = get(reloadVersion$);
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
      ? { agentId, revision, recommendations: data.recommendations }
      : null;
  },
);

const invalidateHomeTaskRecommendations$ = command(({ set }): void => {
  set(reloadVersion$, (version) => {
    return version + 1;
  });
});

const reloadHomeTaskRecommendations$ = command(({ set }): boolean => {
  set(invalidateHomeTaskRecommendations$);
  return false;
});

const reloadHomeTaskRecommendationsFromPush$ = command(
  async (
    { get, set },
    payload: unknown,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const parsed =
      homeTaskRecommendationsChangedPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      return false;
    }
    const currentAgentId = await get(currentChatAgentId$);
    signal.throwIfAborted();
    if (currentAgentId === parsed.data.agentId) {
      set(invalidateHomeTaskRecommendations$);
    }
    return false;
  },
);

const reloadHomeTaskRecommendationsAfterConnectorChange$ = command(
  ({ set }, payload: unknown): boolean => {
    const parsed = connectorChangedPayloadSchema.safeParse(payload);
    if (parsed.success && parsed.data.connectorSlug === "gmail") {
      set(invalidateHomeTaskRecommendations$);
    }
    return false;
  },
);

/**
 * Follow server-owned cron refreshes. The subscription's initial reload closes
 * the read/attach race; there is deliberately no browser timer or polling.
 */
export const subscribeHomeTaskRecommendations$ = command(
  ({ get, set }, signal: AbortSignal): void => {
    if (!get(homeTaskRecommendationsEnabled$)) {
      return;
    }
    set(
      setAblyPayloadLoop$,
      {
        scope: "credential",
        topic: "homeTaskRecommendationsChanged",
        loopCommand$: reloadHomeTaskRecommendationsFromPush$,
        initializeCommand$: reloadHomeTaskRecommendations$,
      },
      signal,
    );
    set(
      setAblyPayloadLoop$,
      {
        topic: "connector:changed",
        loopCommand$: reloadHomeTaskRecommendationsAfterConnectorChange$,
      },
      signal,
    );
    set(
      setAblyInvalidationLoop$,
      {
        topic: "connectorPermissionUpdated",
        invalidations: [invalidateHomeTaskRecommendations$],
      },
      signal,
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
