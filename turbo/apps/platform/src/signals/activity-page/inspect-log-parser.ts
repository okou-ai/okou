import { runContextArchiveSchema } from "@okouai/api-contracts/contracts/run-context-archive";
import type { RunContextResponse } from "@okouai/api-contracts/contracts/run-routes";
import { networkLogEntrySchema } from "@okouai/api-contracts/validators/runs";
import type { NetworkLogEntry } from "@okouai/api-contracts/contracts/runs";
import type { AgentEvent, LogDetail } from "../okou-page/log-types.ts";
import { isNonArrayRecord, jsonParseOr } from "../utils.ts";

export type InspectLogMeta = Partial<LogDetail>;

const INVALID_JSON = Symbol("invalid-json");

function parseAgentEvent(value: unknown): AgentEvent | null {
  if (!isNonArrayRecord(value)) {
    return null;
  }
  if (
    typeof value.sequenceNumber !== "number" ||
    !Number.isFinite(value.sequenceNumber) ||
    typeof value.eventType !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  return {
    sequenceNumber: value.sequenceNumber,
    eventType: value.eventType,
    eventData: value.eventData,
    createdAt: value.createdAt,
  };
}

function parseAgentEvents(value: unknown): AgentEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const event = parseAgentEvent(item);
    return event ? [event] : [];
  });
}

function parseRunContext(value: unknown): RunContextResponse | null {
  const parsed = runContextArchiveSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseNetworkLogs(value: unknown): NetworkLogEntry[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.flatMap((item) => {
    const parsed = networkLogEntrySchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

export function parseInspectLog(jsonText: string): {
  meta: InspectLogMeta | null;
  events: AgentEvent[];
  context: RunContextResponse | null;
  networkLogs: NetworkLogEntry[] | null;
} | null {
  const rawValue = jsonParseOr<unknown | typeof INVALID_JSON>(
    jsonText,
    INVALID_JSON,
  );
  if (rawValue === INVALID_JSON) {
    return null;
  }
  if (!isNonArrayRecord(rawValue)) {
    return null;
  }

  return {
    meta: isNonArrayRecord(rawValue.meta) ? rawValue.meta : null,
    events: parseAgentEvents(rawValue.events),
    context: parseRunContext(rawValue.context),
    networkLogs: parseNetworkLogs(rawValue.networkLogs),
  };
}
