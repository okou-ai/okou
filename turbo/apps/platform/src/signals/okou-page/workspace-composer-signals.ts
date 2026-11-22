import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitches$ } from "../external/feature-switch.ts";
import type { ModelProviderSelection } from "../../views/okou-page/components/model-provider-picker.tsx";
import {
  sendNewThread$,
  sendNewThreadWithoutNavigation$,
} from "../chat-page/optimistic-chat-thread-page.ts";
import type { ChatForwardContext } from "../chat-page/chat-forward.ts";
import {
  createWorkspaceDraftSignals,
  type WorkspaceDraftEntry,
} from "./workspace-draft.ts";
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

interface WorkspaceComposerOptions {
  readonly forward?: ChatForwardContext;
  /**
   * A dialog composer sends from its own unsaved draft and keeps the current
   * page, leaving the Agent's saved composer untouched.
   */
  readonly inPlace?: boolean;
  /** The initial Project for a page's new chat or an in-place fork. */
  readonly projectId?: string;
  /** Names the new thread instead of deriving its title from the message. */
  readonly title?: string;
  readonly onOptimisticSend?: (
    threadId: string,
    submission: ComposerSubmission,
  ) => void;
}

function createSubmitMessage(
  draft: DraftSignals,
  connector: ReturnType<typeof createComposerConnectorSignals>,
  pendingRemoteAccess: ReturnType<typeof createPendingRemoteAccessSignals>,
  options: WorkspaceComposerOptions,
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
      const features = await get(featureSwitches$);
      signal.throwIfAborted();
      const access = get(newThreadComputerAccess$);
      const initialPhoneUse = features[FeatureSwitchKey.PhoneUse]
        ? get(connector.phoneAccess.pending$)
        : null;

      signal.throwIfAborted();
      const send = options.inPlace
        ? sendNewThreadWithoutNavigation$
        : sendNewThread$;
      const initialRemoteAccessOverrides = get(pendingRemoteAccess.overrides$);
      const pendingConnectorAccess = get(connector.chatAccess.pending$);
      const hasPendingConnectorAccess =
        pendingConnectorAccess.overrides.length > 0 ||
        pendingConnectorAccess.selections.length > 0;
      const sent = await set(
        send,
        {
          ...(options.projectId ? { projectId: options.projectId } : {}),
          ...(options.title ? { title: options.title } : {}),
          draft,
          prompt: submission.prompt,
          generationTemplate: submission.generationTemplate,
          editorDocument: submission.editorDocument,
          // An in-place send stays on this page, so only a send that opens the
          // new thread hands the selection over to it.
          ...(options.inPlace
            ? { preserveWorkspaceDraft: true }
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
          onOptimisticSend: options.onOptimisticSend
            ? (threadId) => {
                options.onOptimisticSend?.(threadId, submission);
              }
            : undefined,
          ...(hasPendingConnectorAccess
            ? { initialConnectorAccess: pendingConnectorAccess }
            : {}),
          ...(initialRemoteAccessOverrides.length > 0
            ? { initialRemoteAccessOverrides }
            : {}),
          ...(initialPhoneUse ? { initialPhoneUse } : {}),
        },
        signal,
      );
      if (sent) {
        set(resetNewThreadComputerAccess$);
        set(resetChatPageModelSelection$);
        set(connector.chatAccess.resetPending$);
        set(connector.phoneAccess.resetPending$);
        set(pendingRemoteAccess.reset$);
      }
      return sent;
    },
  );
}

function createComposerSignalsWithDraft(
  workspaceDraft: WorkspaceDraftEntry,
  options: WorkspaceComposerOptions = {},
) {
  const connector = createComposerConnectorSignals();
  const pendingRemoteAccess = createPendingRemoteAccessSignals();
  const submitMessage$ = createSubmitMessage(
    workspaceDraft.draft,
    connector,
    pendingRemoteAccess,
    options,
  );

  // The Project picker navigates, so an in-place composer only uses its
  // initial Project for creation without exposing that picker.
  const project = options.inPlace
    ? undefined
    : createComposerProjectSignals(options.projectId ?? null);
  const composer = createComposerSignals({
    ...(project ? { project } : {}),
    connector,
    pendingRemoteAccess,
    draft: {
      signals: workspaceDraft.draft,
      load$: options.inPlace ? noOpAction$ : workspaceDraft.load$,
      save$: options.inPlace ? noOpAction$ : workspaceDraft.queueDraftSync$,
    },
    eventSignals: createChatEventProjectionSignals(chatEvents$),
    voiceDraftTarget: "new-chat",
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
  return project ? { ...composer, project } : composer;
}

export function createForwardChatComposerSignals(
  forward: ChatForwardContext,
  onOptimisticSend: () => void,
  projectId?: string,
) {
  return createComposerSignalsWithDraft(createWorkspaceDraftSignals(), {
    forward,
    inPlace: true,
    onOptimisticSend,
    projectId,
  });
}

/**
 * A dialog composer that starts a new thread from its own unsaved
 * draft and keeps the current page.
 */
export function createInPlaceChatComposerSignals(
  onOptimisticSend: (threadId: string, submission: ComposerSubmission) => void,
  title: string,
) {
  return createComposerSignalsWithDraft(createWorkspaceDraftSignals(), {
    inPlace: true,
    onOptimisticSend,
    title,
  });
}

interface WorkspaceComposerContext {
  readonly workspaceDraft: WorkspaceDraftEntry;
  readonly projectId?: string;
}

const internalWorkspaceComposerContext$ =
  state<WorkspaceComposerContext | null>(null);

export const setWorkspaceComposerContext$ = command(
  ({ set }, context: WorkspaceComposerContext): void => {
    set(internalWorkspaceComposerContext$, context);
  },
);

export const workspaceChatComposerSignals$ = computed((get) => {
  const context = get(internalWorkspaceComposerContext$);
  if (!context) {
    throw new Error("Chat composer requires an initialized draft context");
  }
  return createComposerSignalsWithDraft(
    context.workspaceDraft,
    context.projectId ? { projectId: context.projectId } : {},
  );
});
