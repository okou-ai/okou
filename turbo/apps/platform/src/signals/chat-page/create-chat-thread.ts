import { artifactCatalogRevision$ } from "../artifact-deletion.ts";
import { readSuggestionContext } from "@okouai/api-contracts/contracts/suggestion-context";
import {
  isAutoSelectedModel,
  sameSelectedModel,
} from "@okouai/core/auto-run-model";
import {
  chatEventCompatibilityRole,
  isChatEventContentTextType,
  isChatInputEventType,
  isChatRunTerminalEventType,
  revokedChatEventIds,
} from "@okouai/api-contracts/contracts/chat-events";
import { chatThreadArtifactsContract } from "@okouai/api-contracts/client/chat-threads";
import { resolveChatEventRecommendedFollowups } from "@okouai/api-contracts/validators/chat-threads";
import type {
  ChatRunOptionsRequest,
  ChatThreadArtifactRun,
  ChatThreadDraft,
  FeedbackNotePart,
  GenerationTemplateRequest,
  ChatEvent as PersistedChatEvent,
  ResolvedAttachFile,
  UserMessageDocument,
  UserMessageInputDocument,
  UserMessagePart,
} from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { i18n } from "../../i18n/index.ts";
import { createChatResourceSignals } from "./chat-resources.ts";
import { createThreadMailSignals } from "./thread-mail.ts";
import { createArtifactCatalogSignals } from "../artifacts-page/create-artifact-catalog-signals.ts";
import { createChatRelationSignals } from "./chat-relations.ts";
import {
  createDraftSignals,
  createRestoredAttachment,
  type DraftSignals,
} from "../okou-page/chat-draft.ts";
import { buildDraftPersistencePayload } from "../okou-page/draft-persistence.ts";
import { resetSignal, settle } from "../utils.ts";
import type {
  ChatEvent,
  OptimisticChatEvent,
  OptimisticUserMessageAssociation,
} from "./chat-event-types.ts";
import { createChatComposerLayoutOnRef } from "./chat-layout.ts";
import { createChatRunUsageSignals } from "./chat-run-usage.ts";
import { createThreadDraftLoad } from "./chat-thread-draft.ts";
import {
  createChatThreadScrollSignals,
  createThreadScrollPositionSignals,
  type ChatThreadScrollSignals,
  type ReadyScrollAfterRenderRequest,
  type ScrollAfterRenderRequest,
  type ThreadScrollPosition,
} from "./chat-thread-scroll.ts";
import { createHeaderAutomationSignals } from "./header-automation-menu.ts";
import {
  collectSuccessfulAttachmentInfos,
  prepareUserMessageFromDraft$,
} from "./resolve-draft-attachments.ts";
import { createSessionOutputStreamSignals } from "./session-output-stream.ts";
import { createThreadSidebarSignals } from "./thread-sidebar.ts";

import {
  isInterruptControlEvent,
  isInterruptedAssistantCancellation,
  isUsageEvent,
  type SemanticChatGroups as GenericSemanticChatGroups,
  type SemanticChatEventState,
} from "@okouai/api-contracts/contracts/chat-event-semantics";
import type { Root } from "hast";
import { accept } from "../../lib/accept.ts";
import {
  markdownCardKey,
  parseMarkdownTree,
} from "../../lib/markdown/pipeline.ts";
import { createPlainMarkdownTree } from "../../lib/markdown/plain-markdown.ts";
import type { ModelProviderSelection } from "../../views/okou-page/components/model-provider-picker.tsx";
import { apiClient$ } from "../api-client.ts";
import { debounceCommand } from "../command-scheduling.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { modelCatalog$ } from "../external/model-catalog.ts";
import { availableRunModels$ } from "../external/run-models.ts";
import {
  createImageLoadRegistry,
  embedImageLoadSignals,
  type ImageLoadRegistry,
} from "../image-load.ts";
import { locale$ } from "../locale.ts";
import { logger } from "../log.ts";
import {
  createMermaidDiagramRegistry,
  embedMermaidSignals,
  type MermaidDiagramRegistry,
} from "../mermaid-diagram.ts";
import { openDiagramLightbox$ } from "../okou-page/attachment-chips.ts";
import {
  writeChatMessageToClipboard,
  type ChatClipboardPayload,
} from "../okou-page/clipboard.ts";
import {
  createComposerSignals,
  type ComposerSignals,
  type ComposerSubmission,
} from "../okou-page/composer-signals.ts";
import {
  createComposerConnectorSignals,
  type ComposerConnectorSignals,
} from "../okou-page/connectors.ts";
import { isCodexFastModeAvailableForSelection } from "../okou-page/model-default-selection.ts";
import { createPersonalModelProviderAuthSignals } from "../okou-page/personal-model-provider-auth.ts";
import { reloadMountedComposerWorkflows$ } from "../okou-page/tiptap-workflow-composer.ts";
import { createBrowserPresenceSignals } from "./browser-presence.ts";
import {
  messageDocumentToPrompt,
  textToMessageDocument,
} from "../okou-page/user-message-document-codec.ts";
import {
  createAgentReferenceSignalsRegistry,
  type AgentReferenceSignalsRegistry,
} from "./agent-reference-signals.ts";
import {
  createArtifactCardSignalsRegistry,
  type ArtifactCardSignalsRegistry,
} from "./artifact-card-signals.ts";
import { createAssistantErrorRecoverySignals } from "./assistant-error-recovery.ts";
import { createBankingCardSignalsRegistry } from "./banking-action-block.ts";
import { createBrowserSessionSignals } from "./browser-session-block.ts";
import { createBrowserUserActionCardSignalsRegistry } from "./browser-user-action-block.ts";
import type { ChatActionContext } from "./chat-action-context.ts";
import { createChatConversationLocatorSignals } from "./chat-conversation-locator.ts";
import {
  chatEventTreeContent,
  chatEventTreePlan,
  isTransientOutputMessage,
} from "./chat-event-body-blocks.ts";
import {
  registerChatEventChangeHandler$,
  type ChatEventChangeHandler,
} from "./chat-event-change-registry.ts";
import { replyTurnKey } from "./chat-event-group-keys.ts";
import {
  createChatEventSignals,
  type ChatEventSignals,
  type SendChatEventInput,
  type SendInputChatEvent,
} from "./chat-event-signals.ts";
import type { RunIndicatorState } from "./chat-event-state.ts";
import type {
  ChatEventGroup,
  EnrichedChatEvent,
  UserMessageFeedbackNoteRenderPart,
  UserMessageRenderDocument,
  UserMessageRenderPart,
} from "./chat-event.ts";
import type { ChatForwardContext } from "./chat-forward.ts";
import type {
  ChatPanelSignals,
  EventImageGroupProjection,
  MessageListSignals,
  QueueMessageOptions,
  RecommendedFollowupSource,
  SendMessageOptions,
  ThinkingIndicators,
} from "./chat-panel-signals.ts";
import { isCancelledRunEvent } from "./chat-run-lifecycle.ts";
import { createChatThreadContainerSignals } from "./chat-thread-container.ts";
import {
  optimisticChatThreadCreateUnsettled,
  threadMeta,
  type ThreadMeta,
} from "./chat-thread-event-sourcing.ts";
import { createChatThreadFeedbackSignals } from "./chat-thread-feedback.ts";
import { markChatThreadRead$ } from "./chat-thread-mark-read.ts";
import { createChatThreadPinSignals } from "./chat-thread-pin.ts";
import {
  createCancellationRecoverySignals,
  createRemoteChatThreadDraft,
  patchChatThreadComputerUseHost$,
  patchChatThreadDraft$,
  patchChatThreadModelSelection$,
  subscribeChatThreadRealtime$,
} from "./chat-thread-remote-signals.ts";
import { createChatThreadSharingSignals } from "./chat-thread-sharing.ts";
import { getChatThreadTitleParts } from "./chat-thread-title.ts";
import { compareCreatedAt } from "./compare-created-at.ts";
import { createComputerUseAuthorizationCardSignalsRegistry } from "./computer-use-authorization-block.ts";
import { createBrowserAuthorizationCardSignalsRegistry } from "./browser-authorization-block.ts";
import { createDesktopShellAuthorizationCardSignalsRegistry } from "./desktop-shell-authorization-block.ts";
import { createConnectorAccountActionCardSignalsRegistry } from "./connector-account-action-block.ts";
import { createConnectorCardSignalsRegistry } from "./connector-action-block.ts";
import { createWalletCardSignalsRegistry } from "./wallet-action-block.ts";
import {
  createMailDraftCardSignalsRegistry,
  type MailDraftCardSignalsRegistry,
} from "./mail-draft.ts";
import { embedMarkdownArtifacts$ } from "./markdown-artifacts.ts";
import type { MarkdownCardRef } from "./markdown-card-ref.ts";
import { embedMarkdownMailDrafts$ } from "./markdown-mail-drafts.ts";
import { runOptionsFromModelProviderSelection } from "./model-selection-request.ts";
import {
  cardSlotUrl,
  classifyChatAttachment,
  type CardDescriptorBlock,
} from "./parse-body-blocks.ts";
import { createPermissionCardSignalsRegistry } from "./permission-card-signals.ts";
import { createPermissionBatchCardSignalsRegistry } from "./permission-batch-signals.ts";
import { createSubscriptionResetCardSignalsRegistry } from "./subscription-reset-block.ts";
import {
  createFirstTaskUpgradeEligibility,
  createPlanUpgradeCardSignalsRegistry,
} from "./plan-upgrade-block.ts";
import { serverUnreadAt$ } from "./sidebar-unread-threads.ts";
import {
  createThreadActivitySummarySignals,
  type ThinkingSummaries,
} from "./thread-activity-summary.ts";
import { unreadThroughAt } from "./unread-through-at.ts";
import {
  canonicalUserMessageFileUrl,
  userMessageFileAttachments,
} from "./user-message-files.ts";

const L = logger("ChatThread");

const noOpComposerDraftAction$ = command(
  (_context, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    return Promise.resolve();
  },
);

function isInputChatEvent(
  event: ChatEvent,
): event is Extract<
  ChatEvent,
  { eventType: "input.prompt" | "input.rejected" }
> {
  return (
    event.eventType === "input.prompt" || event.eventType === "input.rejected"
  );
}

// ---------------------------------------------------------------------------
// Thinking-indicator constants and helpers
// ---------------------------------------------------------------------------

const DONE_PHRASE_COUNT = 8;

