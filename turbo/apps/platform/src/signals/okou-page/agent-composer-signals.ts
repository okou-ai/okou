import { command, computed, state, type Command } from "ccstate";
import { isSupportedRunModel } from "@okouai/api-contracts/contracts/model-providers";
import type { ModelSettingsPatch } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { ConnectorAccountSelection } from "@okouai/api-contracts/contracts/connector-accounts";
import type { ImageModel } from "@okouai/core/image-model-catalog";
import type { VideoModel } from "@okouai/core/video-model-catalog";
import type { ModelProviderSelection } from "../../views/okou-page/components/model-provider-picker.tsx";
import {
  sendNewThread$,
  sendNewThreadWithoutNavigation$,
} from "../chat-page/optimistic-chat-thread-page.ts";
import type { ChatForwardContext } from "../chat-page/chat-forward.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import {
  updateUserModelPreference$,
  userModelPreference$,
} from "../external/user-model-preference.ts";
import {
  createAgentDraftSignals,
  type EnsuredAgentDraft,
} from "./agent-draft.ts";
import { selectedComputerUseHostId } from "./computer-use-hosts.ts";
import type { DraftSignals } from "./chat-draft.ts";
import { computerUseHostsFromWorker$ } from "../shared-database.ts";
import {
  createComposerSignals,
  type ComposerSubmission,
} from "./composer-signals.ts";
import type { ChatEvent } from "../chat-page/chat-event-types.ts";
import { connectorAccountTargetKey } from "./connector-accounts.ts";
import { createComposerConnectorSignals } from "./connectors.ts";
import {
  chatPageEffectiveImageModel$,
  chatPageEffectiveVideoModel$,
  chatPageImageModelPin$,
  chatPageImageModelSelection$,
  chatPageModelSelection$,
  chatPageSelectedModelOauthAvailable$,
  chatPageVideoModelPin$,
  chatPageVideoModelSelection$,
  configureChatPageSelectedModel$,
  resetChatPageImageModelSelection$,
  resetChatPageModelSelection$,
  resetChatPageVideoModelSelection$,
  setChatPageImageModelSelection$,
  setChatPageModelSelection$,
  setChatPageVideoModelSelection$,
} from "./chat-page.ts";
import {
  newThreadComputerAccess$,
  newThreadCloudBrowserEnabled$,
  newThreadComputerUseHostId$,
  resetNewThreadComputerAccess$,
  setNewThreadCloudBrowserEnabled$,
  setNewThreadComputerUseHostId$,
} from "./chat-composer.ts";

const idle$ = computed((): Promise<boolean> => {
  return Promise.resolve(false);
});
const chatEvents$ = computed((): ChatEvent[] => {
  return [];
});

function changedModelSettingsPatch(
  selection: ModelProviderSelection | null,
  previous: ModelProviderSelection | null,
): ModelSettingsPatch | undefined {
  const selectedModel = selection?.selectedModel;
  if (!selection || !isSupportedRunModel(selectedModel)) {
    return undefined;
  }
  const selectedEffort = selection.modelSettings?.[selectedModel]?.effort;
  if (
    selectedEffort === undefined ||
    previous?.modelSettings?.[selectedModel]?.effort === selectedEffort
  ) {
    return undefined;
  }
  return { model: selectedModel, effort: selectedEffort };
}

const setModelSelection$ = command(
  async (
    { get, set },
    selection: ModelProviderSelection | null,
    signal: AbortSignal,
  ): Promise<void> => {
    const previous = await get(chatPageModelSelection$);
    signal.throwIfAborted();
    set(setChatPageModelSelection$, selection);
    const selectedModel = selection?.selectedModel;
    const modelSettingsPatch = changedModelSettingsPatch(selection, previous);
    if (
      previous?.selectedModel === selection?.selectedModel &&
      previous?.codexServiceTier === selection?.codexServiceTier &&
      modelSettingsPatch === undefined
    ) {
      return;
    }
    const explicitDefaultActionEnabled =
      get(featureSwitch$)[FeatureSwitchKey.ChatPreference] ?? false;
    if (!explicitDefaultActionEnabled && isSupportedRunModel(selectedModel)) {
      await set(
        updateUserModelPreference$,
        {
          selectedModel,
          serviceTier:
            selection?.codexServiceTier === "fast" ? "priority" : null,
          ...(modelSettingsPatch === undefined ? {} : { modelSettingsPatch }),
        },
        signal,
      );
    }
  },
);

