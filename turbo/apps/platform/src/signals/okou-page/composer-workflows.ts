import { command, computed, state } from "ccstate";
import { workflowsCollectionContract } from "@okouai/api-contracts/client/workflows";
import type { ComposerWorkflow } from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { BrowserClerk } from "@clerk/shared/types";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import {
  reloadWorkflowData$,
  workflowReloadVersion$,
} from "../workflows-page/workflow-reload.ts";
import { authenticatedSessionKey$, clerk$ } from "../auth.ts";
import { featureSwitches$ } from "../external/feature-switch.ts";
import { rootSignal$, rootVersion$ } from "../root-signal.ts";
import { resetSignal, waitForToken } from "../utils.ts";
import { readLegacyWorkflowIdsForMigration$ } from "./legacy-workflow-recency.ts";

export const workflowRecencyEnabled$ = computed(async (get) => {
  return (await get(featureSwitches$))[FeatureSwitchKey.WorkflowRecency];
});

export const reloadComposerWorkflowRecency$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const owner = get(authenticatedSessionKey$);
    const enabled = await get(workflowRecencyEnabled$);
    signal.throwIfAborted();
    if (owner !== get(authenticatedSessionKey$)) {
      throw new DOMException("Workflow recency owner changed", "AbortError");
    }
    if (enabled) {
      set(reloadWorkflowData$);
    }
  },
);

function isCurrentOwner(clerk: BrowserClerk, owner: string | null): boolean {
  return (
    owner !== null &&
    !!clerk.user &&
    !!clerk.organization &&
    !!clerk.session &&
    JSON.stringify([clerk.organization.id, clerk.user.id, clerk.session.id]) ===
      owner
  );
}

/** One list load, including its optional import, for the current auth/root. */
function createComposerWorkflowList(owner: string | null) {
  const importChecked$ = state(false);
  const resetLoad$ = resetSignal();
  const request$ = state<{
    readonly version: number;
    readonly enabled: Promise<boolean>;
    readonly result: Promise<readonly ComposerWorkflow[]>;
  } | null>(null);
  const read$ = command(
    async (
      { get, set },
      previous: Promise<readonly ComposerWorkflow[]> | undefined,
      enabled: Promise<boolean>,
      signal: AbortSignal,
    ): Promise<readonly ComposerWorkflow[]> => {
      // Refreshes serialize behind the whole GET/import/GET operation. No
      // earlier GET can publish a pre-import response after the import ends.
      // A failed previous opening does not prevent the next opening's retry.
      if (previous) {
        await waitForToken(Promise.allSettled([previous]), signal);
      }
      const loadSignal = set(resetLoad$, signal);
      const clerk = await get(clerk$);
      signal.throwIfAborted();
      const assertCurrent = () => {
        loadSignal.throwIfAborted();
        if (!isCurrentOwner(clerk, owner)) {
          throw new DOMException(
            "Workflow recency owner changed",
            "AbortError",
          );
        }
      };
      assertCurrent();
      using _subscription = {
        unsubscribe: clerk.addListener(() => {
          // Transitional undefined resources must not poison the session;
          // the token guard still rejects requests during that transition.
          if (
            clerk.user !== undefined &&
            clerk.organization !== undefined &&
            clerk.session !== undefined &&
            !isCurrentOwner(clerk, owner)
          ) {
            set(resetLoad$);
          }
        }),
        [Symbol.dispose]() {
          this.unsubscribe();
        },
      };
      const client = get(apiClient$)(workflowsCollectionContract, {
        // Check actual Clerk state on both sides of delayed token acquisition;
        // the reactive session key may not have caught up with Clerk yet.
        getTokenGuard: () => {
          assertCurrent();
          return assertCurrent;
        },
      });
      const readWorkflows = async () => {
        const result = await accept(
          client.composer({ query: {}, fetchOptions: { signal: loadSignal } }),
          [200],
          loadSignal,
        );
        assertCurrent();
        return result.body;
      };
      const recencyEnabled = await enabled;
      signal.throwIfAborted();
      assertCurrent();
      const workflows = await readWorkflows();
      signal.throwIfAborted();
      if (!recencyEnabled || get(importChecked$)) {
        return workflows;
      }
      if (
        workflows.some((workflow) => {
          return typeof workflow.lastUsedAt === "string";
        })
      ) {
        set(importChecked$, true);
        return workflows;
      }
      const workflowIds = set(readLegacyWorkflowIdsForMigration$);
      if (workflowIds.length === 0) {
        return workflows;
      }
      await accept(
        client.migrateRecency({
          body: { workflowIds },
          fetchOptions: { signal: loadSignal },
        }),
        [200],
        loadSignal,
      );
      signal.throwIfAborted();
      assertCurrent();
      // Also remember an atomic no-op: server history can be outside the
      // visible catalog. Never delete or rewrite the legacy browser key.
      set(importChecked$, true);
      return await readWorkflows();
    },
  );
  return {
    needsLoad$: computed((get) => {
      const request = get(request$);
      return (
        request?.version !== get(workflowReloadVersion$) ||
        request.enabled !== get(workflowRecencyEnabled$)
      );
    }),
    load$: command(async ({ get, set }, signal: AbortSignal) => {
      signal.throwIfAborted();
      const version = get(workflowReloadVersion$);
      const enabled = get(workflowRecencyEnabled$);
      let request = get(request$);
      if (request?.version !== version || request.enabled !== enabled) {
        const result = set(read$, request?.result, enabled, get(rootSignal$));
        request = { version, enabled, result };
        set(request$, request);
      }
      // The shared HTTP operation belongs to the root, not the first editor
      // to request it. Unmount cancels only that consumer, not other editors.
      const workflows = await waitForToken(request.result, signal);
      const clerk = await get(clerk$);
      signal.throwIfAborted();
      if (!isCurrentOwner(clerk, owner)) {
        throw new DOMException("Workflow recency owner changed", "AbortError");
      }
      return workflows;
    }),
  };
}

const composerWorkflowList$ = computed((get) => {
  get(rootVersion$);
  return createComposerWorkflowList(get(authenticatedSessionKey$));
});

export const composerWorkflowsNeedLoad$ = computed((get) => {
  return get(get(composerWorkflowList$).needsLoad$);
});

export const loadComposerWorkflows$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    return await set(get(composerWorkflowList$).load$, signal);
  },
);
