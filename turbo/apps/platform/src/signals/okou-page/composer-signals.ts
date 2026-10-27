import {
  createComposerTaskChipsSignals,
  type ComposerTaskChipsSignals,
} from "./composer-task-chips.ts";
import {
  createComposerVoiceInputSignals,
  type ComposerVoiceInputOwner,
  type ComposerVoiceInputSignals,
} from "./composer-voice-input.ts";
import type {
  GenerationTemplateRequest,
  UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  checkPaidToolForCreation$,
  templatePaidTool,
  type AvailablePaidToolId,
} from "./paid-tools.ts";
import { i18n } from "../../i18n/index.ts";
import { createComputerUseGuideSignals } from "../computer-use-setup.ts";
import { command, computed, state, type Command, type Computed } from "ccstate";
import { onRef, settle } from "../utils.ts";
import {
  prepareRecentWorkflowUse$,
  recordRecentWorkflowUse$,
} from "./recent-workflows.ts";
import {
  createPendingRemoteAccessSignals,
  threadRemoteAccess$,
} from "../remote-access.ts";
import type { ModelProviderSelection } from "../../views/okou-page/components/model-provider-picker.tsx";
import type { DraftSignals, ChatAttachment } from "./chat-draft.ts";
import { createComposerFeedbackModel } from "./chat-feedback.ts";
import type { ChatEvent } from "../chat-page/chat-event-types.ts";
import {
  deriveRunIndicatorStateFromChatEvents,
  lastAssistantCancelledFromGroups,
  queuedEventsFromSemanticEvents,
  runningModelSelectionFromChatEvents,
  type ChatRunModelSelection,
} from "../chat-page/chat-event-state.ts";
import {
  groupSemanticChatEvents,
  isUsageEvent,
  semanticChatEventsFromChatEvents,
} from "@okouai/api-contracts/contracts/chat-event-semantics";
import {
  createEditorDocumentSnapshot,
  messageDocumentToDisplayText,
} from "./user-message-document-codec.ts";
import {
  createComposerCreateSignals,
  type ComposerCreateSignals,
} from "./composer-create.ts";
import {
  createWorkflowComposerSignals,
  type WorkflowComposerSignals,
  type WorkflowComposerSubmissionSnapshot,
} from "./tiptap-workflow-composer.ts";
import {
  createComposerConnectorSignals,
  type ComposerConnectorSignals,
} from "./connectors.ts";
import {
  createComposerUiSignals,
  type ComposerUiSignalGroups,
} from "./chat-composer.ts";
import { buildComposerAdditionalInfo } from "./composer-additional-info.ts";
import type { ComposerTaskSelection } from "./composer-task-handoff.ts";
import {
  createComposerConnectorCompletion,
  createComposerDraftActions,
  createComposerTemplateSelection,
} from "./composer-business-actions.ts";
import {
  createImageAnnotationSignals,
  type ImageAnnotationSignals,
} from "./image-annotation.ts";

type ComposerEditorSignals = Pick<
  WorkflowComposerSignals,
  | "editor"
  | "setContainerRef$"
  | "focus$"
  | "hasInput$"
  | "insertPromptMarkdown$"
  | "insertUserMessage$"
  | "insertText$"
  | "selectOrAppendText$"
  | "replacePromptText$"
> & {
  readonly singleLineOnMobile: boolean;
  /**
   * The forward dialog reuses the start page's composer signals, so
   * "not docked under a thread" is not enough to identify the start page. Its
   * shell stays compact while the start page's opens taller.
   */
  readonly forwardComposer: boolean;
};

type ComposerWorkflowEditorSignals = Pick<
  WorkflowComposerSignals,
  "workflows$" | "reloadWorkflows$" | "insertWorkflow$"
>;

type ComposerSuggestionSignals = Pick<
  WorkflowComposerSignals,
  | "activeSlashRange$"
  | "activeChatThreadSuggestionRange$"
  | "chatThreadSuggestions$"
  | "selectedSuggestionIndex$"
  | "setSelectedSuggestionIndex$"
  | "previewSuggestionIndex$"
  | "previewSuggestion$"
  | "slashWorkflowsExpanded$"
  | "slashWorkflowsExpandedHeight$"
  | "recentWorkflowIds$"
  | "expandSlashWorkflows$"
  | "slashMenuSide$"
  | "measureSlashMenuSide$"
  | "closeSuggestionMenu$"
  | "setSlashHintMenuRef$"
  | "setMentionHintMenuRef$"
  | "clearSlashRange$"
  | "insertAgent$"
  | "insertChatThread$"
