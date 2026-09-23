import { command, computed, state } from "ccstate";
import {
  homeTaskRecommendationsContract,
  homeTaskRecommendationsResponseSchema,
  type HomeTaskRecommendation,
  type HomeTaskRecommendationConnector,
} from "@okouai/api-contracts/contracts/home-task-recommendations";
import {
  connectorChangedPayloadSchema,
  homeTaskRecommendationsChangedPayloadSchema,
} from "@okouai/api-contracts/contracts/realtime";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept } from "../../lib/accept.ts";
import { currentChatAgentId$ } from "../agent-chat.ts";
import { apiClient$ } from "../api-client.ts";
import { ensureDraft$ } from "../chat-page/create-chat-thread.ts";
import { sendNewThread$ } from "../chat-page/optimistic-chat-thread-page.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { setAblyPayloadLoop$ } from "../realtime.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { rootSignal$ } from "../root-signal.ts";
import { agentChatComposerSignals$ } from "./agent-composer-signals.ts";
import { ensureAgentDraft$ } from "./agent-draft.ts";
import { createDraftSignals } from "./chat-draft.ts";
import { setLoop } from "../utils.ts";

const reloadVersion$ = state(0);
const pendingRevision$ = state<{
  readonly agentId: string;
  readonly revision?: string;
} | null>(null);
const removedAgentId$ = state<string | null>(null);
const gmailSuspendedAgentId$ = state<string | null>(null);

export const homeTaskRecommendationsPendingRevision$ = computed((get) => {
  return get(pendingRevision$);
});

export const homeTaskRecommendationsRemovedAgentId$ = computed((get) => {
  return get(removedAgentId$);
});

export const homeTaskRecommendationsGmailSuspendedAgentId$ = computed((get) => {
  return get(gmailSuspendedAgentId$);
});

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
  readonly contentRevision?: string;
  readonly recommendations: readonly HomeTaskRecommendation[];
  /** Display metadata for the connector slugs the cards name. */
  readonly connectors: readonly HomeTaskRecommendationConnector[];
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
    return {
      agentId,
      revision,
      contentRevision: data.revision,
      recommendations: data.recommendations,
      // A catalog that was unavailable for this read sends no metadata; the
      // cards then render without connector chips.
      connectors: data.connectors ?? [],
    };
  },
);

const invalidateHomeTaskRecommendations$ = command(({ set }): void => {
  set(reloadVersion$, (version) => {
    return version + 1;
  });
});

export const enterHomeTaskRecommendations$ = command(({ set }): void => {
  set(invalidateHomeTaskRecommendations$);
  set(pendingRevision$, null);
  set(removedAgentId$, null);
  set(gmailSuspendedAgentId$, null);
});

export const reloadHomeTaskRecommendations$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const pendingAtStart = get(pendingRevision$);
    set(invalidateHomeTaskRecommendations$);
    const latest = await get(homeTaskRecommendations$);
    signal.throwIfAborted();
    if (
      latest &&
      get(pendingRevision$) === pendingAtStart &&
      pendingAtStart?.agentId === latest.agentId
    ) {
      // GET is the authoritative, permission-filtered snapshot. Its revision
      // may differ from the cron's unfiltered revision after Gmail revocation.
      set(pendingRevision$, null);
      set(gmailSuspendedAgentId$, null);
    }
  },
);

const suspendGmailCards$ = command(({ set }, agentId: string): void => {
  // The event does not say whether authority expanded or was revoked. Hide
  // Gmail-derived copy immediately and let the next explicit read revalidate it.
  set(gmailSuspendedAgentId$, agentId);
  set(pendingRevision$, { agentId });
});

const recordHomeTaskRecommendationsPush$ = command(
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
      if (parsed.data.removed) {
        set(removedAgentId$, currentAgentId);
        set(pendingRevision$, null);
      } else if (parsed.data.revision === undefined) {
        // An unversioned notification means this Agent's connector scope
        // changed; it may have revoked access to cached Gmail evidence.
        set(suspendGmailCards$, currentAgentId);
      } else {
        set(pendingRevision$, {
          agentId: currentAgentId,
          revision: parsed.data.revision,
        });
      }
    }
    return false;
  },
);