function formatDonePhrase(lastEvent: ChatEvent | undefined): string {
  const time = lastEvent
    ? new Date(lastEvent.createdAt).toLocaleString(i18n.resolvedLanguage, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : i18n.t(($) => {
        return $.chat.run.justNow;
      });
  const phraseIndex = lastEvent?.id
    ? lastEvent.id.charCodeAt(lastEvent.id.length - 1) % DONE_PHRASE_COUNT
    : 0;
  switch (phraseIndex) {
    case 0: {
      return i18n.t(
        ($) => {
          return $.chat.run.done.wrappedUp;
        },
        { time },
      );
    }
    case 1: {
      return i18n.t(
        ($) => {
          return $.chat.run.done.allDone;
        },
        { time },
      );
    }
    case 2: {
      return i18n.t(
        ($) => {
          return $.chat.run.done.delivered;
        },
        { time },
      );
    }
    case 3: {
      return i18n.t(
        ($) => {
          return $.chat.run.done.finished;
        },
        { time },
      );
    }
    case 4: {
      return i18n.t(
        ($) => {
          return $.chat.run.done.wrap;
        },
        { time },
      );
    }
    case 5: {
      return i18n.t(
        ($) => {
          return $.chat.run.done.missionComplete;
        },
        { time },
      );
    }
    case 6: {
      return i18n.t(
        ($) => {
          return $.chat.run.done.signedOff;
        },
        { time },
      );
    }
    default: {
      return i18n.t(
        ($) => {
          return $.chat.run.done.doneAndDusted;
        },
        { time },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Sub-factory: remote thread draft fetching
// ---------------------------------------------------------------------------

function createThreadMeta(threadId: string) {
  return threadMeta(threadId);
}

function createThreadMetadata(threadMeta$: Computed<ThreadMeta | null>) {
  const threadExists$ = computed((get) => {
    return get(threadMeta$) !== null;
  });
  const threadAgentId$ = computed((get) => {
    return get(threadMeta$)?.agentId ?? null;
  });
  const threadTitle$ = computed((get): string | null => {
    return get(threadMeta$)?.title ?? null;
  });
  const threadTitleParts$ = computed((get) => {
    return getChatThreadTitleParts(get(threadTitle$));
  });
  const threadTitleEmoji$ = computed((get) => {
    return get(threadTitleParts$).emoji;
  });
  const threadTitleText$ = computed((get) => {
    return get(threadTitleParts$).text;
  });
  return {
    threadExists$,
    threadAgentId$,
    threadTitle$,
    threadTitleEmoji$,
    threadTitleText$,
  };
}

// ---------------------------------------------------------------------------
// Sub-factory: composer model override
// ---------------------------------------------------------------------------

function createModelSelection(
  threadId: string,
  threadMeta$: Computed<ThreadMeta | null>,
) {
  const selectedModel$ = computed((get): string | null => {
    const threadMeta = get(threadMeta$);
    return threadMeta?.selectedModel ?? null;
  });

  const setModelSelection$ = command(
    async (
      { set },
      value: ModelProviderSelection | null,
      signal: AbortSignal,
    ) => {
      await set(
        patchChatThreadModelSelection$,
        { threadId, modelSelection: value },
        signal,
      );
      signal.throwIfAborted();
    },
  );

  const modelSettings$ = computed((get) => {
    return get(threadMeta$)?.modelSettings ?? {};
  });

  /**
   * The selection the composer shows and sends. A pin of a retired model runs
   * as its catalog replacement; a pin without an offered route runs as Auto
   * (null).
   */
  const effectiveSelectedModel$ = computed(
    async (get): Promise<string | null> => {
      const [models, catalog] = await Promise.all([
        get(availableRunModels$),
        get(modelCatalog$),
      ]);
      const storedModel = get(selectedModel$);
      if (storedModel === null || isAutoSelectedModel(storedModel)) {
        return null;
      }
      const resolvedModel = catalog.resolve(storedModel);
      return resolvedModel !== undefined &&
        models.models.some((runModel) => {
          return runModel.model === resolvedModel;
        })
        ? resolvedModel
        : null;
    },
  );

  const codexFastModeActive$ = computed(async (get): Promise<boolean> => {
    const [models, selectedModel] = await Promise.all([
      get(availableRunModels$),
      get(effectiveSelectedModel$),
    ]);
    if (
      !isCodexFastModeAvailableForSelection({
        models,
        selectedModel,
      })
    ) {
      return false;
    }
    return get(threadMeta$)?.serviceTier === "priority";
  });

  const {
    oauthAvailable$: selectedModelOauthAvailable$,
    configure$: configureSelectedModel$,
  } = createPersonalModelProviderAuthSignals(effectiveSelectedModel$);

  return {
    selectedModel$,
    effectiveSelectedModel$,
    codexFastModeActive$,
    modelSettings$,
    selectedModelOauthAvailable$,
    configureSelectedModel$,
    setModelSelection$,
  };
}

interface ModelSelectionForSend {
  readonly selection: ModelProviderSelection;
}

function createModelSelectionForSend({
  selectedModel$,
  effectiveSelectedModel$,
  codexFastModeActive$,
  setModelSelection$,
}: {
  selectedModel$: Computed<string | null>;
  effectiveSelectedModel$: Computed<Promise<string | null>>;
  codexFastModeActive$: Computed<Promise<boolean>>;
  setModelSelection$: Command<
    Promise<void>,
    [ModelProviderSelection | null, AbortSignal]
  >;
}) {
  return command(
    async (
      { get, set },
      signal: AbortSignal,
    ): Promise<ModelSelectionForSend> => {
      const [selectedModel, codexFastModeActive] = await Promise.all([
        get(effectiveSelectedModel$),
        get(codexFastModeActive$),
      ]);
      signal.throwIfAborted();
      // A pin without an offered route is shown as Auto. Switch the thread to
      // Auto the way the picker does, so the send runs what the composer shows
      // without changing the member's default model.
      if (
        selectedModel === null &&
        !sameSelectedModel(selectedModel, get(selectedModel$))
      ) {
        await set(setModelSelection$, { selectedModel: null }, signal);
        signal.throwIfAborted();
      }
      return {
        selection: codexFastModeActive
          ? { selectedModel, codexServiceTier: "fast" }
          : { selectedModel },
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Sub-factory: composer Computer Use host selection
// ---------------------------------------------------------------------------

function createComputerUseHostSelection(
  threadId: string,
  threadMeta$: Computed<ThreadMeta | null>,
) {
  const optimisticCreateUnsettled$ =
    optimisticChatThreadCreateUnsettled(threadId);
  const internalUserOverride$ = state<
    | { kind: "unset" }
    | {
        kind: "set";
        computerUseHostId: string | null;
        cloudBrowserEnabled: boolean;
      }
  >({ kind: "unset" });

  const computerUseHostId$ = computed((get): string | null => {
    const user = get(internalUserOverride$);
    if (user.kind === "set") {
      return user.computerUseHostId;
    }
    return get(threadMeta$)?.computerUseHostId ?? null;
  });

  const cloudBrowserEnabled$ = computed((get): boolean => {
    const user = get(internalUserOverride$);
    if (user.kind === "set") {
      return user.cloudBrowserEnabled;
    }
    return get(threadMeta$)?.cloudBrowserEnabled ?? false;
  });

  const computerUseHostIdExplicit$ = computed((get): boolean => {
    const user = get(internalUserOverride$);
    return user.kind === "set";
  });

  const setComputerAccess$ = command(
    async (
      { get, set },
      selection: {
        readonly computerUseHostId: string | null;
        readonly cloudBrowserEnabled: boolean;
      },
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      const draft = {
        kind: "set" as const,
        ...selection,
      };
      set(internalUserOverride$, draft);
      if (get(optimisticCreateUnsettled$)) {
        L.debug(
          "setComputerUseHostId$ optimistic thread create unsettled, skip",
          { threadId },
        );
        return;
      }

      await set(
        patchChatThreadComputerUseHost$,
        { threadId, ...selection },
        signal,
      );
      signal.throwIfAborted();
      if (get(internalUserOverride$) === draft) {
        set(internalUserOverride$, { kind: "unset" });
      }
    },
  );

  const setComputerUseHostId$ = command(
    async (
      { get, set },
      computerUseHostId: string | null,
      signal: AbortSignal,
    ) => {
      await set(
        setComputerAccess$,
        {
          computerUseHostId,
          cloudBrowserEnabled: computerUseHostId
            ? false
            : get(cloudBrowserEnabled$),
        },
        signal,
      );
    },
  );

  const setCloudBrowserEnabled$ = command(
    async ({ get, set }, cloudBrowserEnabled: boolean, signal: AbortSignal) => {
      await set(
        setComputerAccess$,
        {
          computerUseHostId: cloudBrowserEnabled
            ? null
            : get(computerUseHostId$),
          cloudBrowserEnabled,
        },
        signal,
      );
    },
  );

  const clearComputerUseHostIdOverride$ = command(({ get, set }) => {
    const user = get(internalUserOverride$);
    if (user.kind === "set") {
      set(internalUserOverride$, { kind: "unset" });
    }
  });

  return {
    computerUseHostId$,
    cloudBrowserEnabled$,
    computerUseHostIdExplicit$,
    setComputerUseHostId$,
    setCloudBrowserEnabled$,
    clearComputerUseHostIdOverride$,
  };
}

function createThreadOwnedSignals(threadId: string) {
  return {
    headerAutomations: createHeaderAutomationSignals(threadId),
    copyEvent$,
  };
}

const copyEvent$ = command(
  async (_ctx, payload: ChatClipboardPayload, signal: AbortSignal) => {
    signal.throwIfAborted();
    const copied = await writeChatMessageToClipboard(payload);
    signal.throwIfAborted();
    return copied;
  },
);

// ---------------------------------------------------------------------------
// Sub-factory: draft server sync (debounced PATCH)
// ---------------------------------------------------------------------------

/** Milliseconds to wait before persisting a draft change to the server. */
const DRAFT_SYNC_DEBOUNCE_MS = 500;

function createDraftSync(threadId: string, draft: DraftSignals) {
  const optimisticCreateUnsettled$ =
    optimisticChatThreadCreateUnsettled(threadId);
  // A reset signal is used to abort any in-flight debounced sync when a new
  // change comes in or when the draft is cleared on send.
  const draftSyncReset$ = resetSignal();

  const syncDraft$ = command(async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (get(optimisticCreateUnsettled$)) {
      L.debug("draft sync skipped for unsettled optimistic thread create", {
        threadId,
      });
      return;
    }

    const attachments = get(draft.attachments$);

    const infos = await Promise.allSettled(
      attachments.map((a) => {
        return get(a.fileInfo$);
      }),
    );
    signal.throwIfAborted();
    // A failed lookup is unknown, not an absent saved reference. Handoff
    // cleanup may persist confirmed removals even when annotation rebuild fails.
    const unresolved = infos.find((info) => {
      return info.status === "rejected";
    });
    if (unresolved?.status === "rejected") {
      throw unresolved.reason;
    }
    const persisted = collectSuccessfulAttachmentInfos(attachments, infos).map(
      (r) => {
        const annotations = get(r.attachment.annotations$);
        const annotatedFileId = get(r.attachment.annotatedFileId$);
        return {
          id: r.info.id,
          url: r.info.url,
          filename: r.attachment.filename,
          contentType: r.info.contentType,
          size: r.attachment.size,
          ...(annotatedFileId ? { annotatedFileId } : {}),
          ...(annotations ? { annotations } : {}),
        };
      },
    );
    const payload = buildDraftPersistencePayload({
      input: get(draft.input$),
      editorDocument: set(draft.readEditorDocument$),
      restoredUserMessage: set(draft.peekRestoredUserMessage$),
      generationTemplate: get(draft.generationTemplate$),
      attachments: persisted,
    });

    await set(
      patchChatThreadDraft$,
      {
        threadId,
        ...payload,
      },
      signal,
    );
  });

  const debouncedSyncDraft$ = debounceCommand(
    syncDraft$,
    DRAFT_SYNC_DEBOUNCE_MS,
  );

  const queueDraftSync$ = command(async ({ set }, signal: AbortSignal) => {
    const debouncedSignal = set(draftSyncReset$, signal);
    await set(debouncedSyncDraft$, debouncedSignal);
  });

  const cancelDraftSync$ = command(({ set }) => {
    set(draftSyncReset$);
  });

  const flushDraftClear$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      set(draftSyncReset$);
      if (get(optimisticCreateUnsettled$)) {
        L.debug(
          "draft clear sync skipped for unsettled optimistic thread create",
          { threadId },
        );
        return;
      }
      await set(
        patchChatThreadDraft$,
        {
          threadId,
          userMessage: null,
          attachments: null,
        },
        signal,
      );
    },
  );

  return { queueDraftSync$, cancelDraftSync$, flushDraftClear$ };
}

// ---------------------------------------------------------------------------
// Sub-factory: paginated chat events
// ---------------------------------------------------------------------------

/**
 * Merge new events into existing groups.
 *
 * Upsert semantics by `id`: if an incoming event's id already exists in
 * the groups, its fields are replaced in place — this lets an optimistic
 * user row reconcile with the server-pushed row without React unmounting
 * and remounting the event (the React key stays the same).
 */
function mergeIntoGroups(
  groups: ChatEventGroup[],
  events: EnrichedChatEvent[],
): ChatEventGroup[] {
  const result = groups.map((g) => {
    return { ...g, events: [...g.events] };
  });

  const positionById = new Map<string, { groupIdx: number; msgIdx: number }>();
  for (let gi = 0; gi < result.length; gi++) {
    const group = result[gi]!;
    for (let mi = 0; mi < group.events.length; mi++) {
      positionById.set(group.events[mi]!.id, { groupIdx: gi, msgIdx: mi });
    }
  }

  for (const event of events) {
    const existing = positionById.get(event.id);
    if (existing) {
      result[existing.groupIdx]!.events[existing.msgIdx] = event;
      continue;
    }

    const last = result[result.length - 1];
    if (last && shouldMergeIntoGroup(last, event)) {
      last.events.push(event);
      positionById.set(event.id, {
        groupIdx: result.length - 1,
        msgIdx: last.events.length - 1,
      });
    } else {
      const role = chatEventCompatibilityRole(event.eventType);
      result.push({
        beginEventId: event.id,
        role,
        events: [event],
      });
      positionById.set(event.id, { groupIdx: result.length - 1, msgIdx: 0 });
    }
  }
  return result;
}

function firstRunIdForGroup(group: ChatEventGroup): string | undefined {
  return group.events.find((event) => {
    return event.runId !== undefined;
  })?.runId;
}

function shouldMergeIntoGroup(
  group: ChatEventGroup,
  event: EnrichedChatEvent,
): boolean {
  if (group.role !== chatEventCompatibilityRole(event.eventType)) {
    return false;
  }
  if (group.role !== "assistant") {
    return true;
  }

  const groupRunId = firstRunIdForGroup(group);
  if (groupRunId === undefined || event.runId === undefined) {
    return true;
  }
  return groupRunId === event.runId;
}

function orderEventsByRunTurn(
  events: readonly EnrichedChatEvent[],
): EnrichedChatEvent[] {
  const items: {
    order: number;
    events: EnrichedChatEvent[];
  }[] = [];
  const itemByRunId = new Map<string, (typeof items)[number]>();

  for (const event of events) {
    const runId = event.runId;
    if (runId === undefined) {
      items.push({ order: items.length, events: [event] });
      continue;
    }

    const existing = itemByRunId.get(runId);
    if (existing) {
      existing.events.push(event);
      continue;
    }

    const item = { order: items.length, events: [event] };
    itemByRunId.set(runId, item);
    items.push(item);
  }

  return items
    .sort((a, b) => {
      return a.order - b.order;
    })
    .flatMap((item) => {
      return item.events;
    });
}

function groupEventsForDisplay(events: EnrichedChatEvent[]): ChatEventGroup[] {
  const activeEvents: EnrichedChatEvent[] = [];
  const queuedEvents: EnrichedChatEvent[] = [];
  for (const event of events) {
    if (isUsageEvent(event)) {
      continue;
    }
    if (
      chatEventCompatibilityRole(event.eventType) === "user" &&
      event.isQueued
    ) {
      queuedEvents.push(event);
      continue;
    }
    activeEvents.push(event);
  }

  return [
    ...mergeIntoGroups([], orderEventsByRunTurn(activeEvents)),
    ...mergeIntoGroups([], queuedEvents),
  ];
}

// While a run is active or a prompt is being sent, a conversation that ends
// with the user turn gets an empty assistant turn whose status row shows the
// thinking indicator. Queued automation groups trail the active groups.
function withPendingAssistantGroup(
  groups: ChatEventGroup[],
  runActive: boolean,
): ChatEventGroup[] {
  if (!runActive) {
    return groups;
  }
  let lastActiveIndex = groups.length - 1;
  while (
    lastActiveIndex >= 0 &&
    groups[lastActiveIndex]!.events.every((event) => {
      return event.isQueued;
    })
  ) {
    lastActiveIndex--;
  }
  // With only queued automation, the empty turn opens the conversation.
  const lastActive = groups[lastActiveIndex];
  if (lastActive !== undefined && lastActive.role !== "user") {
    return groups;
  }
  return [
    ...groups.slice(0, lastActiveIndex + 1),
    {
      beginEventId: replyTurnKey(lastActive),
      role: "assistant",
      events: [],
    },
    ...groups.slice(lastActiveIndex + 1),
  ];
}

interface ChatEventRenderResources {
  readonly trees: ReadonlyMap<string, Root>;
  readonly userMessageDocuments: ReadonlyMap<string, UserMessageRenderDocument>;
}

function renderChatGroups(
  groups: readonly ChatEventGroup[],
  resources: ChatEventRenderResources,
): ChatEventGroup[] {
  return groups.map((group) => {
    return {
      ...group,
      events: group.events.map((event) => {
        const document = resources.userMessageDocuments.get(event.id);
        return {
          ...event,
          tree: resources.trees.get(event.id),
          userMessageRenderDocument:
            document?.document === chatEventUserMessage(event)
              ? document
              : undefined,
        };
      }),
    };
  });
}

function createRenderedChatGroups(
  semanticEvents$: Computed<SemanticChatEventState[]>,
  runActive$: Computed<boolean>,
  eventRenderResources$: Computed<ChatEventRenderResources>,
) {
  const allSemanticChatGroups$ = computed((get): ChatEventGroup[] => {
    return withPendingAssistantGroup(
      groupEventsForDisplay(
        enrichedChatEventsFromSemantic(get(semanticEvents$)),
      ),
      get(runActive$),
    );
  });

  // Full-transcript consumers keep access to resources already prepared by
  // the window without creating resources for the rest of the transcript.
  const allChatGroups$ = computed((get): ChatEventGroup[] => {
    return renderChatGroups(
      get(allSemanticChatGroups$),
      get(eventRenderResources$),
    );
  });
  const eventImageGroups$ = computed(
    (get): Promise<EventImageGroupProjection[]> => {
      return Promise.resolve(
        get(allChatGroups$).map((group) => {
          return {
            role: group.role,
            events: group.events.map((event) => {
              return {
                userMessage: isInputChatEvent(event)
                  ? event.userMessage
                  : undefined,
                userMessageRenderDocument: event.userMessageRenderDocument,
                tree: event.tree,
              };
            }),
          };
        }),
      );
    },
  );

  return {
    allChatGroups$,
    allSemanticChatGroups$,
    eventImageGroups$,
  };
}

const registerFeedbackNoteRenderPart$ = command(
  (
    { set },
    part: FeedbackNotePart,
    agentReferenceSignals: AgentReferenceSignalsRegistry,
  ): UserMessageFeedbackNoteRenderPart => {
    switch (part.type) {
      case "text": {
        return { type: "text", part };
      }
      case "chat_thread": {
        return { type: "chat_thread", part };
      }
      case "template": {
        return { type: "template", part };
      }
      case "agent": {
        return {
          type: part.type,
          part,
          signals: set(agentReferenceSignals.register$, part.agentId),
        };
      }
    }
  },
);

interface UserMessagePartRegistries {
  readonly artifactCardSignals: ArtifactCardSignalsRegistry;
  readonly agentReferenceSignals: AgentReferenceSignalsRegistry;
}

const registerUserMessageRenderPart$ = command(
  (
    { set },
    part: Exclude<UserMessagePart, { type: "additional_info" }>,
    registries: UserMessagePartRegistries,
  ): UserMessageRenderPart => {
    const { artifactCardSignals, agentReferenceSignals } = registries;
    switch (part.type) {
      case "text": {
        return { type: "text", part };
      }
      case "chat_thread": {
        return { type: "chat_thread", part };
      }
      case "template": {
        return { type: "template", part };
      }
      case "automation": {
        return { type: "automation", part };
      }
      case "model": {
        return { type: "model", part };
      }
      case "agent": {
        return {
          type: part.type,
          part,
          signals: set(agentReferenceSignals.register$, part.agentId),
        };
      }
      case "source": {
        return part.kind === "agent"
          ? {
              type: part.type,
              kind: "agent",
              part,
              signals: set(agentReferenceSignals.register$, part.agentId),
            }
          : part.kind === "mcp"
            ? { type: part.type, kind: "mcp", part }
            : { type: part.type, kind: "external", part };
      }
      case "file": {
        const renderFileId = part.annotatedFileId ?? part.fileId;
        const url = canonicalUserMessageFileUrl(renderFileId);
        const renderContentType = part.annotatedFileId
          ? "image/png"
          : part.contentType;
        return {
          type: part.type,
          part,
          signals: set(artifactCardSignals.register$, {
            filename: part.filenameSnapshot,
            url,
            contentType: renderContentType,
            kind: classifyChatAttachment({
              filename: part.filenameSnapshot,
              url,
              contentType: renderContentType,
            }),
          }),
        };
      }
      case "feedback": {
        return {
          type: part.type,
          part,
          note: part.note.map((notePart) => {
            return set(
              registerFeedbackNoteRenderPart$,
              notePart,
              agentReferenceSignals,
            );
          }),
        };
      }
    }
  },
);

function chatEventUserMessage(
  event: ChatEvent,
): UserMessageDocument | undefined {
  return "userMessage" in event ? event.userMessage : undefined;
}

const registerUserMessageRenderDocument$ = command(
  (
    { set },
    document: UserMessageDocument,
    registries: UserMessagePartRegistries,
  ): UserMessageRenderDocument => {
    return {
      document,
      parts: document.parts.flatMap((part, index) => {
        if (part.type === "additional_info") {
          return [];
        }
        const rendered = set(registerUserMessageRenderPart$, part, registries);
        const context = readSuggestionContext(document.parts[index - 1]);
        return [
          rendered.type === "feedback" && context
            ? { ...rendered, suggestionContext: context }
            : rendered,
        ];
      }),
    };
  },
);

interface ServerChatEventProjectionEntry {
  event: PersistedChatEvent;
  source: "server";
  optimisticUserMessageAssociation?: never;
}

interface OptimisticChatEventProjectionEntry {
  event: OptimisticChatEvent;
  source: "optimistic";
  optimisticUserMessageAssociation?: OptimisticUserMessageAssociation;
}

type ChatEventProjectionEntry =
  ServerChatEventProjectionEntry | OptimisticChatEventProjectionEntry;

function isPersistedChatEvent(event: ChatEvent): event is PersistedChatEvent {
  return event.seqId !== undefined;
}

function createRawEventsComputed(
  chatEvents$: Computed<ChatEvent[]>,
): Computed<ChatEventProjectionEntry[]> {
  return computed((get): ChatEventProjectionEntry[] => {
    return get(chatEvents$).map((event) => {
      if (isPersistedChatEvent(event)) {
        return { event, source: "server" };
      }
      return {
        event,
        source: "optimistic",
        optimisticUserMessageAssociation:
          event.optimisticUserMessageAssociation,
      };
    });
  });
}

function enrichedChatEventsFromSemantic(
  entries: readonly SemanticChatEventState[],
): EnrichedChatEvent[] {
  return entries.map((entry) => {
    const { event, isQueued, inputCreatedAt, inputOriginId } = entry;
    return {
      ...event,
      tree: undefined,
      isQueued,
      inputCreatedAt,
      inputOriginId,
      userMessageRenderDocument: undefined,
    };
  });
}

type SemanticChatGroups = GenericSemanticChatGroups<SemanticChatEventState>;

// After the thread goes idle, the last assistant turn of a run shows the
// finished row with its completion time and recommended followups.
function runFinishedFromGroups(groups: SemanticChatGroups): boolean {
  const { activeGroups } = groups;
  const lastGroup = activeGroups.at(-1);
  if (lastGroup?.role !== "assistant") {
    return false;
  }
  const lastAssistantEvent = lastGroup.events.at(-1)?.event;
  return (
    lastAssistantEvent !== undefined &&
    Boolean(lastAssistantEvent.runId) &&
    !isCancelledRunEvent(lastAssistantEvent)
  );
}

function defaultThinkingIndicators(): ThinkingIndicators {
  return { kind: "thinking", runId: null, messages: [] };
}

function latestRecommendedFollowupsFromGroups(
  groups: SemanticChatGroups,
): RecommendedFollowupSource | null {
  const { activeGroups } = groups;
  for (
    let groupIndex = activeGroups.length - 1;
    groupIndex >= 0;
    groupIndex--
  ) {
    const group = activeGroups[groupIndex];
    if (!group) {
      continue;
    }
    if (group.role !== "assistant") {
      return null;
    }
    for (
      let eventIndex = group.events.length - 1;
      eventIndex >= 0;
      eventIndex--
    ) {
      const event = group.events[eventIndex]?.event;
      if (
        !event ||
        chatEventCompatibilityRole(event.eventType) !== "assistant"
      ) {
        continue;
      }
      if (event.eventType === "output.followups") {
        // Video generation is retired, so an older run's video suggestion is
        // not offered as a next step.
        const followups = resolveChatEventRecommendedFollowups(event).filter(
          (followup) => {
            return followup.generationType !== "video";
          },
        );
        if (followups.length > 0) {
          return { eventId: event.id, followups };
        }
        return null;
      }
      if (
        isChatEventContentTextType(event.eventType) &&
        event.content?.trim()
      ) {
        return null;
      }
    }
  }
  return null;
}

function createEventSemanticSignals(
  semanticGroups$: ChatEventSignals["semanticGroups$"],
  {
    serverRunState$,
    hasOptimisticUserMessage$,
    thinkingSummaries$,
    runActive$,
  }: ThinkingIndicatorSources & { runActive$: Computed<boolean> },
) {
  const thinkingIndicators$ = computed(
    async (get): Promise<ThinkingIndicators | null> => {
      const serverRunState = get(serverRunState$);
      if (serverRunState === "running") {
        const summaries = await get(thinkingSummaries$);
        return summaries
          ? {
              kind: "thinking",
              runId: summaries.runId,
              messages: summaries.messages,
            }
          : defaultThinkingIndicators();
      }
      if (serverRunState === "queued") {
        return { kind: "queued" };
      }
      // A prompt still being sent is about to start or steer a run.
      return get(hasOptimisticUserMessage$)
        ? defaultThinkingIndicators()
        : null;
    },
  );
  const runFinished$ = computed((get): Promise<boolean> => {
    return Promise.resolve(
      !get(runActive$) && runFinishedFromGroups(get(semanticGroups$)),
    );
  });
  const recommendedFollowupSource$ = computed(
    (get): Promise<RecommendedFollowupSource | null> => {
      return Promise.resolve(
        latestRecommendedFollowupsFromGroups(get(semanticGroups$)),
      );
    },
  );
  const donePhrase$ = computed((get): Promise<string> => {
    get(locale$);
    const lastEvent = get(semanticGroups$)
      .allGroups.at(-1)
      ?.events.at(-1)?.event;
    return Promise.resolve(formatDonePhrase(lastEvent));
  });
  return {
    thinkingIndicators$,
    runFinished$,
    recommendedFollowupSource$,
    donePhrase$,
  };
}

function isServerProjectionEntry(entry: ChatEventProjectionEntry): boolean {
  return entry.source === "server";
}

function latestRunFinishCreatedAtFromRaw(
  raw: readonly ChatEventProjectionEntry[],
): string | undefined {
  for (let index = raw.length - 1; index >= 0; index--) {
    const entry = raw[index]!;
    if (!isServerProjectionEntry(entry)) {
      continue;
    }
    const { event } = entry;
    if (isChatRunTerminalEventType(event.eventType)) {
      return event.createdAt;
    }
  }
  return undefined;
}

function latestAssistantTextCreatedAtFromRaw(
  raw: readonly ChatEventProjectionEntry[],
): string | undefined {
  const revokedEventIds = revokedChatEventIds(
    raw.map((entry) => {
      return entry.event;
    }),
  );
  const interruptedRunIds = new Set(
    raw.flatMap((entry) => {
      const { event } = entry;
      return isInterruptControlEvent(event) && event.interruptsRunId
        ? [event.interruptsRunId]
        : [];
    }),
  );
  for (let index = raw.length - 1; index >= 0; index--) {
    const event = raw[index]!.event;
    if (revokedEventIds.has(event.id)) {
      continue;
    }
    if (isInterruptControlEvent(event)) {
      return event.createdAt;
    }
    if (
      chatEventCompatibilityRole(event.eventType) === "assistant" &&
      isChatEventContentTextType(event.eventType) &&
      !isUsageEvent(event) &&
      !isInterruptedAssistantCancellation(event, interruptedRunIds) &&
      (event.content?.trim().length ?? 0) > 0
    ) {
      return event.createdAt;
    }
  }
  return undefined;
}

/**
 * A Run starts at its first consumed input. Later steering, output or usage
 * from that Run cannot move it ahead of a newer Run.
 */
function latestRunIdFromRaw(
  raw: readonly ChatEventProjectionEntry[],
): string | null {
  const seenRunIds = new Set<string>();
  let latestRunId: string | null = null;
  for (const { event } of raw) {
    if (
      isChatInputEventType(event.eventType) &&
      "runId" in event &&
      typeof event.runId === "string" &&
      !seenRunIds.has(event.runId)
    ) {
      seenRunIds.add(event.runId);
      latestRunId = event.runId;
    }
  }
  return latestRunId;
}

/** The newest Run while nothing has ended or interrupted it yet. */
function liveRunIdFromRaw(
  raw: readonly ChatEventProjectionEntry[],
): string | null {
  const runId = latestRunIdFromRaw(raw);
  if (runId === null) {
    return null;
  }
  const ended = raw.some(({ event }) => {
    return (
      (isInterruptControlEvent(event) && event.interruptsRunId === runId) ||
      ("runId" in event &&
        event.runId === runId &&
        isChatRunTerminalEventType(event.eventType))
    );
  });
  return ended ? null : runId;
}

function createLatestEventSignals(
  rawEvents$: Computed<ChatEventProjectionEntry[]>,
) {
  const latestRunId$ = computed((get): string | null => {
    return latestRunIdFromRaw(get(rawEvents$));
  });
  const liveRunId$ = computed((get): string | null => {
    return liveRunIdFromRaw(get(rawEvents$));
  });
  const latestRunFinishCreatedAt$ = computed(
    (get): Promise<string | undefined> => {
      return Promise.resolve(latestRunFinishCreatedAtFromRaw(get(rawEvents$)));
    },
  );
  const latestAssistantTextCreatedAt$ = computed(
    (get): Promise<string | undefined> => {
      return Promise.resolve(
        latestAssistantTextCreatedAtFromRaw(get(rawEvents$)),
      );
    },
  );
  return {
    latestRunId$,
    liveRunId$,
    latestRunFinishCreatedAt$,
    latestAssistantTextCreatedAt$,
  };
}

function createArtifacts(threadId: string) {
  // Resources stay unfiltered even when the utility sidebar changes its kind.
  const resourceCatalog = createArtifactCatalogSignals({
    chatThreadId: threadId,
  });
  const artifacts$ = computed(async (get): Promise<ChatThreadArtifactRun[]> => {
    get(artifactCatalogRevision$);
    const client = get(apiClient$)(chatThreadArtifactsContract);
    const result = await accept(client.list({ params: { threadId } }), [200]);
    return result.body.runs;
  });

  return {
    artifacts$,
    resourceCatalog,
  };
}

interface EventTreeRegistries {
  readonly chatActionContext: ChatActionContext;
  readonly subscriptionResetCardSignals: ReturnType<
    typeof createSubscriptionResetCardSignalsRegistry
  >;
  readonly artifactCardSignals: ArtifactCardSignalsRegistry;
  readonly connectorCardSignals: ReturnType<
    typeof createConnectorCardSignalsRegistry
  >;
  readonly connectorAccountActionCardSignals: ReturnType<
    typeof createConnectorAccountActionCardSignalsRegistry
  >;
  readonly permissionCardSignals: ReturnType<
    typeof createPermissionCardSignalsRegistry
  >;
  readonly permissionBatchCardSignals: ReturnType<
    typeof createPermissionBatchCardSignalsRegistry
  >;
  readonly bankingCardSignals: ReturnType<
    typeof createBankingCardSignalsRegistry
  >;
  readonly walletCardSignals: ReturnType<
    typeof createWalletCardSignalsRegistry
  >;
  readonly browserUserActionCardSignals: ReturnType<
    typeof createBrowserUserActionCardSignalsRegistry
  >;
  readonly computerUseAuthorizationCardSignals: ReturnType<
    typeof createComputerUseAuthorizationCardSignalsRegistry
  >;
  readonly browserAuthorizationCardSignals: ReturnType<
    typeof createBrowserAuthorizationCardSignalsRegistry
  >;
  readonly desktopShellAuthorizationCardSignals: ReturnType<
    typeof createDesktopShellAuthorizationCardSignalsRegistry
  >;
  readonly planUpgradeCardSignals: ReturnType<
    typeof createPlanUpgradeCardSignalsRegistry
  >;
  readonly mailDraftCardSignals: MailDraftCardSignalsRegistry;
  readonly browserSessionSignals: ReturnType<
    typeof createBrowserSessionSignals
  >;
  readonly mermaidDiagrams: MermaidDiagramRegistry;
  readonly imageLoads: ImageLoadRegistry;
}

type PermissionCardDescriptorBlock = Extract<
  CardDescriptorBlock,
  { type: "permission-action" | "permission-batch-action" }
>;

function createPermissionCardRefRegistrar(cards: EventTreeRegistries) {
  return command(
    ({ set }, descriptor: PermissionCardDescriptorBlock): MarkdownCardRef => {
      if (descriptor.type === "permission-batch-action") {
        return {
          kind: descriptor.type,
          signals: set(
            cards.permissionBatchCardSignals.register$,
            descriptor.descriptor,
          ),
        };
      }
      return {
        kind: descriptor.type,
        signals: set(
          cards.permissionCardSignals.register$,
          descriptor.descriptor,
        ),
      };
    },
  );
}

function createCardRefRegistrar(
  cards: EventTreeRegistries,
): Command<MarkdownCardRef, [CardDescriptorBlock]> {
  const registerPermissionCardRef$ = createPermissionCardRefRegistrar(cards);
  return command(
    ({ set }, descriptor: CardDescriptorBlock): MarkdownCardRef => {
      switch (descriptor.type) {
        case "subscription-reset": {
          return {
            kind: descriptor.type,
            signals: set(
              cards.subscriptionResetCardSignals.register$,
              descriptor.descriptor,
            ),
          };
        }
        case "connector-action": {
          return {
            kind: descriptor.type,
            signals: set(
              cards.connectorCardSignals.register$,
              descriptor.descriptor,
            ),
          };
        }
        case "connector-account-action": {
          return {
            kind: descriptor.type,
            signals: set(
              cards.connectorAccountActionCardSignals.register$,
              descriptor.descriptor,
            ),
          };
        }
        case "permission-action":
        case "permission-batch-action": {
          return set(registerPermissionCardRef$, descriptor);
        }
        case "banking-action": {
          return {
            kind: descriptor.type,
            signals: set(
              cards.bankingCardSignals.register$,
              descriptor.descriptor,
            ),
          };
        }
        case "wallet-action": {
          return {
            kind: descriptor.type,
            signals: set(
              cards.walletCardSignals.register$,
              descriptor.descriptor,
            ),
          };
        }
        case "browser-user-action": {
          return {
            kind: descriptor.type,
            signals: set(
              cards.browserUserActionCardSignals.register$,
              descriptor.descriptor,
            ),
          };
        }
        case "unavailable-action": {
          return { kind: descriptor.type };
        }
        case "computer-use-authorization": {
          return {
            kind: descriptor.type,
            signals: set(
              cards.computerUseAuthorizationCardSignals.register$,
              descriptor.descriptor,
            ),
          };
        }
        case "browser-authorization": {
          return {
            kind: descriptor.type,
            signals: set(
              cards.browserAuthorizationCardSignals.register$,
              descriptor.descriptor,
            ),
          };
        }
        case "desktop-shell-authorization": {
          return {
            kind: descriptor.type,
            signals: set(
              cards.desktopShellAuthorizationCardSignals.register$,
              descriptor.descriptor,
            ),
          };
        }
        case "plan-upgrade": {
          return {
            kind: descriptor.type,
            signals: set(
              cards.planUpgradeCardSignals.register$,
              descriptor.descriptor,
            ),
          };
        }
        case "mail-draft": {
          return {
            kind: descriptor.type,
            signals: set(
              cards.mailDraftCardSignals.register$,
              descriptor.descriptor,
            ),
          };
        }
        case "browser-session": {
          return {
            kind: descriptor.type,
            signals: cards.browserSessionSignals,
          };
        }
      }
      const exhaustive: never = descriptor;
      return exhaustive;
    },
  );
}

interface EventTree {
  readonly content: string;
  /** The same text and ID can switch from a streaming URL tail to final. */
  readonly requireUrlTerminator: boolean;
  readonly tree: Root | undefined;
  readonly batchConnectorPermissions: boolean;
  /** Diagram sources this event shows, prepared when it becomes visible. */
  readonly diagramCodes?: readonly string[];
}

interface RichEventTreePlan {
  readonly eventId: string;
  readonly content: string;
  readonly treeSource: string;
  readonly descriptors: readonly CardDescriptorBlock[];
  readonly requireUrlTerminator: boolean;
  readonly batchConnectorPermissions: boolean;
}

function createEventTreeParser(registries: EventTreeRegistries) {
  const {
    chatActionContext,
    mermaidDiagrams,
    artifactCardSignals,
    mailDraftCardSignals,
    imageLoads,
  } = registries;
  const registerCardRef$ = createCardRefRegistrar(registries);
  return command(
    (
      { set },
      plan: RichEventTreePlan,
    ): { tree: Root; diagramCodes: string[] } => {
      const cards = new Map<string, MarkdownCardRef>();
      for (const descriptor of plan.descriptors) {
        cards.set(
          markdownCardKey(cardSlotUrl(descriptor)),
          set(registerCardRef$, descriptor),
        );
      }
      const tree = parseMarkdownTree(plan.treeSource, {
        math: true,
        mermaid: true,
        cards,
      });
      const diagramCodes: string[] = [];
      embedMermaidSignals(tree, (code) => {
        diagramCodes.push(code);
        return mermaidDiagrams.register(code);
      });
      set(
        embedMarkdownArtifacts$,
        tree,
        artifactCardSignals,
        chatActionContext.threadId,
      );
      set(embedMarkdownMailDrafts$, tree, mailDraftCardSignals);
      embedImageLoadSignals(tree, (url) => {
        return set(imageLoads.register$, url);
      });
      return { tree, diagramCodes };
    },
  );
}

function planEventTreeUpdates(
  events: readonly ChatEvent[],
  current: ReadonlyMap<string, EventTree>,
  chatActionContext: ChatActionContext,
  batchConnectorPermissions: boolean,
): {
  readonly next: Map<string, EventTree> | undefined;
  readonly richPlans: RichEventTreePlan[];
} {
  let next: Map<string, EventTree> | undefined;
  const richPlans: RichEventTreePlan[] = [];
  for (const event of events) {
    const content = chatEventTreeContent(event);
    if (content === null) {
      continue;
    }
    const requireUrlTerminator = isTransientOutputMessage(event);
    const cached = current.get(event.id);
    if (
      cached?.content === content &&
      cached.requireUrlTerminator === requireUrlTerminator &&
      cached.batchConnectorPermissions === batchConnectorPermissions
    ) {
      continue;
    }
    const plan = chatEventTreePlan(
      event,
      chatActionContext,
      batchConnectorPermissions,
    );
    if (plan === null) {
      continue;
    }
    const plainTree = createPlainMarkdownTree(plan.treeSource, {
      mathEnabled: true,
    });
    next ??= new Map(current);
    if (plainTree !== null) {
      next.set(event.id, {
        content: plan.content,
        requireUrlTerminator: plan.requireUrlTerminator,
        batchConnectorPermissions,
        tree: plainTree,
      });
      continue;
    }
    // A streaming event must stop showing its prior tree while the new rich
    // body loads. This pending identity also deduplicates concurrent ensures.
    next.set(event.id, {
      content: plan.content,
      requireUrlTerminator: plan.requireUrlTerminator,
      batchConnectorPermissions,
      tree: undefined,
    });
    richPlans.push({ eventId: event.id, ...plan, batchConnectorPermissions });
  }
  return { next, richPlans };
}

// Chat prewarms the same layout computeds that visible diagrams read, so
// pagination and scroll restoration can wait for layout. It allocates no URLs.
const prewarmMermaidDiagrams$ = command(
  async (
    { get },
    registry: MermaidDiagramRegistry,
    codes: readonly string[],
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    for (const code of new Set(codes)) {
      // The view owns each diagram's error fallback. A failed layout must
      // not stop prewarming other diagrams or fail chat synchronization.
      // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
      await settle(get(registry.register(code).diagram$));
      signal.throwIfAborted();
    }
  },
);

function createEventTreeSignals(registries: EventTreeRegistries) {
  const { chatActionContext } = registries;

  const internalEventTrees$ = state<ReadonlyMap<string, EventTree>>(new Map());
  const eventTrees$ = computed((get): ReadonlyMap<string, Root> => {
    const trees = new Map<string, Root>();
    for (const [eventId, entry] of get(internalEventTrees$)) {
      if (entry.tree !== undefined) {
        trees.set(eventId, entry.tree);
      }
    }
    return trees;
  });
  const parseEventTree$ = createEventTreeParser(registries);
  const parseRichEventTrees$ = command(
    async (
      { get, set },
      richPlans: readonly RichEventTreePlan[],
      signal: AbortSignal,
    ): Promise<void> => {
      await Promise.resolve();
      signal.throwIfAborted();
      const pending = get(internalEventTrees$);
      let parsed: Map<string, EventTree> | undefined;
      for (const plan of richPlans) {
        const pendingEntry = pending.get(plan.eventId);
        if (
          pendingEntry?.content !== plan.content ||
          pendingEntry.requireUrlTerminator !== plan.requireUrlTerminator ||
          pendingEntry.batchConnectorPermissions !==
            plan.batchConnectorPermissions ||
          pendingEntry.tree !== undefined
        ) {
          continue;
        }
        const { tree, diagramCodes } = set(parseEventTree$, plan);
        parsed ??= new Map(pending);
        parsed.set(plan.eventId, {
          content: plan.content,
          requireUrlTerminator: plan.requireUrlTerminator,
          batchConnectorPermissions: plan.batchConnectorPermissions,
          tree,
          diagramCodes,
        });
      }
      signal.throwIfAborted();
      if (parsed) {
        set(internalEventTrees$, parsed);
      }
    },
  );

  /**
   * Parses the markdown tree of every listed event that has none yet, or whose
   * body changed since it was parsed. Cards register here, ahead of the parse
   * that resolves their slots. Runs after every write that can change the
   * visible window, including scroll captures, so the unchanged path costs a
   * content lookup per event, not a plan.
   */
  const ensureEventTrees$ = command(
    async (
      { get, set },
      events: readonly ChatEvent[],
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      const current = get(internalEventTrees$);
      const { next, richPlans } = planEventTreeUpdates(
        events,
        current,
        chatActionContext,
        get(featureSwitch$)[FeatureSwitchKey.BatchConnectorPermissions] ===
          true,
      );
      if (next) {
        set(internalEventTrees$, next);
      }
      if (richPlans.length > 0) {
        await set(parseRichEventTrees$, richPlans, signal);
      }
      // Only prepared cards have registered signals. Start their subscriptions
      // under the panel owner, including re-entry with already cached trees.
      set(registries.connectorCardSignals.subscribe$, signal);
      set(registries.bankingCardSignals.subscribe$, signal);
      set(registries.desktopShellAuthorizationCardSignals.subscribe$, signal);
      set(registries.browserUserActionCardSignals.subscribe$, signal);
      set(registries.browserAuthorizationCardSignals.subscribe$, signal);
      set(registries.walletCardSignals.subscribe$, signal);
    },
  );

  const diagramCodesForEvents$ = command(
    ({ get }, events: readonly ChatEvent[]): readonly string[] => {
      const trees = get(internalEventTrees$);
      return events.flatMap((event) => {
        return trees.get(event.id)?.diagramCodes ?? [];
      });
    },
  );

  return {
    eventTrees$,
    ensureEventTrees$,
    diagramCodesForEvents$,
  };
}

function createPagedEventResources({
  chatActionContext,
  connector,
}: {
  readonly chatActionContext: ChatActionContext;
  readonly connector: ComposerConnectorSignals;
}) {
  const { threadId } = chatActionContext;
  const mailDraftCardSignals = createMailDraftCardSignalsRegistry(threadId);
  const browserSessionSignals = createBrowserSessionSignals(threadId);
  const artifactCardSignals = createArtifactCardSignalsRegistry();
  const agentReferenceSignals = createAgentReferenceSignalsRegistry();
  const subscriptionResetCardSignals =
    createSubscriptionResetCardSignalsRegistry();
  const connectorCardSignals = createConnectorCardSignalsRegistry();
  const connectorAccountActionCardSignals =
    createConnectorAccountActionCardSignalsRegistry(connector);
  const permissionCardSignals = createPermissionCardSignalsRegistry();
  const permissionBatchCardSignals = createPermissionBatchCardSignalsRegistry();
  const bankingCardSignals = createBankingCardSignalsRegistry();
  const walletCardSignals = createWalletCardSignalsRegistry(chatActionContext);
  const browserUserActionCardSignals =
    createBrowserUserActionCardSignalsRegistry();
  const computerUseAuthorizationCardSignals =
    createComputerUseAuthorizationCardSignalsRegistry();
  const browserAuthorizationCardSignals =
    createBrowserAuthorizationCardSignalsRegistry(chatActionContext);
  const desktopShellAuthorizationCardSignals =
    createDesktopShellAuthorizationCardSignalsRegistry(threadId);
  const planUpgradeCardSignals = createPlanUpgradeCardSignalsRegistry();
  const mermaidDiagrams = createMermaidDiagramRegistry(openDiagramLightbox$);
  const imageLoads = createImageLoadRegistry();

  const { eventTrees$, ensureEventTrees$, diagramCodesForEvents$ } =
    createEventTreeSignals({
      chatActionContext,
      subscriptionResetCardSignals,
      artifactCardSignals,
      connectorCardSignals,
      connectorAccountActionCardSignals,
      permissionCardSignals,
      permissionBatchCardSignals,
      bankingCardSignals,
      walletCardSignals,
      browserUserActionCardSignals,
      computerUseAuthorizationCardSignals,
      browserAuthorizationCardSignals,
      desktopShellAuthorizationCardSignals,
      planUpgradeCardSignals,
      mailDraftCardSignals,
      browserSessionSignals,
      mermaidDiagrams,
      imageLoads,
    });

  const internalUserMessageDocuments$ = state<
    ReadonlyMap<string, UserMessageRenderDocument>
  >(new Map());
  // The window owns first registration. Keep prepared documents and their
  // shared card identities when an event leaves the window.
  const ensureUserMessageDocuments$ = command(
    ({ get, set }, events: readonly ChatEvent[]): void => {
      const current = get(internalUserMessageDocuments$);
      let next: Map<string, UserMessageRenderDocument> | undefined;
      for (const event of events) {
        const document = chatEventUserMessage(event);
        if (!document || current.get(event.id)?.document === document) {
          continue;
        }
        next ??= new Map(current);
        next.set(
          event.id,
          set(registerUserMessageRenderDocument$, document, {
            artifactCardSignals,
            agentReferenceSignals,
          }),
        );
      }
      if (next) {
        set(internalUserMessageDocuments$, next);
      }
    },
  );
  const eventRenderResources$ = computed((get): ChatEventRenderResources => {
    return {
      trees: get(eventTrees$),
      userMessageDocuments: get(internalUserMessageDocuments$),
    };
  });
  return {
    artifactCardSignals,
    eventRenderResources$,
    ensureUserMessageDocuments$,
    ensureEventTrees$,
    diagramCodesForEvents$,
    mermaidDiagrams,
    publicSignals: {
      mailDraftCardSignals,
      browserSessionSignals,
      subscribeBrowserSessions$: browserSessionSignals.subscribe$,
    },
  };
}

interface ThinkingIndicatorSources {
  readonly serverRunState$: Computed<RunIndicatorState>;
  readonly hasOptimisticUserMessage$: Computed<boolean>;
  readonly thinkingSummaries$: Computed<Promise<ThinkingSummaries | null>>;
}

function createPagedEventProjections({
  chatEvents,
  thinkingSources,
  eventRenderResources$,
}: {
  chatEvents: ChatEventSignals;
  thinkingSources: ThinkingIndicatorSources;
  eventRenderResources$: Computed<ChatEventRenderResources>;
}) {
  const { chatEvents$, semanticEvents$, semanticGroups$, hasEvents$ } =
    chatEvents;
  const rawEvents$ = createRawEventsComputed(chatEvents$);
  const { serverRunState$, hasOptimisticUserMessage$ } = thinkingSources;
  // Transcript activity includes server-queued and unacknowledged input;
  // unlike sending$, it is not just a live Run that has not been cancelled.
  const runActive$ = computed((get): boolean => {
    return get(serverRunState$) !== null || get(hasOptimisticUserMessage$);
  });
  return {
    rawEvents$,
    chatEvents$,
    hasEvents$,
    ...createLatestEventSignals(rawEvents$),
    ...createEventSemanticSignals(semanticGroups$, {
      ...thinkingSources,
      runActive$,
    }),
    ...createRenderedChatGroups(
      semanticEvents$,
      runActive$,
      eventRenderResources$,
    ),
  };
}

interface MarkThreadReadDeps {
  threadId: string;
  latestRunFinishCreatedAt$: Computed<Promise<string | undefined>>;
  locallyMarkedReadAt$: State<string | undefined>;
}

/**
 * The newest instant this open thread has to be read through.
 *
 * A Run leaves a terminal event in the local projection. The server may have
 * observed a newer terminal event than the local projection, so read through
 * the later of the two timestamps.
 */
function createUnreadThroughAt$(
  threadId: string,
  latestRunFinishCreatedAt$: Computed<Promise<string | undefined>>,
) {
  const unreadAt$ = serverUnreadAt$(threadId);
  return computed(async (get): Promise<string | undefined> => {
    const [runFinishAt, serverUnreadAt] = await Promise.all([
      get(latestRunFinishCreatedAt$),
      get(unreadAt$),
    ]);
    return unreadThroughAt(runFinishAt, serverUnreadAt);
  });
}

function createMarkThreadReadIfNeeded({
  threadId,
  latestRunFinishCreatedAt$,
  locallyMarkedReadAt$,
}: MarkThreadReadDeps) {
  const optimisticCreateUnsettled$ =
    optimisticChatThreadCreateUnsettled(threadId);
  const unreadThroughAt$ = createUnreadThroughAt$(
    threadId,
    latestRunFinishCreatedAt$,
  );
  return command(async ({ get, set }, sig: AbortSignal) => {
    const latestRunFinishCreatedAt = await get(unreadThroughAt$);
    sig.throwIfAborted();
    if (!latestRunFinishCreatedAt) {
      return;
    }
    if (get(optimisticCreateUnsettled$)) {
      L.debug("markRead$ optimistic thread create unsettled, skip", {
        threadId,
        latestRunFinishCreatedAt,
      });
      return;
    }

    const lastReadAt = get(locallyMarkedReadAt$);
    if (
      lastReadAt !== undefined &&
      compareCreatedAt(lastReadAt, latestRunFinishCreatedAt) >= 0
    ) {
      return;
    }

    const newLastReadAt = await set(markChatThreadRead$, { threadId }, sig);
    sig.throwIfAborted();
    // A response that resolves after a newer delivery already arrived must not
    // record a read mark past it, or the newer unread would be swallowed
    // without ever being read.
    const heldLastReadAt = get(locallyMarkedReadAt$);
    if (
      newLastReadAt !== null &&
      (heldLastReadAt === undefined ||
        compareCreatedAt(newLastReadAt, heldLastReadAt) > 0)
    ) {
      set(locallyMarkedReadAt$, newLastReadAt);
    }
    // No sidebar reload needed: markRead$ records an optimistic read mark
    // that hides the indicators' `unreadAt` until a newer one arrives, so the
    // unread dot clears without refetching the thread list.
  });
}

function createEventChangeEffects({
  threadId,
  mailDraftCardSignals,
  chatEvents,
  projections,
  scroll,
  syncVisibleEventTrees$,
}: {
  readonly threadId: string;
  readonly mailDraftCardSignals: MailDraftCardSignalsRegistry;
  readonly chatEvents: ChatEventSignals;
  readonly projections: Pick<
    ReturnType<typeof createPagedEventProjections>,
    "rawEvents$" | "latestRunFinishCreatedAt$"
  >;
  readonly scroll: ChatThreadScrollSignals;
  readonly syncVisibleEventTrees$: Command<
    Promise<void>,
    [boolean, AbortSignal]
  >;
}) {
  const sidebar = createThreadSidebarSignals(threadId, mailDraftCardSignals);
  const locallyMarkedReadAt$ = state<string | undefined>(undefined);
  const markThreadReadIfNeeded$ = createMarkThreadReadIfNeeded({
    threadId,
    latestRunFinishCreatedAt$: projections.latestRunFinishCreatedAt$,
    locallyMarkedReadAt$,
  });
  const updateEventPresentation$ = command(
    async (
      { set },
      scrollPosition: ThreadScrollPosition | null,
      signal: AbortSignal,
    ): Promise<void> => {
      await set(syncVisibleEventTrees$, true, signal);
      signal.throwIfAborted();
      await set(scroll.autoScroll$, scrollPosition, signal);
    },
  );
  const afterEventsChange$ = command(
    async (
      { get, set },
      _handler: ChatEventChangeHandler,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      const hasOptimisticUserMessage = get(
        chatEvents.hasOptimisticUserMessage$,
      );
      // Scroll events own the DOM-aware decision: reaching the tail clears the
      // held position there. An event batch can run while this thread's DOM is
      // empty or stale, so restoration must read only the position already
      // captured for the reader.
      const scrollPosition = hasOptimisticUserMessage
        ? null
        : get(scroll.threadScrollPosition$);
      await Promise.all([
        set(updateEventPresentation$, scrollPosition, signal),
        set(markThreadReadIfNeeded$, signal),
      ]);
      signal.throwIfAborted();
    },
  );
  const eventChangeHandler: ChatEventChangeHandler = Object.freeze({
    command$: afterEventsChange$,
  });
  return { sidebar, eventChangeHandler };
}

function createChatEventPresentationLifecycle({
  chatEvents,
  eventChangeHandler,
  syncVisibleEventTrees$,
  enableSidebarEntryAnimations$,
  initialEventsReady$,
}: {
  readonly chatEvents: ChatEventSignals;
  readonly eventChangeHandler: ChatEventChangeHandler;
  readonly syncVisibleEventTrees$: Command<
    Promise<void>,
    [boolean, AbortSignal]
  >;
  readonly enableSidebarEntryAnimations$: Command<void, []>;
  readonly initialEventsReady$: State<boolean>;
}) {
  const setup$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      set(
        registerChatEventChangeHandler$,
        chatEvents.chatEvents$,
        eventChangeHandler,
        signal,
      );
      await set(syncVisibleEventTrees$, false, signal);
      set(enableSidebarEntryAnimations$);
      // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
      const result = await settle(set(chatEvents.setup$, signal), signal);
      if (!result.ok) {
        set(initialEventsReady$, true);
        throw result.error;
      }
    },
  );
  const catchUp$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
      const result = await settle(set(chatEvents.catchUp$, signal), signal);
      set(initialEventsReady$, true);
      if (!result.ok) {
        throw result.error;
      }
    },
  );
  return { setup$, catchUp$ };
}

function createReadyScrollAfterRenderRequest(
  pendingScrollAfterRenderRequest$: Computed<ScrollAfterRenderRequest | null>,
  visibleRenderedChatGroups$: Computed<Promise<ChatEventGroup[]>>,
): Computed<Promise<ReadyScrollAfterRenderRequest | null>> {
  return computed(async (get) => {
    const request = get(pendingScrollAfterRenderRequest$);
    if (request === null) {
      return null;
    }
    const renderedGroups = await get(visibleRenderedChatGroups$);
    const currentRequest = get(pendingScrollAfterRenderRequest$);
    if (currentRequest?.revision !== request.revision) {
      return null;
    }
    return {
      request,
      renderedEventKeys: renderedGroups.flatMap((group) => {
        return group.events.map((event) => {
          return `${event.id}:${event.isQueued ? "queued" : "active"}`;
        });
      }),
    };
  });
}

const EARLIER_GROUPS_LOAD_TOP_THRESHOLD_PX = 100;
// Safari reverts a scrollTop write made while its scrolling thread still
// animates a gesture, momentum, or smooth scroll. Every animated frame delivers
// a scroll event, so a quiet interval means the compensation write will stick.
const EARLIER_GROUPS_LOAD_SCROLL_SETTLE_MS = 150;

/**
 * Loads earlier groups once scrolling settles near the top. Every scroll
 * restarts the wait, so the prepend and its scroll compensation never land
 * while the browser is still moving the viewport.
 */
function createLoadEarlierGroupsAfterScroll(
  scroll: ChatThreadScrollSignals,
  loadMoreGroups$: Command<Promise<boolean>, [AbortSignal]>,
) {
  const loadEarlierGroupsNearTop$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
      const container = get(scroll.scrollContainer$);
      if (
        !container ||
        container.scrollTop > EARLIER_GROUPS_LOAD_TOP_THRESHOLD_PX
      ) {
        return false;
      }
      const scrollPosition = set(scroll.readRenderedThreadScrollPosition$);
      const didPrepend = await set(loadMoreGroups$, signal);
      signal.throwIfAborted();
      if (didPrepend) {
        await set(scroll.autoScroll$, scrollPosition, signal);
        signal.throwIfAborted();
      }
      return didPrepend;
    },
  );
  return debounceCommand(
    loadEarlierGroupsNearTop$,
    EARLIER_GROUPS_LOAD_SCROLL_SETTLE_MS,
  );
}