> & {
  /** A token can own a session before its asynchronous rows are available. */
  readonly sessionActive$: Computed<boolean>;
  readonly attachSessionKeyDown$: Command<
    (() => void) | undefined,
    [HTMLElement | null, (event: KeyboardEvent) => boolean]
  >;
};

type ComposerTemplateEditorSignals = Pick<
  WorkflowComposerSignals,
  "hasTemplateAttachment$" | "insertTemplate$" | "openTemplatePicker$"
>;

type ComposerModelUiSignals = ComposerUiSignalGroups["model"];
type ComposerTemplateUiSignals = ComposerUiSignalGroups["template"];

export interface ComposerSubmission {
  readonly prompt: string;
  readonly generationTemplate: GenerationTemplateRequest | undefined;
  readonly editorDocument: WorkflowComposerSubmissionSnapshot["editorDocument"];
  /**
   * What the composer is set to make. A send inside a thread keeps it, so a
   * send that creates one hands it to the thread it opens.
   */
  readonly taskSelection: ComposerTaskSelection;
}

export type ComposerSubmissionAction = "send" | "queue";

export type ComposerPrimaryAction =
  ComposerSubmissionAction | "stop" | "disabled";

export interface ComposerPendingEvent {
  readonly kind: "message" | "automation";
  readonly id: string;
  readonly text: string;
}

interface ComposerDraftSignals extends ReturnType<
  typeof createComposerDraftActions
> {
  readonly load$: Command<Promise<void>, [AbortSignal]>;
  readonly seed$: DraftSignals["seed$"];
  readonly setDraftInput$: Command<void, [string]>;
  readonly attachments$: Computed<ChatAttachment[]>;
  readonly attachmentUploadsReady$: Computed<Promise<boolean>>;
  readonly uploadAttachment$: Command<Promise<void>, [File, AbortSignal]>;
  readonly restoreAttachments$: DraftSignals["restoreAttachments$"];
  readonly removeAttachment$: Command<void, [ChatAttachment]>;
  readonly dragOver$: Computed<boolean>;
  readonly setDragOver$: Command<void, [boolean]>;
  readonly composerFileInput$: Computed<HTMLInputElement | null>;
  readonly setComposerFileInput$: Command<
    (() => void) | undefined,
    [HTMLInputElement | null]
  >;
  readonly save$: Command<Promise<void>, [AbortSignal]>;
}

interface ComposerModelSignals extends ComposerModelUiSignals {
  /** New chats offer to keep a chat-only model for future chats. */
  readonly temporaryModelNoticeEnabled: boolean;
  readonly modelSelection$: Computed<Promise<ModelProviderSelection | null>>;
  readonly runningModelSelection$: Computed<
    Promise<ChatRunModelSelection | null>
  >;
  readonly selectedModelOauthAvailable$: Computed<Promise<boolean>>;
  readonly setModelSelection$: Command<
    Promise<void>,
    [ModelProviderSelection | null, AbortSignal]
  >;
  readonly configureSelectedModel$: Command<Promise<void>, [AbortSignal]>;
}

interface ComposerComputerSignals {
  readonly computerUseHostId$: Computed<string | null>;
  readonly cloudBrowserEnabled$: Computed<
    boolean | undefined | Promise<boolean | undefined>
  >;
  readonly setComputerUseHostId$: Command<
    Promise<void>,
    [string | null, AbortSignal]
  >;
  readonly setCloudBrowserEnabled$: Command<
    Promise<void>,
    [boolean, AbortSignal]
  >;
  readonly computerUseDownloadDialogOpen$: Computed<boolean>;
  readonly setComputerUseDownloadDialogOpen$: Command<void, [boolean]>;
}

interface ComposerSubmissionSignals {
  readonly sending$: Computed<Promise<boolean>>;
  readonly primaryAction$: Computed<Promise<ComposerPrimaryAction>>;
  readonly hasCurrentInvocation$: Computed<boolean>;
  /**
   * Sends what the composer currently holds. The second argument is agent-only
   * context for this one send: it reaches the run's prompt through the
   * message's additional_info part and never the text the member reads, which
   * is how a caller states how the run should be carried out without spending
   * the member's own message on instructions addressed to it.
   */
  readonly submitCurrentInput$: Command<
    Promise<boolean>,
    [ComposerPrimaryAction, string | undefined, AbortSignal]
  >;
  readonly activatePrimaryAction$: Command<
    Promise<boolean>,
    [ComposerPrimaryAction, AbortSignal]
  >;
}

