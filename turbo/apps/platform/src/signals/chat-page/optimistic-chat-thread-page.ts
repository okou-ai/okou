import type { ModelSettings } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { command, computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { ImageModel } from "@okouai/core/image-model-catalog";
import type { VideoModel } from "@okouai/core/video-model-catalog";
import {
  chatThreadsContract,
  type ChatRunVideoOptionsRequest,
  type GenerationTemplateRequest,
  type ResolvedAttachFile,
  type UserMessageDocument,
  type UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { ConnectorAccountSelection } from "@okouai/api-contracts/contracts/connector-accounts";
import type { OrgModelPoliciesResponse } from "@okouai/api-contracts/contracts/model-providers";
import type { UserModelPreferenceResponse } from "@okouai/api-contracts/contracts/user-model-preference";
import { accept } from "../../lib/accept.ts";
import { startChatNavigationTiming$ } from "../../lib/posthog.ts";
import { nowDate } from "../../lib/time.ts";
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
import { currentChatThreadId$ } from "../agent-chat.ts";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import { loadRightThread$ } from "./chat-thread-panes.ts";
import { talkDraft$, type DraftSignals } from "../okou-page/chat-draft.ts";
import { clearAgentDraftById$ } from "../okou-page/agent-draft.ts";
import { prepareUserMessageFromDraft$ } from "./resolve-draft-attachments.ts";
import {
  appendOptimisticChatEvent$,
  createOptimisticChatEventEntry,
  type OptimisticChatEventInput,
} from "./optimistic-chat-events.ts";
import { sendChatEvent } from "./chat-event-api.ts";
import {
  isCodexFastModeAvailableForSelection,
  resolveModelFirstUserDefaultSelection,
} from "../okou-page/model-default-selection.ts";
import { orgModelPolicies$ } from "../external/org-model-policies.ts";
import { userModelPreference$ } from "../external/user-model-preference.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { logger } from "../log.ts";
import {
  runOptionsFromModelProviderSelection,
  withSelectedModelAnnotation,
} from "./model-selection-request.ts";
import type { ModelProviderSelection } from "../../views/okou-page/components/model-provider-picker.tsx";
import { registerOptimisticChatThreadEvent$ } from "./chat-thread-event-sourcing.ts";
import { chatPageModelSelection$ } from "../okou-page/chat-page.ts";
import { selectedModelAvailable$ } from "../okou-page/model-first-personal-oauth.ts";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import {
  textToMessageDocument,
  type EditorDocumentSnapshot,
} from "../okou-page/user-message-document-codec.ts";
import type { ChatForwardContext } from "./chat-forward.ts";
import { withOptimisticAgentRunSource } from "./chat-event-signals.ts";

export type NewChatThreadPane = "main" | "sidebar";

const SIDEBAR_PARAM = "sidebar";

const L = logger("NewChatThread");

export const newChatThreadDisabled$ = computed(() => {
  return false;
});

interface SendNewThreadMessageRequest {
  agentId: string;
  draft?: DraftSignals;
  prompt: string;
  generationTemplate: GenerationTemplateRequest | undefined;
  generationTemplateTitleSnapshot?: string;
  editorDocument?: EditorDocumentSnapshot;
  computerUseHostId?: string | null;
  cloudBrowserEnabled?: boolean;
  imageModel?: ImageModel;
  videoModel?: VideoModel;
  videoRunOptions?: ChatRunVideoOptionsRequest;
  routeSearchParams?: URLSearchParams;
  forward?: ChatForwardContext;
  onOptimisticSend?: () => void;
  connectorSelections?: readonly ConnectorAccountSelection[];
}

interface SendNewThreadMessageResult {
  threadId: string;
  runId: string | null;
}

interface PreparedNewThreadPayload {
  prompt: string;
  attachments: ResolvedAttachFile[] | undefined;
  hasTextContent: boolean;
}

function userMessageForNewThread(
  request: SendNewThreadMessageRequest,
  prepared: PreparedNewThreadPayload,
): UserMessageInputDocument {
  const generationTemplate = request.generationTemplate;
  if (
    generationTemplate &&
    !request.editorDocument &&
    !request.generationTemplateTitleSnapshot
  ) {
    throw new Error("User-message template title snapshot is required");
  }
  const userMessage = request.editorDocument
    ? request.editorDocument.toMessageDocument({
        selectedTemplate: generationTemplate,
        attachments: prepared.attachments,
      })
    : textToMessageDocument(
        prepared.prompt,
        generationTemplate && request.generationTemplateTitleSnapshot
          ? {
              titleSnapshot: request.generationTemplateTitleSnapshot,
              template: generationTemplate,
            }
          : undefined,
        prepared.attachments,
      );
  if (!userMessage) {
    throw new Error("Failed to serialize user message");
  }
  return userMessage;
}

function annotatedMessagesForNewThread(
  request: SendNewThreadMessageRequest,
  userMessage: UserMessageInputDocument,
  modelSelection: ModelProviderSelection,
): {
  readonly annotatedUserMessage: UserMessageDocument;
  readonly optimisticUserMessage: UserMessageDocument;
} {
  const annotatedUserMessage = withSelectedModelAnnotation(
    userMessage,
    modelSelection.selectedModel,
    modelSelection.codexServiceTier === "fast" ? "priority" : undefined,
  );
  return {
    annotatedUserMessage,
    optimisticUserMessage: request.forward
      ? withOptimisticAgentRunSource(annotatedUserMessage, request.forward)
      : annotatedUserMessage,
  };
}

function createNewThreadOptimisticEventEntry({
  threadId,
  clientEventId,
  userMessage,
}: {
  threadId: string;
  clientEventId: string;
  userMessage: UserMessageDocument;
}): OptimisticChatEventInput {
  return {
    threadId,
    optimisticUserMessageAssociation: "run",
    event: {
      id: clientEventId,
      threadId,
      eventType: "input.prompt",
      content: null,
      userMessage,
      createdAt: nowDate().toISOString(),
    },
  };
}

function newThreadSendBody({
  agentId,
  threadId,
  clientEventId,
  prepared,
  modelSelection,
  codexFastModeEnabled,
  realAgentInPreviewEnabled,
  userMessage,
  computerUseHostId,
  cloudBrowserEnabled,
  videoRunOptions,
  sourceRunId,
}: {
  agentId: string;
  threadId: string;
  clientEventId: string;
  prepared: PreparedNewThreadPayload;
  modelSelection: ModelProviderSelection;
  codexFastModeEnabled: boolean;
  realAgentInPreviewEnabled: boolean;
  userMessage: UserMessageDocument;
  computerUseHostId?: string | null;
  cloudBrowserEnabled?: boolean;
  videoRunOptions?: ChatRunVideoOptionsRequest;
  sourceRunId?: string;
}) {
  const runOptions = runOptionsFromModelProviderSelection(
    modelSelection,
    codexFastModeEnabled,
    videoRunOptions,
  );
  return {
    agentId,
    prompt: prepared.prompt,
    threadId,
    hasTextContent: prepared.hasTextContent,
    clientEventId: clientEventId,
    ...(runOptions ? { runOptions } : {}),
    ...(realAgentInPreviewEnabled ? { realAgentInPreview: true } : {}),
    userMessage,
    ...(computerUseHostId === undefined ? {} : { computerUseHostId }),
    ...(cloudBrowserEnabled === undefined ? {} : { cloudBrowserEnabled }),
    ...(sourceRunId === undefined ? {} : { sourceRunId }),
  };
}

function codexFastModeSwitchEnabled(
  switches: Partial<Record<FeatureSwitchKey, boolean>>,
): boolean {
  return switches[FeatureSwitchKey.CodexFastMode] ?? false;
}

function resolveNewThreadModelSelection(
  modelSelection: ModelProviderSelection | null,
  args: {
    readonly policies: OrgModelPoliciesResponse | null | undefined;
    readonly userPreference: UserModelPreferenceResponse | null | undefined;
    readonly codexFastModeEnabled: boolean;
  },
): ModelProviderSelection | null {
  if (modelSelection) {
    return modelSelection.codexServiceTier === "fast" &&
      !isCodexFastModeAvailableForSelection({
        policies: args.policies,
        selectedModel: modelSelection.selectedModel,
        codexFastModeEnabled: args.codexFastModeEnabled,
      })
      ? { ...modelSelection, codexServiceTier: undefined }
      : modelSelection;
  }
  return resolveModelFirstUserDefaultSelection({
    userPreference: args.userPreference,
    policies: args.policies,
    codexFastModeEnabled: args.codexFastModeEnabled,
  });
}

const resolveCurrentNewThreadModelSelection$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const [modelSelection, policies, userPreference] = await Promise.all([
      get(chatPageModelSelection$),
      get(orgModelPolicies$),
      get(userModelPreference$),
    ]);
    signal.throwIfAborted();
    const featureSwitches = get(featureSwitch$);
    const resolved = resolveNewThreadModelSelection(modelSelection, {
      policies,
      userPreference,
      codexFastModeEnabled:
        featureSwitches[FeatureSwitchKey.CodexFastMode] ?? false,
    });
    if (
      resolved &&
      (await set(selectedModelAvailable$, resolved.selectedModel, signal))
    ) {
      return resolved;
    }
    toast.error(
      i18n.t(($) => {
        return $.chat.composer.selectedModelUnavailableToast;
      }),
    );
    return null;
  },
);

