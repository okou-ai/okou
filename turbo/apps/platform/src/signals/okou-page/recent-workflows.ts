import type { ComposerWorkflow } from "@okouai/api-contracts/contracts/workflows";
import { command, computed, state, type Command, type Computed } from "ccstate";
import { createWorkflowTokenMatcher } from "@okouai/core/workflow-slash-token";
import { authenticatedSessionKey$ } from "../auth.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import {
  reloadComposerWorkflowQuery$,
  workflowRecencyEnabled$,
} from "./composer-workflows.ts";
import {
  readRecentWorkflowIds,
  recentWorkflowStorage,
} from "./legacy-workflow-recency.ts";
import type { SlashWorkflowRange } from "./workflow-composer-domain.ts";
import { detach, Reason } from "../utils.ts";

/** Missing timestamps keep old-server responses alphabetical. */
export function recentWorkflowIds(
  workflows: readonly ComposerWorkflow[],
): readonly string[] {
  return workflows
    .flatMap((workflow) => {
      // ISO UTC strings retain PostgreSQL microseconds that Date.parse loses.
      const lastUsedAt = workflow.lastUsedAt?.replace(
        /(?:\.(\d+))?Z$/u,
        (_match, fraction: string | undefined) => {
          return `.${(fraction ?? "").padEnd(9, "0")}Z`;
        },
      );
      return lastUsedAt ? [{ id: workflow.id, lastUsedAt }] : [];
    })
    .sort((left, right) => {
      return (
        right.lastUsedAt.localeCompare(left.lastUsedAt, "en") ||
        left.id.localeCompare(right.id, "en")
      );
    })
    .map((workflow) => {
      return workflow.id;
    });
}

export function createRecentWorkflowIds(
  queryRange$: Computed<SlashWorkflowRange | null>,
) {
  return computed(async (get): Promise<readonly string[]> => {
    const owner = get(authenticatedSessionKey$);
    const enabled = await get(workflowRecencyEnabled$);
    if (enabled) {
      return [];
    }
    const range = get(queryRange$);
    if (!range || owner !== get(authenticatedSessionKey$)) {
      return [];
    }
    // Each query takes a fresh read, independent of writes by another tab or
    // composer. A pending accepted send cannot reorder an already open query.
    return readRecentWorkflowIds(
      get(localStorageSignals("recent-workflows").get$),
    );
  });
}

interface RecentWorkflowUse {
  readonly owner: string | null;
  readonly workflowIds: readonly string[];
}

export const prepareRecentWorkflowUse$ = command(
  async (
    { get, set },
    prompt: string,
    loadWorkflows$: Command<
      Promise<readonly ComposerWorkflow[]>,
      [AbortSignal]
    >,
    signal: AbortSignal,
  ): Promise<RecentWorkflowUse | null> => {
    if (!prompt.includes("/")) {
      return null;
    }
    signal.throwIfAborted();
    const owner = get(authenticatedSessionKey$);
    const enabled = await get(workflowRecencyEnabled$);
    signal.throwIfAborted();
    if (owner !== get(authenticatedSessionKey$)) {
      throw new DOMException("Workflow recency owner changed", "AbortError");
    }
    // ON also waits for an empty-history import before a first accepted send
    // can make server history nonempty. It never prepares a browser write.
    const workflows = await set(loadWorkflows$, signal);
    signal.throwIfAborted();
    if (owner !== get(authenticatedSessionKey$)) {
      throw new DOMException("Workflow recency owner changed", "AbortError");
    }
    if (enabled) {
      return null;
    }
    const matchTokens = createWorkflowTokenMatcher(
      workflows.map((workflow) => {
        return workflow.name;
      }),
    );
    const names = new Set(
      matchTokens?.(prompt).map((token) => {
        return token.name;
      }),
    );
    const workflowIds = workflows
      .filter((workflow) => {
        return names.has(workflow.name);
      })
      .map((workflow) => {
        return workflow.id;
      });
    return workflowIds.length > 0 ? { owner, workflowIds } : null;
  },
);

export const recordRecentWorkflowUse$ = command(
  async (
    { get, set },
    use: RecentWorkflowUse,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    if (use.owner !== get(authenticatedSessionKey$)) {
      return;
    }
    const enabled = await get(workflowRecencyEnabled$);
    signal.throwIfAborted();
    if (enabled || use.owner !== get(authenticatedSessionKey$)) {
      return;
    }
    const previous = readRecentWorkflowIds(
      set(recentWorkflowStorage.readFresh$),
    );
    set(
      recentWorkflowStorage.set$,
      JSON.stringify([...new Set([...use.workflowIds, ...previous])]),
    );
  },
);

/** The editor owns one immutable server response per open query. */
export function createWorkflowQuerySnapshot(
  activeSlashRange$: Computed<SlashWorkflowRange | null>,
  loadWorkflows$: Command<Promise<readonly ComposerWorkflow[]>, [AbortSignal]>,
) {
  const snapshot$ = state<{
    readonly owner: string | null;
    readonly enabled: Promise<boolean>;
    readonly range: SlashWorkflowRange;
    readonly workflows: Promise<readonly ComposerWorkflow[]> | null;
  } | null>(null);
  const ownedSnapshot$ = computed((get) => {
    const snapshot = get(snapshot$);
    return snapshot?.owner === get(authenticatedSessionKey$) &&
      snapshot.enabled === get(workflowRecencyEnabled$)
      ? snapshot
      : null;
  });
  return {
    range$: computed((get) => {
      return get(ownedSnapshot$)?.range ?? null;
    }),
    workflows$: computed((get) => {
      return get(ownedSnapshot$)?.workflows ?? null;
    }),
    clear$: command(({ set }) => {
      set(snapshot$, null);
    }),
    sync$: command(({ get, set }, signal: AbortSignal) => {
      const range = get(activeSlashRange$);
      const owner = get(authenticatedSessionKey$);
      const enabled = get(workflowRecencyEnabled$);
      const previous = get(snapshot$);
      if (!range || signal.aborted) {
        set(snapshot$, null);
        return;
      }
      if (
        previous?.owner === owner &&
        previous.enabled === enabled &&
        previous.range.start === range.start &&
        previous.range.end === range.end &&
        previous.range.query === range.query &&
        previous.workflows !== null
      ) {
        return;
      }
      // Replace synchronously before load awaits the captured mode resource.
      // Its Promise identity guards pending/failed resolution without treating
      // either as OFF; an old typed/IME range never retains selectable rows.
      set(snapshot$, null);
      // A new opening also repairs a missed notification. Query edits reuse
      // the request unless a local send or realtime event invalidated it.
      if (!previous || previous.owner !== owner) {
        set(reloadComposerWorkflowQuery$);
      }
      const workflows = set(loadWorkflows$, signal);
      detach(workflows, Reason.DomCallback, "composer workflow query");
      set(snapshot$, { owner, enabled, range, workflows });
    }),
  };
}