interface ComposerQueueSignals {
  readonly pendingEvents$: Computed<Promise<readonly ComposerPendingEvent[]>>;
  readonly cancellationRecoveryPending$: Computed<Promise<boolean>>;
  readonly removeQueuedMessage$: Command<Promise<void>, [string, AbortSignal]>;
  readonly removeAutomationEvent$: Command<
    Promise<void>,
    [string, AbortSignal]
  >;
}

interface ComposerTemplateSignals
  extends ComposerTemplateEditorSignals, ComposerTemplateUiSignals {
  readonly generationTemplate$: Computed<GenerationTemplateRequest | undefined>;
  readonly setGenerationTemplate$: Command<
    void,
    [GenerationTemplateRequest | undefined]
  >;
  readonly selectTemplateAndSave$: ReturnType<
    typeof createComposerTemplateSelection
  >;
}

export interface ComposerSignals {
  readonly paidToolHints$: Computed<readonly AvailablePaidToolId[]>;
  readonly create: ComposerCreateSignals;
  readonly taskChips: ComposerTaskChipsSignals;
  readonly agentId: string;
  readonly threadId?: string;
  readonly remoteAccess$: ReturnType<typeof threadRemoteAccess$>;
  readonly pendingRemoteAccess: ReturnType<
    typeof createPendingRemoteAccessSignals
  >;
  readonly editor: ComposerEditorSignals;
  readonly voice: ComposerVoiceInputSignals;
  readonly feedback: WorkflowComposerSignals["feedback"];
  readonly workflow: ComposerWorkflowEditorSignals;
  readonly suggestion: ComposerSuggestionSignals;
  readonly connector: ComposerConnectorSignals;
  readonly connectorCompletion: ReturnType<
    typeof createComposerConnectorCompletion
  >;
  readonly draft: ComposerDraftSignals;
  readonly model: ComposerModelSignals;
  readonly computer: ComposerComputerSignals;
  readonly submission: ComposerSubmissionSignals;
  readonly queue: ComposerQueueSignals;
  readonly template: ComposerTemplateSignals;
  readonly imageAnnotation: ImageAnnotationSignals;
  readonly setImageAnnotationLifecycleRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
}

interface CreateComposerSignalsOptions {
  readonly agentId: string;
  readonly draft: {
    readonly signals: DraftSignals;
    readonly load$: ComposerDraftSignals["load$"];
    readonly save$: ComposerDraftSignals["save$"];
  };
  readonly chatEvents$: Computed<ChatEvent[]>;
  readonly threadId?: string;
  readonly pendingRemoteAccess?: ReturnType<
    typeof createPendingRemoteAccessSignals
  >;
  readonly voiceDraftTarget: string;
  readonly connector?: ComposerConnectorSignals;
  readonly singleLineOnMobile: boolean;
  readonly forwardComposer: boolean;
  readonly modelSelection$: ComposerModelSignals["modelSelection$"];
  readonly selectedModelOauthAvailable$: ComposerModelSignals["selectedModelOauthAvailable$"];
  readonly setModelSelection$: ComposerModelSignals["setModelSelection$"];
  readonly configureSelectedModel$: ComposerModelSignals["configureSelectedModel$"];
  readonly computerUseHostId$: ComposerComputerSignals["computerUseHostId$"];
  readonly cloudBrowserEnabled$: ComposerComputerSignals["cloudBrowserEnabled$"];
  readonly setComputerUseHostId$: ComposerComputerSignals["setComputerUseHostId$"];
  readonly setCloudBrowserEnabled$: ComposerComputerSignals["setCloudBrowserEnabled$"];
  readonly submitMessage$: Command<
    Promise<boolean>,
    [ComposerSubmissionAction, ComposerSubmission, AbortSignal]
  >;
  readonly cancelRun$: Command<Promise<void>, [AbortSignal]>;
  readonly cancellationRecoveryPending$: ComposerQueueSignals["cancellationRecoveryPending$"];
  readonly removeQueuedMessage$: ComposerQueueSignals["removeQueuedMessage$"];
  readonly removeAutomationEvent$: ComposerQueueSignals["removeAutomationEvent$"];
}

function forwardFeedbackPlaceholder(): string {
  return i18n.t(($) => {
    return $.chat.forward.composerPlaceholder;
  });
}

