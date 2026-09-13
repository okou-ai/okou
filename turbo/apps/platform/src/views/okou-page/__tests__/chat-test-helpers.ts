import {
  withModelReasoningEffort,
  type ModelSettings,
  type ReasoningEffort,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { waitFor } from "@testing-library/react";
import { createChatEvent } from "../../../mocks/mock-helpers.ts";
import {
  chatThreadsContract,
  chatThreadByIdContract,
  chatThreadComputerUseHostContract,
  chatThreadDraftContract,
  chatThreadModelSelectionContract,
  chatThreadEventsContract,
  chatEventsContract,
  MODEL_FIRST_SELECTION_PROVIDER_ID,
  type ChatRunOptionsRequest,
  type ChatThreadServiceTier,
  type CodexServiceTier,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { logsByIdContract } from "@okouai/api-contracts/contracts/logs";
import type { SupportedRunModel } from "@okouai/api-contracts/contracts/model-providers";
import {
  runsCancelContract,
  runsByIdContract,
} from "@okouai/api-contracts/contracts/run-routes";
import { computerUseHostsContract } from "@okouai/api-contracts/contracts/computer-use";
import { queuePositionContract } from "@okouai/api-contracts/contracts/queue-position";
import type { ConnectorAccountSelection } from "@okouai/api-contracts/contracts/connector-accounts";
import type { RunStatus } from "@okouai/api-contracts/contracts/runs";
import {
  mockChatEventRows,
  normalizeMockChatEvents,
  type MockChatEventInput,
} from "./chat-event-test-helpers.ts";

import { fill } from "../../../__tests__/page-helper.ts";
import {
  chatEventRowsResponse,
  type TestContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { nowDate } from "../../../lib/time.ts";

export const PLACEHOLDER = "Ask me to automate workflows, manage tasks...";

const MOCK_RUN_ID = "d0000000-0000-4000-a000-000000000001";

interface ModelSelectionRequest {
  readonly modelProviderId: string;
  readonly selectedModel: SupportedRunModel;
}

function modelFirstSelection(
  selectedModel: SupportedRunModel,
): ModelSelectionRequest {
  return {
    modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
    selectedModel,
  };
}

function modelSelectionFromBody(body: {
  readonly model?: SupportedRunModel | null;
}): ModelSelectionRequest | null | undefined {
  if (body.model === undefined) {
    return undefined;
  }
  return body.model === null ? null : modelFirstSelection(body.model);
}

function mountedComposerEditor(): HTMLElement {
  const editor = document.querySelector(
    '[data-slot="chat-composer-card"] [contenteditable="true"]',
  );
  if (!(editor instanceof HTMLElement)) {
    throw new Error("Composer editor is not mounted");
  }
  return editor;
}

/**
 * The composer editor is mounted on first paint and mounted again once page
 * bootstrap settles, so an element captured too early can be detached by the
 * time a test types into it — and typing into a detached editor silently does
 * nothing. Type into the editor that is currently mounted and retry until the
 * draft actually lands.
 */
export async function fillComposer(
  input: Element,
  text: string,
): Promise<void> {
  await waitFor(async () => {
    await fill(input.isConnected ? input : mountedComposerEditor(), text);
    const editor = input.isConnected ? input : mountedComposerEditor();
    if (!(editor.textContent ?? "").includes(text)) {
      throw new Error("Composer draft did not land in the mounted editor");
    }
  });
}

interface ThreadListItem {
  id: string;
  title: string | null;
  agent: { id: string; avatarUrl: string | null };
  createdAt: string;
  updatedAt: string;
  pinnedAt?: string | null;
  renamedAt?: string | null;
  selectedModel?: string | null;
  serviceTier?: "priority" | null;
  modelSettings?: ModelSettings;
  computerUseHostId?: string | null;
  cloudBrowserEnabled?: boolean;
  selectedVideoModel?: string | null;
}

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

export function threadListSnapshot(threads: readonly ThreadListItem[]) {
  return threads.map((thread) => {
    return {
      id: thread.id,
      agentId: thread.agent.id,
      title: thread.title,
      sortAt: thread.updatedAt,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      pinnedAt: thread.pinnedAt ?? null,
      renamedAt: thread.renamedAt ?? null,
      selectedModel: thread.selectedModel ?? null,
      serviceTier: thread.serviceTier ?? null,
      modelSettings: thread.modelSettings ?? {},
      computerUseHostId: thread.computerUseHostId ?? null,
      cloudBrowserEnabled: thread.cloudBrowserEnabled ?? false,
      selectedVideoModel: thread.selectedVideoModel ?? null,
    };
  });
}

interface MockLifecycleControl {
  setRunStatus: (status: RunStatus) => void;
  setQueuePosition: (n: number) => void;
  setRunOutput: (content: string) => void;
  setThreadList: (list: ThreadListItem[]) => void;
  setCodexServiceTier: (tier: CodexServiceTier | null) => void;
  completeRun: (content?: string) => void;
  failRun: (error: string) => void;
  cancelRun: () => void;
}

type MockChatEvent = MockChatEventInput;

function cloneMockChatEvent<T extends MockChatEventInput>(event: T): T {
  return structuredClone(event);
}

function isRecallEventBody(body: {
  revokesEventId?: string;
  prompt?: string;
}): body is {
  revokesEventId: string;
  threadId: string;
  clientEventId?: string;
} {
  return body.revokesEventId !== undefined && body.prompt === undefined;
}

function isInterruptEventBody(body: { interruptsRunId?: string }): body is {
  interruptsRunId: string;
  threadId: string;
  clientEventId?: string;
} {
  return body.interruptsRunId !== undefined;
}

function appendSeedChatEvents(args: {
  pagedEvents: (MockChatEvent & { id: string })[];
  chatEvents: MockChatEvent[];
  activeRunIds: readonly string[];
}) {
  const completionCandidateRuns = new Map<string, string>();
  const terminalRunIds = new Set<string>();
  for (let i = 0; i < args.chatEvents.length; i++) {
    const seed = args.chatEvents[i]!;
    const runId = "runId" in seed ? seed.runId : MOCK_RUN_ID;
    collectSeedRunState({
      seed,
      runId,
      completionCandidateRuns,
      terminalRunIds,
    });
    args.pagedEvents.push({
      ...seed,
      id: seed.id ?? `msg-seed-${i}`,
      runId,
    });
  }
  appendDefaultCompletionMarkers({
    pagedEvents: args.pagedEvents,
    completionCandidateRuns,
    terminalRunIds,
    activeRunIds: new Set(args.activeRunIds),
  });
}

function markerCreatedAtAfter(createdAt: string): string {
  return new Date(new Date(createdAt).getTime() + 1).toISOString();
}

function addCompletionCandidate(
  runs: Map<string, string>,
  runId: string,
  createdAt: string,
): void {
  const markerCreatedAt = markerCreatedAtAfter(createdAt);
  const current = runs.get(runId);
  if (current === undefined || current < markerCreatedAt) {
    runs.set(runId, markerCreatedAt);
  }
}

function collectSeedRunState(args: {
  seed: MockChatEvent;
  runId: string | undefined;
  completionCandidateRuns: Map<string, string>;
  terminalRunIds: Set<string>;
}) {
  if (!("runId" in args.seed) && args.runId !== undefined) {
    addCompletionCandidate(
      args.completionCandidateRuns,
      args.runId,
      args.seed.createdAt,
    );
  }
  if (
    args.seed.role === "assistant" &&
    args.seed.runId !== undefined &&
    args.seed.runLifecycleEvent !== undefined
  ) {
    args.terminalRunIds.add(args.seed.runId);
  }
  if (
    args.seed.role === "assistant" &&
    args.runId !== undefined &&
    args.seed.content !== null &&
    args.seed.runEventId === undefined
  ) {
    addCompletionCandidate(
      args.completionCandidateRuns,
      args.runId,
      args.seed.createdAt,
    );
  }
}

function appendDefaultCompletionMarkers(args: {
  pagedEvents: (MockChatEvent & { id: string })[];
  completionCandidateRuns: Map<string, string>;
  terminalRunIds: Set<string>;
  activeRunIds: Set<string>;
}) {
  for (const [runId, createdAt] of args.completionCandidateRuns) {
    if (args.terminalRunIds.has(runId) || args.activeRunIds.has(runId)) {
      continue;
    }
    args.pagedEvents.push({
      id: `msg-seed-marker-${runId}`,
      role: "assistant",
      content: null,
      runId,
      runLifecycleEvent: "completed",
      createdAt,
    });
  }
}

function initialMockThreadModelSelection(
  options:
    | {
        selectedModel?: SupportedRunModel | null;
        codexServiceTier?: CodexServiceTier | null;
        modelSettings?: ModelSettings;
        reasoningEffort?: ReasoningEffort | null;
      }
    | undefined,
) {
  const selectedModel = options?.selectedModel ?? null;
  const modelSettings =
    options?.modelSettings ??
    (selectedModel && options?.reasoningEffort
      ? withModelReasoningEffort(
          {},
          {
            model: selectedModel,
            effort: options.reasoningEffort,
          },
        )
      : {});
  return {
    selectedModel,
    codexServiceTier: options?.codexServiceTier ?? null,
    modelSettings,
  };
}

export function mockChatLifecycle(
  context: TestContext,
  options?: {
    threadId?: string;
    historyEvents?: MockChatEvent[];
    chatEvents?: MockChatEvent[];
    threadTitle?: string | null;
    selectedModel?: SupportedRunModel | null;
    codexServiceTier?: CodexServiceTier | null;
    modelSettings?: ModelSettings;
    reasoningEffort?: ReasoningEffort | null;
    computerUseHostId?: string | null;
    cloudBrowserEnabled?: boolean;
    activeRunIds?: string[];
    onQueuedEventAppend?: (body: {
      content?: string;
      hasTextContent?: boolean;
      clientEventId: string;
      userMessage?: UserMessageDocument;
      modelSelection?: ModelSelectionRequest | null;
      runOptions?: ChatRunOptionsRequest;
    }) => void;
    onRecallEventAppend?: (body: {
      revokesEventId: string;
      clientEventId: string;
    }) => void;
    onInterruptEventAppend?: (body: {
      interruptsRunId: string;
      clientEventId: string;
    }) => void;
    onComputerUseHostUpdate?: (body: {
      computerUseHostId: string | null;
      cloudBrowserEnabled?: boolean;
    }) => void;
    /**
     * Promise the append handler awaits before responding. Lets a test observe
     * the optimistic queued row before the server round-trip completes.
     */
    appendGate?: Promise<void>;
    /**
     * Gate or per-send gate factory awaited before the initial send responds.
     * Lets tests keep an optimistic run mounted while interacting with it.
     */
    sendGate?: Promise<void> | (() => Promise<void>);
    /**
     * Promise the thread metadata handler awaits before responding. Lets tests
     * prove event-derived UI does not wait for activeRunIds metadata.
     */
    threadGate?: Promise<void>;
    afterInitialEventsList?: () => void;
    onRunCreate?: (body: {
      prompt?: string;
      clientEventId?: string;
      clientThreadId?: string;
      hasTextContent?: boolean;
      userMessage?: UserMessageDocument;
      model?: string;
      modelSelection?: ModelSelectionRequest | null;
      runOptions?: ChatRunOptionsRequest;
      computerUseHostId?: string | null;
      cloudBrowserEnabled?: boolean;
      revokesEventId?: string;
      sourceRunId?: string;
    }) => void;
    onSendRequest?: (body: {
      prompt: string;
      threadId?: string;
      clientThreadId?: string;
      userMessage?: UserMessageDocument;
      model?: string;
      modelSelection?: ModelSelectionRequest | null;
      computerUseHostId?: string | null;
      cloudBrowserEnabled?: boolean;
      sourceRunId?: string;
    }) => void;
    onThreadCreate?: (body: {
      clientThreadId?: string;
      eventId?: string;
      model?: SupportedRunModel;
      modelSelection: ModelSelectionRequest;
      serviceTier?: ChatThreadServiceTier | null;
      reasoningEffort?: ReasoningEffort;
      imageModel?: string;
      videoModel?: string;
      connectorSelections?: readonly ConnectorAccountSelection[];
    }) => void;
    onModelSelectionUpdate?: (body: {
      model?: string | null;
      modelSelection?: ModelSelectionRequest | null;
      codexServiceTier?: CodexServiceTier | null;
      reasoningEffort?: ReasoningEffort;
    }) => void;
  },
): MockLifecycleControl {
  let threadId = options?.threadId ?? "b0000000-0000-4000-a000-000000000900";
  const historyEvents = options?.historyEvents ?? [];
  const chatEvents = options?.chatEvents ?? [];

  let runStatus: RunStatus = "running";
  let runError: string | null = null;
  let queuePosition = 0;
  let resultContent = "";
  let threadListOverride: ThreadListItem[] | null = null;
  let runPrompt: string | null = null;
  let runUserEventId = "msg-user-sent";
  let runUserMessage: UserMessageDocument | undefined;
  let runAssociated = false;
  let runSequence = 0;
  let currentRunId = MOCK_RUN_ID;
  const initialDynamicSeqId = Math.max(
    (historyEvents.length + chatEvents.length + 1) * 4,
    ...[...historyEvents, ...chatEvents].flatMap((event) => {
      return event.seqId === undefined ? [] : [event.seqId];
    }),
  );
  let nextDynamicSeqId = initialDynamicSeqId;
  let runUserSeqId: number | undefined;
  let assistantSeqId: number | undefined;
  let completedMarkerSeqId: number | undefined;
  let threadTitle: string | null = options?.threadTitle ?? null;
  let { selectedModel, codexServiceTier, modelSettings } =
    initialMockThreadModelSelection(options);
  let computerUseHostId: string | null = options?.computerUseHostId ?? null;
  let cloudBrowserEnabled = options?.cloudBrowserEnabled ?? false;
  let latestThreadEventId: string | null = null;
  let latestThreadEventSeqId: number | null = null;
  const queuedEvents: MockChatEvent[] = [];
  const lifecycleEvents: MockChatEvent[] = [];
  let activeRunIds = options?.activeRunIds ?? [];

  const allocateDynamicSeqId = (): number => {
    nextDynamicSeqId++;
    return nextDynamicSeqId;
  };

  const markRunCancelled = () => {
    if (runStatus === "cancelled") {
      return;
    }
    runStatus = "cancelled";
    runError = "Run cancelled";
    assistantSeqId = allocateDynamicSeqId();
    createChatEvent(threadId);
  };

  const appendRecallControlEvent = (body: {
    revokesEventId: string;
    threadId: string;
    clientEventId?: string;
  }) => {
    const clientEventId = body.clientEventId ?? crypto.randomUUID();
    const now = nowDate().toISOString();
    options?.onRecallEventAppend?.({
      revokesEventId: body.revokesEventId,
      clientEventId,
    });
    queuedEvents.push({
      id: clientEventId,
      role: "user" as const,
      content: null,
      revokesEventId: body.revokesEventId,
      seqId: allocateDynamicSeqId(),
      createdAt: now,
    });
    return { runId: null, threadId: body.threadId, createdAt: now };
  };

  const appendInterruptControlEvent = (body: {
    interruptsRunId: string;
    threadId: string;
    clientEventId?: string;
  }) => {
    const clientEventId = body.clientEventId ?? crypto.randomUUID();
    const now = nowDate().toISOString();
    options?.onInterruptEventAppend?.({
      interruptsRunId: body.interruptsRunId,
      clientEventId,
    });
    queuedEvents.push({
      id: clientEventId,
      role: "user" as const,
      content: null,
      interruptsRunId: body.interruptsRunId,
      seqId: allocateDynamicSeqId(),
      createdAt: now,
    });
    markRunCancelled();
    return { runId: null, threadId: body.threadId, createdAt: now };
  };

  const terminal = new Set(["completed", "failed", "cancelled", "timeout"]);

  const associatedRunEvents = (): (MockChatEvent & { id: string })[] => {
    if (!runAssociated) {
      return [];
    }
    const events: (MockChatEvent & { id: string })[] = [
      {
        id: runUserEventId,
        role: "user",
        content: runPrompt ?? "Hello",
        ...(runUserMessage ? { userMessage: runUserMessage } : {}),
        runId: currentRunId,
        seqId: runUserSeqId,
        createdAt: "2026-03-10T00:00:01Z",
      },
      {
        id: `msg-assistant-${currentRunId}`,
        role: "assistant",
        content: resultContent || null,
        runId: currentRunId,
        error: runError ?? undefined,
        runLifecycleEvent:
          runStatus === "failed" || runStatus === "cancelled"
            ? runStatus
            : undefined,
        seqId: assistantSeqId,
        createdAt: "2026-03-10T00:00:02Z",
      },
    ];
    if (runStatus === "completed") {
      events.push({
        id: `msg-assistant-marker-${currentRunId}`,
        role: "assistant",
        content: null,
        runId: currentRunId,
        runLifecycleEvent: "completed",
        seqId: completedMarkerSeqId,
        createdAt: "2026-03-10T00:00:03Z",
      });
    }
    return events;
  };

  const archiveAssociatedRun = (): void => {
    lifecycleEvents.push(...associatedRunEvents().map(cloneMockChatEvent));
    runAssociated = false;
  };

  const hasActiveRun = () => {
    return (
      activeRunIds.length > 0 || (runAssociated && !terminal.has(runStatus))
    );
  };

  const effectiveThreadList = () => {
    if (threadListOverride !== null) {
      return threadListOverride;
    }
    if (!UUID_PATTERN.test(threadId)) {
      return [];
    }
    return [
      {
        id: threadId,
        title: threadTitle,
        agent: {
          id: "c0000000-0000-4000-a000-000000000001",
          avatarUrl: null,
        },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
        pinnedAt: null,
        selectedModel,
        modelSettings,
        serviceTier: codexServiceTier === "fast" ? ("priority" as const) : null,
        computerUseHostId,
        cloudBrowserEnabled,
      },
    ];
  };

  const buildCanonicalEvents = (): (MockChatEvent & {
    id: string;
    seqId: number;
  })[] => {
    const historicalEvents = historyEvents.map((event, i) => {
      return {
        id: `msg-history-${i}`,
        ...event,
      };
    });

    const pagedEvents: (MockChatEvent & { id: string })[] = [];

    for (const event of historicalEvents) {
      pagedEvents.push(event);
    }

    // Seed with pre-existing chatEvents (e.g. history on resume). Seeded
    // entries represent historical events, so default `runId` to the mock
    // run when the test didn't include the key — without it, user events
    // would look "unassociated" (runId === undefined) and be treated as
    // queued. Tests that *want* a queued seed should explicitly pass
    // `runId: undefined`, which we respect via the `in` check.
    appendSeedChatEvents({
      pagedEvents,
      chatEvents: [...chatEvents, ...lifecycleEvents],
      activeRunIds,
    });

    for (const event of queuedEvents) {
      pagedEvents.push({
        id: event.id ?? `queued-${pagedEvents.length}`,
        ...event,
      });
    }

    pagedEvents.push(...associatedRunEvents());

    return pagedEvents
      .map((event, index) => {
        return { ...event, seqId: event.seqId ?? index + 1 };
      })
      .sort((left, right) => {
        return left.seqId - right.seqId;
      });
  };

  const appendQueuedUserMessage = async (body: {
    prompt?: string;
    clientEventId?: string;
    hasTextContent?: boolean;
    userMessage?: UserMessageDocument;
    model?: SupportedRunModel;
    runOptions?: ChatRunOptionsRequest;
  }) => {
    const clientEventId = body.clientEventId ?? crypto.randomUUID();
    const modelSelection = modelSelectionFromBody(body);
    options?.onQueuedEventAppend?.({
      content: body.prompt,
      hasTextContent: body.hasTextContent,
      clientEventId,
      userMessage: body.userMessage,
      modelSelection,
      runOptions: body.runOptions,
    });
    if (options?.appendGate) {
      await options.appendGate;
    }
    const now = nowDate().toISOString();
    queuedEvents.push({
      id: clientEventId,
      role: "user" as const,
      content: body.prompt ?? "",
      ...(body.userMessage ? { userMessage: body.userMessage } : {}),
      seqId: allocateDynamicSeqId(),
      createdAt: now,
    });
    return { runId: null, threadId, createdAt: now };
  };

  const startRunFromUserMessage = async (body: {
    prompt?: string;
    clientEventId?: string;
    hasTextContent?: boolean;
    userMessage?: UserMessageDocument;
    model?: SupportedRunModel;
    runOptions?: ChatRunOptionsRequest;
    computerUseHostId?: string | null;
    cloudBrowserEnabled?: boolean;
    revokesEventId?: string;
    sourceRunId?: string;
  }) => {
    if (typeof options?.sendGate === "function") {
      await options.sendGate();
    } else if (options?.sendGate) {
      await options.sendGate;
    }
    if (runAssociated) {
      archiveAssociatedRun();
    }
    runSequence += 1;
    currentRunId = `d0000000-0000-4000-a000-${String(runSequence).padStart(12, "0")}`;
    runPrompt = body.prompt ?? null;
    runUserEventId = body.clientEventId ?? crypto.randomUUID();
    runUserMessage = body.userMessage;
    if (body.cloudBrowserEnabled === true) {
      computerUseHostId = null;
      cloudBrowserEnabled = true;
    } else if (body.computerUseHostId) {
      computerUseHostId = body.computerUseHostId;
      cloudBrowserEnabled = false;
    }
    const modelSelection = modelSelectionFromBody(body);
    options?.onRunCreate?.({ ...body, modelSelection });
    runStatus = "running";
    runError = null;
    resultContent = "";
    selectedModel = modelSelection?.selectedModel ?? selectedModel;
    codexServiceTier = body.runOptions?.codexServiceTier ?? null;
    runAssociated = true;
    runUserSeqId = allocateDynamicSeqId();
    assistantSeqId = allocateDynamicSeqId();
    completedMarkerSeqId = undefined;
    createChatEvent(threadId);
    return {
      runId: currentRunId,
      threadId,
      status: "pending" as const,
      createdAt: "2026-03-10T00:00:00Z",
    };
  };

  context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
    return respond(404, {
      error: {
        message: "Chat event snapshot not found",
        code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
      },
    });
  });
  context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
    const rows = mockChatEventRows(
      normalizeMockChatEvents(
        buildCanonicalEvents().map(cloneMockChatEvent),
        threadId,
      ),
    )
      .filter((row) => {
        return row.seqId > query.sinceSeqId;
      })
      .slice(0, query.limit ?? 50);
    if (query.sinceSeqId === 0) {
      options?.afterInitialEventsList?.();
    }
    return respond(200, chatEventRowsResponse(rows, query));
  });
  context.mocks.api(chatThreadByIdContract.get, async ({ respond }) => {
    if (options?.threadGate) {
      await options.threadGate;
    }
    return respond(200, {
      lastReadAt: "2026-03-10T00:00:00Z",
      cancellationRecoveryPending: false,
    });
  });
  context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: null,
      draftAttachments: null,
    });
  });
  context.mocks.api(
    chatThreadModelSelectionContract.update,
    ({ body, respond }) => {
      const modelSelection = modelSelectionFromBody(body);
      selectedModel = modelSelection?.selectedModel ?? null;
      codexServiceTier = body.codexServiceTier ?? null;
      if (selectedModel && body.reasoningEffort !== undefined) {
        modelSettings = withModelReasoningEffort(modelSettings, {
          model: selectedModel,
          effort: body.reasoningEffort,
        });
      }
      latestThreadEventId =
        body.serviceTierEventId ?? body.eventId ?? crypto.randomUUID();
      latestThreadEventSeqId = (latestThreadEventSeqId ?? 0) + 1;
      options?.onModelSelectionUpdate?.({
        model: body.model,
        modelSelection,
        codexServiceTier: body.codexServiceTier,
        reasoningEffort: body.reasoningEffort,
      });
      return respond(204);
    },
  );
  context.mocks.api(
    chatThreadComputerUseHostContract.update,
    ({ body, respond }) => {
      computerUseHostId = body.computerUseHostId;
      cloudBrowserEnabled =
        body.cloudBrowserEnabled ??
        (body.computerUseHostId ? false : cloudBrowserEnabled);
      latestThreadEventId = body.eventId ?? crypto.randomUUID();
      latestThreadEventSeqId = (latestThreadEventSeqId ?? 0) + 1;
      options?.onComputerUseHostUpdate?.({
        computerUseHostId: body.computerUseHostId,
        cloudBrowserEnabled: body.cloudBrowserEnabled,
      });
      return respond(204);
    },
  );
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: threadListSnapshot(effectiveThreadList()),
      latestEventId: latestThreadEventId,
      latestSeqId: latestThreadEventSeqId,
    });
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    const activeThreadIds = new Set<string>();
    if (
      activeRunIds.length > 0 ||
      (runAssociated && !terminal.has(runStatus))
    ) {
      activeThreadIds.add(threadId);
    }
    return respond(200, {
      agents: {},
      threads: Object.fromEntries(
        [...activeThreadIds]
          .filter((id) => {
            return UUID_PATTERN.test(id);
          })
          .map((id) => {
            return [id, "active" as const];
          }),
      ),
    });
  });
  context.mocks.api(chatThreadsContract.create, ({ body, respond }) => {
    threadId = body.clientThreadId ?? threadId;
    const modelSelection = modelSelectionFromBody(body);
    if (!modelSelection) {
      throw new Error("Expected chat thread create to include model");
    }
    selectedModel = modelSelection.selectedModel;
    codexServiceTier = body.serviceTier === "priority" ? "fast" : null;
    if (body.reasoningEffort !== undefined) {
      modelSettings = withModelReasoningEffort(modelSettings, {
        model: selectedModel,
        effort: body.reasoningEffort,
      });
    }
    options?.onThreadCreate?.({
      clientThreadId: body.clientThreadId,
      eventId: body.eventId,
      model: body.model,
      modelSelection,
      serviceTier: body.serviceTier,
      reasoningEffort: body.reasoningEffort,
      imageModel: body.imageModel,
      videoModel: body.videoModel,
      connectorSelections: body.connectorSelections,
    });
    return respond(201, {
      id: threadId,
      title: null,
      createdAt: "2026-03-10T00:00:00Z",
      selectedModel,
      serviceTier: body.serviceTier ?? null,
    });
  });
  // Unified chat event endpoint (creates thread + run + association)
  context.mocks.api(chatEventsContract.send, async ({ body, respond }) => {
    if (isRecallEventBody(body)) {
      return respond(201, appendRecallControlEvent(body));
    }

    if (isInterruptEventBody(body)) {
      return respond(201, appendInterruptControlEvent(body));
    }
    if (body.prompt === undefined) {
      throw new Error("Expected prompt for a normal chat event send");
    }

    options?.onSendRequest?.({
      prompt: body.prompt,
      threadId: body.threadId,
      clientThreadId: body.clientThreadId,
      userMessage: body.userMessage,
      model: body.model,
      modelSelection: modelSelectionFromBody(body),
      computerUseHostId: body.computerUseHostId,
      cloudBrowserEnabled: body.cloudBrowserEnabled,
      sourceRunId: body.sourceRunId,
    });
    threadId = body.clientThreadId ?? body.threadId ?? threadId;
    const responseBody = hasActiveRun()
      ? await appendQueuedUserMessage(body)
      : await startRunFromUserMessage(body);
    return respond(201, responseBody);
  });
  context.mocks.api(logsByIdContract.getById, ({ respond }) => {
    return respond(200, {
      id: "a0000000-0000-4000-a000-000000000001",
      sessionId: "session-1",
      agentId: "zero",
      displayName: null,
      framework: "claude-code",
      modelProvider: null,
      selectedModel: null,
      triggerSource: "web",
      status: runStatus,
      prompt: "Hello",
      appendSystemPrompt: null,
      error: runError,
      createdAt: "2026-03-10T00:00:00Z",
      startedAt: "2026-03-10T00:00:01Z",
      completedAt: null,
      artifact: { name: null, version: null },
    });
  });
  context.mocks.api(runsCancelContract.cancel, ({ respond }) => {
    return respond(200, {
      id: "a0000000-0000-4000-a000-000000000001",
      status: "cancelled",
      message: "Run cancelled",
    });
  });
  context.mocks.api(runsByIdContract.getById, ({ respond }) => {
    return respond(200, {
      runId: "a0000000-0000-4000-a000-000000000001",
      status: runStatus,
      prompt: runPrompt ?? "Hello",
      appendSystemPrompt: null,
      result: { agentSessionId: "session-1", output: resultContent },
      createdAt: "2026-03-10T00:00:00Z",
    });
  });
  context.mocks.api(queuePositionContract.getPosition, ({ respond }) => {
    return respond(200, { position: queuePosition, total: 0 });
  });
  context.mocks.api(computerUseHostsContract.list, ({ respond }) => {
    return respond(200, { hosts: [] });
  });

  return {
    setRunStatus: (s) => {
      runStatus = s;
    },
    setQueuePosition: (n) => {
      queuePosition = n;
    },
    setRunOutput: (content) => {
      resultContent = content;
      assistantSeqId = allocateDynamicSeqId();
      createChatEvent(threadId);
    },
    setThreadList: (list) => {
      threadListOverride = list;
    },
    setCodexServiceTier: (tier) => {
      codexServiceTier = tier;
      latestThreadEventId = crypto.randomUUID();
      latestThreadEventSeqId = (latestThreadEventSeqId ?? 0) + 1;
    },
    completeRun: (content?: string) => {
      const activeSeedRunId = activeRunIds.at(-1);
      if (!runAssociated && activeSeedRunId !== undefined) {
        runStatus = "completed";
        const completedAt = nowDate().toISOString();
        if (content) {
          lifecycleEvents.push({
            id: crypto.randomUUID(),
            role: "assistant",
            content,
            runId: activeSeedRunId,
            seqId: allocateDynamicSeqId(),
            createdAt: completedAt,
          });
        }
        lifecycleEvents.push({
          id: crypto.randomUUID(),
          role: "assistant",
          content: null,
          runId: activeSeedRunId,
          runLifecycleEvent: "completed",
          seqId: allocateDynamicSeqId(),
          createdAt: completedAt,
        });
        activeRunIds = activeRunIds.filter((runId) => {
          return runId !== activeSeedRunId;
        });
        createChatEvent(threadId);
        return;
      }
      runStatus = "completed";
      resultContent = content ?? "";
      threadTitle = threadTitle ?? runPrompt;
      assistantSeqId = allocateDynamicSeqId();
      completedMarkerSeqId = allocateDynamicSeqId();
      createChatEvent(threadId);
    },
    failRun: (error: string) => {
      runStatus = "failed";
      runError = error;
      assistantSeqId = allocateDynamicSeqId();
      createChatEvent(threadId);
    },
    cancelRun: () => {
      markRunCancelled();
    },
  };
}
