import {
  mergePiMemoryCitations,
  parsePiMemoryCitation,
  type PiMemoryCitation,
} from "@okouai/api-contracts/contracts/pi-memory-citations";

import type {
  AgentEvent,
  EventConsumerPayload,
} from "../../lib/event-consumer/verify";

export interface EventCitation {
  readonly sequenceNumber: number;
  readonly citation: PiMemoryCitation;
}

interface NormalizedRunOutputEvents {
  readonly payload: EventConsumerPayload;
  readonly citations: readonly EventCitation[];
}

function citationSignature(citation: PiMemoryCitation): string {
  return JSON.stringify([
    citation.entries.map(({ path, lineStart, lineEnd, note }) => {
      return [path, lineStart, lineEnd, note];
    }),
    citation.rolloutIds,
  ]);
}

interface NormalizedEvent {
  readonly event: AgentEvent;
  readonly citation?: PiMemoryCitation;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function hasMemoryCitation(value: Record<string, unknown>): boolean {
  return Object.hasOwn(value, "memoryCitation");
}

function withoutMemoryCitation(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const { memoryCitation: _memoryCitation, ...rest } = value;
  return rest;
}

function withoutEventMemoryCitation(event: AgentEvent): AgentEvent {
  return {
    ...withoutMemoryCitation(event),
    type: event.type,
    sequenceNumber: event.sequenceNumber,
  };
}

function normalizeAssistantEvent(event: AgentEvent): {
  readonly event: AgentEvent;
  readonly citation?: PiMemoryCitation;
} {
  const message = recordOf(event.message);
  if (!message) {
    const citation = parsePiMemoryCitation(event.memoryCitation);
    const changed = hasMemoryCitation(event);
    return {
      event: changed ? withoutEventMemoryCitation(event) : event,
      ...(citation ? { citation } : {}),
    };
  }
  const suppliedCitation = mergePiMemoryCitations(
    parsePiMemoryCitation(message.memoryCitation),
    parsePiMemoryCitation(event.memoryCitation),
  );
  const messageChanged = hasMemoryCitation(message);
  const eventChanged = hasMemoryCitation(event);
  if (!messageChanged && !eventChanged) {
    return { event };
  }
  return {
    event: {
      ...(eventChanged ? withoutEventMemoryCitation(event) : event),
      message: messageChanged ? withoutMemoryCitation(message) : message,
    },
    ...(suppliedCitation ? { citation: suppliedCitation } : {}),
  };
}

function normalizeResultEvent(event: AgentEvent): {
  readonly event: AgentEvent;
  readonly citation?: PiMemoryCitation;
} {
  const citation = mergePiMemoryCitations(
    parsePiMemoryCitation(event.memoryCitation),
    undefined,
  );
  const changed = hasMemoryCitation(event);
  const normalized: AgentEvent = changed
    ? withoutEventMemoryCitation(event)
    : event;
  return {
    event: normalized,
    ...(citation ? { citation } : {}),
  };
}

/**
 * Remove supplied private citation metadata from an admitted event batch.
 * Pi Guest and API-first producers normalize hidden text before admission.
 */
export function normalizeRunOutputEvents(
  payload: EventConsumerPayload,
  suppliedCitations: readonly EventCitation[] = [],
): NormalizedRunOutputEvents {
  const suppliedBySequence = new Map(
    suppliedCitations.map((item) => {
      return [item.sequenceNumber, item.citation] as const;
    }),
  );
  const normalizedEvents: NormalizedEvent[] = payload.events.map((event) => {
    const normalized =
      event.type === "assistant"
        ? normalizeAssistantEvent(event)
        : event.type === "result"
          ? normalizeResultEvent(event)
          : { event };
    const supplied = suppliedBySequence.get(event.sequenceNumber);
    return {
      ...normalized,
      ...(supplied
        ? {
            citation: mergePiMemoryCitations(normalized.citation, supplied),
          }
        : {}),
    };
  });

  const citations: EventCitation[] = [];
  let lastAssistantCitationSignature: string | undefined;
  for (const normalized of normalizedEvents) {
    const signature = normalized.citation
      ? citationSignature(normalized.citation)
      : undefined;
    if (normalized.event.type === "assistant") {
      lastAssistantCitationSignature = signature;
    }
    if (
      !normalized.citation ||
      (normalized.event.type === "result" &&
        signature === lastAssistantCitationSignature)
    ) {
      continue;
    }
    citations.push({
      sequenceNumber: normalized.event.sequenceNumber,
      citation: normalized.citation,
    });
  }
  return {
    payload: {
      ...payload,
      events: normalizedEvents.map(({ event }) => {
        return event;
      }),
    },
    citations,
  };
}
