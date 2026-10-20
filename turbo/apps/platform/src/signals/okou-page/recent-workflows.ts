import type { ComposerWorkflow } from "@okouai/api-contracts/contracts/workflows";
import { command, computed, type Computed } from "ccstate";
import { z } from "zod";
import { localStorageSignals } from "../external/local-storage.ts";
import { jsonParseOr } from "../utils.ts";
import {
  workflowTokenPattern,
  type SlashWorkflowRange,
} from "./workflow-composer-domain.ts";

const recentWorkflowIdsSchema = z.array(z.string());
const recentWorkflowStorage = localStorageSignals("recent-workflows");

function readRecentWorkflowIds(value: string | null): readonly string[] {
  const parsed = recentWorkflowIdsSchema.safeParse(
    jsonParseOr<unknown>(value ?? "[]", null),
  );
  return parsed.success ? parsed.data : [];
}

export function createRecentWorkflowIds(
  activeSlashRange$: Computed<SlashWorkflowRange | null>,
) {
  return computed((get) => {
    const range = get(activeSlashRange$);
    if (!range) {
      return [];
    }
    // Each query owns a read-only snapshot. A send from another composer or tab
    // cannot move the rows until this query changes or the menu opens again.
    const storage = localStorageSignals("recent-workflows");
    return readRecentWorkflowIds(get(storage.get$));
  });
}

export const prepareRecentWorkflowUse$ = command(
  async (
    { get },
    prompt: string,
    workflows$: Computed<Promise<readonly ComposerWorkflow[]> | null>,
    signal: AbortSignal,
  ): Promise<readonly string[] | null> => {
    if (!prompt.includes("/")) {
      return null;
    }
    const workflows = await get(workflows$);
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
    return workflowIds;
  },
);

export const recordRecentWorkflowUse$ = command(
  ({ set }, workflowIds: readonly string[], signal: AbortSignal): void => {
    signal.throwIfAborted();
    const previous = readRecentWorkflowIds(
      set(recentWorkflowStorage.readFresh$),
    );
    const ids = [...new Set([...workflowIds, ...previous])];
    set(recentWorkflowStorage.set$, JSON.stringify(ids));
  },
);
