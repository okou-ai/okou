import { captureRunActivity$ } from "./run-activity-snapshot.service";
import { command, type Command } from "ccstate";

import { eventConsumerPayloadState$ } from "../../lib/event-consumer/route";
import type {
  AgentEvent,
  EventConsumerPayload,
} from "../../lib/event-consumer/verify";
import { eventDeliveryUnavailable } from "../../lib/error";
import { logger } from "../../lib/log";
import { isForeignKeyViolation, isLockNotAvailable } from "../../lib/pg-errors";
import { now } from "../../lib/time";
import type { SandboxAuth } from "../../types/auth";
import { refreshAgentPhoneTypingEvents$ } from "./agent-event-consumer-agentphone-typing.service";
import { ingestAxiomEvents } from "./agent-event-consumer-axiom.service";
import {
  materializeRunOutputEvents$,
  publishMaterializedChatProjection,
  type MaterializedChatProjection,
} from "./agent-event-consumer-run-output.service";
import { AgentEventRunNotFoundError } from "./run-content-erasure-admission.service";
import type { EventCitation } from "./pi-memory-citation-events";
import { refreshTelegramTypingEvents$ } from "./agent-event-consumer-telegram-typing.service";
import { settle, tapError } from "../utils";

const L = logger("webhook:events");

interface ConsumerResult {
  readonly status: number;
}

type ConsumerCommandResult = ConsumerResult | Promise<ConsumerResult>;
type ConsumerCommand = Command<ConsumerCommandResult, [AbortSignal]>;

interface AgentEventsBody {
  readonly runId: string;
  readonly events: readonly AgentEvent[];
  readonly piMemoryCitationTransport?: {
    readonly schemaVersion: 1;
    readonly citations: readonly EventCitation[];
  };
}

interface ReceiveAgentEventsParams {
  readonly auth: SandboxAuth;
  readonly body: AgentEventsBody;
}

interface DispatchableConsumer {
  readonly name: string;
  readonly command$: ConsumerCommand;
}

interface AcceptedAgentEvents {
  readonly payload: EventConsumerPayload;
  readonly chatProjection: MaterializedChatProjection | null;
}

const OPTIONAL_EVENT_CONSUMERS: readonly DispatchableConsumer[] = [
  { name: "activity-snapshot", command$: captureRunActivity$ },
  {
    name: "telegram-typing",
    command$: refreshTelegramTypingEvents$,
  },
  {
    name: "agentphone-typing",
    command$: refreshAgentPhoneTypingEvents$,
  },
];

function eventRange(events: readonly AgentEvent[]): {
  readonly firstSequence: number;
  readonly lastSequence: number;
} {
  return {
    firstSequence: events[0]!.sequenceNumber,
    lastSequence: events[events.length - 1]!.sequenceNumber,
  };
}

function immutableEventPayload(
  auth: SandboxAuth,
  body: AgentEventsBody,
): EventConsumerPayload {
  return Object.freeze({
    runId: body.runId,
    events: Object.freeze([...body.events]),
    context: Object.freeze({
      userId: auth.userId,
      orgId: auth.orgId,
    }),
  });
}

const runOptionalEventConsumer$ = command(
  async (
    { set },
    params: {
      readonly consumer: DispatchableConsumer;
      readonly payload: EventConsumerPayload;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const range = eventRange(params.payload.events);
    set(eventConsumerPayloadState$, params.payload);
    const result = await tapError(
      Promise.resolve(set(params.consumer.command$, signal)),
      (error) => {
        L.error(`Optional event consumer "${params.consumer.name}" failed`, {
          runId: params.payload.runId,
          ...range,
          error,
        });
      },
    );
    signal.throwIfAborted();

    if (result && result.status !== 200) {
      L.error(`Optional event consumer "${params.consumer.name}" failed`, {
        runId: params.payload.runId,
        ...range,
        status: result.status,
      });
    }
  },
);

export const dispatchOptionalAgentEventConsumers$ = command(
  async (
    { set },
    accepted: AcceptedAgentEvents,
    signal: AbortSignal,
  ): Promise<void> => {
    const startedAt = now();
    const { payload } = accepted;
    const axiomTrace = tapError(ingestAxiomEvents(payload, signal), (error) => {
      L.error("Optional Axiom trace delivery failed", {
        runId: payload.runId,
        ...eventRange(payload.events),
        error,
      });
    });

    if (accepted.chatProjection) {
      await tapError(
        publishMaterializedChatProjection(
          payload,
          accepted.chatProjection,
          signal,
        ),
        (error) => {
          L.error("Optional materialized chat publication failed", {
            runId: payload.runId,
            ...eventRange(payload.events),
            error,
          });
        },
      );
      signal.throwIfAborted();
    }

    for (const consumer of OPTIONAL_EVENT_CONSUMERS) {
      await set(runOptionalEventConsumer$, { consumer, payload }, signal);
    }

    const range = eventRange(payload.events);
    await axiomTrace;
    signal.throwIfAborted();
    L.debug(
      `Optional events ${range.firstSequence}-${range.lastSequence} dispatched for run ${payload.runId} (${now() - startedAt}ms)`,
    );
  },
);

export const receiveAgentEvents$ = command(
  async ({ set }, params: ReceiveAgentEventsParams, signal: AbortSignal) => {
    const payload = immutableEventPayload(params.auth, params.body);
    const range = eventRange(payload.events);
    const startedAt = now();

    L.debug(
      `Delivering events ${range.firstSequence}-${range.lastSequence} for run ${payload.runId}`,
    );
    const projectionResult = await settle(
      set(
        materializeRunOutputEvents$,
        {
          payload,
          suppliedCitations:
            params.body.piMemoryCitationTransport?.citations ?? [],
        },
        signal,
      ),
    );
    signal.throwIfAborted();
    if (!projectionResult.ok) {
      if (
        projectionResult.error instanceof AgentEventRunNotFoundError ||
        isForeignKeyViolation(projectionResult.error)
      ) {
        L.debug("Ignored events for deleted run", {
          runId: payload.runId,
          ...range,
        });
        return {
          response: {
            status: 200 as const,
            body: {
              received: payload.events.length,
              ...range,
            },
          },
        };
      }
      if (isLockNotAvailable(projectionResult.error)) {
        L.info("Required database run output projection backpressured", {
          runId: payload.runId,
          ...range,
          errorCode: "55P03",
          retryable: true,
        });
      } else {
        L.error("Required database run output projection failed", {
          runId: payload.runId,
          ...range,
          error: projectionResult.error,
        });
      }
      return {
        response: eventDeliveryUnavailable(
          "Agent event delivery is temporarily unavailable",
        ),
      };
    }

    if (projectionResult.value.outcome !== "accepted") {
      return {
        response: {
          status: 200 as const,
          body: {
            received: payload.events.length,
            ...range,
          },
        },
      };
    }

    L.debug(
      `Events ${range.firstSequence}-${range.lastSequence} accepted for run ${payload.runId} (${now() - startedAt}ms)`,
    );
    return {
      response: {
        status: 200 as const,
        body: {
          received: payload.events.length,
          ...range,
        },
      },
      acceptedEvents: {
        payload: projectionResult.value.payload,
        chatProjection: projectionResult.value.chatProjection,
      },
    };
  },
);