interface ChatThreadMessagePipelineOptions {
  chatActionContext: ChatActionContext;
  chatEvents: ChatEventSignals;
  connector: ComposerConnectorSignals;
  thinkingSummaries$: Computed<Promise<ThinkingSummaries | null>>;
}

function createChatThreadMessagePipeline({
  chatActionContext,
  chatEvents,
  connector,
  thinkingSummaries$,
}: ChatThreadMessagePipelineOptions) {
  const { threadId } = chatActionContext;
  // Position is created before scroll writers are wired to the render window.
  const position = createThreadScrollPositionSignals(threadId);
  const resources = createPagedEventResources({
    chatActionContext,
    connector,
  });
  const usage = createChatRunUsageSignals(
    threadId,
    chatEvents.lastUsageEventIdByRunId$,
  );
  const projections = createPagedEventProjections({
    chatEvents,
    thinkingSources: {
      serverRunState$: chatEvents.serverRunState$,
      hasOptimisticUserMessage$: chatEvents.hasOptimisticUserMessage$,
      thinkingSummaries$,
    },
    eventRenderResources$: resources.eventRenderResources$,
  });
  const initialEventsReady$ = state(false);
  const initialEventsReadyView$ = computed((get): boolean => {
    return get(initialEventsReady$);
  });
  const renderWindow = createChatRenderWindow({
    threadId,
    allSemanticChatGroups$: projections.allSemanticChatGroups$,
    threadScrollPosition$: position.threadScrollPosition$,
    awayFromBottom$: position.awayFromBottom$,
    eventRenderResources$: resources.eventRenderResources$,
    ensureUserMessageDocuments$: resources.ensureUserMessageDocuments$,
    ensureEventTrees$: resources.ensureEventTrees$,
    diagramCodesForEvents$: resources.diagramCodesForEvents$,
    mermaidDiagrams: resources.mermaidDiagrams,
    syncVisibleRunUsage$: usage.syncVisibleRuns$,
    initialEventsReady$,
  });
  const afterPositionChanged$ = createEnsureVisibleEventTreesAfterScroll(
    renderWindow.ensureVisibleEventTrees$,
  );
  const scroll = createChatThreadScrollSignals(
    threadId,
    position,
    {
      afterThreadScrollPositionChanged$: afterPositionChanged$,
      preloadPreviousRenderWindowForEvent$:
        renderWindow.preloadPreviousRenderWindowForEvent$,
      loadEarlierGroups$: renderWindow.loadMoreRenderedChatGroups$,
    },
    chatEvents.chatEvents$,
    initialEventsReadyView$,
  );
  const effects = createEventChangeEffects({
    threadId,
    mailDraftCardSignals: resources.publicSignals.mailDraftCardSignals,
    chatEvents,
    projections,
    scroll,
    syncVisibleEventTrees$: renderWindow.ensureVisibleEventTrees$,
  });
  const lifecycle = createChatEventPresentationLifecycle({
    chatEvents,
    eventChangeHandler: effects.eventChangeHandler,
    syncVisibleEventTrees$: renderWindow.ensureVisibleEventTrees$,
    enableSidebarEntryAnimations$: effects.sidebar.enableEntryAnimations$,
    initialEventsReady$,
  });
  const assistantErrorRecovery = createAssistantErrorRecoverySignals({
    threadId,
    chatEvents,
    visibleRenderedChatGroups$: renderWindow.visibleRenderedChatGroups$,
  });
  const readyScrollAfterRenderRequest$ = createReadyScrollAfterRenderRequest(
    scroll.pendingScrollAfterRenderRequest$,
    renderWindow.visibleRenderedChatGroups$,
  );
  const loadEarlierGroupsAfterScroll$ = createLoadEarlierGroupsAfterScroll(
    scroll,
    renderWindow.loadMoreRenderedChatGroups$,
  );
  return {
    scroll,
    sidebar: effects.sidebar,
    firstTaskUpgradeEligible$: createFirstTaskUpgradeEligibility(
      projections.allSemanticChatGroups$,
    ),
    ...lifecycle,
    initialEventsReady$: initialEventsReadyView$,
    ...assistantErrorRecovery,
    ...projections,
    ...resources.publicSignals,
    visibleRunUsageSignals$: usage.visibleRunUsageSignals$,
    ...renderWindow,
    readyScrollAfterRenderRequest$,
    loadEarlierGroupsAfterScroll$,
  };
}

