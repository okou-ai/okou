import { fetchResource } from "../lib/resource-fetch.ts";
import { command, computed, state } from "ccstate";
import { delay } from "signal-timers";

import { localStorageSignals } from "./external/local-storage.ts";
import { isRecord, jsonParseOr, setLoop } from "./utils.ts";
import { resolvePlatformServiceStatusConfig } from "../lib/platform-host.ts";

const STATUS_REFRESH_INTERVAL_MS = 3 * 60 * 1000;

const { get$: dismissedIssueIdsRaw$, set$: setDismissedIssueIdsRaw$ } =
  localStorageSignals("closedFrames");
const refreshVersion$ = state(0);

type InstatusIssueType = "incident" | "maintenance";

export interface InstatusIssue {
  readonly id: string;
  readonly status: string;
  readonly title: string;
  readonly type: InstatusIssueType;
}

function parseIssue(value: unknown, type: InstatusIssueType): InstatusIssue {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.status !== "string"
  ) {
    throw new Error(`Invalid Instatus ${type} issue`);
  }

  return {
    id: value.id,
    status: value.status,
    title: value.name,
    type,
  };
}

function parseIssueList(
  value: unknown,
  type: InstatusIssueType,
): InstatusIssue[] {
  // Instatus omits collections with no active entries. Remove this fallback
  // only if the provider guarantees both collections are always present.
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Invalid Instatus ${type} issue list`);
  }

  return value.map((item) => {
    return parseIssue(item, type);
  });
}

function parseIssues(value: unknown): InstatusIssue[] {
  if (!isRecord(value)) {
    throw new Error("Invalid Instatus issues response");
  }

  return [
    ...parseIssueList(value.activeIncidents, "incident"),
    ...parseIssueList(value.activeMaintenances, "maintenance"),
  ];
}

function parseDismissedIssueIds(value: string | null): Set<string> {
  if (value === null) {
    return new Set();
  }

  const parsed = jsonParseOr<unknown>(value, []);
  return new Set(
    Array.isArray(parsed)
      ? parsed.filter((item): item is string => {
          return typeof item === "string";
        })
      : [],
  );
}

const activeInstatusIssues$ = computed(
  async (get): Promise<InstatusIssue[]> => {
    get(refreshVersion$);
    const config = resolvePlatformServiceStatusConfig(window.location.hostname);
    if (!config) {
      return [];
    }

    const response = await fetchResource(config.issuesUrl, {});
    if (!response.ok) {
      throw new Error(`Instatus issues request failed with ${response.status}`);
    }

    const result: unknown = await response.json();
    return parseIssues(result);
  },
);

const dismissedIssueIds$ = computed((get) => {
  return parseDismissedIssueIds(get(dismissedIssueIdsRaw$));
});

export const visibleInstatusIssues$ = computed(
  async (get): Promise<InstatusIssue[]> => {
    const issues = await get(activeInstatusIssues$);
    const dismissedIssueIds = get(dismissedIssueIds$);
    return issues.filter((issue) => {
      return !dismissedIssueIds.has(issue.id);
    });
  },
);

export const dismissInstatusIssue$ = command(
  ({ get, set }, issueId: string) => {
    const nextDismissedIssueIds = new Set(get(dismissedIssueIds$));
    nextDismissedIssueIds.add(issueId);
    set(
      setDismissedIssueIdsRaw$,
      JSON.stringify(Array.from(nextDismissedIssueIds)),
    );
  },
);

export const pollInstatusIssues$ = command(
  ({ set }, signal: AbortSignal): void => {
    if (!resolvePlatformServiceStatusConfig(window.location.hostname)) {
      return;
    }

    setLoop(
      async (loopSignal) => {
        await delay(STATUS_REFRESH_INTERVAL_MS, { signal: loopSignal });
        set(refreshVersion$, (version) => {
          return version + 1;
        });
        return false;
      },
      0,
      signal,
      { retryTransientErrors: false },
    );
  },
);
