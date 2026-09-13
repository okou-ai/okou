import { command, computed, state, type Command } from "ccstate";
import {
  chatThreadByIdContract,
  chatThreadDraftContract,
  chatThreadDraftSchema,
  chatThreadComputerUseHostContract,
  chatThreadImageModelContract,
  chatThreadModelSelectionContract,
  chatThreadVideoModelContract,
  type PersistedAttachment,
  type UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { ImageModel } from "@okouai/core/image-model-catalog";
import type { VideoModel } from "@okouai/core/video-model-catalog";
import type { ModelSettingsPatch } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { accept } from "../../lib/accept.ts";
import { nowDate } from "../../lib/time.ts";
import { apiClient$ } from "../api-client.ts";
import { chatReasoningEffortEnabled$ } from "../external/feature-switch.ts";
import { threadCodexServiceTierFromSelection } from "./model-selection-request.ts";
import {
  setAblyInvalidationLoop$,
  setAblyLoop$,
  type RealtimeInvalidationCommands,
} from "../realtime.ts";
import { createDeferredPromise } from "../utils.ts";
import { reloadSidebarDraftThreads$ } from "./sidebar-draft-threads.ts";
import {
  chatThreadMetaMap$,
  optimisticChatThreadCreateUnsettled,
  registerOptimisticChatThreadEvent$,
  type ThreadMeta,
} from "./chat-thread-event-sourcing.ts";
import type { ModelProviderSelection } from "../../views/okou-page/components/model-provider-picker.tsx";

interface ChatThreadRealtimeInvalidations {
  readonly threadDetail: RealtimeInvalidationCommands;
  readonly automations: RealtimeInvalidationCommands;
  readonly artifacts: RealtimeInvalidationCommands;
}

interface ChatThreadRealtimeHandlers {
  readonly onWorkflowsChanged$: Command<
    Promise<boolean> | boolean,
    [AbortSignal]
  >;
  readonly onSubscribed$?: Command<Promise<void> | void, [AbortSignal]>;
}

interface PatchDraftArgs {
  readonly threadId: string;
  readonly userMessage: UserMessageInputDocument | null;
  readonly attachments: PersistedAttachment[] | null;
}

interface PatchModelSelectionArgs {
  readonly threadId: string;
  readonly modelSelection: ModelProviderSelection | null;
}

interface PatchComputerUseHostArgs {
  readonly threadId: string;
  readonly computerUseHostId: string | null;
  readonly cloudBrowserEnabled: boolean;
}

interface PatchVideoModelArgs {
  readonly threadId: string;
  readonly videoModel: VideoModel | null;
}

interface PatchImageModelArgs {
  readonly threadId: string;
  readonly imageModel: ImageModel | null;
}

interface SubscribeRealtimeArgs {
  readonly threadId: string;
  readonly invalidations: ChatThreadRealtimeInvalidations;
  readonly handlers: ChatThreadRealtimeHandlers;
}

function changedModelSettingsPatch(args: {
  readonly enabled: boolean;
  readonly threadMeta: ThreadMeta | undefined;
  readonly selection: ModelProviderSelection | null;
}): ModelSettingsPatch | undefined {
  const selection = args.selection;
  const selectedModel = selection?.selectedModel;
  if (
    !args.enabled ||
    !args.threadMeta ||
    !selection ||
    args.threadMeta.selectedModel !== selectedModel ||
    selectedModel === undefined
  ) {
    return undefined;
  }
  const selectedEffort = selection.modelSettings?.[selectedModel]?.effort;
  if (
    selectedEffort === undefined ||
    args.threadMeta.modelSettings[selectedModel]?.effort === selectedEffort
  ) {
    return undefined;
  }
  return { model: selectedModel, effort: selectedEffort };
}

type ChatRealtimeSubscription =
  | {
      readonly kind: "invalidate";
      readonly topic: string;
      readonly invalidations: RealtimeInvalidationCommands;
    }
  | {
      readonly kind: "command";
      readonly topic: string;
      readonly loopCommand$: Command<Promise<boolean> | boolean, [AbortSignal]>;
    };

export const patchChatThreadDraft$ = command(
  async (
    { get, set },
    { threadId, userMessage, attachments }: PatchDraftArgs,
    signal: AbortSignal,
  ) => {
    const client = get(apiClient$)(chatThreadByIdContract);
    await accept(
      client.patch({
        params: { id: threadId },
        body: {
          draftUserMessage: userMessage,
          draftAttachments: attachments,
        },
        fetchOptions: { signal },
      }),
      [200, 204],
    );
    signal.throwIfAborted();
    set(reloadSidebarDraftThreads$);
  },
);

export const patchChatThreadModelSelection$ = command(
  async (
    { get, set },
    { threadId, modelSelection }: PatchModelSelectionArgs,
    signal: AbortSignal,
  ) => {
    const threadMeta = get(chatThreadMetaMap$).get(threadId);
    const modelSettingsPatch = changedModelSettingsPatch({
      enabled: get(chatReasoningEffortEnabled$),
      threadMeta,
      selection: modelSelection,
    });
    const reasoningEffort = modelSettingsPatch?.effort;
    const effortUpdate =
      reasoningEffort === undefined ? {} : { reasoningEffort };
    const modelSelectionEventId = crypto.randomUUID();
    const serviceTierEventId = crypto.randomUUID();
    if (threadMeta) {
      const createdAt = nowDate().toISOString();
      set(registerOptimisticChatThreadEvent$, {
        id: modelSelectionEventId,
        kind: "model_selection_updated",
        chatThreadId: threadId,
        agentId: threadMeta.agentId,
        selectedModel: modelSelection?.selectedModel ?? null,
        ...(modelSettingsPatch === undefined ? {} : { modelSettingsPatch }),
        createdAt,
      });
      set(registerOptimisticChatThreadEvent$, {
        id: serviceTierEventId,
        kind: "service_tier_updated",
        chatThreadId: threadId,
        agentId: threadMeta.agentId,
        serviceTier:
          modelSelection?.codexServiceTier === "fast" ? "priority" : null,
        createdAt,
      });
    }

    const client = get(apiClient$)(chatThreadModelSelectionContract);
    await accept(
      client.update({
        params: { id: threadId },
        body: {
          model: modelSelection?.selectedModel ?? null,
          ...effortUpdate,
          codexServiceTier: threadCodexServiceTierFromSelection(modelSelection),
          eventId: modelSelectionEventId,
          serviceTierEventId,
        },
        fetchOptions: { signal },
      }),
      [204],
    );
  },
);

export const patchChatThreadComputerUseHost$ = command(
  async (
    { get, set },
    {
      threadId,
      computerUseHostId,
      cloudBrowserEnabled,
    }: PatchComputerUseHostArgs,
    signal: AbortSignal,
  ) => {
    const eventId = crypto.randomUUID();
    const threadMeta = get(chatThreadMetaMap$).get(threadId);
    if (threadMeta) {
      set(registerOptimisticChatThreadEvent$, {
        id: eventId,
        kind: "computer_use_host_updated",
        chatThreadId: threadId,
        agentId: threadMeta.agentId,
        computerUseHostId,
        cloudBrowserEnabled,
      });
    }
    const client = get(apiClient$)(chatThreadComputerUseHostContract);
    await accept(
      client.update({
        params: { id: threadId },
        body: { computerUseHostId, cloudBrowserEnabled, eventId },
        fetchOptions: { signal },
      }),
      [204],
    );
  },
);

export const patchChatThreadVideoModel$ = command(
  async (
    { get, set },
    { threadId, videoModel }: PatchVideoModelArgs,
    signal: AbortSignal,
  ) => {
    const eventId = crypto.randomUUID();
    const threadMeta = get(chatThreadMetaMap$).get(threadId);
    if (threadMeta) {
      set(registerOptimisticChatThreadEvent$, {
        id: eventId,
        kind: "video_model_updated",
        chatThreadId: threadId,
        agentId: threadMeta.agentId,
        selectedVideoModel: videoModel,
      });
    }
    const client = get(apiClient$)(chatThreadVideoModelContract);
    await accept(
      client.update({
        params: { id: threadId },
        body: { model: videoModel, eventId },
        fetchOptions: { signal },
      }),
      [204],
    );
  },
);

export const patchChatThreadImageModel$ = command(
  async (
    { get, set },
    { threadId, imageModel }: PatchImageModelArgs,
    signal: AbortSignal,
  ) => {
    const eventId = crypto.randomUUID();
    const threadMeta = get(chatThreadMetaMap$).get(threadId);
    if (threadMeta) {
      set(registerOptimisticChatThreadEvent$, {
        id: eventId,
        kind: "image_model_updated",
        chatThreadId: threadId,
        agentId: threadMeta.agentId,
        selectedImageModel: imageModel,
      });
    }
    const client = get(apiClient$)(chatThreadImageModelContract);
    await accept(
      client.update({
        params: { id: threadId },
        body: { model: imageModel, eventId },
        fetchOptions: { signal },
      }),
      [204],
    );
  },
);

export const subscribeChatThreadRealtime$ = command(
  async (
    { set },
    { threadId, invalidations, handlers }: SubscribeRealtimeArgs,
    signal: AbortSignal,
  ) => {
    const ready = createDeferredPromise<void>(signal);
    const subscriptions: ChatRealtimeSubscription[] = [
      {
        kind: "invalidate",
        topic: `chatThreadDetailChanged:${threadId}`,
        invalidations: invalidations.threadDetail,
      },
      {
        kind: "invalidate",
        topic: `chatThreadAutomationsChanged:${threadId}`,
        invalidations: invalidations.automations,
      },
      {
        kind: "invalidate",
        topic: `chatThreadArtifactsChanged:${threadId}`,
        invalidations: invalidations.artifacts,
      },
      {
        kind: "command",
        topic: `chatThreadWorkflowsChanged:${threadId}`,
        loopCommand$: handlers.onWorkflowsChanged$,
      },
    ];

    let pendingSubscriptions = subscriptions.length;
    const markSubscribed = () => {
      pendingSubscriptions -= 1;
      if (pendingSubscriptions === 0 && !ready.settled()) {
        ready.resolve();
      }
    };
    const options = { onSubscribed: markSubscribed };
    const subscription = Promise.all(
      subscriptions.map((subscription) => {
        if (subscription.kind === "invalidate") {
          return set(
            setAblyInvalidationLoop$,
            {
              topic: subscription.topic,
              invalidations: subscription.invalidations,
              options,
            },
            signal,
          );
        }
        return set(
          setAblyLoop$,
          {
            topic: subscription.topic,
            loopCommand$: subscription.loopCommand$,
            options,
          },
          signal,
        );
      }),
    );

    await Promise.race([ready.promise, subscription]);
    signal.throwIfAborted();
    if (ready.settled() && handlers.onSubscribed$) {
      await set(handlers.onSubscribed$, signal);
      signal.throwIfAborted();
    }
    await subscription;
  },
);

export function createCancellationRecoverySignals(threadId: string) {
  const threadDetailReloadCounter$ = state(0);
  const optimisticCreateUnsettled$ =
    optimisticChatThreadCreateUnsettled(threadId);

  const cancellationRecoveryPending$ = computed(async (get) => {
    if (get(optimisticCreateUnsettled$)) {
      return false;
    }
    get(threadDetailReloadCounter$);
    const client = get(apiClient$)(chatThreadByIdContract);
    const result = await accept(
      client.get({ params: { id: threadId } }),
      [200, 404],
    );
    if (result.status === 404) {
      return false;
    }
    return result.body.cancellationRecoveryPending;
  });

  const reload$ = command(({ set }) => {
    set(threadDetailReloadCounter$, (value) => {
      return value + 1;
    });
  });

  return { pending$: cancellationRecoveryPending$, reload$ };
}

export function createRemoteChatThreadDraft(threadId: string) {
  const optimisticCreateUnsettled$ =
    optimisticChatThreadCreateUnsettled(threadId);
  return computed(async (get) => {
    if (get(optimisticCreateUnsettled$)) {
      return null;
    }
    const client = get(apiClient$)(chatThreadDraftContract);
    const result = await accept(
      client.get({ params: { id: threadId } }),
      [200, 404],
    );
    if (result.status === 404) {
      return null;
    }
    return chatThreadDraftSchema.parse(result.body);
  });
}
