import type { ComposerWorkflow } from "@okouai/api-contracts/contracts/workflows";
import { command, computed, type Computed } from "ccstate";
import { z } from "zod";
import { now } from "../../lib/time.ts";
import { authenticatedIdentity$ } from "../auth.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import { jsonParseOr, tapError } from "../utils.ts";
import {
  workflowTokenPattern,
  type SlashWorkflowRange,
  type WorkflowUsage,
} from "./workflow-composer-domain.ts";

const workflowUsesSchema = z.array(
  z.object({ workflowId: z.string(), usedAt: z.number().int().nonnegative() }),
);
const WORKFLOW_USAGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function workflowStorageKey(identity: { userId: string; orgId: string }) {
  // The old recent-workflows list has no timestamps. Keep its key separate so
  // older clients cannot overwrite usage, and never invent dates for old IDs.
  return `workflow-usage:${identity.userId}:${identity.orgId}`;
}

const workflowUsageStorage$ = computed(async (get) => {
  return localStorageSignals(
    workflowStorageKey(await get(authenticatedIdentity$)),
  );
});

function readWorkflowUses(value: string | null, timestamp: number) {
  const parsed = workflowUsesSchema.safeParse(
    jsonParseOr<unknown>(value ?? "[]", null),
  );
  return parsed.success
    ? parsed.data.filter(({ usedAt }) => {
        return (
          usedAt > timestamp - WORKFLOW_USAGE_WINDOW_MS && usedAt <= timestamp
        );
      })
    : [];
}

export function createWorkflowUsage(
  activeSlashRange$: Computed<SlashWorkflowRange | null>,
): Computed<Promise<ReadonlyMap<string, WorkflowUsage>>> {
  const snapshot$ = computed(async (get) => {
    const range = get(activeSlashRange$);
    const usage = new Map<string, WorkflowUsage>();
    if (!range) {
      return usage;
    }
    // Each query owns a read-only snapshot. A send from another composer or tab
    // cannot move the rows until this query changes or the menu opens again.
    const storage = localStorageSignals(
      workflowStorageKey(await get(authenticatedIdentity$)),
    );
    for (const { workflowId, usedAt } of readWorkflowUses(
      get(storage.get$),
      now(),
    )) {
      const previous = usage.get(workflowId);
      usage.set(workflowId, {
        count: (previous?.count ?? 0) + 1,
        lastUsedAt: Math.max(previous?.lastUsedAt ?? 0, usedAt),
      });
    }
    return usage;
  });
  return computed(async (get) => {
    // Browser storage can be unavailable; the menu still offers every workflow.
    return (await tapError(get(snapshot$))) ?? new Map<string, WorkflowUsage>();
  });
}

interface WorkflowUse {
  readonly storage: Promise<ReturnType<typeof localStorageSignals>>;
  readonly workflowIds: readonly string[];
}

export const captureWorkflowUse$ = command(
  ({ get }, workflowIds: readonly string[]): WorkflowUse => {
    return { storage: get(workflowUsageStorage$), workflowIds };
  },
);

export const prepareWorkflowUse$ = command(
  async (
    { get, set },
    prompt: string,
    workflows$: Computed<Promise<readonly ComposerWorkflow[]> | null>,
    signal: AbortSignal,
  ): Promise<WorkflowUse | null> => {
    if (!prompt.includes("/")) {
      return null;
    }
    // Usage is optional metadata: a failed lookup must not prevent sending.
    const workflows = await tapError(get(workflows$) ?? Promise.resolve([]));
    signal.throwIfAborted();
    const workflowIds = (workflows ?? [])
      .filter((workflow) => {
        return workflowTokenPattern([workflow.name])?.test(prompt);
      })
      .map((workflow) => {
        return workflow.id;
      });
    if (workflowIds.length === 0) {
      return null;
    }
    // Capture the owner before submission can navigate to another composer.
    return set(captureWorkflowUse$, workflowIds);
  },
);

export const recordWorkflowUse$ = command(
  async ({ set }, usage: WorkflowUse, signal: AbortSignal): Promise<void> => {
    // Read fresh storage on every accepted use, including updates from tabs
    // that share this user and workspace.
    const storage = await usage.storage;
    signal.throwIfAborted();
    const timestamp = now();
    const previous = readWorkflowUses(set(storage.readFresh$), timestamp);
    const uses = [...new Set(usage.workflowIds)].map((workflowId) => {
      return { workflowId, usedAt: timestamp };
    });
    set(storage.set$, JSON.stringify([...previous, ...uses]));
  },
);