const routeMainChatThread$ = command(
  (
    { get, set },
    args: {
      readonly threadId: string;
      readonly searchParams?: URLSearchParams;
    },
  ) => {
    const next = new URLSearchParams(args.searchParams ?? get(searchParams$));
    if (next.get(SIDEBAR_PARAM) === args.threadId) {
      next.delete(SIDEBAR_PARAM);
    }
    set(detachedNavigateTo$, "/chats/:threadId", {
      pathParams: { threadId: args.threadId },
      searchParams: next,
    });
  },
);

const routeSidebarChatThread$ = command(
  ({ get, set }, threadId: string): void => {
    if (!get(currentChatThreadId$)) {
      return;
    }
    set(loadRightThread$, threadId);
  },
);

const routeChatThread$ = command(
  async (
    { set },
    {
      pane,
      threadId,
      searchParams,
    }: {
      readonly pane: NewChatThreadPane;
      readonly threadId: string;
      readonly searchParams?: URLSearchParams;
    },
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();

    if (pane === "main") {
      set(routeMainChatThread$, {
        threadId,
        ...(searchParams ? { searchParams } : {}),
      });
    } else {
      await set(routeSidebarChatThread$, threadId);
    }
  },
);

const mintOptimisticThreadWithEvent$ = command(
  (
    { set },
    args: {
      readonly threadId: string;
      readonly eventId: string;
      readonly agentId: string;
      readonly selectedModel: string | null;
      readonly serviceTier: "priority" | null;
      readonly modelSettings: ModelSettings;
      readonly computerUseHostId: string | null;
      readonly cloudBrowserEnabled: boolean;
      readonly selectedImageModel: ImageModel | null;
      readonly selectedVideoModel: VideoModel | null;
    },
    signal: AbortSignal,
  ): void => {
    signal.throwIfAborted();
    L.debug("optimistic thread minted", {
      threadId: args.threadId,
      agentId: args.agentId,
    });
    set(registerOptimisticChatThreadEvent$, {
      id: args.eventId,
      kind: "created",
      chatThreadId: args.threadId,
      agentId: args.agentId,
      selectedModel: args.selectedModel,
      modelSettings: args.modelSettings,
      serviceTier: args.serviceTier,
      computerUseHostId: args.computerUseHostId,
      cloudBrowserEnabled: args.cloudBrowserEnabled,
      selectedVideoModel: args.selectedVideoModel,
      selectedImageModel: args.selectedImageModel,
    });
  },
);