// ---------------------------------------------------------------------------
// Draft cache
// ---------------------------------------------------------------------------

type ThreadDraftPersistence = ReturnType<typeof createThreadDraftPersistence>;

export interface ThreadDraftOwner {
  readonly draft: DraftSignals;
  readonly persistence$: Computed<ThreadDraftPersistence>;
}

function createThreadDraftPersistence(
  threadId: string,
  draft: DraftSignals,
  threadDraft$: Computed<Promise<ChatThreadDraft | null>>,
) {
  const sync = createDraftSync(threadId, draft);
  return {
    ...sync,
    loadDraft$: createThreadDraftLoad(
      threadDraft$,
      draft,
      sync.queueDraftSync$,
    ),
  };
}

function createThreadDraftOwner(threadId: string): ThreadDraftOwner {
  const draft = createDraftSignals();
  const persistence$ = computed(() => {
    return createThreadDraftPersistence(
      threadId,
      draft,
      createRemoteChatThreadDraft(threadId),
    );
  });
  return { draft, persistence$ };
}

const draftCache$ = state(new Map<string, ThreadDraftOwner>());

export const ensureThreadDraft$ = command(({ get, set }, threadId: string) => {
  const cache = get(draftCache$);
  const existing = cache.get(threadId);
  if (existing) {
    return existing;
  }
  const entry = createThreadDraftOwner(threadId);
  const next = new Map(cache);
  next.set(threadId, entry);
  set(draftCache$, next);
  return entry;
});

