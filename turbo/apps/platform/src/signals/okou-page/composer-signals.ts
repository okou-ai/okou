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
  ImageAnnotation,
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
import { detach, onRef, Reason } from "../utils.ts";
import { rootSignal$ } from "../root-signal.ts";
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
import type { ChatRunModelSelection } from "../chat-page/chat-event-state.ts";
import type { ChatEventProjectionSignals } from "../chat-page/chat-event-projection-signals.ts";
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
  createTemplateRecommendationPreviewCommand,
  type ComposerUiSignalGroups,
} from "./chat-composer.ts";
import { buildComposerAdditionalInfo } from "./composer-additional-info.ts";
import { createPresentationFormatSetupSignals } from "./composer-presentation-format-setup.ts";
import type { ComposerTaskSelection } from "./composer-task-handoff.ts";
import type { ComposerProjectSignals } from "../projects/composer-project.ts";
import {
  createComposerConnectorCompletion,
  createComposerDraftActions,
  createComposerTemplateSelection,
} from "./composer-business-actions.ts";
import {
  createImageAnnotationSignals,
  type ImageAnnotationSignals,
} from "./image-annotation.ts";
import {
  openImageLightbox$,
  openVideoLightbox$,
  type AnnotationImage,
} from "./attachment-chips.ts";

type ComposerEditorSignals = Pick<
  WorkflowComposerSignals,
  | "editor"
  | "voiceChips$"
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
  "hasTemplateAttachment$" | "insertTemplate$"
>;

type ComposerModelUiSignals = ComposerUiSignalGroups["model"];
type ComposerTemplateUiSignals = ComposerUiSignalGroups["template"];

export interface ComposerSubmission {
  readonly prompt: string;
  readonly generationTemplate: GenerationTemplateRequest | undefined;
  readonly editorDocument: WorkflowComposerSubmissionSnapshot["editorDocument"];
  /** The task and retained parameters for the composer after this send. */
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

interface ComposerSubmissionSignals extends ReturnType<
  typeof createComposerPrimaryActionSignals
> {
  readonly sending$: Computed<Promise<boolean>>;
  readonly hasCurrentInvocation$: Computed<boolean>;
  readonly presentationFormatSetup: ReturnType<
    typeof createPresentationFormatSetupSignals
  >;
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
  readonly previewRecommendation$: ReturnType<
    typeof createTemplateRecommendationPreviewCommand
  >;
}

export interface ComposerSignals {
  readonly recommendedFollowupSource$: ChatEventProjectionSignals["recommendedFollowupSource$"];
  readonly setup$: Command<void, [AbortSignal]>;
  readonly paidToolHints$: Computed<readonly AvailablePaidToolId[]>;
  readonly create: ComposerCreateSignals;
  readonly addMenu: ComposerUiSignalGroups["addMenu"];
  readonly taskChips: ComposerTaskChipsSignals;
  readonly threadId?: string;
  /** Present on a new chat's page composer, which can start it in a Project. */
  readonly project?: ComposerProjectSignals;
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
  /** Previews draft media; images can also be marked up in the lightbox. */
  readonly openAttachmentPreview$: Command<
    void,
    [ChatAttachment, AnnotationImage, AbortSignal]
  >;
  /** Produces a draft image's annotated copy again after it failed. */
  readonly retryAnnotatedCopy$: Command<
    Promise<void>,
    [ChatAttachment, AbortSignal]
  >;
  readonly setLifecycleRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
}

interface CreateComposerSignalsOptions {
  readonly draft: {
    readonly signals: DraftSignals;
    readonly load$: ComposerDraftSignals["load$"];
    readonly save$: ComposerDraftSignals["save$"];
  };
  readonly eventSignals: Pick<
    ChatEventProjectionSignals,
    | "recommendedFollowupSource$"
    | "sending$"
    | "hasEvents$"
    | "queuedEvents$"
    | "runningModelSelection$"
  >;
  readonly threadId?: string;
  readonly project?: ComposerProjectSignals;
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
    voiceChips$: composer.voiceChips$,
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
    insertChatThread$: composer.insertChatThread$,
  };
}

