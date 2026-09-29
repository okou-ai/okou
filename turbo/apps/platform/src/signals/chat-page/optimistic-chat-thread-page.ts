import type { ModelSettings } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { command, computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  chatThreadsContract,
  type GenerationTemplateRequest,
  type ResolvedAttachFile,
  type UserMessageDocument,
  type UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { ConnectorAccountSelection } from "@okouai/api-contracts/contracts/connector-accounts";
import type { InitialRemoteAccessOverride } from "@okouai/api-contracts/contracts/chat-remote-access";
import type { OrgModelPoliciesResponse } from "@okouai/api-contracts/contracts/model-providers";
import type { UserModelPreferenceResponse } from "@okouai/api-contracts/contracts/user-model-preference";
import { accept } from "../../lib/accept.ts";
import { startChatNavigationTiming$ } from "../../lib/posthog.ts";
import { nowDate } from "../../lib/time.ts";
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
import { authenticatedIdentity$ } from "../auth.ts";
import {
  deliveryIntentsChanged$,
  saveDeliveryIntent,
  updateDeliveryIntent,
  type NewThreadDeliveryIntent,
} from "./chat-delivery-intents.ts";
import { newThreadDeliveryFailure } from "./new-thread-delivery.ts";
import { detach, Reason, settle } from "../utils.ts";
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
import {
  rememberComposerTaskForThread$,
  type ComposerTaskSelection,
} from "../okou-page/composer-task-handoff.ts";
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
  /** Send from an isolated draft without clearing the Agent's saved composer. */
  preserveAgentDraft?: boolean;
  prompt: string;
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
  onAcceptedSend?: () => void;
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
    readonly policies: OrgModelPoliciesResponse | null | undefined;
    readonly userPreference: UserModelPreferenceResponse | null | undefined;
  },
): ModelProviderSelection | null {
  if (modelSelection) {
    return modelSelection.codexServiceTier === "fast" &&
      !isCodexFastModeAvailableForSelection({
        policies: args.policies,
        selectedModel: modelSelection.selectedModel,
      })
      ? { ...modelSelection, codexServiceTier: undefined }
      : modelSelection;
  }
  return resolveModelFirstUserDefaultSelection({
    userPreference: args.userPreference,
    policies: args.policies,
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
    const resolved = resolveNewThreadModelSelection(modelSelection, {
      policies,
      userPreference,
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

function newThreadCreateBody(args: {
  readonly agentId: string;
  readonly title: string | undefined;
  readonly clientThreadId: string;
  readonly eventId: string;
  readonly modelSelection: ModelProviderSelection;
  readonly connectorSelections?: readonly ConnectorAccountSelection[];
  readonly initialRemoteAccessOverrides?: readonly InitialRemoteAccessOverride[];
}) {
  const selectedEffort =
    args.modelSelection.modelSettings?.[args.modelSelection.selectedModel]
      ?.effort;
  return {
    agentId: args.agentId,
    clientThreadId: args.clientThreadId,
    eventId: args.eventId,
    model: args.modelSelection.selectedModel,
    serviceTier:
      args.modelSelection.codexServiceTier === "fast"
        ? ("priority" as const)
        : null,
    ...(selectedEffort === undefined
      ? {}
      : { reasoningEffort: selectedEffort }),
    ...(args.title ? { title: args.title } : {}),
    ...(args.connectorSelections?.length
      ? { connectorSelections: [...args.connectorSelections] }
      : {}),
    ...(args.initialRemoteAccessOverrides?.length
      ? {
          initialRemoteAccessOverrides: [...args.initialRemoteAccessOverrides],
        }
      : {}),
  };
}

async function createChatThread(
  createClient: ApiClientFactory,
  body: ReturnType<typeof newThreadCreateBody>,
  signal: AbortSignal,
): Promise<void> {
  await accept(
    createClient(chatThreadsContract).create({
      body,
      fetchOptions: { signal },
    }),
    [201],
    signal,
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
    const modelSelection = resolveNewThreadModelSelection(null, {
      policies,
      userPreference,
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
        serviceTier:
          modelSelection.codexServiceTier === "fast" ? "priority" : null,
        computerUseHostId: null,
        cloudBrowserEnabled: false,
      },
      signal,
    );

    const createClient = get(apiClient$);
    L.debug("startNewChatThreadCreate$ POST chat-threads start", { threadId });
    const createResult = (async (): Promise<void> => {
      await createChatThread(
        createClient,
        newThreadCreateBody({
          agentId,
          title: undefined,
          clientThreadId: threadId,
          eventId,
          modelSelection,
        }),
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
  createClient: ApiClientFactory,
  body: ReturnType<typeof newThreadCreateBody>,
  signal: AbortSignal,
): Promise<void> {
  await createChatThread(createClient, body, signal);
  L.debug("sendNewThreadMessage$ POST chat-threads 201", {
    threadId: body.clientThreadId,
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
    readonly sendResult: Promise<boolean>;
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
    const { annotatedUserMessage, optimisticUserMessage } =
      annotatedMessagesForNewThread(
        request,
        userMessageForNewThread(request, prepared),
        resolvedModelSelection,
      );
    const threadId = crypto.randomUUID();
    const clientEventId = crypto.randomUUID();
    const chatThreadEventId = crypto.randomUUID();
    const identity = await get(authenticatedIdentity$);
    signal.throwIfAborted();
    const createBody = newThreadCreateBody({
      agentId,
      title: undefined,
      clientThreadId: threadId,
      eventId: chatThreadEventId,
      modelSelection: resolvedModelSelection,
      connectorSelections: request.connectorSelections,
      initialRemoteAccessOverrides: request.initialRemoteAccessOverrides,
    });
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
    const intent: NewThreadDeliveryIntent = {
      kind: "new-thread",
      phase: "create",
      threadId,
      clientEventId,
      createEventId: chatThreadEventId,
      createdAt: nowDate().toISOString(),
      status: "prepared",
      rejection: null,
      createBody,
      body: sendBody,
    };
    if (!saveDeliveryIntent(identity, intent)) {
      toast.error(
        "Message not sent: this browser could not save a recovery copy. Free up storage and try again.",
      );
      return null;
    }
    set(deliveryIntentsChanged$);
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
      },
      signal,
    );
    if (request.composerTask) {
      set(rememberComposerTaskForThread$, threadId, request.composerTask);
    }
    request.onOptimisticSend?.();
    set(draft.clear$);
    if (!request.forward && !request.preserveAgentDraft) {
      detach(
        settle(set(clearAgentDraftById$, agentId, signal)),
        Reason.Daemon,
        "clear agent draft after first-message recovery save",
      );
    }
    const createClient = get(apiClient$);
    L.debug("sendNewThreadMessage$ POST chat-threads start", { threadId });
    const sendResult = (async (): Promise<boolean> => {
      const currentIdentity = await settle(get(authenticatedIdentity$));
      signal.throwIfAborted();
      if (
        !currentIdentity.ok ||
        currentIdentity.value.userId !== identity.userId ||
        currentIdentity.value.orgId !== identity.orgId
      ) {
        updateDeliveryIntent(identity, clientEventId, {
          status: "rejected",
          rejection: "authentication",
        });
        set(deliveryIntentsChanged$);
        return false;
      }
      const created = await settle(
        createNewThreadRecord(createClient, createBody, signal),
      );
      signal.throwIfAborted();
      if (!created.ok) {
        updateDeliveryIntent(
          identity,
          clientEventId,
          newThreadDeliveryFailure(created.error),
        );
        set(deliveryIntentsChanged$);
        return false;
      }
      updateDeliveryIntent(identity, clientEventId, {
        phase: "prompt",
        status: "prepared",
        rejection: null,
      });
      set(deliveryIntentsChanged$);
      const promptIdentity = await settle(get(authenticatedIdentity$));
      signal.throwIfAborted();
      if (
        !promptIdentity.ok ||
        promptIdentity.value.userId !== identity.userId ||
        promptIdentity.value.orgId !== identity.orgId
      ) {
        updateDeliveryIntent(identity, clientEventId, {
          status: "rejected",
          rejection: "authentication",
        });
        set(deliveryIntentsChanged$);
        return false;
      }
      const sent = await settle(sendChatEvent(createClient, sendBody, signal));
      signal.throwIfAborted();
      if (!sent.ok) {
        updateDeliveryIntent(
          identity,
          clientEventId,
          newThreadDeliveryFailure(sent.error),
        );
        set(deliveryIntentsChanged$);
        return false;
      }
      updateDeliveryIntent(identity, clientEventId, {
        status: "accepted",
        rejection: null,
      });
      set(deliveryIntentsChanged$);
      request.onAcceptedSend?.();
      L.debug("sendNewThreadMessage$ POST chat/events 201", { threadId });
      return true;
    })();
    // Navigation can fail before its caller begins awaiting the in-flight send.
    detach(
      sendResult,
      Reason.Daemon,
      "first-message delivery after navigation",
    );
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
    const sent = await result.sendResult;
    signal.throwIfAborted();
    return sent;
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
    const sent = await result.sendResult;
    signal.throwIfAborted();
    return sent;
  },
);