export const ensureDraft$ = command(
  ({ set }, threadId: string): DraftSignals => {
    return set(ensureThreadDraft$, threadId).draft;
  },
);

// ---------------------------------------------------------------------------
// Factory: createRunTracking
// ---------------------------------------------------------------------------

type ThreadActivitySummarySignals = ReturnType<
  typeof createThreadActivitySummarySignals
>;

interface RunTrackingDeps {
  threadId: string;
  messages: Pick<
    MessageListSignals,
    "setup$" | "catchUp$" | "subscribeBrowserSessions$" | "sidebar"
  >;
  subscribeSessionOutput$: Command<void, [AbortSignal]>;
  subscribeThinkingSummaries$: ThreadActivitySummarySignals["subscribe$"];
  automationSignals: Pick<ChatPanelSignals, "headerAutomations">;
  cancellationRecovery: ReturnType<typeof createCancellationRecoverySignals>;
  reloadConnectorAccountPreference$: Command<void, []>;
  resourceCatalog: ReturnType<typeof createArtifacts>["resourceCatalog"];
}

interface ChatRenderWindowState {
  cursorGroupId: string | null;
}

const INITIAL_RENDER_GROUP_COUNT = 5;
const RENDER_GROUP_LOAD_INCREMENT = 10;

const renderWindowStateByThreadId$ = state(
  new Map<string, ChatRenderWindowState>(),
);

