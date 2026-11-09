import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../external/feature-switch.ts";
import type { ModelProviderSelection } from "../../views/okou-page/components/model-provider-picker.tsx";
import {
  sendNewThread$,
  sendNewThreadWithoutNavigation$,
} from "../chat-page/optimistic-chat-thread-page.ts";
import type { ChatForwardContext } from "../chat-page/chat-forward.ts";
import {
  createAgentDraftSignals,
  type EnsuredAgentDraft,
} from "./agent-draft.ts";
import type { DraftSignals } from "./chat-draft.ts";
import {
  createComposerSignals,
  type ComposerSubmission,
} from "./composer-signals.ts";
import type { ChatEvent } from "../chat-page/chat-event-types.ts";
import { createChatEventProjectionSignals } from "../chat-page/chat-event-projection-signals.ts";
import { createComposerConnectorSignals } from "./connectors.ts";
import { createComposerProjectSignals } from "../projects/composer-project.ts";
import { createPendingRemoteAccessSignals } from "../remote-access.ts";
import {
  chatPageModelSelection$,
  chatPageSelectedModelOauthAvailable$,
  configureChatPageSelectedModel$,
  resetChatPageModelSelection$,
  setChatPageModelSelection$,
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

const setModelSelection$ = command(
  (
    { set },
    selection: ModelProviderSelection | null,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    set(setChatPageModelSelection$, selection);
    return Promise.resolve();
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
  readonly title?: string;
  /**
   * A dialog composer sends from its own unsaved draft and keeps the current
   * page, leaving the Agent's saved composer untouched.
   */
  readonly inPlace?: boolean;
  /** A Project page starts its chats in that Project. */
  readonly projectId?: string;
  readonly onOptimisticSend?: (threadId: string) => void;
}

function createAgentSubmitMessage(
  agentId: string,
  draft: DraftSignals,
  connector: ReturnType<typeof createComposerConnectorSignals>,
  pendingRemoteAccess: ReturnType<typeof createPendingRemoteAccessSignals>,
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
      const access = get(newThreadComputerAccess$);
      const chatAccessEnabled =
        get(featureSwitch$)[FeatureSwitchKey.ConnectorChatAccountAccess];
      const connectorPreference = chatAccessEnabled
        ? null
        : await get(connector.accounts.preferenceState$);
      signal.throwIfAborted();
      const send = options.inPlace
        ? sendNewThreadWithoutNavigation$
        : sendNewThread$;
      const initialRemoteAccessOverrides = get(pendingRemoteAccess.overrides$);
      const connectorSelections = connectorPreference?.selections ?? [];
      const pendingConnectorAccess = get(connector.chatAccess.pending$);
      const hasPendingConnectorAccess =
        pendingConnectorAccess.overrides.length > 0 ||
        pendingConnectorAccess.selections.length > 0;
      const sent = await set(
        send,
        {
          agentId,
          title: options.title,
          ...(options.projectId ? { projectId: options.projectId } : {}),
          draft,
          prompt: submission.prompt,
          generationTemplate: submission.generationTemplate,
          editorDocument: submission.editorDocument,
          // An in-place send stays on this page, so only a send that opens the
          // new thread hands the selection over to it.
          ...(options.inPlace
            ? { preserveAgentDraft: true }
            : { composerTask: submission.taskSelection }),
          // Omit untouched draft preferences so the server applies the current
          // member default. Explicit "none" must also override a true default.
          ...(access === null
            ? {}
            : {
                computerUseHostId:
                  access.kind === "computerUse" ? access.hostId : null,
                cloudBrowserEnabled: access.kind === "cloudBrowser",
              }),
          ...(options.forward ? { forward: options.forward } : {}),
          ...(options.onOptimisticSend
            ? { onOptimisticSend: options.onOptimisticSend }
            : {}),
          ...(connectorSelections.length > 0 ? { connectorSelections } : {}),
          ...(chatAccessEnabled && hasPendingConnectorAccess
            ? { initialConnectorAccess: pendingConnectorAccess }
            : {}),
          ...(initialRemoteAccessOverrides.length > 0
            ? { initialRemoteAccessOverrides }
            : {}),
        },
        signal,
      );
      if (sent) {
        set(resetNewThreadComputerAccess$);
        set(resetChatPageModelSelection$);
        set(connector.accounts.resetPendingSelections$);
        set(connector.chatAccess.resetPending$);
        set(pendingRemoteAccess.reset$);
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
  const pendingRemoteAccess = createPendingRemoteAccessSignals();
  const submitMessage$ = createAgentSubmitMessage(
    agentId,
    agentDraft.draft,
    connector,
    pendingRemoteAccess,
    options,
  );

  return createComposerSignals({
    agentId,
    // A dialog composer sends from its own draft without leaving the page, so
    // only the page's own composer can move its chat into a Project.
    ...(options.inPlace
      ? {}
      : {
          project: createComposerProjectSignals(
            agentId,
            options.projectId ?? null,
          ),
        }),
    connector,
    pendingRemoteAccess,
    draft: {
      signals: agentDraft.draft,
      load$: options.inPlace ? noOpAction$ : agentDraft.load$,
      save$: options.inPlace ? noOpAction$ : agentDraft.queueDraftSync$,
    },
    eventSignals: createChatEventProjectionSignals(chatEvents$),
    voiceDraftTarget: `agent:${agentId}`,
    singleLineOnMobile: false,
    forwardComposer: options.inPlace === true,
    modelSelection$: chatPageModelSelection$,
    selectedModelOauthAvailable$: chatPageSelectedModelOauthAvailable$,
    setModelSelection$,
    configureSelectedModel$: configureChatPageSelectedModel$,
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
    { forward, inPlace: true, onOptimisticSend },
  );
}

/** A dialog composer for a prepared draft that starts a new thread in place. */
export function createInPlaceAgentComposerSignals(
  agentId: string,
  agentDraft: EnsuredAgentDraft,
  onOptimisticSend: (threadId: string) => void,
  title: string,
) {
  return createAgentComposerSignalsWithDraft(agentId, agentDraft, {
    inPlace: true,
    onOptimisticSend,
    title,
  });
}

interface AgentComposerContext {
  readonly agentId: string;
  readonly agentDraft: EnsuredAgentDraft;
  readonly projectId?: string;
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
    context.projectId ? { projectId: context.projectId } : {},
  );
});
