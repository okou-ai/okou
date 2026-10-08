import { command } from "ccstate";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import type {
  AgentEvent,
  EventConsumerPayload,
} from "../../lib/event-consumer/verify";
import { getDatasetName, ingestAxiomDirect } from "../external/axiom";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";

const AGENT_RUN_EVENTS_DATASET = "agent-run-events";
const AXIOM_EVENT_INGEST_TIMEOUT_MS = 10_000;
const AXIOM_EVENT_DATA_MAX_BYTES = 900_000;
const AXIOM_TRUNCATED_STRING_VALUE = "[truncated]";
const AXIOM_TRUNCATED_STRING_SUFFIX = `\n\n${AXIOM_TRUNCATED_STRING_VALUE}`;

function serializedUtf8Bytes(
  value: unknown,
  encoder: InstanceType<typeof TextEncoder>,
): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Axiom event data must be JSON serializable");
  }
  return encoder.encode(serialized).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type MutableStringSlot =
  | {
      readonly kind: "array";
      readonly container: unknown[];
      readonly key: number;
      readonly original: string;
      readonly serializedBytes: number;
    }
  | {
      readonly kind: "object";
      readonly container: Record<string, unknown>;
      readonly key: string;
      readonly original: string;
      readonly serializedBytes: number;
    };

function collectMutableStringSlots(
  value: unknown,
  encoder: InstanceType<typeof TextEncoder>,
): MutableStringSlot[] {
  const slots: MutableStringSlot[] = [];
  const pending: unknown[] = [value];

  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      for (const [key, item] of current.entries()) {
        if (typeof item === "string") {
          slots.push({
            kind: "array",
            container: current,
            key,
            original: item,
            serializedBytes: serializedUtf8Bytes(item, encoder),
          });
        } else if (typeof item === "object" && item !== null) {
          pending.push(item);
        }
      }
      continue;
    }

    if (!isRecord(current)) {
      continue;
    }
    for (const [key, item] of Object.entries(current)) {
      if (current === value && key === "axiomReduction") {
        continue;
      }
      if (typeof item === "string") {
        slots.push({
          kind: "object",
          container: current,
          key,
          original: item,
          serializedBytes: serializedUtf8Bytes(item, encoder),
        });
      } else if (typeof item === "object" && item !== null) {
        pending.push(item);
      }
    }
  }

  return slots.sort((left, right) => {
    return right.serializedBytes - left.serializedBytes;
  });
}

function setStringSlot(slot: MutableStringSlot, value: string): void {
  if (slot.kind === "array") {
    slot.container[slot.key] = value;
  } else {
    slot.container[slot.key] = value;
  }
}

function truncatedStringPrefix(value: string, end: number): string {
  let safeEnd = end;
  const boundaryCodePoint = value.codePointAt(end - 1);
  if (boundaryCodePoint !== undefined && boundaryCodePoint > 65_535) {
    safeEnd -= 1;
  }
  if (safeEnd === 0) {
    return AXIOM_TRUNCATED_STRING_VALUE;
  }
  return `${value.slice(0, safeEnd)}${AXIOM_TRUNCATED_STRING_SUFFIX}`;
}

interface StringTruncationResult {
  readonly bytes: number;
  readonly fits: boolean;
}

function truncateStringSlotToFit(
  slot: MutableStringSlot,
  currentBytes: number,
  encoder: InstanceType<typeof TextEncoder>,
): StringTruncationResult {
  const minimumSerializedBytes = serializedUtf8Bytes(
    AXIOM_TRUNCATED_STRING_VALUE,
    encoder,
  );
  const surroundingBytes = currentBytes - slot.serializedBytes;
  setStringSlot(slot, AXIOM_TRUNCATED_STRING_VALUE);
  if (surroundingBytes + minimumSerializedBytes > AXIOM_EVENT_DATA_MAX_BYTES) {
    return {
      bytes: surroundingBytes + minimumSerializedBytes,
      fits: false,
    };
  }

  let lower = 0;
  let upper = slot.original.length;
  let best = 0;
  let bestSerializedBytes = minimumSerializedBytes;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const candidate = truncatedStringPrefix(slot.original, middle);
    const candidateBytes = serializedUtf8Bytes(candidate, encoder);
    if (surroundingBytes + candidateBytes <= AXIOM_EVENT_DATA_MAX_BYTES) {
      best = middle;
      bestSerializedBytes = candidateBytes;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  setStringSlot(slot, truncatedStringPrefix(slot.original, best));
  return {
    bytes: surroundingBytes + bestSerializedBytes,
    fits: true,
  };
}

function reducedEventData(
  event: AgentEvent,
  serialized: string,
  originalBytes: number,
  encoder: InstanceType<typeof TextEncoder>,
): AgentEvent {
  const parsed: unknown = JSON.parse(serialized);
  if (!isRecord(parsed)) {
    throw new Error("Axiom event data must be a JSON object");
  }
  const axiomReduction = {
    reason: "field_size_limit",
    originalBytes,
    budgetBytes: AXIOM_EVENT_DATA_MAX_BYTES,
  };
  const reducedEvent: AgentEvent = {
    ...parsed,
    type: event.type,
    sequenceNumber: event.sequenceNumber,
    axiomReduction,
  };
  const stringSlots = collectMutableStringSlots(reducedEvent, encoder);

  const minimumReplacementBytes = serializedUtf8Bytes(
    AXIOM_TRUNCATED_STRING_VALUE,
    encoder,
  );
  let currentBytes = serializedUtf8Bytes(reducedEvent, encoder);
  for (const slot of stringSlots) {
    if (slot.serializedBytes <= minimumReplacementBytes) {
      continue;
    }
    const truncation = truncateStringSlotToFit(slot, currentBytes, encoder);
    currentBytes = truncation.bytes;
    if (truncation.fits) {
      return reducedEvent;
    }
  }

  return {
    type: event.type,
    sequenceNumber: event.sequenceNumber,
    axiomReduction,
  };
}

function eventDataForAxiom(
  event: AgentEvent,
  encoder: InstanceType<typeof TextEncoder>,
): AgentEvent {
  const serialized = JSON.stringify(event);
  if (serialized === undefined) {
    throw new Error("Axiom event data must be JSON serializable");
  }
  const originalBytes = encoder.encode(serialized).byteLength;
  if (originalBytes <= AXIOM_EVENT_DATA_MAX_BYTES) {
    return event;
  }

  return reducedEventData(event, serialized, originalBytes, encoder);
}

export const ingestAxiomEvents$ = command(
  async (
    { set },
    payload: EventConsumerPayload,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const context = await set(
      loadUserFeatureSwitchContext$,
      payload.context.orgId,
      payload.context.userId,
      signal,
    );
    signal.throwIfAborted();
    // Raw events are diagnostic data, not the persisted chat transcript.
    // Resolve the current override for every batch, before serializing events.
    if (!isFeatureEnabled(FeatureSwitchKey.OkouDebug, context)) {
      return;
    }
    const encoder = new TextEncoder();
    const axiomEvents = payload.events.map((event) => {
      return {
        runId: payload.runId,
        userId: payload.context.userId,
        sequenceNumber: event.sequenceNumber,
        eventType: event.type,
        eventData: eventDataForAxiom(event, encoder),
      };
    });
    const result = await ingestAxiomDirect(
      getDatasetName(AGENT_RUN_EVENTS_DATASET),
      axiomEvents,
      AXIOM_EVENT_INGEST_TIMEOUT_MS,
      signal,
    );
    signal.throwIfAborted();
    if (!result.configured) {
      throw new Error("Axiom agent-run-events dataset is not configured");
    }
  },
);