function createComposerFileInputSignals() {
  const internal$ = state<HTMLInputElement | null>(null);
  const composerFileInput$ = computed((get) => {
    return get(internal$);
  });
  const setComposerFileInput$ = onRef(
    command(({ set }, element: HTMLInputElement, signal: AbortSignal) => {
      signal.addEventListener("abort", () => {
        set(internal$, null);
      });
      set(internal$, element);
    }),
  );
  return { composerFileInput$, setComposerFileInput$ };
}

function composerEditorSignals(
  composer: WorkflowComposerSignals,
  options: Pick<
    CreateComposerSignalsOptions,
    "singleLineOnMobile" | "forwardComposer"
  >,
): ComposerEditorSignals {
  return {
    singleLineOnMobile: options.singleLineOnMobile,
    forwardComposer: options.forwardComposer,
    editor: composer.editor,
    setContainerRef$: composer.setContainerRef$,
    focus$: composer.focus$,
    hasInput$: composer.hasInput$,
    insertPromptMarkdown$: composer.insertPromptMarkdown$,
    insertUserMessage$: composer.insertUserMessage$,
    insertText$: composer.insertText$,
    selectOrAppendText$: composer.selectOrAppendText$,
    replacePromptText$: composer.replacePromptText$,
  };
}

function composerWorkflowSignals(
  composer: WorkflowComposerSignals,
): ComposerWorkflowEditorSignals {
  return {
    workflows$: composer.workflows$,
    reloadWorkflows$: composer.reloadWorkflows$,
    insertWorkflow$: composer.insertWorkflow$,
  };
}

function composerSuggestionSignals(
  composer: WorkflowComposerSignals,
): ComposerSuggestionSignals {
  const sessionActive$ = computed((get) => {
    return (
      get(composer.activeSlashRange$) !== null ||
      get(composer.activeChatThreadSuggestionRange$) !== null
    );
  });
  // The committed session subtree owns this external DOM integration, not
  // the permanent editor mount. Each ref attachment supplies its own committed
  // row closure; cleanup releases exactly that listener without storing it.
  const attachSessionKeyDown$ = command(
    (
      _,
      host: HTMLElement | null,
      handleKeyDown: (event: KeyboardEvent) => boolean,
    ) => {
      if (!host) {
        return;
      }
      const element = composer.editor.view.dom;
      const capture = (event: KeyboardEvent) => {
        if (handleKeyDown(event) || event.defaultPrevented) {
          event.stopPropagation();
        }
      };
      element.addEventListener("keydown", capture, true);
      return () => {
        element.removeEventListener("keydown", capture, true);
      };
    },
  );
  return {
    sessionActive$,
    attachSessionKeyDown$,
    activeSlashRange$: composer.activeSlashRange$,
    activeChatThreadSuggestionRange$: composer.activeChatThreadSuggestionRange$,
    chatThreadSuggestions$: composer.chatThreadSuggestions$,
    selectedSuggestionIndex$: composer.selectedSuggestionIndex$,
    setSelectedSuggestionIndex$: composer.setSelectedSuggestionIndex$,
    previewSuggestionIndex$: composer.previewSuggestionIndex$,
    previewSuggestion$: composer.previewSuggestion$,
    slashWorkflowsExpanded$: composer.slashWorkflowsExpanded$,
    slashWorkflowsExpandedHeight$: composer.slashWorkflowsExpandedHeight$,
    recentWorkflowIds$: composer.recentWorkflowIds$,
    expandSlashWorkflows$: composer.expandSlashWorkflows$,
    slashMenuSide$: composer.slashMenuSide$,
    measureSlashMenuSide$: composer.measureSlashMenuSide$,
    closeSuggestionMenu$: composer.closeSuggestionMenu$,
    setSlashHintMenuRef$: composer.setSlashHintMenuRef$,
    setMentionHintMenuRef$: composer.setMentionHintMenuRef$,
    clearSlashRange$: composer.clearSlashRange$,
    insertAgent$: composer.insertAgent$,
    insertChatThread$: composer.insertChatThread$,
  };
}

function composerTemplateSignals(
  composer: WorkflowComposerSignals,
): ComposerTemplateEditorSignals {
  return {
    hasTemplateAttachment$: composer.hasTemplateAttachment$,
    insertTemplate$: composer.insertTemplate$,
    openTemplatePicker$: composer.openTemplatePicker$,
  };
}

