import { command, computed, state } from "ccstate";
import type { ActivityRunContext } from "./run-context.ts";
import type { NetworkLogEntry } from "@okouai/api-contracts/contracts/runs";
import type { AgentEvent } from "../okou-page/log-types.ts";
import { parseInspectLog, type InspectLogMeta } from "./inspect-log-parser.ts";
import { logger } from "../log.ts";
import { groupVisibleGroups, type EventGroup } from "./log-detail-utils.ts";
import { i18n } from "../../i18n/index.ts";

const L = logger("InspectLogSignals");
const MAX_INSPECT_LOG_FILE_SIZE_BYTES = 25 * 1024 * 1024;

function invalidInspectLogMessage(): string {
  return i18n.t(($) => {
    return $.activity.inspect.errors.invalid;
  });
}

function oversizedInspectLogMessage(): string {
  return i18n.t(($) => {
    return $.activity.inspect.errors.oversized;
  });
}

export interface InspectLogData {
  meta: InspectLogMeta | null;
  events: AgentEvent[];
  context: ActivityRunContext | null;
  networkLogs: NetworkLogEntry[] | null;
}

const internalInspectLogData$ = state<InspectLogData | null>(null);
const internalInspectLogLoadError$ = state<string | null>(null);
const internalInspectStepSearch$ = state("");
const internalInspectLogLoadGeneration$ = state(0);

export const inspectLogData$ = computed((get) => {
  return get(internalInspectLogData$);
});

function inspectLogFramework(meta: InspectLogMeta | null): string | null {
  return typeof meta?.framework === "string" ? meta.framework : null;
}

export const inspectVisibleGroups$ = computed((get) => {
  const data = get(internalInspectLogData$);
  if (!data) {
    return [] as EventGroup[];
  }
  return groupVisibleGroups(data.events, {
    framework: inspectLogFramework(data.meta),
  });
});

export const inspectLogLoadError$ = computed((get) => {
  return get(internalInspectLogLoadError$);
});

export const loadInspectLogFile$ = command(
  async ({ get, set }, file: File, signal: AbortSignal) => {
    const generation = get(internalInspectLogLoadGeneration$) + 1;
    set(internalInspectLogLoadGeneration$, generation);
    set(internalInspectLogLoadError$, null);

    if (file.size > MAX_INSPECT_LOG_FILE_SIZE_BYTES) {
      L.warn("Inspect log file is too large", file.name, file.size);
      set(internalInspectLogData$, null);
      set(internalInspectLogLoadError$, oversizedInspectLogMessage());
      set(internalInspectStepSearch$, "");
      return;
    }

    const text = await file.text();
    signal.throwIfAborted();
    if (generation !== get(internalInspectLogLoadGeneration$)) {
      return;
    }
    const data = parseInspectLog(text);
    if (!data) {
      L.warn("Failed to parse inspect log file", file.name);
      set(internalInspectLogData$, null);
      set(internalInspectLogLoadError$, invalidInspectLogMessage());
      set(internalInspectStepSearch$, "");
      return;
    }
    if (generation !== get(internalInspectLogLoadGeneration$)) {
      return;
    }
    L.info("Loaded inspect log file", file.name);
    set(internalInspectLogData$, data);
    set(internalInspectLogLoadError$, null);
    set(internalInspectStepSearch$, "");
  },
);

// ---------------------------------------------------------------------------
// Inspect step search — component-local filter for the inspect detail view
// ---------------------------------------------------------------------------

/** Current step search filter for the inspect detail view. */
export const inspectStepSearch$ = computed((get) => {
  return get(internalInspectStepSearch$);
});

/** Update the inspect step search filter. */
export const setInspectStepSearch$ = command(({ set }, value: string) => {
  set(internalInspectStepSearch$, value);
});
