import { stopAndTranscribe$ } from "../voice-io/voice-io-stt.ts";
import {
  createComposerTaskChipsSignals,
  type ComposerTaskChipsSignals,
} from "./composer-task-chips.ts";
import {
  createComposerVoiceInputSignals,
  type ComposerVoiceInputSignals,
} from "./composer-voice-input.ts";
import type {
  ChatRunVideoOptionsRequest,
  GenerationTemplateRequest,
  UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { VOICE_IO_POLISH_MAX_TEXT_CHARS } from "@okouai/api-contracts/contracts/voice-io-polish";
import { INTRO_VIDEO_TEMPLATE_ID } from "@okouai/core/intro-video-template";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { ImageModel } from "@okouai/core/image-model-catalog";
import type { VideoModel } from "@okouai/core/video-model-catalog";
import { command, computed, state, type Command, type Computed } from "ccstate";
import { onRef } from "../utils.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import type { ModelProviderSelection } from "../../views/okou-page/components/model-provider-picker.tsx";
import type { DraftSignals, ChatAttachment } from "./chat-draft.ts";
import { createComposerFeedbackModel } from "./chat-feedback.ts";
import type { ChatEvent } from "../chat-page/chat-event-types.ts";
import {
  deriveRunIndicatorStateFromChatEvents,
  groupSemanticChatEvents,
  isUsageEvent,
  lastAssistantCancelledFromGroups,
  queuedEventsFromSemanticEvents,
  runningModelSelectionFromChatEvents,
  semanticChatEventsFromChatEvents,
  type ChatRunModelSelection,
} from "../chat-page/chat-event-state.ts";
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
import { videoRunOptionsForSend } from "./video-run-options.ts";
import { buildComposerAdditionalInfo } from "./composer-additional-info.ts";
import {
  createImageAnnotationSignals,
  type ImageAnnotationSignals,
} from "./image-annotation.ts";
import {
  CREATE_WORKFLOW_WITH_CHAT_PROMPT,
  replaceWorkflowPromptDraftTarget$,
  setReplaceWorkflowPromptDraftTarget$,
} from "../chat-page/workflow-prompt-action.ts";

type ComposerEditorSignals = Pick<
  WorkflowComposerSignals,
  | "editor"
  | "setContainerRef$"
  | "focus$"
  | "hasInput$"
  | "insertPromptMarkdown$"
  | "insertUserMessage$"
  | "insertText$"
  | "appendText$"
  | "selectOrAppendText$"
> & {
  readonly singleLineOnMobile: boolean;
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
  | "closeSuggestionMenu$"
  | "insertAgent$"
  | "insertChatThread$"
>;

type ComposerTemplateEditorSignals = Pick<
  WorkflowComposerSignals,
  | "templatePreview"
  | "hasTemplateAttachment$"
  | "insertTemplate$"
  | "openTemplatePicker$"
>;

type ComposerModelUiSignals = ComposerUiSignalGroups["model"];
type ComposerVideoOptionsSignals = ComposerUiSignalGroups["videoOptions"];
type ComposerTemplateUiSignals = ComposerUiSignalGroups["template"];

export interface ComposerSubmission {
  readonly prompt: string;
  readonly generationTemplate: GenerationTemplateRequest | undefined;
  readonly editorDocument: WorkflowComposerSubmissionSnapshot["editorDocument"];
  /**
   * Video parameters for composers outside the Create rollout. Enabled
   * composers carry their settings in the message's additional_info part.
   */
  readonly videoRunOptions: ChatRunVideoOptionsRequest | undefined;
}

export type ComposerSubmissionAction = "send" | "queue";

export type ComposerPrimaryAction =
  | ComposerSubmissionAction
  | "stop"
  | "disabled";

export interface ComposerPendingEvent {
  readonly kind: "message" | "automation";
  readonly id: string;
  readonly text: string;
}

interface ComposerWorkflowSignals extends ComposerWorkflowEditorSignals {
  readonly createWorkflowPrompt$: Command<Promise<void>, [AbortSignal]>;
  readonly replaceWorkflowPromptOpen$: Computed<boolean>;
  readonly confirmReplaceWorkflowPrompt$: Command<Promise<void>, [AbortSignal]>;
  readonly setReplaceWorkflowPromptOpen$: Command<void, [boolean]>;
}

interface ComposerDraftSignals {
  readonly load$: Command<Promise<void>, [AbortSignal]>;
  readonly seed$: DraftSignals["seed$"];
  readonly setDraftInput$: Command<void, [string]>;
  readonly attachments$: Computed<ChatAttachment[]>;
  readonly attachmentUploadsReady$: Computed<boolean>;
  readonly uploadAttachment$: Command<Promise<void>, [File, AbortSignal]>;
  readonly restoreAttachments$: DraftSignals["restoreAttachments$"];
  readonly removeAttachment$: Command<void, [ChatAttachment]>;
  readonly dragOver$: Computed<boolean>;
  readonly setDragOver$: Command<void, [boolean]>;
  readonly composerFileInput$: Computed<HTMLElement | null>;
  readonly setComposerFileInput$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  readonly save$: Command<Promise<void>, [AbortSignal]>;
}

interface ComposerModelSignals extends ComposerModelUiSignals {
  readonly temporaryModelNoticeEnabled$: Computed<boolean>;
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

/** Video model selected for the composer, when that surface supports it. */
export interface ComposerVideoModelSignals {
  readonly selectedVideoModel$: Computed<
    VideoModel | null | Promise<VideoModel | null>
  >;
  /**
   * The model a video run started from this composer would actually use, with
   * the thread pin, the member default and the system default already folded
   * in. `selectedVideoModel$` is the pin alone, which is null far more often
   * than the run is unconfigured, so it cannot answer "which values does the
   * parameter panel offer".
   */
  readonly effectiveVideoModel$: Computed<VideoModel | Promise<VideoModel>>;
  readonly setVideoModel$: Command<
    Promise<void>,
    [VideoModel | null, AbortSignal]
  >;
}

/** Image model selected for a composer that supports image generation. */
export interface ComposerImageModelSignals {
  readonly selectedImageModel$: Computed<
    ImageModel | null | Promise<ImageModel | null>
  >;
  readonly effectiveImageModel$: Computed<ImageModel | Promise<ImageModel>>;
  readonly setImageModel$: Command<
    Promise<void>,
    [ImageModel | null, AbortSignal]
  >;
}

interface ComposerComputerSignals {
  readonly computerUseHostId$: Computed<string | null>;
  readonly cloudBrowserEnabled$: Computed<boolean | Promise<boolean>>;
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
  readonly submitCurrentInput$: Command<
    Promise<boolean>,
    [ComposerPrimaryAction, AbortSignal]
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
}

export interface ComposerSignals {
  readonly create: ComposerCreateSignals;
  readonly taskChips: ComposerTaskChipsSignals;
  readonly agentId: string;
  readonly editor: ComposerEditorSignals;
  readonly voice: ComposerVoiceInputSignals;
  readonly feedback: WorkflowComposerSignals["feedback"];
  readonly workflow: ComposerWorkflowSignals;
  readonly suggestion: ComposerSuggestionSignals;
  readonly connector: ComposerConnectorSignals;
  readonly draft: ComposerDraftSignals;
  readonly model: ComposerModelSignals;
  readonly imageModel?: ComposerImageModelSignals;
  readonly videoModel?: ComposerVideoModelSignals;
  readonly videoOptions: ComposerVideoOptionsSignals;
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
  readonly voiceDraftTarget: string;
  readonly connector?: ComposerConnectorSignals;
  readonly singleLineOnMobile: boolean;
  readonly modelSelection$: ComposerModelSignals["modelSelection$"];
  readonly selectedModelOauthAvailable$: ComposerModelSignals["selectedModelOauthAvailable$"];
  readonly setModelSelection$: ComposerModelSignals["setModelSelection$"];
  readonly configureSelectedModel$: ComposerModelSignals["configureSelectedModel$"];
  readonly imageModel?: ComposerImageModelSignals;
  readonly videoModel?: ComposerVideoModelSignals;
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

function createComposerFileInputSignals() {
  const internal$ = state<HTMLElement | null>(null);
  const composerFileInput$ = computed((get) => {
    return get(internal$);
  });
  const setComposerFileInput$ = onRef(
    command(({ set }, element: HTMLElement, signal: AbortSignal) => {
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
  singleLineOnMobile: boolean,
): ComposerEditorSignals {
  return {
    singleLineOnMobile,
    editor: composer.editor,
    setContainerRef$: composer.setContainerRef$,
    focus$: composer.focus$,
    hasInput$: composer.hasInput$,
    insertPromptMarkdown$: composer.insertPromptMarkdown$,
    insertUserMessage$: composer.insertUserMessage$,
    insertText$: composer.insertText$,
    appendText$: composer.appendText$,
    selectOrAppendText$: composer.selectOrAppendText$,
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
  return {
    activeSlashRange$: composer.activeSlashRange$,
    activeChatThreadSuggestionRange$: composer.activeChatThreadSuggestionRange$,
    chatThreadSuggestions$: composer.chatThreadSuggestions$,
    selectedSuggestionIndex$: composer.selectedSuggestionIndex$,
    setSelectedSuggestionIndex$: composer.setSelectedSuggestionIndex$,
    closeSuggestionMenu$: composer.closeSuggestionMenu$,
    insertAgent$: composer.insertAgent$,
    insertChatThread$: composer.insertChatThread$,
  };
}

function composerTemplateSignals(
  composer: WorkflowComposerSignals,
): ComposerTemplateEditorSignals {
  return {
    templatePreview: composer.templatePreview,
    hasTemplateAttachment$: composer.hasTemplateAttachment$,
    insertTemplate$: composer.insertTemplate$,
    openTemplatePicker$: composer.openTemplatePicker$,
  };
}

function createComputerUseUiSignals(): Pick<
  ComposerComputerSignals,
  "computerUseDownloadDialogOpen$" | "setComputerUseDownloadDialogOpen$"
> {
  const internalDownloadDialogOpen$ = state(false);
  const computerUseDownloadDialogOpen$ = computed((get): boolean => {
    return get(internalDownloadDialogOpen$);
  });
  const setComputerUseDownloadDialogOpen$ = command(
    ({ set }, open: boolean): void => {
      set(internalDownloadDialogOpen$, open);
    },
  );
  return {
    computerUseDownloadDialogOpen$,
    setComputerUseDownloadDialogOpen$,
  };
}

function createComposerWorkflowPromptSignals(
  options: CreateComposerSignalsOptions,
  workflowComposer: WorkflowComposerSignals,
): Pick<
  ComposerWorkflowSignals,
  | "createWorkflowPrompt$"
  | "replaceWorkflowPromptOpen$"
  | "confirmReplaceWorkflowPrompt$"
  | "setReplaceWorkflowPromptOpen$"
> {
  const draft = options.draft.signals;
  const draftTarget = `composer:${options.threadId ?? "new-thread"}`;
  const replaceWorkflowPromptOpen$ = computed((get): boolean => {
    return get(replaceWorkflowPromptDraftTarget$) === draftTarget;
  });
  const applyWorkflowPrompt$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      if (options.threadId !== undefined) {
        set(draft.clear$);
      }
      set(draft.setInput$, CREATE_WORKFLOW_WITH_CHAT_PROMPT);
      await set(options.draft.save$, signal);
      if (options.threadId !== undefined) {
        set(workflowComposer.focus$);
      }
    },
  );
  const createWorkflowPrompt$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const hasDraft =
        set(draft.readInput$).trim().length > 0 ||
        (options.threadId !== undefined && get(draft.attachments$).length > 0);
      if (hasDraft) {
        set(setReplaceWorkflowPromptDraftTarget$, draftTarget);
        return;
      }
      await set(applyWorkflowPrompt$, signal);
    },
  );
  const confirmReplaceWorkflowPrompt$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      set(setReplaceWorkflowPromptDraftTarget$, null);
      await set(applyWorkflowPrompt$, signal);
    },
  );
  const setReplaceWorkflowPromptOpen$ = command(
    ({ set }, open: boolean): void => {
      set(setReplaceWorkflowPromptDraftTarget$, open ? draftTarget : null);
    },
  );
  return {
    createWorkflowPrompt$,
    replaceWorkflowPromptOpen$,
    confirmReplaceWorkflowPrompt$,
    setReplaceWorkflowPromptOpen$,
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

function createTemporaryModelNoticeEnabled(
  options: CreateComposerSignalsOptions,
): Computed<boolean> {
  return computed((get): boolean => {
    return (
      options.threadId === undefined &&
      (get(featureSwitch$)[FeatureSwitchKey.ChatPreference] ?? false)
    );
  });
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
  lastAssistantMessage$: Computed<string | undefined>,
) {
  const deliverText$ = command(
    async ({ set }, text: string, signal: AbortSignal) => {
      await set(options.draft.load$, signal);
      signal.throwIfAborted();
      set(workflowComposer.insertText$, text);
    },
  );
  return createComposerVoiceInputSignals(
    workflowComposer.appendText$,
    deliverText$,
    workflowComposer.readVoiceContext$,
    lastAssistantMessage$,
    options.voiceDraftTarget,
  );
}

export function createComposerSignals(
  options: CreateComposerSignalsOptions,
): ComposerSignals {
  const eventSignals = createComposerChatEventSignals(options.chatEvents$);
  const draft = options.draft.signals;
  const agentId$ = computed((): string => {
    return options.agentId;
  });
  const feedback = createComposerFeedbackModel();
  const temporaryModelNoticeEnabled$ =
    createTemporaryModelNoticeEnabled(options);
  const ui = createComposerUiSignals();
  const workflowComposer = createWorkflowComposerSignals(
    draft,
    ui.openTemplatePickerDialog$,
    agentId$,
    {
      autoFocus: true,
    },
    feedback,
  );
  const create = createComposerCreateSignals(workflowComposer, ui, {
    image: options.imageModel !== undefined,
    video: options.videoModel !== undefined,
  });
  const taskChips = createComposerTaskChipsSignals(create, {
    insertTemplate$: workflowComposer.insertTemplate$,
    insertPrompt$: workflowComposer.selectOrAppendText$,
    openTemplatePicker$: workflowComposer.openTemplatePicker$,
    focusEditor$: workflowComposer.focus$,
    saveDraft$: options.draft.save$,
  });
  const voice = createComposerVoiceInput(
    options,
    workflowComposer,
    eventSignals.lastAssistantMessage$,
  );
  const submission = createComposerSubmissionSignals(
    options,
    eventSignals,
    workflowComposer,
    ui.videoOptions,
    { voice, create, taskChips },
  );
  const fileInput = createComposerFileInputSignals();
  const workflowPrompt = createComposerWorkflowPromptSignals(
    options,
    workflowComposer,
  );
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
    create,
    taskChips,
    editor: composerEditorSignals(workflowComposer, options.singleLineOnMobile),
    voice,
    feedback: workflowComposer.feedback,
    workflow: {
      ...composerWorkflowSignals(workflowComposer),
      ...workflowPrompt,
    },
    suggestion: composerSuggestionSignals(workflowComposer),
    connector:
      options.connector ??
      createComposerConnectorSignals(options.agentId, options.threadId),
    draft: composerDraftSignals(options.draft, fileInput),
    model: {
      ...ui.model,
      temporaryModelNoticeEnabled$,
      modelSelection$: options.modelSelection$,
      runningModelSelection$: eventSignals.runningModelSelection$,
      selectedModelOauthAvailable$: options.selectedModelOauthAvailable$,
      setModelSelection$: options.setModelSelection$,
      configureSelectedModel$: options.configureSelectedModel$,
    },
    ...(options.imageModel ? { imageModel: options.imageModel } : {}),
    ...(options.videoModel ? { videoModel: options.videoModel } : {}),
    videoOptions: ui.videoOptions,
    computer: {
      ...createComputerUseUiSignals(),
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
  const lastAssistantMessage$ = computed((get): string | undefined => {
    const events = get(chatEvents$);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.eventType !== "output.message") {
        continue;
      }
      const content = event.content.trim();
      if (content.length > 0) {
        return content.slice(-VOICE_IO_POLISH_MAX_TEXT_CHARS);
      }
    }
    return undefined;
  });
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
    lastAssistantMessage$,
    actionsLoading$,
    sending$,
    runningModelSelection$,
    pendingEvents$,
    hasEvents$,
  };
}

/**
 * Resolved at send rather than held settled, so the parameters follow a video
 * model the user changed after setting them. Nothing is sent when the run
 * would use that model's defaults anyway.
 */
function createVideoRunOptionsSignal(
  videoModel: ComposerVideoModelSignals | undefined,
  videoOptions: ComposerVideoOptionsSignals,
): Command<Promise<ChatRunVideoOptionsRequest | undefined>, [AbortSignal]> {
  return command(async ({ get }, signal: AbortSignal) => {
    if (!videoModel) {
      return undefined;
    }
    const patch = get(videoOptions.videoRunOptions$);
    if (Object.keys(patch).length === 0) {
      return undefined;
    }
    const model = await get(videoModel.effectiveVideoModel$);
    signal.throwIfAborted();
    return videoRunOptionsForSend(patch, model);
  });
}

function createComposerPrimaryActionSignal(args: {
  readonly options: CreateComposerSignalsOptions;
  readonly eventSignals: ReturnType<typeof createComposerChatEventSignals>;
  readonly workflowComposer: WorkflowComposerSignals;
  readonly voiceState$: ComposerVoiceInputSignals["state$"];
  readonly createPickerOpen$: ComposerCreateSignals["pickerOpen$"];
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

    const uploadsReady = get(draft.attachmentUploadsReady$);
    const attachments = get(draft.attachments$);
    const hasContent =
      get(workflowComposer.hasInput$) || attachments.length > 0;
    const canSend = !get(args.createPickerOpen$) && uploadsReady && hasContent;
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

function createSubmitCurrentInput({
  options,
  workflowComposer,
  videoOptions,
  voice,
  create,
  taskChips,
}: {
  readonly options: CreateComposerSignalsOptions;
  readonly workflowComposer: WorkflowComposerSignals;
  readonly videoOptions: ComposerVideoOptionsSignals;
  readonly voice: ComposerVoiceInputSignals;
  readonly create: ComposerCreateSignals;
  readonly taskChips: ComposerTaskChipsSignals;
}) {
  const draft = options.draft.signals;
  const voiceState$ = voice.state$;
  const readVideoRunOptions$ = createVideoRunOptionsSignal(
    options.videoModel,
    videoOptions,
  );
  return command(
    async (
      { get, set },
      action: ComposerPrimaryAction,
      signal: AbortSignal,
    ): Promise<boolean> => {
      signal.throwIfAborted();
      if (action !== "send" && action !== "queue") {
        return false;
      }
      await set(stopAndTranscribe$, signal);
      signal.throwIfAborted();
      if (!get(draft.attachmentUploadsReady$)) {
        return false;
      }
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
      if (get(featureSwitch$)[FeatureSwitchKey.IntroVideo] !== true) {
        const message = submission.editorDocument.toMessageDocument({
          selectedTemplate: get(draft.generationTemplate$),
        });
        if (
          message?.parts.some((part) => {
            return (
              part.type === "template" &&
              part.template.type === "video" &&
              part.template.selection.stylePresetId === INTRO_VIDEO_TEMPLATE_ID
            );
          })
        ) {
          toast.error(
            i18n.t(($) => {
              return $.artifacts.templates.introVideoUnavailable;
            }),
          );
          return false;
        }
      }
      const visiblePrompt = submission.prompt.trim();
      if (visiblePrompt.length === 0 && get(draft.attachments$).length === 0) {
        return false;
      }
      if (!get(draft.attachmentUploadsReady$)) {
        return false;
      }
      const mode = get(create.mode$);
      const videoRunOptions =
        mode !== null && mode !== "video"
          ? undefined
          : await set(readVideoRunOptions$, signal);
      signal.throwIfAborted();
      // Keep the new persisted part within the existing Create rollout.
      const additionalInfo = get(create.enabled$)
        ? buildComposerAdditionalInfo(
            mode,
            videoRunOptions,
            get(create.presentationSlideCount$),
            get(taskChips.task$) === "visualization"
              ? get(taskChips.visualization.preferences$)
              : undefined,
          )
        : undefined;
      const editorDocument = additionalInfo
        ? createEditorDocumentSnapshot(
            workflowComposer.editor.schema.nodeFromJSON(
              submission.editorDocument.toEditorDocument(),
            ),
            additionalInfo,
          )
        : submission.editorDocument;
      return await set(
        options.submitMessage$,
        action,
        {
          prompt: visiblePrompt,
          generationTemplate: get(draft.generationTemplate$),
          editorDocument,
          videoRunOptions: additionalInfo ? undefined : videoRunOptions,
        },
        signal,
      );
    },
  );
}

function createComposerSubmissionSignals(
  options: CreateComposerSignalsOptions,
  eventSignals: ReturnType<typeof createComposerChatEventSignals>,
  workflowComposer: WorkflowComposerSignals,
  videoOptions: ComposerVideoOptionsSignals,
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
    readonly owner: AbortController;
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
    createPickerOpen$: create.pickerOpen$,
  });
  const submitCurrentInput$ = createSubmitCurrentInput({
    options,
    workflowComposer,
    videoOptions,
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
      return await set(submitCurrentInput$, action, signal);
    },
  );

  return {
    hasCurrentInvocation$,
    primaryAction$,
    submitCurrentInput$,
    activatePrimaryAction$,
  };
}