function createRemoveQueuedMessage(
  removeQueuedMessage$: CreateComposerSignalsOptions["removeQueuedMessage$"],
  workflowComposer: WorkflowComposerSignals,
): ComposerQueueSignals["removeQueuedMessage$"] {
  return command(
    async ({ set }, eventId: string, signal: AbortSignal): Promise<void> => {
      await set(removeQueuedMessage$, eventId, signal);
      set(workflowComposer.focus$);
    },
  );
}

function composerDraftSignals(
  options: CreateComposerSignalsOptions["draft"],
  fileInput: ReturnType<typeof createComposerFileInputSignals>,
): ComposerDraftSignals {
  const draft = options.signals;
  return {
    load$: options.load$,
    seed$: draft.seed$,
    setDraftInput$: draft.setInput$,
    attachments$: draft.attachments$,
    attachmentUploadsReady$: draft.attachmentUploadsReady$,
    uploadAttachment$: draft.uploadAttachment$,
    restoreAttachments$: draft.restoreAttachments$,
    ...createComposerDraftActions(draft, options.save$),
    removeAttachment$: draft.removeAttachment$,
    dragOver$: draft.dragOver$,
    setDragOver$: draft.setDragOver$,
    ...fileInput,
    save$: options.save$,
  };
}

function createComposerVoiceInput(
  options: Pick<CreateComposerSignalsOptions, "draft" | "voiceDraftTarget">,
  workflowComposer: WorkflowComposerSignals,
) {
  const deliverText$ = command(
    async ({ set }, text: string, signal: AbortSignal) => {
      await set(options.draft.load$, signal);
      signal.throwIfAborted();
      set(workflowComposer.insertText$, text);
    },
  );
  return createComposerVoiceInputSignals(
    deliverText$,
    workflowComposer.readVoiceContext$,
    options.voiceDraftTarget,
  );
}

function createPaidToolHints(
  create: ComposerCreateSignals,
  draft: DraftSignals,
  composer: WorkflowComposerSignals,
) {
  return computed((get) => {
    const mode = get(create.mode$);
    const tools = new Set<AvailablePaidToolId>();
    if (mode === "image") {
      tools.add("image-generation");
    }
    const selectedTemplate = get(draft.generationTemplate$);
    const templates = get(composer.templateRequests$);
    for (const template of selectedTemplate
      ? [...templates, selectedTemplate]
      : templates) {
      const tool = templatePaidTool(template);
      if (tool) {
        tools.add(tool);
      }
    }
    return [...tools];
  });
}

function composerRemoteAccessSignals(
  options: CreateComposerSignalsOptions,
  connector: ComposerConnectorSignals,
) {
  return {
    remoteAccess$: threadRemoteAccess$(
      options.threadId ?? "",
      connector.resources.openedVersion$,
    ),
    pendingRemoteAccess:
      options.pendingRemoteAccess ?? createPendingRemoteAccessSignals(),
  };
}