async function createChatThread(
  args: {
    readonly createClient: ApiClientFactory;
    readonly agentId: string;
    readonly title: string | undefined;
    readonly clientThreadId: string;
    readonly eventId: string;
    readonly modelSelection: ModelProviderSelection;
    readonly reasoningEffortEnabled: boolean;
    readonly imageModel?: ImageModel;
    readonly videoModel?: VideoModel;
    readonly connectorSelections?: readonly ConnectorAccountSelection[];
  },
  signal: AbortSignal,
): Promise<void> {
  const selectedEffort = args.reasoningEffortEnabled
    ? args.modelSelection.modelSettings?.[args.modelSelection.selectedModel]
        ?.effort
    : undefined;
  const client = args.createClient(chatThreadsContract);
  await accept(
    client.create({
      body: {
        agentId: args.agentId,
        clientThreadId: args.clientThreadId,
        eventId: args.eventId,
        model: args.modelSelection.selectedModel,
        serviceTier:
          args.modelSelection.codexServiceTier === "fast" ? "priority" : null,
        ...(selectedEffort === undefined
          ? {}
          : { reasoningEffort: selectedEffort }),
        ...(args.imageModel ? { imageModel: args.imageModel } : {}),
        ...(args.videoModel ? { videoModel: args.videoModel } : {}),
        ...(args.title ? { title: args.title } : {}),
        ...(args.connectorSelections?.length
          ? { connectorSelections: [...args.connectorSelections] }
          : {}),
      },
      fetchOptions: { signal },
    }),
    [201],
  );
  signal.throwIfAborted();
}

