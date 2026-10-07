import { command, type Command, type Computed } from "ccstate";
import type {
  ChatRunOptionsRequest,
  UserMessageDocument,
  UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { ChatEvent } from "./chat-event-types.ts";
import type { RunIndicatorState } from "./chat-event-state.ts";
import {
  createChatEventStorageSignals,
  type AppendOptimisticEventCommand,
} from "./chat-event-storage-signals.ts";
import { nowDate } from "../../lib/time.ts";
import { apiClient$ } from "../api-client.ts";
import { sendChatEvent } from "./chat-event-api.ts";
import {
  optimisticChatThreadCreateUnsettled,
  touchOptimisticChatThreadSort$,
} from "./chat-thread-event-sourcing.ts";
import { registerActiveChatEventSignals$ } from "./chat-event-signal-registry.ts";
import { logger } from "../log.ts";
import { chatEventTraceTime } from "./chat-event-debug.ts";
import { withSelectedModelAnnotation } from "./model-selection-request.ts";

const L = logger("ChatEventSignals");

export interface ChatAgentRunSource {
  readonly runId: string;
  readonly threadId: string;
  readonly agentId: string;
  readonly titleSnapshot: string;
}

export function withOptimisticAgentRunSource(
  document: UserMessageDocument,
  source: ChatAgentRunSource,
): UserMessageDocument {
  return {
    version: 1,
    parts: [
      ...document.parts.filter((part) => {
        return part.type !== "source" && part.type !== "automation";
      }),
      {
        type: "source",
        kind: "agent",
        runId: source.runId,
        threadId: source.threadId,
        agentId: source.agentId,
        titleSnapshot: source.titleSnapshot,
        href: `/chats/${source.threadId}#run-${source.runId}`,
      },
    ],
  };
}

export interface SendInputChatEvent {
  readonly kind: "input";
  readonly delivery: "run" | "queue";
  readonly agentId: string;
  readonly prompt: string;
  readonly hasTextContent: boolean;
  readonly userMessage: UserMessageInputDocument;
  readonly selectedModel?: string | null;
  readonly runOptions?: ChatRunOptionsRequest;
  readonly realAgentInPreview?: boolean;
  readonly computerUseHostId?: string | null;
  readonly cloudBrowserEnabled?: boolean;
  readonly revokesEventId?: string;
  readonly source?: ChatAgentRunSource;
  readonly onOptimisticSend?: () => void;
}

export interface SendRevokeChatEvent {
  readonly kind: "revoke";
  readonly agentId: string;
  readonly revokesEventId: string;
}

export interface SendInterruptChatEvent {
  readonly kind: "interrupt";
  readonly agentId: string;
  readonly interruptsRunId: string;
}

export type SendChatEventInput =
  | SendInputChatEvent
  | SendRevokeChatEvent
  | SendInterruptChatEvent;

interface SendChatEventDependencies {
  readonly threadId: string;
  readonly appendOptimisticEvent$: AppendOptimisticEventCommand;
}

function createSendInputChatEvent({
  threadId,
  appendOptimisticEvent$,
}: SendChatEventDependencies): Command<
  Promise<void>,
  [SendInputChatEvent, AbortSignal]
> {
  return command(
    async ({ get, set }, input: SendInputChatEvent, signal: AbortSignal) => {
      const clientEventId = crypto.randomUUID();
      const createdAt = nowDate().toISOString();
      const chatThreadSortEventId = crypto.randomUUID();
      const userMessage =
        input.delivery === "run"
          ? withSelectedModelAnnotation(
              input.userMessage,
              input.selectedModel,
              input.runOptions?.codexServiceTier === "fast"
                ? "priority"
                : undefined,
            )
          : input.userMessage;
      const optimisticUserMessage = input.source
        ? withOptimisticAgentRunSource(userMessage, input.source)
        : userMessage;
      L.debug("send input prepared", {
        traceTime: chatEventTraceTime(),
        threadId,
        clientEventId,
        delivery: input.delivery,
        createdAt,
      });
      set(touchOptimisticChatThreadSort$, {
        id: chatThreadSortEventId,
        threadId,
        agentId: input.agentId,
        createdAt,
      });
      await set(
        appendOptimisticEvent$,
        {
          threadId,
          optimisticUserMessageAssociation: input.delivery,
          event: {
            id: clientEventId,
            threadId,
            eventType: "input.prompt",
            content: null,
            userMessage: optimisticUserMessage,
            ...(input.revokesEventId === undefined
              ? {}
              : { revokesEventId: input.revokesEventId }),
            createdAt,
          },
        },
        signal,
      );
      signal.throwIfAborted();
      L.debug("send input optimistic change notified", {
        traceTime: chatEventTraceTime(),
        threadId,
        clientEventId,
      });
      input.onOptimisticSend?.();
      await sendChatEvent(
        get(apiClient$),
        {
          agentId: input.agentId,
          prompt: input.prompt,
          threadId,
          hasTextContent: input.hasTextContent,
          clientEventId,
          chatThreadSortEventId,
          ...(input.runOptions === undefined
            ? {}
            : { runOptions: input.runOptions }),
          ...(input.realAgentInPreview === true
            ? { realAgentInPreview: true }
            : {}),
          userMessage,
          ...(input.source ? { sourceRunId: input.source.runId } : {}),
          ...(input.computerUseHostId === undefined
            ? {}
            : { computerUseHostId: input.computerUseHostId }),
          ...(input.cloudBrowserEnabled === undefined
            ? {}
            : { cloudBrowserEnabled: input.cloudBrowserEnabled }),
          ...(input.revokesEventId === undefined
            ? {}
            : { revokesEventId: input.revokesEventId }),
        },
        signal,
      );
      signal.throwIfAborted();
      L.debug("send input accepted", {
        traceTime: chatEventTraceTime(),
        threadId,
        clientEventId,
      });
    },
  );
}

function createSendRevokeChatEvent({
  threadId,
  appendOptimisticEvent$,
}: SendChatEventDependencies): Command<
  Promise<void>,
  [SendRevokeChatEvent, AbortSignal]
> {
  return command(
    async ({ get, set }, input: SendRevokeChatEvent, signal: AbortSignal) => {
      const clientEventId = crypto.randomUUID();
      await set(
        appendOptimisticEvent$,
        {
          threadId,
          event: {
            id: clientEventId,
            threadId,
            eventType: "control.revoke",
            content: null,
            revokesEventId: input.revokesEventId,
            createdAt: nowDate().toISOString(),
          },
        },
        signal,
      );
      signal.throwIfAborted();
      await sendChatEvent(
        get(apiClient$),
        {
          agentId: input.agentId,
          threadId,
          revokesEventId: input.revokesEventId,
          clientEventId,
        },
        signal,
      );
    },
  );
}

function createSendInterruptChatEvent({
  threadId,
  appendOptimisticEvent$,
}: SendChatEventDependencies): Command<
  Promise<void>,
  [SendInterruptChatEvent, AbortSignal]
> {
  return command(
    async (
      { get, set },
      input: SendInterruptChatEvent,
      signal: AbortSignal,
    ) => {
      const clientEventId = crypto.randomUUID();
      await set(
        appendOptimisticEvent$,
        {
          threadId,
          event: {
            id: clientEventId,
            threadId,
            eventType: "control.interrupt",
            content: null,
            interruptsRunId: input.interruptsRunId,
            createdAt: nowDate().toISOString(),
          },
        },
        signal,
      );
      signal.throwIfAborted();
      await sendChatEvent(
        get(apiClient$),
        {
          agentId: input.agentId,
          threadId,
          interruptsRunId: input.interruptsRunId,
          clientEventId,
        },
        signal,
      );
    },
  );
}

function createSendChatEvent(
  dependencies: SendChatEventDependencies,
): Command<Promise<void>, [SendChatEventInput, AbortSignal]> {
  const sendInput$ = createSendInputChatEvent(dependencies);
  const sendRevoke$ = createSendRevokeChatEvent(dependencies);
  const sendInterrupt$ = createSendInterruptChatEvent(dependencies);
  return command(
    async ({ set }, input: SendChatEventInput, signal: AbortSignal) => {
      switch (input.kind) {
        case "input": {
          return await set(sendInput$, input, signal);
        }
        case "revoke": {
          return await set(sendRevoke$, input, signal);
        }
        case "interrupt": {
          return await set(sendInterrupt$, input, signal);
        }
      }
    },
  );
}

function createChatEventSetup({
  threadId,
  initializeIndexedDbEvents$,
  syncRemoteEvents$,
}: {
  readonly threadId: string;
  readonly initializeIndexedDbEvents$: Command<Promise<void>, [AbortSignal]>;
  readonly syncRemoteEvents$: Command<Promise<void>, [AbortSignal]>;
}): {
  readonly setup$: Command<Promise<void>, [AbortSignal]>;
  readonly catchUp$: Command<Promise<void>, [AbortSignal]>;
} {
  const optimisticCreateUnsettled$ =
    optimisticChatThreadCreateUnsettled(threadId);

  const setup$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      set(registerActiveChatEventSignals$, threadId, syncRemoteEvents$, signal);
      await set(initializeIndexedDbEvents$, signal);
      signal.throwIfAborted();
    },
  );
  const catchUp$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      if (get(optimisticCreateUnsettled$)) {
        return;
      }
      await set(syncRemoteEvents$, signal);
    },
  );

  return { setup$, catchUp$ };
}

export interface ChatEventSignals {
  readonly threadId: string;
  readonly chatEvents$: Computed<ChatEvent[]>;
  readonly hasOptimisticUserMessage$: Computed<boolean>;
  readonly serverRunState$: Computed<RunIndicatorState>;
  readonly setup$: Command<Promise<void>, [AbortSignal]>;
  readonly catchUp$: Command<Promise<void>, [AbortSignal]>;
  readonly sendEvent$: Command<
    Promise<void>,
    [SendChatEventInput, AbortSignal]
  >;
}

export function createChatEventSignals(threadId: string): ChatEventSignals {
  const events = createChatEventStorageSignals({ threadId });
  const sendEvent$ = createSendChatEvent({
    threadId,
    appendOptimisticEvent$: events.appendOptimisticEvent$,
  });
  const setup = createChatEventSetup({
    threadId,
    initializeIndexedDbEvents$: events.initializeIndexedDbEvents$,
    syncRemoteEvents$: events.syncRemoteEvents$,
  });
  return {
    threadId,
    chatEvents$: events.chatEvents$,
    hasOptimisticUserMessage$: events.hasOptimisticUserMessage$,
    serverRunState$: events.serverRunState$,
    ...setup,
    sendEvent$,
  };
}
