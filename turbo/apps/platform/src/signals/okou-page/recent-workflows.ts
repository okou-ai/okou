import type { ComposerWorkflow } from "@okouai/api-contracts/contracts/workflows";
import { command, computed, state, type Computed } from "ccstate";
import { authenticatedSessionKey$ } from "../auth.ts";
import { reloadComposerWorkflowRecency$ } from "./composer-workflows.ts";
import type { SlashWorkflowRange } from "./workflow-composer-domain.ts";

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

/** The editor owns one immutable server response per open query. */
export function createWorkflowQuerySnapshot(
  activeSlashRange$: Computed<SlashWorkflowRange | null>,
  workflows$: Computed<Promise<readonly ComposerWorkflow[]> | null>,
) {
  const snapshot$ = state<{
    readonly owner: string | null;
    readonly range: SlashWorkflowRange;
    readonly workflows: Promise<readonly ComposerWorkflow[]> | null;
  } | null>(null);
  return {
    workflows$: computed((get) => {
      const snapshot = get(snapshot$);
      return snapshot?.owner === get(authenticatedSessionKey$)
        ? snapshot.workflows
        : null;
    }),
    sync$: command(({ get, set }) => {
      const range = get(activeSlashRange$);
      const owner = get(authenticatedSessionKey$);
      const previous = get(snapshot$);
      if (!range) {
        set(snapshot$, null);
        return;
      }
      if (
        previous?.owner === owner &&
        previous.range.start === range.start &&
        previous.range.end === range.end &&
        previous.range.query === range.query &&
        previous.workflows !== null
      ) {
        return;
      }
      // A new opening also repairs a missed notification. Query edits reuse
      // the request unless a local send or realtime event invalidated it.
      if (!previous || previous.owner !== owner) {
        set(reloadComposerWorkflowRecency$);
      }
      set(snapshot$, { owner, range, workflows: get(workflows$) });
    }),
  };
}