const startNewChatThreadCreate$ = command(
  async (
    { get, set },
    agentId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly threadId: string;
    readonly createResult: Promise<void>;
  }> => {
    const threadId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const policies = await get(orgModelPolicies$);
    signal.throwIfAborted();
    const userPreference = await get(userModelPreference$);
    signal.throwIfAborted();
    const featureSwitches = get(featureSwitch$);
    const modelSelection = resolveNewThreadModelSelection(null, {
      policies,
      userPreference,
      codexFastModeEnabled:
        featureSwitches[FeatureSwitchKey.CodexFastMode] ?? false,
    });
    if (!modelSelection) {
      throw new Error("A model selection is required");
    }
    // A blank thread carries no image or video model pin, so it follows the
    // member's live default: changing that default later updates every thread
    // that was never explicitly repinned, matching the run-model behavior.
    signal.throwIfAborted();
    await set(
      mintOptimisticThreadWithEvent$,
      {
        threadId,
        eventId,
        agentId,
        selectedModel: modelSelection.selectedModel,
        modelSettings: modelSelection.modelSettings ?? {},
        serviceTier:
          modelSelection.codexServiceTier === "fast" ? "priority" : null,
        computerUseHostId: null,
        cloudBrowserEnabled: false,
        selectedImageModel: null,
        selectedVideoModel: null,
      },
      signal,
    );

    const createClient = get(apiClient$);
    L.debug("startNewChatThreadCreate$ POST chat-threads start", { threadId });
    const createResult = (async (): Promise<void> => {
      await createChatThread(
        {
          createClient,
          agentId,
          title: undefined,
          clientThreadId: threadId,
          eventId,
          modelSelection,
          reasoningEffortEnabled:
            featureSwitches[FeatureSwitchKey.ChatReasoningEffort] ?? false,
        },
        signal,
      );
      L.debug("startNewChatThreadCreate$ POST chat-threads 201", { threadId });
      signal.throwIfAborted();
    })();

    return { threadId, createResult };
  },
);

export const createNewChatThread$ = command(
  async (
    { get, set },
    agentId: string,
    pane: NewChatThreadPane,
    signal: AbortSignal,
  ) => {
    const targetPane =
      pane === "sidebar" && get(currentChatThreadId$) ? "sidebar" : "main";
    const result = await set(startNewChatThreadCreate$, agentId, signal);

    await set(
      routeChatThread$,
      { pane: targetPane, threadId: result.threadId },
      signal,
    );
    await result.createResult;
  },
);

/** The thread row, created alongside the send it is about to carry. */
async function createNewThreadRecord(
  args: Parameters<typeof createChatThread>[0],
  signal: AbortSignal,
): Promise<void> {
  await createChatThread(args, signal);
  L.debug("sendNewThreadMessage$ POST chat-threads 201", {
    threadId: args.clientThreadId,
  });
  signal.throwIfAborted();
}