function composerTemplateSignals(
  composer: WorkflowComposerSignals,
): ComposerTemplateEditorSignals {
  return {
    hasTemplateAttachment$: composer.hasTemplateAttachment$,
    insertTemplate$: composer.insertTemplate$,
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
    command(async ({ set }, fileId: string, signal: AbortSignal) => {
      await set(options.draft.load$, signal);
      signal.throwIfAborted();
      set(workflowComposer.insertVoiceClip$, fileId);
    }),
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
  const eventSignals = createComposerChatEventSignals(options.eventSignals);
  const draft = options.draft.signals;
  const ui = createComposerUiSignals();
  const workflowComposer = createWorkflowComposerSignals(
    draft,
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
    clearPrompt$: workflowComposer.clearUnchangedPrompt$,
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
    options.connector ?? createComposerConnectorSignals(options.threadId);
  const draftSignals = composerDraftSignals(options.draft, fileInput);
  const annotation = createComposerAttachmentAnnotation(draft, draftSignals);
  const connectorCompletion = createComposerConnectorCompletion(connector);
  return {
    threadId: options.threadId,
    recommendedFollowupSource$: options.eventSignals.recommendedFollowupSource$,
    /** Starts the composer's owner-scoped work under its owner's signal. */
    setup$: command(({ set }, signal: AbortSignal) => {
      set(voice.setup$, signal);
      set(submission.presentationFormatSetup.setup$, signal);
      set(connectorCompletion.registerConnectHost$, signal);
    }),
    ...composerRemoteAccessSignals(options, connector),
    paidToolHints$: createPaidToolHints(create, draft, workflowComposer),
    create,
    addMenu: ui.addMenu,
    taskChips,
    editor: composerEditorSignals(workflowComposer, options),
    voice,
    feedback: workflowComposer.feedback,
    workflow: composerWorkflowSignals(workflowComposer),
    suggestion: composerSuggestionSignals(workflowComposer),
    connector,
    connectorCompletion,
    draft: draftSignals,
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
        `${options.forwardComposer ? "forward" : "composer"}:${options.threadId ?? "new-chat"}`,
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
      previewRecommendation$: createTemplateRecommendationPreviewCommand(
        ui.template,
      ),
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
    ...annotation,
    setLifecycleRef$: createComposerLifecycleRef(
      taskChips,
      annotation.imageAnnotation,
      draft,
    ),
  };
}

/**
 * Own capability geometry and annotation uploads while this composer is mounted.
 * The annotation editor lives in this subtree; losing it must cancel uploads
 * rather than leave the restored draft permanently pending.
 *
 * The composer factory has no lifecycle signal, so its root is the narrowest
 * available owner until the factory can receive one.
 */
function createComposerLifecycleRef(
  taskChips: ComposerTaskChipsSignals,
  imageAnnotation: ImageAnnotationSignals,
  draft: DraftSignals,
) {
  return onRef<HTMLElement>(
    command(({ get, set }, element: HTMLElement, signal: AbortSignal) => {
      set(taskChips.home.layout.mount$, element, signal);
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
}

/**
 * Draft images are previewed in the shared lightbox and marked up in this
 * composer's editor. The marks are committed back to the attachment that is
 * still in the draft under the editor's key.
 */
function createComposerAttachmentAnnotation(
  draft: DraftSignals,
  actions: Pick<ComposerDraftSignals, "confirmAttachmentAnnotations$">,
) {
  const commitAttachmentAnnotations$ = command(
    async (
      { get, set },
      key: string,
      annotations: ImageAnnotation | null,
      signal: AbortSignal,
    ): Promise<void> => {
      const attachment = get(draft.attachments$).find((candidate) => {
        return candidate.key === key;
      });
      if (!attachment) {
        throw new Error("The annotated image is no longer attached");
      }
      await set(
        actions.confirmAttachmentAnnotations$,
        attachment,
        annotations,
        signal,
      );
    },
  );
  const imageAnnotation = createImageAnnotationSignals(
    commitAttachmentAnnotations$,
  );
  const annotateAttachment$ = command(
    ({ get, set }, attachment: ChatAttachment, image: AnnotationImage) => {
      set(imageAnnotation.openAnnotationEditor$, {
        key: attachment.key,
        filename: attachment.filename,
        url: image.url,
        ...(image.preview ? { preview: image.preview } : {}),
        annotations: get(attachment.annotations$),
      });
    },
  );
  const openAttachmentPreview$ = command(
    (
      { set },
      attachment: ChatAttachment,
      image: AnnotationImage,
      signal: AbortSignal,
    ) => {
      // A pending upload is not an artifact yet, so checking it must not take
      // over an open artifact sidebar. An attachment is the user's own input,
      // not a published artifact, so it carries no sharing controls.
      const input = {
        url: image.url,
        filename: attachment.filename,
        contentType: attachment.contentType,
        ...(image.preview ? { preview: image.preview } : {}),
        shareAvailable: false,
        splitViewAvailable: false,
      };
      if (attachment.contentType.startsWith("video/")) {
        set(openVideoLightbox$, input, signal);
        return;
      }
      set(
        openImageLightbox$,
        {
          ...input,
          annotationTarget: { attachment, annotate$: annotateAttachment$ },
        },
        signal,
      );
    },
  );
  /**
   * Produces the copy again for the marks already on the attachment. Attaching
   * no longer waits for the copy, so a failed one is retried from the chip
   * rather than by pressing "Attach marks" again in an editor still open.
   */
  const retryAnnotatedCopy$ = command(
    ({ get, set }, attachment: ChatAttachment, signal: AbortSignal) => {
      return set(
        actions.confirmAttachmentAnnotations$,
        attachment,
        get(attachment.annotations$),
        signal,
      );
    },
  );
  return { imageAnnotation, openAttachmentPreview$, retryAnnotatedCopy$ };
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

function createComposerChatEventSignals(
  events: CreateComposerSignalsOptions["eventSignals"],
) {
  const { hasEvents$, sending$, runningModelSelection$ } = events;
  // The thread owns queue selection and ordering; the composer formats labels.
  const pendingEvents$ = computed(
    (get): Promise<readonly ComposerPendingEvent[]> => {
      return Promise.resolve(
        get(events.queuedEvents$).map((event) => {
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
    sending$,
    runningModelSelection$,
    pendingEvents$,
    hasEvents$,
  };
}

// Reuse the same choices when a thread refresh leaves its actions unchanged.
function composerActionsForRun(
  submit: ComposerSubmissionAction,
  unavailable: "disabled" | "stop",
) {
  const blocked = {
    missingNote: unavailable,
    withoutInput: unavailable,
    withInput: unavailable,
  } as const;
  const withoutAttachments = { ...blocked, withInput: submit } as const;
  const withAttachments = {
    ...withoutAttachments,
    withoutInput: submit,
  } as const;
  return { blocked, withoutAttachments, withAttachments };
}

const idleActions = composerActionsForRun("send", "disabled");
const runningActions = composerActionsForRun("queue", "stop");

function createComposerPrimaryActionSignals(args: {
  readonly options: CreateComposerSignalsOptions;
  readonly eventSignals: ReturnType<typeof createComposerChatEventSignals>;
  readonly workflowComposer: WorkflowComposerSignals;
  readonly voiceState$: ComposerVoiceInputSignals["state$"];
}) {
  const { options, eventSignals, workflowComposer } = args;
  const draft = options.draft.signals;
  const inputState$ = computed((get) => {
    const needsSuggestionNote = get(workflowComposer.feedback.items$).some(
      (item) => {
        return item.suggestionContext && !item.note.trim();
      },
    );
    if (needsSuggestionNote) {
      return "missingNote";
    }
    return get(workflowComposer.hasInput$) ? "withInput" : "withoutInput";
  });

  // Resolve the actions before the next edit so the button and keyboard can
  // select one as soon as the editor changes between empty and nonempty.
  const runActions$ = computed(async (get) => {
    await get(eventSignals.hasEvents$);
    if ((await get(args.voiceState$)).status !== "idle") {
      return idleActions.blocked;
    }
    const uploadsReady = await get(draft.attachmentUploadsReady$);
    const attachments = await get(draft.usableAttachments$);
    const sending = await get(eventSignals.sending$);
    const actions = sending ? runningActions : idleActions;
    if (!uploadsReady) {
      return actions.blocked;
    }
    return attachments.length > 0
      ? actions.withAttachments
      : actions.withoutAttachments;
  });
  const actionsByInput$ = computed((get) => {
    // A chat can start in a just-created Project once the server has it.
    return options.project && get(options.project.pending$)
      ? idleActions.blocked
      : get(runActions$);
  });
  const primaryAction$ = computed(async (get) => {
    const actions = await get(actionsByInput$);
    return actions[get(inputState$)];
  });
  return { actionsByInput$, inputState$, primaryAction$ } as const;
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

function createReadComposerTaskSelection(
  create: ComposerCreateSignals,
  taskChips: ComposerTaskChipsSignals,
) {
  return command(({ get }): ComposerTaskSelection => {
    const task = get(taskChips.task$) ?? get(create.mode$);
    const source = taskChips.visualization;
    const visualizationSubmission =
      task === "visualization"
        ? { source, snapshot: { revision: get(source.revision$) } }
        : undefined;
    return {
      task,
      presentationSlideCount: get(create.presentationSlideCount$),
      visualization: get(source.preferences$),
      ...(visualizationSubmission ? { visualizationSubmission } : {}),
    };
  });
}

function createSubmitMessageWithVisualization(
  submitMessage$: CreateComposerSignalsOptions["submitMessage$"],
) {
  return command(
    async (
      { set },
      action: ComposerSubmissionAction,
      submission: ComposerSubmission,
      signal: AbortSignal,
    ): Promise<boolean> => {
      const visualization = submission.taskSelection.visualizationSubmission;
      if (!visualization) {
        return await set(submitMessage$, action, submission, signal);
      }
      set(visualization.source.trackSubmission$, visualization.snapshot);
      let submitted = false;
      {
        using _visualizationSubmission = {
          [Symbol.dispose]() {
            set(
              visualization.source.finishSubmission$,
              visualization.snapshot,
              submitted,
            );
          },
        };
        submitted = await set(submitMessage$, action, submission, signal);
      }
      return submitted;
    },
  );
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
  const readTaskSelection$ = createReadComposerTaskSelection(create, taskChips);
  const submitMessage$ = createSubmitMessageWithVisualization(
    options.submitMessage$,
  );
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
      const menuRevision = get(taskChips.home.menuRevision$);
      if (!(await get(draft.attachmentUploadsReady$))) {
        return false;
      }
      signal.throwIfAborted();
      const voiceState = await get(voice.state$);
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
      const taskSelection = set(readTaskSelection$);
      const visualization =
        taskSelection.task === "visualization"
          ? taskSelection.visualization
          : undefined;
      const composerAdditionalInfo = buildComposerAdditionalInfo(
        mode,
        get(create.presentationSlideCount$),
        visualization,
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
        taskSelection,
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
      const recencySignal = get(rootSignal$);
      const submitted = await set(
        submitMessage$,
        action,
        nextSubmission,
        signal,
      );
      if (submitted && workflowUse) {
        // The send is already accepted. Optional persistence belongs to the
        // authenticated root, not the composer that navigation may replace.
        detach(
          set(recordRecentWorkflowUse$, workflowUse, recencySignal),
          Reason.Daemon,
          "accepted send workflow recency",
        );
      }
      if (submitted) {
        await set(taskChips.home.dismissMenu$, menuRevision, signal);
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
  const primaryAction = createComposerPrimaryActionSignals({
    options,
    eventSignals,
    workflowComposer,
    voiceState$,
  });
  const submitInput$ = createSubmitCurrentInput({
    options,
    workflowComposer,
    voice,
    create,
    taskChips,
  });
  const knownPresentation$ = computed((get) => {
    const task = get(taskChips.task$);
    return (
      task === "presentation" ||
      (task === "visualization" &&
        get(taskChips.visualization.preferences$).output === "presentation")
    );
  });
  const presentationFormatSetup = createPresentationFormatSetupSignals({
    knownPresentation$,
    primaryAction$: primaryAction.primaryAction$,
    submitCurrentInput$: submitInput$,
  });
  const submitCurrentInput$ = presentationFormatSetup.submit$;
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
    ...primaryAction,
    presentationFormatSetup,
    submitCurrentInput$,
    activatePrimaryAction$,
  };
}
