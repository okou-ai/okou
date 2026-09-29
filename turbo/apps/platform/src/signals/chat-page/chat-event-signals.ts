import { command, type Command, type Computed } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import { authenticatedIdentity$ } from "../auth.ts";
import { queryChatEventSharedDatabase$ } from "../shared-database.ts";
import {
  classifyDeliveryFailure,
  deliveryIntentsChanged$,
  listDeliveryIntents,
  removeDeliveryIntent,
  saveDeliveryIntent,
  updateDeliveryIntent,
  watchDeliveryIntents$,
  withDeliveryLock,
  type ExistingThreadDeliveryIntent,
} from "./chat-delivery-intents.ts";
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
import { settle } from "../utils.ts";
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
  /** Prepared before the composer clears, so the same IDs survive a rejection. */
  readonly preparedIntent?: ExistingThreadDeliveryIntent;
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

function createPrepareInputChatEvent(threadId: string) {
  return command(
    async ({ get, set }, input: SendInputChatEvent, signal: AbortSignal) => {
      const identity = await get(authenticatedIdentity$);
      signal.throwIfAborted();
      const clientEventId = crypto.randomUUID();
      const createdAt = nowDate().toISOString();
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
      const intent: ExistingThreadDeliveryIntent = {
        kind: "existing-thread",
        threadId,
        clientEventId,
        createdAt,
        delivery: input.delivery,
        status: "prepared",
        rejection: null,
        ...(input.source ? { optimisticSource: input.source } : {}),
        body: {
          agentId: input.agentId,
          prompt: input.prompt,
          threadId,
          hasTextContent: input.hasTextContent,
          clientEventId,
          chatThreadSortEventId: crypto.randomUUID(),
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
      };
      if (!saveDeliveryIntent(identity, intent)) {
        toast.error(
          "Message not sent: this browser could not save a recovery copy. Free up storage and try again.",
        );
        return null;
      }
      set(deliveryIntentsChanged$);
      return intent;
    },
  );
}

function createSendInputChatEvent({
  threadId,
  appendOptimisticEvent$,
}: SendChatEventDependencies): Command<
  Promise<boolean>,
  [SendInputChatEvent, AbortSignal]
> {
  const prepare$ = createPrepareInputChatEvent(threadId);
  return command(
    async ({ get, set }, input: SendInputChatEvent, signal: AbortSignal) => {
      const intent =
        input.preparedIntent ?? (await set(prepare$, input, signal));
      if (!intent) {
        return false;
      }
      const { clientEventId, createdAt } = intent;
      const identity = await get(authenticatedIdentity$);
      signal.throwIfAborted();
      const optimisticUserMessage = input.source
        ? withOptimisticAgentRunSource(intent.body.userMessage, input.source)
        : intent.body.userMessage;
      L.debug("send input prepared", {
        traceTime: chatEventTraceTime(),
        threadId,
        clientEventId,
        delivery: input.delivery,
        createdAt,
      });
      set(touchOptimisticChatThreadSort$, {
        id: intent.body.chatThreadSortEventId ?? crypto.randomUUID(),
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
      const send = async (): Promise<boolean> => {
        if (navigator.locks) {
          const sent = await withDeliveryLock(
            identity,
            clientEventId,
            "prompt",
            signal,
            () => {
              return sendChatEvent(get(apiClient$), intent.body, signal);
            },
          );
          return sent !== null;
        }
        await sendChatEvent(get(apiClient$), intent.body, signal);
        return true;
      };
      const outcome = await settle(send());
      signal.throwIfAborted();
      if (!outcome.ok || !outcome.value) {
        updateDeliveryIntent(
          identity,
          clientEventId,
          outcome.ok
            ? { status: "uncertain", rejection: null }
            : classifyDeliveryFailure(outcome.error),
        );
        set(deliveryIntentsChanged$);
        return false;
      }
      updateDeliveryIntent(identity, clientEventId, {
        status: "accepted",
        rejection: null,
      });
      set(deliveryIntentsChanged$);
      input.onOptimisticSend?.();
      L.debug("send input accepted", {
        traceTime: chatEventTraceTime(),
        threadId,
        clientEventId,
      });
      return true;
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
): Command<Promise<boolean>, [SendChatEventInput, AbortSignal]> {
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
          await set(sendRevoke$, input, signal);
          return true;
        }
        case "interrupt": {
          await set(sendInterrupt$, input, signal);
          return true;
        }
      }
    },
  );
}

/** Shared prompt-phase recovery for both existing and newly created threads. */
export const checkAndRetryPromptDelivery$ = command(
  async (
    { get, set },
    options: {
      readonly threadId: string;
      readonly clientEventId: string;
      /** Existing mounted thread can also merge the canonical rows into its view. */
      readonly confirmDelivery$?: Command<
        Promise<boolean>,
        [string, AbortSignal]
      >;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const { threadId, clientEventId: eventId, confirmDelivery$ } = options;
    const identity = await get(authenticatedIdentity$);
    signal.throwIfAborted();
    if (!navigator.locks) {
      toast.error("This browser cannot safely retry messages across tabs.");
      return false;
    }
    const locked = await settle(
      withDeliveryLock(identity, eventId, "prompt", signal, async () => {
        const intent = listDeliveryIntents(identity).find((item) => {
          return item.threadId === threadId && item.clientEventId === eventId;
        });
        if (
          !intent ||
          (intent.kind === "new-thread" && intent.phase !== "prompt")
        ) {
          return false;
        }
        // A successful authoritative catch-up, not cache-only absence, gates retry.
        const checkServer = async (): Promise<boolean> => {
          if (confirmDelivery$) {
            return await set(confirmDelivery$, eventId, signal);
          }
          const rows = await set(
            queryChatEventSharedDatabase$,
            {
              dataKey: { kind: "chat-event", threadId },
              afterSeqId: null,
              consistency: "catch-up",
            },
            signal,
          );
          signal.throwIfAborted();
          return rows.some((row) => {
            return row.id === eventId;
          });
        };
        const confirmed = await settle(checkServer());
        if (!confirmed.ok || signal.aborted) {
          updateDeliveryIntent(identity, eventId, {
            status: "uncertain",
            rejection: null,
          });
          set(deliveryIntentsChanged$);
          return false;
        }
        if (confirmed.value) {
          removeDeliveryIntent(identity, eventId);
          set(deliveryIntentsChanged$);
          return true;
        }
        const latest = listDeliveryIntents(identity).find((item) => {
          return item.clientEventId === eventId;
        });
        if (
          !latest ||
          (latest.kind === "new-thread" && latest.phase !== "prompt")
        ) {
          return false;
        }
        updateDeliveryIntent(identity, eventId, {
          status: "prepared",
          rejection: null,
        });
        set(deliveryIntentsChanged$);
        const sent = await settle(
          sendChatEvent(get(apiClient$), latest.body, signal),
        );
        if (!sent.ok || signal.aborted) {
          updateDeliveryIntent(
            identity,
            eventId,
            sent.ok
              ? { status: "uncertain", rejection: null }
              : classifyDeliveryFailure(sent.error),
          );
          set(deliveryIntentsChanged$);
          return false;
        }
        updateDeliveryIntent(identity, eventId, {
          status: "accepted",
          rejection: null,
        });
        set(deliveryIntentsChanged$);
        return true;
      }),
    );
    signal.throwIfAborted();
    if (!locked.ok || locked.value === null) {
      toast.error(
        "This message is being sent in another tab. Check again before retrying.",
      );
      return false;
    }
    return locked.value;
  },
);

function createRetryInputChatEvent(
  threadId: string,
  confirmDelivery$: Command<Promise<boolean>, [string, AbortSignal]>,
) {
  return command(
    async ({ set }, eventId: string, signal: AbortSignal): Promise<boolean> => {
      return await set(
        checkAndRetryPromptDelivery$,
        { threadId, clientEventId: eventId, confirmDelivery$ },
        signal,
      );
    },
  );
}

function createChatEventSetup({
  threadId,
  chatEvents$,
  appendOptimisticEvent$,
  initializeIndexedDbEvents$,
  syncRemoteEvents$,
}: {
  readonly threadId: string;
  readonly chatEvents$: Computed<ChatEvent[]>;
  readonly appendOptimisticEvent$: AppendOptimisticEventCommand;
  readonly initializeIndexedDbEvents$: Command<Promise<void>, [AbortSignal]>;
  readonly syncRemoteEvents$: Command<Promise<void>, [AbortSignal]>;
}): {
  readonly setup$: Command<Promise<void>, [AbortSignal]>;
  readonly catchUp$: Command<Promise<void>, [AbortSignal]>;
} {
  const optimisticCreateUnsettled$ =
    optimisticChatThreadCreateUnsettled(threadId);

  const setup$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      set(registerActiveChatEventSignals$, threadId, syncRemoteEvents$, signal);
      await set(initializeIndexedDbEvents$, signal);
      signal.throwIfAborted();
      set(watchDeliveryIntents$, signal);
      const identity = await get(authenticatedIdentity$);
      signal.throwIfAborted();
      const canonicalIds = new Set(
        get(chatEvents$)
          .filter((event) => {
            return "seqId" in event;
          })
          .map((event) => {
            return event.id;
          }),
      );
      for (const intent of listDeliveryIntents(identity)) {
        if (intent.kind !== "existing-thread" || intent.threadId !== threadId) {
          continue;
        }
        if (canonicalIds.has(intent.clientEventId)) {
          removeDeliveryIntent(identity, intent.clientEventId);
          continue;
        }
        if (intent.status === "prepared") {
          updateDeliveryIntent(identity, intent.clientEventId, {
            status: "uncertain",
            rejection: null,
          });
        }
        const source = intent.optimisticSource;
        await set(
          appendOptimisticEvent$,
          {
            threadId,
            optimisticUserMessageAssociation: intent.delivery,
            event: {
              id: intent.clientEventId,
              threadId,
              eventType: "input.prompt",
              content: null,
              userMessage: source
                ? withOptimisticAgentRunSource(intent.body.userMessage, source)
                : intent.body.userMessage,
              ...(intent.body.revokesEventId === undefined
                ? {}
                : { revokesEventId: intent.body.revokesEventId }),
              createdAt: intent.createdAt,
            },
          },
          signal,
        );
        signal.throwIfAborted();
      }
      set(deliveryIntentsChanged$);
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
  readonly prepareInput$: Command<
    Promise<ExistingThreadDeliveryIntent | null>,
    [SendInputChatEvent, AbortSignal]
  >;
  readonly retryInput$: Command<Promise<boolean>, [string, AbortSignal]>;
  readonly sendEvent$: Command<
    Promise<boolean>,
    [SendChatEventInput, AbortSignal]
  >;
}

export function createChatEventSignals(threadId: string): ChatEventSignals {
  const events = createChatEventStorageSignals({ threadId });
  const sendEvent$ = createSendChatEvent({
    threadId,
    appendOptimisticEvent$: events.appendOptimisticEvent$,
  });
  const prepareInput$ = createPrepareInputChatEvent(threadId);
  const setup = createChatEventSetup({
    threadId,
    chatEvents$: events.chatEvents$,
    appendOptimisticEvent$: events.appendOptimisticEvent$,
    initializeIndexedDbEvents$: events.initializeIndexedDbEvents$,
    syncRemoteEvents$: events.syncRemoteEvents$,
  });
  return {
    threadId,
    chatEvents$: events.chatEvents$,
    hasOptimisticUserMessage$: events.hasOptimisticUserMessage$,
    serverRunState$: events.serverRunState$,
    ...setup,
    prepareInput$,
    retryInput$: createRetryInputChatEvent(threadId, events.confirmDelivery$),
    sendEvent$,
  };
}