// A turn without events (the pending assistant turn) takes no window slot of
// its own; it stays with the turn before it.
function takesRenderWindowSlot(
  groups: readonly ChatEventGroup[],
  groupIndex: number,
): boolean {
  return groupIndex === 0 || (groups[groupIndex]?.events.length ?? 0) > 0;
}

/** The first group of the run `runId` that continues at `groupIndex`. */
function runStartGroupIndex(
  groups: readonly ChatEventGroup[],
  groupIndex: number,
  runId: string | undefined,
): number {
  let startIndex = groupIndex;
  while (
    runId !== undefined &&
    startIndex > 0 &&
    groups[startIndex - 1]?.events.some((event) => {
      return event.runId === runId;
    })
  ) {
    startIndex--;
  }
  return startIndex;
}

/**
 * The start index that shows `slotCount` window slots before `endIndex`. A
 * window opens at the start of a run, so a visible answer keeps its prompt.
 */
function renderWindowStartIndexBefore(
  groups: readonly ChatEventGroup[],
  endIndex: number,
  slotCount: number,
): number {
  let slots = 0;
  for (
    let groupIndex = Math.min(endIndex, groups.length) - 1;
    groupIndex >= 0;
    groupIndex--
  ) {
    if (takesRenderWindowSlot(groups, groupIndex)) {
      slots++;
      if (slots >= slotCount) {
        const group = groups[groupIndex];
        return runStartGroupIndex(
          groups,
          groupIndex,
          group === undefined ? undefined : firstRunIdForGroup(group),
        );
      }
    }
  }
  return 0;
}

function renderWindowStartIndex(
  groups: readonly ChatEventGroup[],
  cursorGroupId: string | null,
): number {
  let cursorGroupIndex =
    cursorGroupId === null
      ? -1
      : groups.findIndex((group) => {
          return group.beginEventId === cursorGroupId;
        });
  if (cursorGroupIndex === -1) {
    return renderWindowStartIndexBefore(
      groups,
      groups.length,
      INITIAL_RENDER_GROUP_COUNT,
    );
  }
  while (!takesRenderWindowSlot(groups, cursorGroupIndex)) {
    cursorGroupIndex--;
  }
  return cursorGroupIndex;
}

function previousRenderWindowStartIndex(
  groups: readonly ChatEventGroup[],
  currentStartGroupIndex: number,
): number {
  return renderWindowStartIndexBefore(
    groups,
    currentStartGroupIndex,
    RENDER_GROUP_LOAD_INCREMENT,
  );
}

function renderWindowStateForThread(
  stateByThreadId: ReadonlyMap<string, ChatRenderWindowState>,
  threadId: string,
): ChatRenderWindowState {
  return stateByThreadId.get(threadId) ?? { cursorGroupId: null };
}

function setThreadRenderWindowState(
  stateByThreadId: ReadonlyMap<string, ChatRenderWindowState>,
  threadId: string,
  nextState: ChatRenderWindowState,
): Map<string, ChatRenderWindowState> {
  const next = new Map(stateByThreadId);
  next.set(threadId, nextState);
  return next;
}

function eventRunStartIndex(
  groups: readonly ChatEventGroup[],
  eventId: string,
): number | null {
  const targetGroupIndex = groups.findIndex((group) => {
    return group.events.some((event) => {
      return event.id === eventId;
    });
  });
  if (targetGroupIndex === -1) {
    return null;
  }
  const targetRunId = groups[targetGroupIndex]?.events.find((event) => {
    return event.id === eventId;
  })?.runId;
  return runStartGroupIndex(groups, targetGroupIndex, targetRunId);
}

function scrollTargetStartIndex(
  groups: readonly ChatEventGroup[],
  position: ThreadScrollPosition | null,
): number | null {
  return position === null
    ? null
    : eventRunStartIndex(groups, position.targetEventId);
}

interface ChatRenderWindowOptions {
  readonly threadId: string;
  readonly allSemanticChatGroups$: Computed<ChatEventGroup[]>;
  readonly threadScrollPosition$: Computed<ThreadScrollPosition | null>;
  readonly awayFromBottom$: Computed<boolean>;
  readonly eventRenderResources$: Computed<ChatEventRenderResources>;
  readonly ensureUserMessageDocuments$: Command<void, [readonly ChatEvent[]]>;
  readonly ensureEventTrees$: Command<
    Promise<void>,
    [readonly ChatEvent[], AbortSignal]
  >;
  readonly diagramCodesForEvents$: Command<
    readonly string[],
    [readonly ChatEvent[]]
  >;
  readonly mermaidDiagrams: MermaidDiagramRegistry;
  readonly syncVisibleRunUsage$: ReturnType<
    typeof createChatRunUsageSignals
  >["syncVisibleRuns$"];
  readonly initialEventsReady$: State<boolean>;
}

interface PreloadPreviousRenderWindowOptions {
  readonly threadId: string;
  readonly allSemanticChatGroups$: Computed<ChatEventGroup[]>;
  readonly ensureVisibleEventTrees$: Command<
    Promise<void>,
    [boolean, AbortSignal]
  >;
}

function createPreloadPreviousRenderWindowForEvent({
  threadId,
  allSemanticChatGroups$,
  ensureVisibleEventTrees$,
}: PreloadPreviousRenderWindowOptions): Command<
  Promise<void>,
  [string, AbortSignal]
> {
  return command(
    async (
      { get, set },
      eventId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      const groups = get(allSemanticChatGroups$);
      signal.throwIfAborted();
      const targetStartIndex = eventRunStartIndex(groups, eventId);
      if (targetStartIndex === null) {
        return;
      }
      const preloadStartIndex = previousRenderWindowStartIndex(
        groups,
        targetStartIndex,
      );
      const current = renderWindowStateForThread(
        get(renderWindowStateByThreadId$),
        threadId,
      );
      const requestedStartIndex = renderWindowStartIndex(
        groups,
        current.cursorGroupId,
      );
      const nextStartIndex = Math.min(requestedStartIndex, preloadStartIndex);
      if (nextStartIndex < requestedStartIndex) {
        set(
          renderWindowStateByThreadId$,
          setThreadRenderWindowState(
            get(renderWindowStateByThreadId$),
            threadId,
            {
              cursorGroupId: groups[nextStartIndex]?.beginEventId ?? null,
            },
          ),
        );
      }
      // Locator jumps need stable content above the destination before their
      // smooth-scroll request commits. Persist this one-time expansion in the
      // cursor instead of deriving it from every live scroll position.
      await set(ensureVisibleEventTrees$, false, signal);
    },
  );
}

/**
 * Prepare visible user-message references and rich content, then prewarm its
 * diagram layout before callers restore scroll positions. The view reads the
 * same layout computeds; only mounted image refs own object URLs.
 */
function createEnsureVisibleEventTrees({
  visibleChatGroups$,
  ensureUserMessageDocuments$,
  ensureEventTrees$,
  diagramCodesForEvents$,
  mermaidDiagrams,
  syncVisibleRunUsage$,
  initialEventsReady$,
}: {
  readonly visibleChatGroups$: Computed<ChatEventGroup[]>;
  readonly ensureUserMessageDocuments$: ChatRenderWindowOptions["ensureUserMessageDocuments$"];
  readonly ensureEventTrees$: ChatRenderWindowOptions["ensureEventTrees$"];
  readonly diagramCodesForEvents$: ChatRenderWindowOptions["diagramCodesForEvents$"];
  readonly mermaidDiagrams: MermaidDiagramRegistry;
  readonly syncVisibleRunUsage$: ChatRenderWindowOptions["syncVisibleRunUsage$"];
  readonly initialEventsReady$: State<boolean>;
}): Command<Promise<void>, [boolean, AbortSignal]> {
  return command(
    async (
      { get, set },
      revealPreparedEvents: boolean,
      signal: AbortSignal,
    ): Promise<void> => {
      const groups = get(visibleChatGroups$);
      signal.throwIfAborted();
      set(syncVisibleRunUsage$, groups);
      const visibleEvents = groups.flatMap((group) => {
        return group.events;
      });
      set(ensureUserMessageDocuments$, visibleEvents);
      const richContentReady = set(ensureEventTrees$, visibleEvents, signal);
      if (revealPreparedEvents) {
        set(initialEventsReady$, true);
      }
      await richContentReady;
      signal.throwIfAborted();
      await set(
        prewarmMermaidDiagrams$,
        mermaidDiagrams,
        set(diagramCodesForEvents$, visibleEvents),
        signal,
      );
    },
  );
}

function createChatRenderWindow({
  threadId,
  allSemanticChatGroups$,
  threadScrollPosition$,
  awayFromBottom$,
  eventRenderResources$,
  ensureUserMessageDocuments$,
  ensureEventTrees$,
  diagramCodesForEvents$,
  mermaidDiagrams,
  syncVisibleRunUsage$,
  initialEventsReady$,
}: ChatRenderWindowOptions) {
  const visibleChatGroups$ = computed((get): ChatEventGroup[] => {
    const groups = get(allSemanticChatGroups$);
    const { cursorGroupId } = renderWindowStateForThread(
      get(renderWindowStateByThreadId$),
      threadId,
    );
    const requestedStartIndex = renderWindowStartIndex(groups, cursorGroupId);
    // A complete window cannot be extended by a reading-position anchor.
    if (requestedStartIndex === 0) {
      return groups;
    }
    const targetStartIndex = scrollTargetStartIndex(
      groups,
      get(threadScrollPosition$),
    );
    return groups.slice(
      targetStartIndex === null
        ? requestedStartIndex
        : Math.min(requestedStartIndex, targetStartIndex),
    );
  });
  const visibleRenderedChatGroups$ = computed(
    (get): Promise<ChatEventGroup[]> => {
      return Promise.resolve(
        renderChatGroups(get(visibleChatGroups$), get(eventRenderResources$)),
      );
    },
  );
  const visibleRenderedChatGroupsReady$ = computed(
    async (get): Promise<boolean> => {
      await get(visibleRenderedChatGroups$);
      return true;
    },
  );

  /**
   * Prepares resources for every event currently in the render window. Every
   * write that can grow the window or change what it holds runs this
   * afterwards: the event sync, the load-more cursor, and the scroll position
   * commands. Parsing stays command-driven — reading the window never parses.
   */
  const ensureVisibleEventTrees$ = createEnsureVisibleEventTrees({
    visibleChatGroups$,
    ensureUserMessageDocuments$,
    ensureEventTrees$,
    diagramCodesForEvents$,
    mermaidDiagrams,
    syncVisibleRunUsage$,
    initialEventsReady$,
  });

  const preloadPreviousRenderWindowForEvent$ =
    createPreloadPreviousRenderWindowForEvent({
      threadId,
      allSemanticChatGroups$,
      ensureVisibleEventTrees$,
    });

  const loadMoreRenderedChatGroups$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
      const current = renderWindowStateForThread(
        get(renderWindowStateByThreadId$),
        threadId,
      );
      const groups = get(allSemanticChatGroups$);
      signal.throwIfAborted();
      const requestedStartIndex = renderWindowStartIndex(
        groups,
        current.cursorGroupId,
      );
      const targetStartIndex = scrollTargetStartIndex(
        groups,
        get(threadScrollPosition$),
      );
      const startIndex =
        targetStartIndex === null
          ? requestedStartIndex
          : Math.min(requestedStartIndex, targetStartIndex);
      const nextStartIndex = previousRenderWindowStartIndex(groups, startIndex);
      if (nextStartIndex === startIndex) {
        return false;
      }
      set(
        renderWindowStateByThreadId$,
        setThreadRenderWindowState(
          get(renderWindowStateByThreadId$),
          threadId,
          {
            cursorGroupId: groups[nextStartIndex]?.beginEventId ?? null,
          },
        ),
      );
      // The newly revealed groups need trees before the prepend renders, so
      // the caller's scroll restoration lands on the final layout.
      await set(ensureVisibleEventTrees$, false, signal);
      return true;
    },
  );

  const resetRenderedChatGroupsIfAtBottom$ = command(({ get, set }) => {
    if (get(awayFromBottom$)) {
      return;
    }
    const current = renderWindowStateForThread(
      get(renderWindowStateByThreadId$),
      threadId,
    );
    if (current.cursorGroupId === null) {
      return;
    }
    // Resetting the cursor only shrinks the window — the visible slice is a
    // suffix, so every event it still holds already has its tree and no
    // ensure pass is needed here.
    set(
      renderWindowStateByThreadId$,
      setThreadRenderWindowState(get(renderWindowStateByThreadId$), threadId, {
        ...current,
        cursorGroupId: null,
      }),
    );
  });

  return {
    visibleRenderedChatGroups$,
    visibleRenderedChatGroupsReady$,
    ensureVisibleEventTrees$,
    preloadPreviousRenderWindowForEvent$,
    loadMoreRenderedChatGroups$,
    resetRenderedChatGroupsIfAtBottom$,
  };
}

function createEnsureVisibleEventTreesAfterScroll(
  ensureVisibleEventTrees$: Command<Promise<void>, [boolean, AbortSignal]>,
): Command<Promise<void>, [AbortSignal]> {
  return command(async ({ set }, signal: AbortSignal): Promise<void> => {
    await set(ensureVisibleEventTrees$, false, signal);
  });
}

function createOnSubscribedCommand({
  threadId,
  catchUpChatEvents$,
  cancellationRecovery,
}: Pick<RunTrackingDeps, "threadId" | "cancellationRecovery"> & {
  catchUpChatEvents$: MessageListSignals["catchUp$"];
}): Command<Promise<void>, [AbortSignal]> {
  return command(async ({ get, set }, signal: AbortSignal) => {
    L.debug("subscribeChatThread$ catchup start", { threadId });
    set(cancellationRecovery.reload$);
    await Promise.all([
      get(cancellationRecovery.pending$),
      set(reloadMountedComposerWorkflows$, signal),
      set(catchUpChatEvents$, signal),
    ]);
    signal.throwIfAborted();
    L.debug("subscribeChatThread$ catchup done", { threadId });
  });
}

const onWorkflowsChanged$ = command(
  async ({ set }, signal: AbortSignal): Promise<boolean> => {
    await set(reloadMountedComposerWorkflows$, signal);
    return false;
  },
);