const recordHomeTaskConnectorChange$ = command(
  async (
    { get, set },
    payload: unknown,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const parsed = connectorChangedPayloadSchema.safeParse(payload);
    if (parsed.success && parsed.data.connectorSlug === "gmail") {
      const agentId = await get(currentChatAgentId$);
      signal.throwIfAborted();
      if (agentId) {
        set(suspendGmailCards$, agentId);
      }
    }
    return false;
  },
);

const recordHomeTaskPermissionChange$ = command(
  async (
    { get, set },
    _payload: unknown,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const agentId = await get(currentChatAgentId$);
    signal.throwIfAborted();
    if (agentId) {
      set(suspendGmailCards$, agentId);
    }
    return false;
  },
);

const renewHomeTaskRecommendationDemand$ = command(
  async ({ get }, signal: AbortSignal): Promise<void> => {
    const agentId = await get(currentChatAgentId$);
    signal.throwIfAborted();
    if (!agentId) {
      return;
    }
    await accept(
      get(apiClient$)(homeTaskRecommendationsContract).touch({
        query: { agentId },
        fetchOptions: { signal },
      }),
      [204],
      undefined,
      { showErrorToast: false },
    );
  },
);

/**
 * Ably announces completed server changes without changing visible cards.
 * Only entry or an explicit reload reads the new snapshot. A small route-owned
 * lease renewal keeps cron demand active during a long home-page visit.
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
        loopCommand$: recordHomeTaskRecommendationsPush$,
      },
      signal,
    );
    set(
      setAblyPayloadLoop$,
      {
        topic: "connector:changed",
        loopCommand$: recordHomeTaskConnectorChange$,
      },
      signal,
    );
    set(
      setAblyPayloadLoop$,
      {
        topic: "connectorPermissionUpdated",
        loopCommand$: recordHomeTaskPermissionChange$,
      },
      signal,
    );
    let first = true;
    setLoop(
      async (loopSignal) => {
        if (first) {
          first = false;
          return false;
        }
        await set(renewHomeTaskRecommendationDemand$, loopSignal);
        return false;
      },
      30 * 60 * 1000,
      signal,
      { testIntervalMs: 30 * 60 * 1000 },
    );
  },
);

/**
 * Ordinary cards prepend the composer draft. Workflow cards send a task to the
 * owning Agent, who decides whether a reusable workflow should be created.
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
    if (args.recommendation.purpose === "workflow") {
      // Navigation aborts the page signal; the root-owned send must finish.
      await set(
        sendNewThread$,
        {
          agentId: args.agentId,
          draft: createDraftSignals(),
          prompt: args.recommendation.prompt,
          generationTemplate: undefined,
          preserveAgentDraft: true,
        },
        get(rootSignal$),
      );
      signal.throwIfAborted();
      return;
    }
    if (args.recommendation.target.kind === "existing-thread") {
      const draft = set(ensureDraft$, args.recommendation.target.threadId);
      set(draft.prependRecommendation$, args.recommendation.prompt);
      set(detachedNavigateTo$, ROUTES.chat, {
        pathParams: { threadId: args.recommendation.target.threadId },
      });
      return;
    }

    const agentDraft = set(ensureAgentDraft$, args.agentId);
    set(agentDraft.draft.prependRecommendation$, args.recommendation.prompt);
    const currentAgentId = await get(currentChatAgentId$);
    signal.throwIfAborted();
    if (currentAgentId !== args.agentId) {
      set(detachedNavigateTo$, ROUTES.agentChat, {
        pathParams: { agentId: args.agentId },
      });
      return;
    }
    const composer = get(agentChatComposerSignals$);
    set(composer.editor.focus$);
    await set(agentDraft.load$, signal);
  },
);
