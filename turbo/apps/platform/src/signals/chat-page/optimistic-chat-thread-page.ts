import { suggestionFeedbacks } from "@okouai/api-contracts/contracts/suggestion-context";
import type { InitialRemoteAccessOverride } from "@okouai/api-contracts/contracts/chat-remote-access";
import { chatThreadsContract } from "@okouai/api-contracts/client/chat-threads";
import type {
  GenerationTemplateRequest,
  ResolvedAttachFile,
  UserMessageDocument,
  UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { ConnectorAccountSelection } from "@okouai/api-contracts/contracts/connector-accounts";
import type { AvailableRunModelsResponse } from "@okouai/api-contracts/contracts/model-providers";
import type { ModelSettings } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import type { UserModelPreferenceResponse } from "@okouai/api-contracts/contracts/user-model-preference";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { toast } from "@okouai/ui/components/ui/sonner";
import { command, computed } from "ccstate";
import { i18n } from "../../i18n/index.ts";
import { accept } from "../../lib/accept.ts";
import { nowDate } from "../../lib/time.ts";
import type { ModelProviderSelection } from "../../views/okou-page/components/model-provider-picker.tsx";
import { currentChatThreadId$ } from "../agent-chat.ts";
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { modelCatalog$, type ModelCatalog } from "../external/model-catalog.ts";
import { availableRunModels$ } from "../external/run-models.ts";
import { userModelPreference$ } from "../external/user-model-preference.ts";
import { logger } from "../log.ts";
import { clearAgentDraftById$ } from "../okou-page/agent-draft.ts";
import {
  talkDraft$,
  type DraftSignals,
  type ChatAttachment,
  type PendingThreadIdentity,
} from "../okou-page/chat-draft.ts";
import { chatPageModelSelection$ } from "../okou-page/chat-page.ts";
import {
  rememberComposerTaskForThread$,
  type ComposerTaskSelection,
} from "../okou-page/composer-task-handoff.ts";
import {
  isCodexFastModeAvailableForSelection,
  resolveDefaultModelSelection,
} from "../okou-page/model-default-selection.ts";
import { selectedModelAvailable$ } from "../okou-page/model-first-personal-oauth.ts";
import { requestedNewThreadReasoningEffort } from "../okou-page/model-reasoning-effort.ts";
import {
  textToMessageDocument,
  type EditorDocumentSnapshot,
} from "../okou-page/user-message-document-codec.ts";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import { sendChatEvent } from "./chat-event-api.ts";
import { withOptimisticAgentRunSource } from "./chat-event-signals.ts";
import type { ChatForwardContext } from "./chat-forward.ts";
import { registerOptimisticChatThreadEvent$ } from "./chat-thread-event-sourcing.ts";
import { loadRightThread$ } from "./chat-thread-panes.ts";
import {
  apiServiceTierFromSelection,
  runOptionsFromModelProviderSelection,
  withSelectedModelAnnotation,
} from "./model-selection-request.ts";
import {
  appendOptimisticChatEvent$,
  createOptimisticChatEventEntry,
  type OptimisticChatEventInput,
} from "./optimistic-chat-events.ts";
import { prepareUserMessageFromDraft$ } from "./resolve-draft-attachments.ts";

export type NewChatThreadPane = "main" | "sidebar";

const SIDEBAR_PARAM = "sidebar";
const PWA_COMPOSE_PARAM = "compose";

const L = logger("NewChatThread");

export const newChatThreadDisabled$ = computed(() => {
  return false;
});

interface SendNewThreadMessageRequest {
  agentId: string;
  draft?: DraftSignals;
  /** Send from an isolated draft without clearing the Agent's saved composer. */
  preserveAgentDraft?: boolean;
  prompt: string;
  /** Undefined uses the composer selection; null resolves the member default. */
  modelSelection?: ModelProviderSelection | null;
  generationTemplate: GenerationTemplateRequest | undefined;
  generationTemplateTitleSnapshot?: string;
  editorDocument?: EditorDocumentSnapshot;
  computerUseHostId?: string | null;
  cloudBrowserEnabled?: boolean;
  /** What the composer was set to make, for the thread this send creates. */
  composerTask?: ComposerTaskSelection;
  routeSearchParams?: URLSearchParams;
  forward?: ChatForwardContext;
  onOptimisticSend?: () => void;
  connectorSelections?: readonly ConnectorAccountSelection[];
  initialRemoteAccessOverrides?: readonly InitialRemoteAccessOverride[];
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
    apiServiceTierFromSelection(modelSelection) ?? undefined,
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
  realAgentInPreviewEnabled,
  userMessage,
  computerUseHostId,
  cloudBrowserEnabled,
  sourceRunId,
}: {
  agentId: string;
  threadId: string;
  clientEventId: string;
  prepared: PreparedNewThreadPayload;
  modelSelection: ModelProviderSelection;
  realAgentInPreviewEnabled: boolean;
  userMessage: UserMessageDocument;
  computerUseHostId?: string | null;
  cloudBrowserEnabled?: boolean;
  sourceRunId?: string;
}) {
  const runOptions = runOptionsFromModelProviderSelection(modelSelection);
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

function resolveNewThreadModelSelection(
  modelSelection: ModelProviderSelection | null,
  args: {
    readonly models: AvailableRunModelsResponse | null | undefined;
    readonly userPreference: UserModelPreferenceResponse | null | undefined;
    readonly catalog: ModelCatalog;
  },
): ModelProviderSelection | null {
  if (modelSelection) {
    return modelSelection.codexServiceTier === "fast" &&
      !isCodexFastModeAvailableForSelection({
        models: args.models,
        selectedModel: modelSelection.selectedModel,
      })
      ? { ...modelSelection, codexServiceTier: undefined }
      : modelSelection;
  }
  return resolveDefaultModelSelection({
    userPreference: args.userPreference,
    models: args.models,
    catalog: args.catalog,
  });
}

const resolveNewThreadModelSelection$ = command(
  async (
    { get, set },
    override: ModelProviderSelection | null | undefined,
    signal: AbortSignal,
  ) => {
    const [modelSelection, models, userPreference, catalog] = await Promise.all(
      [
        override === undefined ? get(chatPageModelSelection$) : override,
        get(availableRunModels$),
        get(userModelPreference$),
        get(modelCatalog$),
      ],
    );
    signal.throwIfAborted();
    const resolved = resolveNewThreadModelSelection(modelSelection, {
      models,
      userPreference,
      catalog,
    });
    if (
      resolved &&
      (await set(selectedModelAvailable$, resolved.selectedModel, signal))
    ) {
      return { modelSelection: resolved, models, catalog };
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
    // The mobile composer request belongs to the agent chat URL, not to the
    // thread it starts.
    next.delete(PWA_COMPOSE_PARAM);
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
    readonly models: AvailableRunModelsResponse;
    readonly catalog: ModelCatalog;
    readonly codexExecution: boolean;
    readonly connectorSelections?: readonly ConnectorAccountSelection[];
    readonly initialRemoteAccessOverrides?: readonly InitialRemoteAccessOverride[];
  },
  signal: AbortSignal,
): Promise<void> {
  const { selectedModel } = args.modelSelection;
  const selectedEffort = requestedNewThreadReasoningEffort(
    args.modelSelection,
    args.models.models.find((entry) => {
      return entry.model === selectedModel;
    }),
    args.catalog,
    args.codexExecution,
  );
  const client = args.createClient(chatThreadsContract);
  await accept(
    client.create({
      body: {
        agentId: args.agentId,
        clientThreadId: args.clientThreadId,
        eventId: args.eventId,
        model: selectedModel,
        serviceTier: apiServiceTierFromSelection(args.modelSelection),
        ...(selectedEffort === undefined
          ? {}
          : { reasoningEffort: selectedEffort }),
        ...(args.title ? { title: args.title } : {}),
        ...(args.connectorSelections?.length
          ? {
              connectorSelections: [...args.connectorSelections],
              connectorSelectionPolicy: "required" as const,
            }
          : {}),
        ...(args.initialRemoteAccessOverrides?.length
          ? {
              initialRemoteAccessOverrides: [
                ...args.initialRemoteAccessOverrides,
              ],
            }
          : {}),
      },
      fetchOptions: { signal },
    }),
    [201],
    signal,
    { expectedErrors: { 400: ["CONNECTOR_ACCOUNT_UNAVAILABLE"] } },
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
    const models = await get(availableRunModels$);
    signal.throwIfAborted();
    const userPreference = await get(userModelPreference$);
    signal.throwIfAborted();
    const catalog = await get(modelCatalog$);
    signal.throwIfAborted();
    const modelSelection = resolveNewThreadModelSelection(null, {
      models,
      userPreference,
      catalog,
    });
    if (!modelSelection) {
      throw new Error("A model selection is required");
    }
    signal.throwIfAborted();
    await set(
      mintOptimisticThreadWithEvent$,
      {
        threadId,
        eventId,
        agentId,
        selectedModel: modelSelection.selectedModel,
        modelSettings: modelSelection.modelSettings ?? {},
        serviceTier: apiServiceTierFromSelection(modelSelection),
        computerUseHostId: null,
        cloudBrowserEnabled: false,
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
          models,
          catalog,
          codexExecution: get(featureSwitch$)[FeatureSwitchKey.CodexExecution],
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

const mintNewThreadSubmission$ = command(
  async (
    { set },
    request: Pick<
      SendNewThreadMessageRequest,
      "agentId" | "computerUseHostId" | "cloudBrowserEnabled"
    >,
    identity: Omit<PendingThreadIdentity, "intent">,
    submission: {
      readonly modelSelection: ModelProviderSelection;
      readonly userMessage: UserMessageDocument;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const { modelSelection, userMessage } = submission;
    set(
      appendOptimisticChatEvent$,
      createOptimisticChatEventEntry(
        createNewThreadOptimisticEventEntry({
          threadId: identity.threadId,
          clientEventId: identity.clientEventId,
          userMessage,
        }),
      ),
    );
    await set(
      mintOptimisticThreadWithEvent$,
      {
        threadId: identity.threadId,
        eventId: identity.chatThreadEventId,
        agentId: request.agentId,
        selectedModel: modelSelection.selectedModel,
        modelSettings: modelSelection.modelSettings ?? {},
        serviceTier: apiServiceTierFromSelection(modelSelection),
        computerUseHostId: request.computerUseHostId ?? null,
        cloudBrowserEnabled: request.cloudBrowserEnabled ?? false,
      },
      signal,
    );
  },
);

// A prepared quote carries its own persisted nonce. Routing defaults can change
// across reloads; the same saved user message must still reconcile one input.
async function customDirectionIdentity(intent: string) {
  const identities = await Promise.all(
    ["thread", "input", "created"].map(async (kind) => {
      const bytes = new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(`suggestion:${kind}:${intent}`),
        ),
      ).slice(0, 16);
      bytes[6] = (bytes[6] & 0x0f) | 0x80;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes)
        .map((byte) => {
          return byte.toString(16).padStart(2, "0");
        })
        .join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }),
  );
  return {
    threadId: identities[0],
    clientEventId: identities[1],
    chatThreadEventId: identities[2],
  };
}

const reserveNewThreadSubmissionIdentity$ = command(
  async (
    { set },
    args: {
      readonly request: SendNewThreadMessageRequest;
      readonly draft: DraftSignals;
      readonly userMessage: UserMessageDocument;
      readonly modelSelection: ModelProviderSelection;
    },
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const { request, draft, userMessage, modelSelection } = args;
    const customDirection = suggestionFeedbacks(userMessage).length > 0;
    const identity = customDirection
      ? await customDirectionIdentity(
          JSON.stringify({
            agentId: request.agentId,
            userMessage: {
              ...userMessage,
              parts: userMessage.parts.filter((part) => {
                return part.type !== "model";
              }),
            },
          }),
        )
      : set(
          draft.reserveThreadIdentity$,
          JSON.stringify({
            agentId: request.agentId,
            userMessage,
            modelSelection,
            computerUseHostId: request.computerUseHostId,
            cloudBrowserEnabled: request.cloudBrowserEnabled,
            connectorSelections: request.connectorSelections,
            initialRemoteAccessOverrides: request.initialRemoteAccessOverrides,
          }),
        );
    signal.throwIfAborted();
    return { ...identity, customDirection };
  },
);

const clearSubmittedNewThreadDraft$ = command(
  async (
    { get, set },
    args: {
      readonly request: SendNewThreadMessageRequest;
      readonly draft: DraftSignals;
      readonly submittedInput: string;
      readonly submittedDocument: EditorDocumentSnapshot | null;
      readonly submittedAttachments: readonly ChatAttachment[];
      readonly submittedTemplate: GenerationTemplateRequest | undefined;
    },
    signal: AbortSignal,
  ) => {
    const { draft, request } = args;
    const unchanged =
      get(draft.input$) === args.submittedInput &&
      set(draft.readEditorDocument$) === args.submittedDocument &&
      get(draft.attachments$) === args.submittedAttachments &&
      get(draft.generationTemplate$) === args.submittedTemplate;
    if (!unchanged) {
      return;
    }
    set(draft.clear$);
    if (!request.forward && !request.preserveAgentDraft) {
      await set(clearAgentDraftById$, request.agentId, signal);
    }
  },
);

function newThreadRecordOptions(args: {
  readonly createClient: ApiClientFactory;
  readonly request: SendNewThreadMessageRequest;
  readonly identity: {
    readonly threadId: string;
    readonly chatThreadEventId: string;
  };
  readonly resolved: {
    readonly modelSelection: ModelProviderSelection;
    readonly models: AvailableRunModelsResponse;
    readonly catalog: ModelCatalog;
  };
  readonly codexExecution: boolean;
}): Parameters<typeof createChatThread>[0] {
  const { createClient, request, identity, resolved, codexExecution } = args;
  return {
    createClient,
    agentId: request.agentId,
    title: undefined,
    clientThreadId: identity.threadId,
    eventId: identity.chatThreadEventId,
    modelSelection: resolved.modelSelection,
    models: resolved.models,
    catalog: resolved.catalog,
    codexExecution,
    connectorSelections: request.connectorSelections,
    initialRemoteAccessOverrides: request.initialRemoteAccessOverrides,
  };
}

const sendNewThreadMessage$ = command(
  async (
    { get, set },
    request: SendNewThreadMessageRequest,
    signal: AbortSignal,
  ): Promise<{
    readonly threadId: string;
    readonly sendResult: Promise<void>;
  } | null> => {
    const { agentId, prompt } = request;
    const { computerUseHostId, cloudBrowserEnabled } = request;
    const draft = request.draft ?? get(talkDraft$);
    const submittedInput = get(draft.input$);
    const submittedDocument = set(draft.readEditorDocument$);
    const submittedAttachments = get(draft.attachments$);
    const submittedTemplate = get(draft.generationTemplate$);
    const resolved = await set(
      resolveNewThreadModelSelection$,
      request.modelSelection,
      signal,
    );
    if (!resolved) {
      return null;
    }
    const resolvedModelSelection = resolved.modelSelection;
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
    const { annotatedUserMessage, optimisticUserMessage } =
      annotatedMessagesForNewThread(
        request,
        userMessageForNewThread(request, prepared),
        resolvedModelSelection,
      );
    const { threadId, clientEventId, chatThreadEventId, customDirection } =
      await set(
        reserveNewThreadSubmissionIdentity$,
        {
          request,
          draft,
          userMessage: annotatedUserMessage,
          modelSelection: resolvedModelSelection,
        },
        signal,
      );
    const createClient = get(apiClient$);
    L.debug("sendNewThreadMessage$ POST chat-threads start", { threadId });
    const creation = newThreadRecordOptions({
      createClient,
      request,
      identity: { threadId, chatThreadEventId },
      resolved,
      codexExecution: features[FeatureSwitchKey.CodexExecution],
    });
    const createResult =
      request.connectorSelections?.length || customDirection
        ? createNewThreadRecord(creation, signal)
        : null;
    // An explicit account choice must be accepted before publishing an
    // optimistic chat or clearing its composer. A rejected creation leaves the
    // entire draft and its pending connector/remote preferences in place.
    if (createResult) {
      await createResult;
      signal.throwIfAborted();
    }
    const sendBody = newThreadSendBody({
      agentId,
      threadId,
      clientEventId,
      prepared,
      modelSelection: resolvedModelSelection,
      realAgentInPreviewEnabled:
        features[FeatureSwitchKey.RealAgentInPreview] ?? false,
      userMessage: annotatedUserMessage,
      computerUseHostId,
      cloudBrowserEnabled,
      sourceRunId: request.forward?.runId,
    });
    // Custom follow-ups keep the complete composer and card until the input is
    // durably accepted. A failed or unknown delivery can replay the same IDs.
    if (customDirection) {
      await sendChatEvent(createClient, sendBody, signal);
      signal.throwIfAborted();
    }
    await set(
      mintNewThreadSubmission$,
      request,
      { threadId, clientEventId, chatThreadEventId },
      {
        modelSelection: resolvedModelSelection,
        userMessage: optimisticUserMessage,
      },
      signal,
    );
    if (request.composerTask) {
      set(rememberComposerTaskForThread$, threadId, request.composerTask);
    }
    request.onOptimisticSend?.();
    const clearDraftResult = set(
      clearSubmittedNewThreadDraft$,
      {
        request,
        draft,
        submittedInput,
        submittedDocument,
        submittedAttachments,
        submittedTemplate,
      },
      signal,
    );
    const sendResult = (async (): Promise<void> => {
      await Promise.all([
        clearDraftResult,
        createResult ?? createNewThreadRecord(creation, signal),
      ]);
      signal.throwIfAborted();
      set(draft.confirmThreadIdentity$, threadId);
      if (!customDirection) {
        await sendChatEvent(createClient, sendBody, signal);
      }
      signal.throwIfAborted();
      L.debug("sendNewThreadMessage$ POST chat/events 201", { threadId });
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