function createRunTracking({
  threadId,
  messages,
  subscribeSessionOutput$,
  subscribeThinkingSummaries$,
  automationSignals,
  cancellationRecovery,
  reloadConnectorAccountPreference$,
  resourceCatalog,
}: RunTrackingDeps) {
  const onSubscribed$ = createOnSubscribedCommand({
    threadId,
    catchUpChatEvents$: messages.catchUp$,
    cancellationRecovery,
  });

  const subscribeChatThread$ = command(async ({ set }, signal: AbortSignal) => {
    L.debug("subscribeChatThread$ start", { threadId });
    await set(messages.setup$, signal);
    signal.throwIfAborted();

    await Promise.all([
      set(messages.subscribeBrowserSessions$, signal),
      set(subscribeSessionOutput$, signal),
      set(subscribeThinkingSummaries$, signal),
      set(
        subscribeChatThreadRealtime$,
        {
          threadId,
          invalidations: {
            artifactCatalog: [
              resourceCatalog.reload$,
              messages.sidebar.artifactCatalog.reload$,
            ],
            threadDetail: [
              cancellationRecovery.reload$,
              reloadConnectorAccountPreference$,
            ],
            automations: [
              automationSignals.headerAutomations.reloadAutomations$,
            ],
          },
          handlers: {
            onWorkflowsChanged$,
            onSubscribed$,
          },
        },
        signal,
      ),
    ]);
  });

  return { subscribeChatThread$ };
}

// ---------------------------------------------------------------------------
// Sub-factory: sendMessage command
// ---------------------------------------------------------------------------

interface PreparedSendMessageResult {
  prompt: string;
  attachments: ResolvedAttachFile[] | undefined;
  hasTextContent: boolean;
}

function prepareTextOnlyUserMessage(
  prompt: string,
): PreparedSendMessageResult | null {
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) {
    return null;
  }
  return {
    prompt: trimmedPrompt,
    attachments: undefined,
    hasTextContent: true,
  };
}

function userMessageForSend({
  prompt,
  editorDocument,
  generationTemplate,
  attachments,
}: {
  readonly prompt: string;
  readonly editorDocument: SendMessageOptions["editorDocument"];
  readonly generationTemplate: GenerationTemplateRequest | undefined;
  readonly attachments: ResolvedAttachFile[] | undefined;
}): UserMessageInputDocument {
  const userMessage = editorDocument
    ? editorDocument.toMessageDocument({
        selectedTemplate: generationTemplate,
        attachments,
      })
    : textToMessageDocument(prompt, undefined, attachments);
  if (!userMessage) {
    throw new Error("Failed to serialize user message");
  }
  return userMessage;
}

function queueUserMessage(
  options: QueueMessageOptions,
  result: PreparedSendMessageResult,
): UserMessageInputDocument {
  return userMessageForSend({
    prompt: result.prompt,
    editorDocument: options.editorDocument,
    generationTemplate: options.generationTemplate,
    attachments: result.attachments,
  });
}

function sendRuntimeOptions(
  features: Partial<Record<FeatureSwitchKey, boolean>>,
  modelSelection: ModelProviderSelection | null,
) {
  return {
    runOptions: runOptionsFromModelProviderSelection(modelSelection),
    realAgentInPreviewEnabled:
      features[FeatureSwitchKey.RealAgentInPreview] ?? false,
  };
}

interface SendMessageDeps {
  readonly threadId: string;
  readonly agentId: string;
  modelSelectionForSend$: Command<
    Promise<ModelSelectionForSend>,
    [AbortSignal]
  >;
  draft: DraftSignals;
  cancelDraftSync$: Command<void, []>;
  flushDraftClear$: Command<Promise<void>, [AbortSignal]>;
  sendEvent$: Command<Promise<void>, [SendChatEventInput, AbortSignal]>;
}

interface ValidatedSendMessageRequest {
  readonly prompt: string;
  readonly options: SendMessageOptions | undefined;
  readonly agentId: string;
  readonly modelSelection: ModelSelectionForSend;
}

function generationTemplateForSend(
  request: ValidatedSendMessageRequest,
  draftGenerationTemplate: GenerationTemplateRequest | undefined,
): GenerationTemplateRequest | undefined {
  return request.options?.editorDocument
    ? request.options.generationTemplate
    : draftGenerationTemplate;
}

function prepareSendMessageResult(
  textOnly: boolean,
  prompt: string,
  prepareFromDraft: () => Promise<PreparedSendMessageResult | null>,
): Promise<PreparedSendMessageResult | null> {
  return textOnly
    ? Promise.resolve(prepareTextOnlyUserMessage(prompt))
    : prepareFromDraft();
}

function flushDraftForSend(
  forward: ChatForwardContext | undefined,
  flush: () => Promise<void>,
): Promise<void> {
  return forward ? Promise.resolve() : flush();
}

function sendInputForRequest(args: {
  readonly request: ValidatedSendMessageRequest;
  readonly result: PreparedSendMessageResult;
  readonly userMessage: UserMessageInputDocument;
  readonly runOptions: ChatRunOptionsRequest | undefined;
  readonly realAgentInPreviewEnabled: boolean;
}): SendInputChatEvent {
  const { request, result } = args;
  return {
    kind: "input",
    delivery: "run",
    agentId: request.agentId,
    prompt: result.prompt,
    hasTextContent: result.hasTextContent,
    userMessage: args.userMessage,
    selectedModel: request.modelSelection.selection.selectedModel,
    ...(args.runOptions === undefined ? {} : { runOptions: args.runOptions }),
    ...(args.realAgentInPreviewEnabled ? { realAgentInPreview: true } : {}),
    ...(request.options && "computerUseHostId" in request.options
      ? { computerUseHostId: request.options.computerUseHostId ?? null }
      : {}),
    ...(request.options && "cloudBrowserEnabled" in request.options
      ? { cloudBrowserEnabled: request.options.cloudBrowserEnabled ?? false }
      : {}),
    ...(request.options?.revokesEventId === undefined
      ? {}
      : { revokesEventId: request.options.revokesEventId }),
    ...(request.options?.forward ? { source: request.options.forward } : {}),
    ...(request.options?.onOptimisticSend
      ? { onOptimisticSend: request.options.onOptimisticSend }
      : {}),
  };
}

function createPerformSendMessage(deps: SendMessageDeps) {
  const { threadId, draft, cancelDraftSync$, flushDraftClear$, sendEvent$ } =
    deps;
  return command(
    async (
      { get, set },
      request: ValidatedSendMessageRequest,
      signal: AbortSignal,
    ): Promise<boolean> => {
      const generationTemplate = generationTemplateForSend(
        request,
        get(draft.generationTemplate$),
      );
      const submissionPrompt = request.prompt;
      const result = await prepareSendMessageResult(
        request.options?.includeDraftAttachments === false,
        submissionPrompt,
        () => {
          return set(
            prepareUserMessageFromDraft$,
            draft,
            submissionPrompt,
            signal,
          );
        },
      );
      signal.throwIfAborted();
      if (!result) {
        L.debug("sendMessage$ prepare returned null, abort", { threadId });
        return false;
      }
      signal.throwIfAborted();
      const userMessage = userMessageForSend({
        prompt: result.prompt,
        editorDocument: request.options?.editorDocument,
        generationTemplate,
        attachments: result.attachments,
      });
      set(cancelDraftSync$);
      set(draft.clear$);
      const { runOptions, realAgentInPreviewEnabled } = sendRuntimeOptions(
        get(featureSwitch$),
        request.modelSelection.selection,
      );
      await Promise.all([
        flushDraftForSend(request.options?.forward, () => {
          return set(flushDraftClear$, signal);
        }),
        set(
          sendEvent$,
          sendInputForRequest({
            request,
            result,
            userMessage,
            runOptions,
            realAgentInPreviewEnabled,
          }),
          signal,
        ),
      ]);
      signal.throwIfAborted();
      L.debug("sendMessage$ POST accepted", { threadId });
      return true;
    },
  );
}

function createSendMessage(deps: SendMessageDeps) {
  const { threadId, agentId, modelSelectionForSend$ } = deps;
  const performSendMessage$ = createPerformSendMessage(deps);
  const optimisticCreateUnsettled$ =
    optimisticChatThreadCreateUnsettled(threadId);
  return command(
    async (
      { get, set },
      prompt: string,
      options: SendMessageOptions | undefined,
      signal: AbortSignal,
    ): Promise<boolean> => {
      L.debug("sendMessage$ start", { threadId, promptLen: prompt.length });
      if (get(optimisticCreateUnsettled$)) {
        return false;
      }
      const modelSelection = await set(modelSelectionForSend$, signal);
      signal.throwIfAborted();
      return await set(
        performSendMessage$,
        {
          prompt,
          options,
          agentId,
          modelSelection,
        },
        signal,
      );
    },
  );
}

function createQueueMessage(deps: SendMessageDeps) {
  const {
    threadId,
    agentId,
    modelSelectionForSend$,
    draft,
    cancelDraftSync$,
    flushDraftClear$,
    sendEvent$,
  } = deps;
  const optimisticCreateUnsettled$ =
    optimisticChatThreadCreateUnsettled(threadId);

  return command(
    async (
      { get, set },
      prompt: string,
      options: QueueMessageOptions,
      signal: AbortSignal,
    ): Promise<boolean> => {
      if (get(optimisticCreateUnsettled$)) {
        L.debug("queueMessage$ optimistic thread create unsettled, abort", {
          threadId,
        });
        return false;
      }
      const modelSelection = await set(modelSelectionForSend$, signal);
      signal.throwIfAborted();
      const result = await set(
        prepareUserMessageFromDraft$,
        draft,
        prompt,
        signal,
      );
      if (!result) {
        return false;
      }
      signal.throwIfAborted();
      const features = get(featureSwitch$);
      const userMessage = queueUserMessage(options, result);

      set(cancelDraftSync$);
      set(draft.clear$);

      const { runOptions, realAgentInPreviewEnabled } = sendRuntimeOptions(
        features,
        modelSelection.selection,
      );
      await Promise.all([
        options.forward ? Promise.resolve() : set(flushDraftClear$, signal),
        set(
          sendEvent$,
          {
            kind: "input",
            delivery: "queue",
            agentId,
            prompt: result.prompt,
            hasTextContent: result.hasTextContent,
            userMessage,
            selectedModel: modelSelection.selection.selectedModel,
            ...(runOptions === undefined ? {} : { runOptions }),
            ...(realAgentInPreviewEnabled ? { realAgentInPreview: true } : {}),
            ...(options.computerUseHostId === undefined
              ? {}
              : { computerUseHostId: options.computerUseHostId }),
            ...(options.cloudBrowserEnabled === undefined
              ? {}
              : { cloudBrowserEnabled: options.cloudBrowserEnabled }),
            ...(options.forward ? { source: options.forward } : {}),
            ...(options.onOptimisticSend
              ? { onOptimisticSend: options.onOptimisticSend }
              : {}),
          },
          signal,
        ),
      ]);
      signal.throwIfAborted();

      return true;
    },
  );
}

interface RecallMessageDeps {
  readonly threadId: string;
  readonly agentId: string;
  readonly queuedEvents$: ChatEventSignals["queuedEvents$"];
  draft: DraftSignals;
  queueDraftSync$: Command<Promise<void>, [AbortSignal]>;
  sendEvent$: Command<Promise<void>, [SendChatEventInput, AbortSignal]>;
}

function createRecallMessage(deps: RecallMessageDeps) {
  const { agentId, queuedEvents$, draft, queueDraftSync$, sendEvent$ } = deps;

  return command(async ({ get, set }, eventId: string, signal: AbortSignal) => {
    const event = get(queuedEvents$).find((candidate) => {
      return candidate.id === eventId;
    });
    if (!event || event.eventType !== "input.prompt") {
      return;
    }
    const userMessage = event.userMessage;
    const templatePart = userMessage.parts.find((part) => {
      return part.type === "template";
    });
    await set(
      draft.seed$,
      {
        content: messageDocumentToPrompt(userMessage) ?? "",
        userMessage,
        generationTemplate:
          templatePart?.type === "template" ? templatePart.template : undefined,
        attachments: userMessageFileAttachments(userMessage).map(
          createRestoredAttachment,
        ),
      },
      signal,
    );

    await set(
      sendEvent$,
      {
        kind: "revoke",
        agentId,
        revokesEventId: event.id,
      },
      signal,
    );
    signal.throwIfAborted();
    await set(queueDraftSync$, signal);
    signal.throwIfAborted();
  });
}

function createSkipAutomationEvent({
  agentId,
  queuedEvents$,
  sendEvent$,
}: RecallMessageDeps) {
  return command(
    async (
      { get, set },
      eventId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      const event = get(queuedEvents$).find((candidate) => {
        return (
          candidate.id === eventId && candidate.eventType === "input.automation"
        );
      });
      if (!event) {
        return;
      }

      await set(
        sendEvent$,
        {
          kind: "revoke",
          agentId,
          revokesEventId: event.id,
        },
        signal,
      );
      signal.throwIfAborted();
    },
  );
}

interface MessageCommandsDeps extends SendMessageDeps, RecallMessageDeps {
  readonly liveRunIds$: ChatEventSignals["liveRunIds$"];
}

function createMessageCommands(deps: MessageCommandsDeps) {
  return {
    sendMessage$: createSendMessage(deps),
    queueMessage$: createQueueMessage(deps),
    recallMessage$: createRecallMessage(deps),
  };
}

function createThreadMessageActions(deps: MessageCommandsDeps) {
  return {
    ...createMessageCommands(deps),
    skipAutomationEvent$: createSkipAutomationEvent(deps),
    cancelRun$: createInterruptLiveRuns(deps),
  };
}

/**
 * Stop interrupts the thread's live runs only. Queued follow-ups stay in the
 * queue bar; the user recalls them one by one.
 */
function createInterruptLiveRuns({
  threadId,
  agentId,
  liveRunIds$,
  sendEvent$,
}: {
  readonly threadId: string;
  readonly agentId: string;
  readonly liveRunIds$: ChatEventSignals["liveRunIds$"];
  sendEvent$: Command<Promise<void>, [SendChatEventInput, AbortSignal]>;
}) {
  const optimisticCreateUnsettled$ =
    optimisticChatThreadCreateUnsettled(threadId);
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    if (get(optimisticCreateUnsettled$)) {
      L.debug("cancelRun$ optimistic thread create unsettled, skip", {
        threadId,
      });
      return;
    }
    await Promise.all(
      get(liveRunIds$).map((runId) => {
        return set(
          sendEvent$,
          {
            kind: "interrupt",
            agentId,
            interruptsRunId: runId,
          },
          signal,
        );
      }),
    );
    signal.throwIfAborted();
  });
}

// ---------------------------------------------------------------------------
// Sub-factory: thinking indicator
// ---------------------------------------------------------------------------

function createThinkingIndicatorSignals() {
  const thinkingPhrase$ = computed((get) => {
    get(locale$);
    return i18n.t(($) => {
      return $.chat.run.thinking.default;
    });
  });
  return { thinkingPhrase$ };
}

// ---------------------------------------------------------------------------
// Factory: createChatPanelSignals
// ---------------------------------------------------------------------------