export function createComposerSignals(
  options: CreateComposerSignalsOptions,
): ComposerSignals {
  const eventSignals = createComposerChatEventSignals(options.chatEvents$);
  const draft = options.draft.signals;
  const agentId$ = computed((): string => {
    return options.agentId;
  });
  const ui = createComposerUiSignals();
  const workflowComposer = createWorkflowComposerSignals(
    draft,
    ui.openTemplatePickerDialog$,
    agentId$,
    {
      autoFocus: true,
      ...(options.forwardComposer
        ? { feedbackPlaceholder: forwardFeedbackPlaceholder }
        : {}),
    },
    createComposerFeedbackModel(),
  );
  const create = createComposerCreateSignals(workflowComposer, ui);
  const taskChips = createComposerTaskChipsSignals(create, {
    insertTemplate$: workflowComposer.insertTemplate$,
    insertPrompt$: workflowComposer.replacePromptText$,
    openTemplatePicker$: workflowComposer.openTemplatePicker$,
    focusEditor$: workflowComposer.focus$,
    saveDraft$: options.draft.save$,
  });
  const voice = createComposerVoiceInput(options, workflowComposer);
  const submission = createComposerSubmissionSignals(
    options,
    eventSignals,
    workflowComposer,
    { voice, create, taskChips },
  );
  const fileInput = createComposerFileInputSignals();
  const connector =
    options.connector ??
    createComposerConnectorSignals(options.agentId, options.threadId);
  const imageAnnotation = createImageAnnotationSignals();
  /**
   * Teardown owner for the annotation session and its in-flight derivative
   * uploads. The element itself is not part of the work, but its committed
   * presence is: `ImageAnnotationEditor` renders inside this exact subtree, so
   * the subtree leaving the tree is what makes an open session and a pending
   * upload unreachable. An abandoned upload would otherwise leave the
   * attachment stuck in `pending`, blocking every later send on the restored
   * draft with no retry affordance.
   *
   * `createComposerSignals` takes no lifecycle signal today, so this is the
   * narrowest available owner. Replace it with an injected `AbortSignal` if
   * the composer factory ever gains one.
   */
  const setImageAnnotationLifecycleRef$ = onRef<HTMLElement>(
    command(({ get, set }, _element: HTMLElement, signal: AbortSignal) => {
      signal.addEventListener(
        "abort",
        () => {
          set(imageAnnotation.closeAnnotationEditor$);
          for (const attachment of get(draft.attachments$)) {
            set(attachment.cancelAnnotationUpload$);
          }
        },
        { once: true },
      );
    }),
  );
  return {
    agentId: options.agentId,
    threadId: options.threadId,
    ...composerRemoteAccessSignals(options, connector),
    paidToolHints$: createPaidToolHints(create, draft, workflowComposer),
    create,
    taskChips,
    editor: composerEditorSignals(workflowComposer, options),
    voice,
    feedback: workflowComposer.feedback,
    workflow: composerWorkflowSignals(workflowComposer),
    suggestion: composerSuggestionSignals(workflowComposer),
    connector,
    connectorCompletion: createComposerConnectorCompletion(
      connector,
      options.agentId,
    ),
    draft: composerDraftSignals(options.draft, fileInput),
    model: {
      ...ui.model,
      temporaryModelNoticeEnabled: options.threadId === undefined,
      modelSelection$: options.modelSelection$,
      runningModelSelection$: eventSignals.runningModelSelection$,
      selectedModelOauthAvailable$: options.selectedModelOauthAvailable$,
      setModelSelection$: options.setModelSelection$,
      configureSelectedModel$: options.configureSelectedModel$,
    },
    computer: {
      ...createComputerUseGuideSignals(
        `${options.forwardComposer ? "forward" : "composer"}:${options.threadId ?? options.agentId}`,
      ),
      computerUseHostId$: options.computerUseHostId$,
      cloudBrowserEnabled$: options.cloudBrowserEnabled$,
      setComputerUseHostId$: options.setComputerUseHostId$,
      setCloudBrowserEnabled$: options.setCloudBrowserEnabled$,
    },
    submission: {
      ...submission,
      sending$: eventSignals.sending$,
    },
    queue: {
      pendingEvents$: eventSignals.pendingEvents$,
      cancellationRecoveryPending$: options.cancellationRecoveryPending$,
      removeQueuedMessage$: createRemoveQueuedMessage(
        options.removeQueuedMessage$,
        workflowComposer,
      ),
      removeAutomationEvent$: options.removeAutomationEvent$,
    },
    template: {
      selectTemplateAndSave$: createComposerTemplateSelection(
        taskChips,
        ui.template,
        options.draft.save$,
      ),
      ...composerTemplateSignals(workflowComposer),
      ...ui.template,
      generationTemplate$: draft.generationTemplate$,
      setGenerationTemplate$: draft.setGenerationTemplate$,
    },
    imageAnnotation,
    setImageAnnotationLifecycleRef$,
  };
}

/**
 * Automation events fired by a watched chat run carry an agent-run source
 * annotation instead of an automation part, so the document text is the label
 * whenever no workflow annotation survived.
 */
function pendingAutomationEventText(
  userMessage: UserMessageDocument | undefined,
): string {
  const automationPart = userMessage?.parts.find((part) => {
    return part.type === "automation";
  });
  if (automationPart?.type === "automation") {
    return (
      automationPart.automationBrief ?? automationPart.workflowName
    ).trim();
  }
  return (messageDocumentToDisplayText(userMessage) ?? "").trim();
}