function createMediaModelSetter<M extends ImageModel | VideoModel>(
  setSelection$: Command<void, [M | null]>,
  preference: (
    model: M | null,
  ) =>
    | { selectedImageModel: ImageModel | null }
    | { selectedVideoModel: VideoModel | null },
) {
  return command(
    async (
      { get, set },
      model: M | null,
      signal: AbortSignal,
    ): Promise<void> => {
      set(setSelection$, model);
      const explicitDefaultActionEnabled =
        get(featureSwitch$)[FeatureSwitchKey.ChatPreference] ?? false;
      if (explicitDefaultActionEnabled) {
        // The composer card carries an explicit "Use this for future chats" action,
        // so picking a media model only scopes the next new chat.
        return;
      }
      const userPreference = await get(userModelPreference$);
      signal.throwIfAborted();
      await set(
        updateUserModelPreference$,
        {
          selectedModel: userPreference.selectedModel,
          serviceTier: userPreference.serviceTier,
          ...preference(model),
        },
        signal,
      );
    },
  );
}

const setVideoModel$ = createMediaModelSetter(
  setChatPageVideoModelSelection$,
  (selectedVideoModel) => {
    return { selectedVideoModel };
  },
);

const setImageModel$ = createMediaModelSetter(
  setChatPageImageModelSelection$,
  (selectedImageModel) => {
    return { selectedImageModel };
  },
);

const computerUseHostId$ = computed((get): string | null => {
  return get(newThreadComputerUseHostId$);
});
const cloudBrowserEnabled$ = newThreadCloudBrowserEnabled$;
const setComputerUseHostId$ = command(
  ({ set }, hostId: string | null, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    set(setNewThreadComputerUseHostId$, hostId);
    return Promise.resolve();
  },
);
const setCloudBrowserEnabled$ = command(
  ({ set }, enabled: boolean, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    set(setNewThreadCloudBrowserEnabled$, enabled);
    return Promise.resolve();
  },
);

const noOpAction$ = command((_context, signal: AbortSignal): Promise<void> => {
  signal.throwIfAborted();
  return Promise.resolve();
});
const noOpEventAction$ = command(
  (_context, _eventId: string, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    return Promise.resolve();
  },
);

interface AgentComposerOptions {
  readonly forward?: ChatForwardContext;
  readonly onOptimisticSend?: () => void;
}

function createAgentSubmitMessage(
  agentId: string,
  draft: DraftSignals,
  connector: ReturnType<typeof createComposerConnectorSignals>,
  options: AgentComposerOptions,
) {
  return command(
    async (
      { get, set },
      action: "send" | "queue",
      submission: ComposerSubmission,
      signal: AbortSignal,
    ): Promise<boolean> => {
      if (action !== "send") {
        return false;
      }
      const access = await get(newThreadComputerAccess$);
      signal.throwIfAborted();
      const [hosts, imageModelPin, videoModelPin, connectorPreference] =
        await Promise.all([
          get(computerUseHostsFromWorker$),
          get(chatPageImageModelPin$),
          get(chatPageVideoModelPin$),
          get(connector.accounts.preferenceState$),
        ]);
      signal.throwIfAborted();
      const hostId =
        access.kind === "computerUse"
          ? selectedComputerUseHostId(hosts, access.hostId)
          : null;
      const send = options.forward
        ? sendNewThreadWithoutNavigation$
        : sendNewThread$;
      let connectorSelections: readonly ConnectorAccountSelection[] = [];
      if (connectorPreference.selections.length > 0) {
        const connectorAuthorization = await get(
          connector.connectorAuthorization$,
        );
        signal.throwIfAborted();
        const authorizedTargetKeys = new Set([
          ...connectorAuthorization.enabledConnectorSlugs.map(
            (connectorSlug) => {
              return connectorAccountTargetKey({
                kind: "builtin",
                connectorSlug,
              });
            },
          ),
          ...connectorAuthorization.customConnectorGrants.map((grant) => {
            return connectorAccountTargetKey({
              kind: "custom",
              customConnectorId: grant.customConnectorId,
            });
          }),
        ]);
        connectorSelections = connectorPreference.selections.filter(
          (selection) => {
            return authorizedTargetKeys.has(
              connectorAccountTargetKey(selection.target),
            );
          },
        );
      }
      const sent = await set(
        send,
        {
          agentId,
          draft,
          prompt: submission.prompt,
          generationTemplate: submission.generationTemplate,
          editorDocument: submission.editorDocument,
          // Forward only an explicit per-thread pick; an untouched picker sends
          // nothing so the new thread stays unpinned and follows the member's
          // live default.
          ...(imageModelPin !== null ? { imageModel: imageModelPin } : {}),
          ...(videoModelPin !== null ? { videoModel: videoModelPin } : {}),
          ...(submission.videoRunOptions === undefined
            ? {}
            : { videoRunOptions: submission.videoRunOptions }),
          ...(access.kind === "computerUse"
            ? { computerUseHostId: hostId }
            : {}),
          ...(access.kind === "cloudBrowser"
            ? { cloudBrowserEnabled: true }
            : {}),
          ...(options.forward ? { forward: options.forward } : {}),
          ...(options.onOptimisticSend
            ? { onOptimisticSend: options.onOptimisticSend }
            : {}),
          ...(connectorSelections.length > 0 ? { connectorSelections } : {}),
        },
        signal,
      );
      if (sent) {
        set(resetNewThreadComputerAccess$);
        set(resetChatPageImageModelSelection$);
        set(resetChatPageModelSelection$);
        set(resetChatPageVideoModelSelection$);
        set(connector.accounts.resetPendingSelections$);
      }
      return sent;
    },
  );
}