const sendNewThreadMessage$ = command(
  async (
    { get, set },
    request: SendNewThreadMessageRequest,
    signal: AbortSignal,
  ): Promise<{
    readonly threadId: string;
    readonly sendResult: Promise<SendNewThreadMessageResult>;
  } | null> => {
    const { agentId, prompt } = request;
    const { computerUseHostId, cloudBrowserEnabled } = request;
    const draft = request.draft ?? get(talkDraft$);
    const resolvedModelSelection = await set(
      resolveCurrentNewThreadModelSelection$,
      signal,
    );
    if (!resolvedModelSelection) {
      return null;
    }
    const prepared = await set(
      prepareUserMessageFromDraft$,
      draft,
      prompt,
      signal,
    );
    if (!prepared) {
      return null;
    }
    const features = get(featureSwitch$);
    // Pin only an explicit per-thread pick; an unpinned (null) thread follows
    // the member's live default, so changing the default later updates it.
    const imageModel = request.imageModel;
    const videoModel = request.videoModel;
    const { annotatedUserMessage, optimisticUserMessage } =
      annotatedMessagesForNewThread(
        request,
        userMessageForNewThread(request, prepared),
        resolvedModelSelection,
      );
    const threadId = crypto.randomUUID();
    const clientEventId = crypto.randomUUID();
    const chatThreadEventId = crypto.randomUUID();
    set(
      appendOptimisticChatEvent$,
      createOptimisticChatEventEntry(
        createNewThreadOptimisticEventEntry({
          threadId,
          clientEventId,
          userMessage: optimisticUserMessage,
        }),
      ),
    );
    await set(
      mintOptimisticThreadWithEvent$,
      {
        threadId,
        eventId: chatThreadEventId,
        agentId,
        selectedModel: resolvedModelSelection.selectedModel,
        modelSettings: resolvedModelSelection.modelSettings ?? {},
        serviceTier:
          resolvedModelSelection.codexServiceTier === "fast"
            ? "priority"
            : null,
        computerUseHostId: computerUseHostId ?? null,
        cloudBrowserEnabled: cloudBrowserEnabled ?? false,
        selectedImageModel: imageModel ?? null,
        selectedVideoModel: videoModel ?? null,
      },
      signal,
    );
    request.onOptimisticSend?.();
    set(draft.clear$);
    const clearDraftResult = request.forward
      ? Promise.resolve()
      : set(clearAgentDraftById$, agentId, signal);
    const createClient = get(apiClient$);
    L.debug("sendNewThreadMessage$ POST chat-threads start", { threadId });
    const createResult = createNewThreadRecord(
      {
        createClient,
        agentId,
        title: undefined,
        clientThreadId: threadId,
        eventId: chatThreadEventId,
        modelSelection: resolvedModelSelection,
        reasoningEffortEnabled:
          features[FeatureSwitchKey.ChatReasoningEffort] ?? false,
        imageModel,
        videoModel,
        connectorSelections: request.connectorSelections,
      },
      signal,
    );
    const sendBody = newThreadSendBody({
      agentId,
      threadId,
      clientEventId,
      prepared,
      modelSelection: resolvedModelSelection,
      codexFastModeEnabled: codexFastModeSwitchEnabled(features),
      realAgentInPreviewEnabled:
        features[FeatureSwitchKey.RealAgentInPreview] ?? false,
      userMessage: annotatedUserMessage,
      computerUseHostId,
      cloudBrowserEnabled,
      videoRunOptions: request.videoRunOptions,
      sourceRunId: request.forward?.runId,
    });
    const sendResult = (async (): Promise<SendNewThreadMessageResult> => {
      await Promise.all([clearDraftResult, createResult]);
      signal.throwIfAborted();
      const result = await sendChatEvent(createClient, sendBody, signal);
      signal.throwIfAborted();
      L.debug("sendNewThreadMessage$ POST chat/events 201", {
        threadId: result.threadId,
        runId: result.runId,
      });
      return { threadId: result.threadId, runId: result.runId };
    })();
    return { threadId, sendResult };
  },
);

export const sendNewThread$ = command(
  async (
    { set },
    request: SendNewThreadMessageRequest,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const result = await set(sendNewThreadMessage$, request, signal);
    if (!result) {
      return false;
    }

    set(startChatNavigationTiming$);
    await set(
      routeChatThread$,
      {
        pane: "main",
        threadId: result.threadId,
        ...(request.routeSearchParams
          ? { searchParams: request.routeSearchParams }
          : {}),
      },
      signal,
    );
    await result.sendResult;
    signal.throwIfAborted();
    return true;
  },
);

export const sendNewThreadWithoutNavigation$ = command(
  async (
    { set },
    request: SendNewThreadMessageRequest,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const result = await set(sendNewThreadMessage$, request, signal);
    if (!result) {
      return false;
    }
    await result.sendResult;
    signal.throwIfAborted();
    return true;
  },
);