function createComposerChatEventSignals(chatEvents$: Computed<ChatEvent[]>) {
  const semanticEvents$ = computed((get) => {
    return semanticChatEventsFromChatEvents(get(chatEvents$));
  });
  const semanticGroups$ = computed((get) => {
    return groupSemanticChatEvents(get(semanticEvents$));
  });
  const hasEvents$ = computed((get): Promise<boolean> => {
    return Promise.resolve(
      get(semanticEvents$).some((entry) => {
        return !isUsageEvent(entry.event);
      }),
    );
  });
  const runIndicatorState$ = computed((get) => {
    return deriveRunIndicatorStateFromChatEvents(get(chatEvents$));
  });
  const runningModelSelection$ = computed(
    (get): Promise<ChatRunModelSelection | null> => {
      return Promise.resolve(
        runningModelSelectionFromChatEvents(get(chatEvents$)),
      );
    },
  );
  const sending$ = computed((get): Promise<boolean> => {
    const running = get(runIndicatorState$) !== null;
    const lastAssistantCancelled = lastAssistantCancelledFromGroups(
      get(semanticGroups$),
    );
    return Promise.resolve(running && !lastAssistantCancelled);
  });
  const actionsLoading$ = computed(async (get): Promise<boolean> => {
    await get(hasEvents$);
    return false;
  });
  // Queue order is FIFO by seqId: chatEvents$ lists persisted events by seqId,
  // then still-sending optimistic events in their local order. Prompts and
  // automation inputs share one order and must not be regrouped by kind.
  const pendingEvents$ = computed(
    (get): Promise<readonly ComposerPendingEvent[]> => {
      return Promise.resolve(
        queuedEventsFromSemanticEvents(get(semanticEvents$)).map((event) => {
          return event.eventType === "input.automation"
            ? {
                kind: "automation" as const,
                id: event.id,
                text: pendingAutomationEventText(event.userMessage),
              }
            : {
                kind: "message" as const,
                id: event.id,
                text: (
                  messageDocumentToDisplayText(event.userMessage) ?? ""
                ).trim(),
              };
        }),
      );
    },
  );
  return {
    actionsLoading$,
    sending$,
    runningModelSelection$,
    pendingEvents$,
    hasEvents$,
  };
}

function createComposerPrimaryActionSignal(args: {
  readonly options: CreateComposerSignalsOptions;
  readonly eventSignals: ReturnType<typeof createComposerChatEventSignals>;
  readonly workflowComposer: WorkflowComposerSignals;
  readonly voiceState$: ComposerVoiceInputSignals["state$"];
}): Computed<Promise<ComposerPrimaryAction>> {
  const { options, eventSignals, workflowComposer } = args;
  const draft = options.draft.signals;
  return computed(async (get): Promise<ComposerPrimaryAction> => {
    if (await get(eventSignals.actionsLoading$)) {
      return "disabled";
    }
    if ((await get(args.voiceState$)).status !== "idle") {
      return "disabled";
    }

    const uploadsReady = await get(draft.attachmentUploadsReady$);
    const attachments = await get(draft.usableAttachments$);
    const hasContent =
      get(workflowComposer.hasInput$) || attachments.length > 0;
    const needsSuggestionNote = get(workflowComposer.feedback.items$).some(
      (item) => {
        return item.suggestionContext && !item.note.trim();
      },
    );
    const canSend = uploadsReady && hasContent && !needsSuggestionNote;
    const sending = await get(eventSignals.sending$);
    if (sending && !canSend) {
      return "stop";
    }
    if (!canSend) {
      return "disabled";
    }
    if (!sending) {
      return "send";
    }
    return "queue";
  });
}

/**
 * One message carries one additional_info part, so a caller's context for this
 * send and the composer's own selections are joined into it rather than one
 * replacing the other.
 */
function joinAdditionalInfo(
  ...blocks: readonly (string | undefined)[]
): string | undefined {
  const text = blocks
    .filter((block): block is string => {
      return block !== undefined && block.length > 0;
    })
    .join("\n\n");
  return text.length > 0 ? text : undefined;
}