function publicChatThreadEventSignals(events: MessageListSignals) {
  return {
    firstTaskUpgradeEligible$: events.firstTaskUpgradeEligible$,
    latestRunFinishCreatedAt$: events.latestRunFinishCreatedAt$,
    latestAssistantTextCreatedAt$: events.latestAssistantTextCreatedAt$,
    visibleRenderedChatGroups$: events.visibleRenderedChatGroups$,
    visibleRenderedChatGroupsReady$: events.visibleRenderedChatGroupsReady$,
    visibleRunUsageSignals$: events.visibleRunUsageSignals$,
    readyScrollAfterRenderRequest$: events.readyScrollAfterRenderRequest$,
    initialEventsReady$: events.initialEventsReady$,
    assistantErrorRecovery$: events.assistantErrorRecovery$,
    assistantErrorRecoveryEventId$: events.assistantErrorRecoveryEventId$,
    retryAssistantError$: events.retryAssistantError$,
    resetCodexSubscriptionAndRetry$: events.resetCodexSubscriptionAndRetry$,
    eventImageGroups$: events.eventImageGroups$,
    browserSessionSignals: events.browserSessionSignals,
    hasEvents$: events.hasEvents$,
    thinkingIndicators$: events.thinkingIndicators$,
    runFinished$: events.runFinished$,
    recommendedFollowupSource$: events.recommendedFollowupSource$,
    donePhrase$: events.donePhrase$,
    loadEarlierGroupsAfterScroll$: events.loadEarlierGroupsAfterScroll$,
    resetRenderedChatGroupsIfAtBottom$:
      events.resetRenderedChatGroupsIfAtBottom$,
  };
}

interface CreateChatThreadComposerSignalsOptions {
  readonly chatEvents: ChatEventSignals;
  readonly agentId: string;
  readonly draft: DraftSignals;
  readonly loadDraft$: Command<Promise<void>, [AbortSignal]>;
  readonly queueDraftSync$: Command<Promise<void>, [AbortSignal]>;
  readonly modelSelection: ReturnType<typeof createModelSelection>;
  readonly computerUseHostSelection: ReturnType<
    typeof createComputerUseHostSelection
  >;
  readonly messageActions: ReturnType<typeof createThreadMessageActions>;
  readonly cancellationRecoveryPending$: Computed<Promise<boolean>>;
  readonly forward?: ChatForwardContext;
  readonly onOptimisticSend?: () => void;
  readonly connector: ComposerSignals["connector"];
}

interface ChatThreadComposerContext {
  readonly threadMeta$: Computed<ThreadMeta | null>;
  readonly preserveThreadDraft?: boolean;
  readonly agentId: string;
  readonly cancellationRecoveryPending$: Computed<Promise<boolean>>;
  readonly forward?: ChatForwardContext;
  readonly onOptimisticSend?: () => void;
}

function createThreadSubmitMessageSignal(
  options: CreateChatThreadComposerSignalsOptions,
) {
  const { computerUseHostSelection, messageActions } = options;
  return command(
    async (
      { get, set },
      action: "send" | "queue",
      submission: ComposerSubmission,
      signal: AbortSignal,
    ): Promise<boolean> => {
      const explicit = get(computerUseHostSelection.computerUseHostIdExplicit$);
      const computerUseHostId = get(
        computerUseHostSelection.computerUseHostId$,
      );
      const cloudBrowserEnabled = get(
        computerUseHostSelection.cloudBrowserEnabled$,
      );
      const submitted =
        action === "queue"
          ? await set(
              messageActions.queueMessage$,
              submission.prompt,
              {
                computerUseHostId: explicit ? computerUseHostId : undefined,
                cloudBrowserEnabled: explicit ? cloudBrowserEnabled : undefined,
                generationTemplate: submission.generationTemplate,
                editorDocument: submission.editorDocument,
                ...(options.forward ? { forward: options.forward } : {}),
                ...(options.onOptimisticSend
                  ? { onOptimisticSend: options.onOptimisticSend }
                  : {}),
              },
              signal,
            )
          : await set(
              messageActions.sendMessage$,
              submission.prompt,
              {
                ...(explicit ? { computerUseHostId } : {}),
                ...(explicit ? { cloudBrowserEnabled } : {}),
                generationTemplate: submission.generationTemplate,
                editorDocument: submission.editorDocument,
                ...(options.forward ? { forward: options.forward } : {}),
                ...(options.onOptimisticSend
                  ? { onOptimisticSend: options.onOptimisticSend }
                  : {}),
              },
              signal,
            );
      if (submitted) {
        set(computerUseHostSelection.clearComputerUseHostIdOverride$);
      }
      return submitted;
    },
  );
}

function createThreadPendingActionSignals(
  options: CreateChatThreadComposerSignalsOptions,
) {
  const { messageActions } = options;
  const removeQueuedMessage$ = command(
    async ({ set }, eventId: string, signal: AbortSignal): Promise<void> => {
      await set(messageActions.recallMessage$, eventId, signal);
    },
  );
  const removeAutomationEvent$ = command(
    async ({ set }, eventId: string, signal: AbortSignal): Promise<void> => {
      await set(messageActions.skipAutomationEvent$, eventId, signal);
    },
  );
  return {
    removeQueuedMessage$,
    removeAutomationEvent$,
  };
}

function createChatThreadComposerSignals(
  options: CreateChatThreadComposerSignalsOptions,
): ComposerSignals {
  const { modelSelection, computerUseHostSelection, messageActions } = options;
  const composerModelSelection$ = computed(
    async (get): Promise<ModelProviderSelection> => {
      const selectedModel = await get(modelSelection.effectiveSelectedModel$);
      const modelSettings = get(modelSelection.modelSettings$);
      return {
        selectedModel,
        ...((await get(modelSelection.codexFastModeActive$))
          ? { codexServiceTier: "fast" as const }
          : {}),
        modelSettings,
      };
    },
  );
  return createComposerSignals({
    agentId: options.agentId,
    connector: options.connector,
    draft: {
      signals: options.draft,
      load$: options.forward ? noOpComposerDraftAction$ : options.loadDraft$,
      save$: options.forward
        ? noOpComposerDraftAction$
        : options.queueDraftSync$,
    },
    eventSignals: options.chatEvents,
    threadId: options.chatEvents.threadId,
    voiceDraftTarget: `thread:${options.chatEvents.threadId}`,
    singleLineOnMobile: true,
    forwardComposer: options.forward !== undefined,
    modelSelection$: composerModelSelection$,
    selectedModelOauthAvailable$: modelSelection.selectedModelOauthAvailable$,
    setModelSelection$: modelSelection.setModelSelection$,
    configureSelectedModel$: modelSelection.configureSelectedModel$,
    computerUseHostId$: computerUseHostSelection.computerUseHostId$,
    cloudBrowserEnabled$: computerUseHostSelection.cloudBrowserEnabled$,
    setComputerUseHostId$: computerUseHostSelection.setComputerUseHostId$,
    setCloudBrowserEnabled$: computerUseHostSelection.setCloudBrowserEnabled$,
    submitMessage$: createThreadSubmitMessageSignal(options),
    cancelRun$: messageActions.cancelRun$,
    cancellationRecoveryPending$: options.cancellationRecoveryPending$,
    ...createThreadPendingActionSignals(options),
  });
}

// A draft handoff owns a finite load/save before the destination page mounts.
// A previous save can fail after finish cleared its merge marker, so absence
// of that marker is not proof that the installed handoff reached storage.
export const resumeThreadDraftHandoff$ = command(
  async ({ get, set }, threadId: string, signal: AbortSignal) => {
    const { draft, persistence$ } = set(ensureThreadDraft$, threadId);
    const persistence = get(persistence$);
    const handoff = get(draft.composerDraftHandoff$);
    if (handoff) {
      await set(persistence.loadDraft$, signal);
    } else {
      await set(draft.reconcileComposerDraft$, signal);
      await set(persistence.queueDraftSync$, signal);
    }
  },
);

function createThreadComposerSignalsWithContext(
  threadId: string,
  chatEvents: ChatEventSignals,
  context: ChatThreadComposerContext,
  draft: DraftSignals,
  persistence: ThreadDraftPersistence,
): ComposerSignals {
  const connector = createComposerConnectorSignals(context.agentId, threadId);
  const modelSelection = createModelSelection(threadId, context.threadMeta$);
  const modelSelectionForSend$ = createModelSelectionForSend(modelSelection);
  const computerUseHostSelection = createComputerUseHostSelection(
    threadId,
    context.threadMeta$,
  );
  const { queueDraftSync$, cancelDraftSync$, flushDraftClear$, loadDraft$ } =
    context.preserveThreadDraft
      ? {
          queueDraftSync$: noOpComposerDraftAction$,
          cancelDraftSync$: command(() => {
            return undefined;
          }),
          flushDraftClear$: noOpComposerDraftAction$,
          loadDraft$: noOpComposerDraftAction$,
        }
      : persistence;
  const messageActions = createThreadMessageActions({
    threadId,
    agentId: context.agentId,
    modelSelectionForSend$,
    queuedEvents$: chatEvents.queuedEvents$,
    liveRunIds$: chatEvents.liveRunIds$,
    draft,
    queueDraftSync$,
    cancelDraftSync$,
    flushDraftClear$,
    sendEvent$: chatEvents.sendEvent$,
  });
  return createChatThreadComposerSignals({
    chatEvents,
    agentId: context.agentId,
    draft,
    loadDraft$,
    queueDraftSync$,
    modelSelection,
    computerUseHostSelection,
    messageActions,
    cancellationRecoveryPending$: context.cancellationRecoveryPending$,
    connector,
    forward: context.forward,
    onOptimisticSend: context.onOptimisticSend,
  });
}

/**
 * Creates the public composer signals for a chat thread.
 *
 * @public
 */
export function createThreadComposerSignals(
  threadId: string,
  agentId: string,
  chatEvents: ChatEventSignals,
  options: {
    readonly forward?: ChatForwardContext;
    readonly onOptimisticSend?: () => void;
    readonly preserveThreadDraft?: boolean;
  } = {},
): ComposerSignals {
  const threadMeta$ = createThreadMeta(threadId);
  const cancellationRecovery = createCancellationRecoverySignals(threadId);
  const draft = createDraftSignals();
  const threadDraft$ = createRemoteChatThreadDraft(threadId);
  return createThreadComposerSignalsWithContext(
    threadId,
    chatEvents,
    {
      threadMeta$,
      agentId,
      cancellationRecoveryPending$: cancellationRecovery.pending$,
      forward: options.forward,
      onOptimisticSend: options.onOptimisticSend,
      preserveThreadDraft: options.preserveThreadDraft,
    },
    draft,
    createThreadDraftPersistence(threadId, draft, threadDraft$),
  );
}

/**
 * Creates the complete signal graph of one chat panel. The graph carries no
 * AbortSignal, so a pane can derive it from the thread it shows.
 */
export function createChatPanelSignals(
  threadId: string,
  agentId: string,
  draft: DraftSignals,
  persistence: ThreadDraftPersistence,
): ChatPanelSignals {
  const chatEvents = createChatEventSignals(threadId);
  const artifact = createArtifacts(threadId);
  const threadDraft$ = createRemoteChatThreadDraft(threadId);
  const threadMeta$ = createThreadMeta(threadId);
  const optimisticCreateUnsettled$ =
    optimisticChatThreadCreateUnsettled(threadId);
  const threadMetadata = createThreadMetadata(threadMeta$);
  const sessionOutput = createSessionOutputStreamSignals(threadId, chatEvents);
  const activity = createThreadActivitySummarySignals(
    threadId,
    chatEvents,
    threadMeta$,
  );
  const container = createChatThreadContainerSignals();
  const threadOwned = createThreadOwnedSignals(threadId);
  const cancellationRecovery = createCancellationRecoverySignals(threadId);
  const composer = createThreadComposerSignalsWithContext(
    threadId,
    chatEvents,
    {
      threadMeta$,
      agentId,
      cancellationRecoveryPending$: cancellationRecovery.pending$,
    },
    draft,
    persistence,
  );
  const messagePipeline = createChatThreadMessagePipeline({
    chatActionContext: { threadId, agentId },
    chatEvents,
    connector: composer.connector,
    thinkingSummaries$: activity.thinkingSummaries$,
  });
  const refreshMessages$ = command(async ({ set }, signal: AbortSignal) => {
    await set(messagePipeline.ensureVisibleEventTrees$, true, signal);
  });
  const messages: MessageListSignals = {
    ...messagePipeline,
    ...artifact,
  };
  const feedback = createChatThreadFeedbackSignals(
    threadId,
    composer.feedback,
    messages.scroll.isProgrammaticScrollEvent$,
  );
  const sharing = createChatThreadSharingSignals(
    threadId,
    messages.scroll,
    messagePipeline.allChatGroups$,
    feedback.close$,
  );
  const locator = createChatConversationLocatorSignals({
    threadId,
    scrollContainer$: messages.scroll.scrollContainer$,
    allSemanticChatGroups$: messagePipeline.allSemanticChatGroups$,
    scrollToEvent$: messages.scroll.scrollToEvent$,
  });
  const runTracking = createRunTracking({
    threadId,
    messages,
    subscribeThinkingSummaries$: activity.subscribe$,
    subscribeSessionOutput$: sessionOutput.subscribe$,
    automationSignals: threadOwned,
    cancellationRecovery,
    reloadConnectorAccountPreference$:
      composer.connector.accounts.reloadPreference$,
    resourceCatalog: artifact.resourceCatalog,
  });
  const relations = createChatRelationSignals(threadId, messagePipeline);
  return {
    threadId,
    agentId,
    threadDraft$,
    refreshMessages$,
    threadMeta$,
    optimisticCreateUnsettled$,
    ...threadMetadata,
    scrollContainerOnRef$: messages.scroll.scrollContainerOnRef$,
    scrollContentOnRef$: messages.scroll.scrollContentOnRef$,
    composerLayoutOnRef$: createChatComposerLayoutOnRef(
      composer.editor.editor,
      messages.scroll.restoreScrollPosition$,
    ),
    scrollCommitOnRef$: messages.scroll.scrollCommitOnRef$,
    scrollContainer$: messages.scroll.scrollContainer$,
    threadScrollPosition$: messages.scroll.threadScrollPosition$,
    awayFromBottom$: messages.scroll.awayFromBottom$,
    scrollTo$: messages.scroll.scrollTo$,
    scrollToTop$: messages.scroll.scrollToTop$,
    scrollToBottom$: messages.scroll.scrollToBottom$,
    restoreScrollPosition$: messages.scroll.restoreScrollPosition$,
    ...container,
    composer,
    feedback,
    sharing,
    pin: createChatThreadPinSignals(threadId, threadMeta$),
    locator,
    mail: createThreadMailSignals(
      threadId,
      messagePipeline.mailDraftCardSignals,
      messagePipeline.latestRunFinishCreatedAt$,
    ),
    resources: createChatResourceSignals(
      artifact.resourceCatalog,
      messagePipeline.initialEventsReady$,
      relations,
    ),
    relations,
    browserPresence: createBrowserPresenceSignals({
      latestRunId$: messages.latestRunId$,
      liveRunId$: messages.liveRunId$,
      composer,
    }),
    ...threadOwned,
    sidebar: messages.sidebar,
    ...publicChatThreadEventSignals(messages),
    subscribeChatThread$: runTracking.subscribeChatThread$,
    ...createThinkingIndicatorSignals(),
    artifacts$: messages.artifacts$,
  };
}
