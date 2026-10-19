import type { ComposerWorkflow } from "@okouai/api-contracts/contracts/workflows";
import { command, computed, type Computed } from "ccstate";
import { z } from "zod";
import { authenticatedIdentity$ } from "../auth.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import { jsonParseOr, tapError } from "../utils.ts";
import {
  workflowTokenPattern,
  type SlashWorkflowRange,
} from "./workflow-composer-domain.ts";

const recentWorkflowIdsSchema = z.array(z.string());

function workflowStorageKey(identity: { userId: string; orgId: string }) {
  return `recent-workflows:${identity.userId}:${identity.orgId}`;
}

const recentWorkflowStorage$ = computed(async (get) => {
  return localStorageSignals(
    workflowStorageKey(await get(authenticatedIdentity$)),
  );
});

function readRecentWorkflowIds(value: string | null): readonly string[] {
  const parsed = recentWorkflowIdsSchema.safeParse(
    jsonParseOr<unknown>(value ?? "[]", null),
  );
  return parsed.success ? parsed.data : [];
}

export function createRecentWorkflowIds(
  activeSlashRange$: Computed<SlashWorkflowRange | null>,
) {
  const snapshot$ = computed(async (get) => {
    const range = get(activeSlashRange$);
    if (!range) {
      return [];
    }
    // Each query owns a read-only snapshot. A send from another composer or tab
    // cannot move the rows until this query changes or the menu opens again.
    const storage = localStorageSignals(
      workflowStorageKey(await get(authenticatedIdentity$)),
    );
    return readRecentWorkflowIds(get(storage.get$));
  });
  return computed(async (get) => {
    // Browser storage can be unavailable; the menu still offers every workflow.
    return (await tapError(get(snapshot$))) ?? [];
  });
}

interface RecentWorkflowUse {
  readonly storage: Promise<ReturnType<typeof localStorageSignals>>;
  readonly workflowIds: readonly string[];
}

export const captureRecentWorkflowUse$ = command(
  ({ get }, workflowIds: readonly string[]): RecentWorkflowUse => {
    return { storage: get(recentWorkflowStorage$), workflowIds };
  },
);

export const prepareRecentWorkflowUse$ = command(
  async (
    { get, set },
    prompt: string,
    workflows$: Computed<Promise<readonly ComposerWorkflow[]> | null>,
    signal: AbortSignal,
  ): Promise<RecentWorkflowUse | null> => {
    if (!prompt.includes("/")) {
      return null;
    }
    // Recency is optional metadata: a failed lookup must not prevent sending.
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
    return set(captureRecentWorkflowUse$, workflowIds);
  },
);

export const recordRecentWorkflowUse$ = command(
  async (
    { set },
    usage: RecentWorkflowUse,
    signal: AbortSignal,
  ): Promise<void> => {
    // Read fresh storage on every accepted use, including updates from tabs
    // that share this user and workspace.
    const storage = await usage.storage;
    signal.throwIfAborted();
    const previous = readRecentWorkflowIds(set(storage.readFresh$));
    const ids = [...new Set([...usage.workflowIds, ...previous])];
    set(storage.set$, JSON.stringify(ids));
  },
);