function createSubmitCurrentInput({
  options,
  workflowComposer,
  voice,
  create,
  taskChips,
}: {
  readonly options: CreateComposerSignalsOptions;
  readonly workflowComposer: WorkflowComposerSignals;
  readonly voice: ComposerVoiceInputSignals;
  readonly create: ComposerCreateSignals;
  readonly taskChips: ComposerTaskChipsSignals;
}) {
  const draft = options.draft.signals;
  const voiceState$ = voice.state$;
  return command(
    async (
      { get, set },
      action: ComposerPrimaryAction,
      callerAdditionalInfo: string | undefined,
      signal: AbortSignal,
    ): Promise<boolean> => {
      signal.throwIfAborted();
      if (action !== "send" && action !== "queue") {
        return false;
      }
      if (!(await get(draft.attachmentUploadsReady$))) {
        return false;
      }
      signal.throwIfAborted();
      const voiceState = await get(voiceState$);
      signal.throwIfAborted();
      if (voiceState.status !== "idle") {
        return false;
      }
      const submission = await set(
        workflowComposer.readInputForSubmission$,
        signal,
      );
      signal.throwIfAborted();
      if (
        get(workflowComposer.feedback.items$).some((item) => {
          return item.suggestionContext && !item.note.trim();
        })
      ) {
        return false;
      }
      const visiblePrompt = submission.prompt.trim();
      const attachments = await get(draft.usableAttachments$);
      signal.throwIfAborted();
      if (visiblePrompt.length === 0 && attachments.length === 0) {
        return false;
      }
      if (!(await get(draft.attachmentUploadsReady$))) {
        return false;
      }
      signal.throwIfAborted();
      const mode = get(create.mode$);
      const selectedTask = get(taskChips.task$);
      const composerAdditionalInfo = buildComposerAdditionalInfo(
        mode,
        get(create.presentationSlideCount$),
        get(taskChips.task$) === "visualization"
          ? get(taskChips.visualization.preferences$)
          : undefined,
      );
      const additionalInfo = joinAdditionalInfo(
        callerAdditionalInfo,
        composerAdditionalInfo,
      );
      const editorDocument = additionalInfo
        ? createEditorDocumentSnapshot(
            workflowComposer.editor.schema.nodeFromJSON(
              submission.editorDocument.toEditorDocument(),
            ),
            additionalInfo,
          )
        : submission.editorDocument;
      const nextSubmission: ComposerSubmission = {
        prompt: visiblePrompt,
        generationTemplate: get(draft.generationTemplate$),
        editorDocument,
        taskSelection: {
          task:
            selectedTask === "suggestions" || selectedTask === "jobs"
              ? null
              : (selectedTask ?? mode),
          presentationSlideCount: get(create.presentationSlideCount$),
          visualization: get(taskChips.visualization.preferences$),
        },
      };
      if (!(await set(checkPaidToolForCreation$, mode, signal))) {
        return false;
      }
      signal.throwIfAborted();
      const workflowUse = await set(
        prepareRecentWorkflowUse$,
        visiblePrompt,
        workflowComposer.workflows$,
        signal,
      );
      const submitted = await set(
        options.submitMessage$,
        action,
        nextSubmission,
        signal,
      );
      if (submitted && workflowUse) {
        // Browser history must never turn an accepted send into a send error.
        await settle(() => {
          set(recordRecentWorkflowUse$, workflowUse, signal);
        }, signal);
      }
      return submitted;
    },
  );
}

function createComposerSubmissionSignals(
  options: CreateComposerSignalsOptions,
  eventSignals: ReturnType<typeof createComposerChatEventSignals>,
  workflowComposer: WorkflowComposerSignals,
  {
    voice,
    create,
    taskChips,
  }: {
    voice: ComposerVoiceInputSignals;
    create: ComposerCreateSignals;
    taskChips: ComposerTaskChipsSignals;
  },
) {
  const { state$: voiceState$, owner$ } = voice;
  const invocation$ = state<{
    readonly owner: ComposerVoiceInputOwner;
    readonly action: ComposerPrimaryAction;
  } | null>(null);
  const hasCurrentInvocation$ = computed((get) => {
    const invocation = get(invocation$);
    return invocation !== null && invocation.owner === get(owner$);
  });
  const primaryAction$ = createComposerPrimaryActionSignal({
    options,
    eventSignals,
    workflowComposer,
    voiceState$,
  });
  const submitCurrentInput$ = createSubmitCurrentInput({
    options,
    workflowComposer,
    voice,
    create,
    taskChips,
  });
  const activatePrimaryAction$ = command(
    async (
      { get, set },
      action: ComposerPrimaryAction,
      signal: AbortSignal,
    ): Promise<boolean> => {
      signal.throwIfAborted();
      const owner = get(owner$);
      if (owner) {
        set(invocation$, { owner, action });
      }
      if (action === "stop") {
        await set(options.cancelRun$, signal);
        return true;
      }
      // A member pressing the composer's own button asks for exactly what they
      // typed, so this send adds no context of its own.
      return await set(submitCurrentInput$, action, undefined, signal);
    },
  );

  return {
    hasCurrentInvocation$,
    primaryAction$,
    submitCurrentInput$,
    activatePrimaryAction$,
  };
}