function createAgentComposerSignalsWithDraft(
  agentId: string,
  agentDraft: EnsuredAgentDraft,
  options: AgentComposerOptions = {},
) {
  const connector = createComposerConnectorSignals(agentId);
  const submitMessage$ = createAgentSubmitMessage(
    agentId,
    agentDraft.draft,
    connector,
    options,
  );

  return createComposerSignals({
    agentId,
    connector,
    draft: {
      signals: agentDraft.draft,
      load$: options.forward ? noOpAction$ : agentDraft.load$,
      save$: options.forward ? noOpAction$ : agentDraft.queueDraftSync$,
    },
    chatEvents$,
    voiceDraftTarget: `agent:${agentId}`,
    singleLineOnMobile: false,
    modelSelection$: chatPageModelSelection$,
    selectedModelOauthAvailable$: chatPageSelectedModelOauthAvailable$,
    setModelSelection$,
    configureSelectedModel$: configureChatPageSelectedModel$,
    imageModel: {
      selectedImageModel$: chatPageImageModelSelection$,
      effectiveImageModel$: chatPageEffectiveImageModel$,
      setImageModel$,
    },
    videoModel: {
      selectedVideoModel$: chatPageVideoModelSelection$,
      effectiveVideoModel$: chatPageEffectiveVideoModel$,
      setVideoModel$,
    },
    computerUseHostId$,
    cloudBrowserEnabled$,
    setComputerUseHostId$,
    setCloudBrowserEnabled$,
    submitMessage$,
    cancelRun$: noOpAction$,
    cancellationRecoveryPending$: idle$,
    removeQueuedMessage$: noOpEventAction$,
    removeAutomationEvent$: noOpEventAction$,
  });
}

export function createForwardAgentComposerSignals(
  agentId: string,
  forward: ChatForwardContext,
  onOptimisticSend: () => void,
) {
  return createAgentComposerSignalsWithDraft(
    agentId,
    createAgentDraftSignals(agentId),
    { forward, onOptimisticSend },
  );
}

interface AgentComposerContext {
  readonly agentId: string;
  readonly agentDraft: EnsuredAgentDraft;
}

const internalAgentComposerContext$ = state<AgentComposerContext | null>(null);

export const setAgentComposerContext$ = command(
  ({ set }, context: AgentComposerContext): void => {
    set(internalAgentComposerContext$, context);
  },
);

export const agentChatComposerSignals$ = computed((get) => {
  const context = get(internalAgentComposerContext$);
  if (!context) {
    throw new Error("Chat composer requires an initialized agent context");
  }
  return createAgentComposerSignalsWithDraft(
    context.agentId,
    context.agentDraft,
  );
});
