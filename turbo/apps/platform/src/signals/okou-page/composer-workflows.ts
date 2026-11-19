import { command, computed, state, type Computed } from "ccstate";
import { workflowsCollectionContract } from "@okouai/api-contracts/client/workflows";
import type { ComposerWorkflow } from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { BrowserClerk } from "@clerk/shared/types";
import { accept } from "../../lib/accept.ts";
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
import { workflowReloadVersion$ } from "../workflows-page/workflow-reload.ts";
import { authenticatedSessionKey$, clerk$ } from "../auth.ts";
import { featureSwitches$ } from "../external/feature-switch.ts";
import { rootSignal$, rootVersion$ } from "../root-signal.ts";
import { resetSignal } from "../utils.ts";
import { readLegacyWorkflowIdsForMigration$ } from "./legacy-workflow-recency.ts";

const recencyVersion$ = state(0);
const queryVersion$ = state(0);

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
    if (!enabled) {
      return;
    }
    set(recencyVersion$, (version) => {
      return version + 1;
    });
  },
);

/** Reopening retries failed catalog reads in both switch modes. */
export const reloadComposerWorkflowQuery$ = command(({ set }) => {
  set(queryVersion$, (version) => {
    return version + 1;
  });
});

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

function createWorkflowRecencyClient(
  createClient: ApiClientFactory,
  assertCurrent: () => void,
) {
  return createClient(workflowsCollectionContract, {
    getTokenGuard: () => {
      assertCurrent();
      return assertCurrent;
    },
  });
}

interface WorkflowRecencyOwnerResource {
  readonly client: ReturnType<typeof createWorkflowRecencyClient>;
  readonly assertCurrent: () => void;
  readonly signal: AbortSignal;
}

/** Session-bound HTTP ownership shared by the current owner's requests. */
function createWorkflowRecencyOwnerResource(owner: string | null) {
  const resource$ = state<Promise<WorkflowRecencyOwnerResource> | null>(null);
  const resetOwner$ = resetSignal();
  const initialize$ = command(async ({ get, set }, signal: AbortSignal) => {
    let initialized = false;
    using _initialization = {
      [Symbol.dispose]() {
        if (!initialized) {
          set(resource$, null);
        }
      },
    };
    const createClient = get(apiClient$);
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    const ownerSignal = set(resetOwner$, signal);
    const assertCurrent = () => {
      ownerSignal.throwIfAborted();
      if (!isCurrentOwner(clerk, owner)) {
        throw new DOMException("Workflow recency owner changed", "AbortError");
      }
    };
    assertCurrent();
    const unsubscribe = clerk.addListener(() => {
      // Transitive undefined resources do not replace a still-owned session.
      // Token guards reject during that transition without poisoning it.
      if (
        clerk.user === undefined ||
        clerk.organization === undefined ||
        clerk.session === undefined
      ) {
        return;
      }
      if (!isCurrentOwner(clerk, owner)) {
        set(resetOwner$);
      }
    });
    ownerSignal.addEventListener("abort", unsubscribe, { once: true });
    const client = createWorkflowRecencyClient(createClient, assertCurrent);
    initialized = true;
    return {
      client,
      assertCurrent,
      signal: ownerSignal,
    };
  });
  const open$ = command(async ({ get, set }, signal: AbortSignal) => {
    let resource = get(resource$);
    if (!resource) {
      resource = set(initialize$, signal);
      set(resource$, resource);
    }
    const result = await resource;
    signal.throwIfAborted();
    result.assertCurrent();
    return result;
  });
  return open$;
}

/** One bounded request and migration graph per authenticated owner/app root. */
function createWorkflowRecencyOwner(owner: string | null) {
  const open$ = createWorkflowRecencyOwnerResource(owner);
  const checked$ = state(false);
  const migrationRevision$ = state(0);
  const migration$ = state<Promise<void> | null>(null);
  const readComposer$ = command(
    async ({ get, set }, agentId: string, consumerSignal: AbortSignal) => {
      const resource = await set(open$, get(rootSignal$));
      const signal = AbortSignal.any([resource.signal, consumerSignal]);
      signal.throwIfAborted();
      resource.assertCurrent();
      const result = await accept(
        resource.client.composer({
          query: { agentId },
          fetchOptions: { signal },
        }),
        [200],
        signal,
      );
      signal.throwIfAborted();
      resource.assertCurrent();
      return result.body;
    },
  );
  const migrate$ = command(
    async ({ set }, workflowIds: string[], signal: AbortSignal) => {
      // Only in-flight work is released. Failure remains retryable on the next
      // genuine opening; success (including an atomic no-op) belongs to owner.
      using _pending = {
        [Symbol.dispose]() {
          set(migration$, null);
        },
      };
      const resource = await set(open$, signal);
      signal.throwIfAborted();
      await accept(
        resource.client.migrateRecency({
          body: { workflowIds },
          fetchOptions: { signal: resource.signal },
        }),
        [200],
        resource.signal,
      );
      signal.throwIfAborted();
      resource.assertCurrent();
      set(checked$, true);
      set(migrationRevision$, (revision) => {
        return revision + 1;
      });
    },
  );
  return {
    open$,
    load$: command(
      async (
        { get, set },
        agentId: string,
        enabled: boolean,
        signal: AbortSignal,
      ): Promise<readonly ComposerWorkflow[]> => {
        const revision = get(migrationRevision$);
        const workflows = await set(readComposer$, agentId, signal);
        if (!enabled) {
          return workflows;
        }
        const pending = get(migration$);
        if (pending) {
          await pending;
          signal.throwIfAborted();
          return await set(readComposer$, agentId, signal);
        }
        // A GET started before another composer imported history must not
        // publish pre-import data after that import finishes.
        if (revision !== get(migrationRevision$)) {
          return await set(readComposer$, agentId, signal);
        }
        if (get(checked$)) {
          return workflows;
        }
        if (
          workflows.some((workflow) => {
            return typeof workflow.lastUsedAt === "string";
          })
        ) {
          set(checked$, true);
          return workflows;
        }
        const legacyIds = set(readLegacyWorkflowIdsForMigration$);
        if (legacyIds.length === 0) {
          return workflows;
        }
        const migration = set(migrate$, legacyIds, get(rootSignal$));
        set(migration$, migration);
        await migration;
        signal.throwIfAborted();
        return await set(readComposer$, agentId, signal);
      },
    ),
  };
}

const recencyOwner$ = computed((get) => {
  get(rootVersion$);
  return createWorkflowRecencyOwner(get(authenticatedSessionKey$));
});

type AgentIdValue = string | null | Promise<string | null>;

interface ComposerWorkflowRequestKey {
  readonly owner: ReturnType<typeof createWorkflowRecencyOwner>;
  readonly agentId: AgentIdValue;
  readonly enabled: Promise<boolean>;
}

export function createComposerWorkflows<T extends AgentIdValue>(
  agentIdSource$: Computed<T>,
) {
  const requestKey$ = computed((get): ComposerWorkflowRequestKey => {
    get(recencyVersion$);
    get(queryVersion$);
    get(workflowReloadVersion$);
    return {
      owner: get(recencyOwner$),
      agentId: get(agentIdSource$),
      enabled: get(workflowRecencyEnabled$),
    };
  });
  const mountVersion$ = state(0);
  const request$ = state<{
    readonly key: ComposerWorkflowRequestKey;
    readonly result: Promise<readonly ComposerWorkflow[]>;
  } | null>(null);
  const loadRequest$ = command(
    async ({ set }, key: ComposerWorkflowRequestKey, signal: AbortSignal) => {
      signal.throwIfAborted();
      const [agentId, enabled] = await Promise.all([key.agentId, key.enabled]);
      signal.throwIfAborted();
      return agentId
        ? await set(key.owner.load$, agentId, enabled, signal)
        : [];
    },
  );
  return {
    mount$: command(async ({ get, set }, signal: AbortSignal) => {
      signal.throwIfAborted();
      const version = get(mountVersion$) + 1;
      set(mountVersion$, version);
      set(request$, null);
      signal.addEventListener(
        "abort",
        () => {
          if (get(mountVersion$) === version) {
            set(request$, null);
          }
        },
        { once: true },
      );
      await set(get(recencyOwner$).open$, get(rootSignal$));
      signal.throwIfAborted();
    }),
    load$: command(
      (
        { get, set },
        signal: AbortSignal,
      ): Promise<readonly ComposerWorkflow[]> => {
        signal.throwIfAborted();
        const key = get(requestKey$);
        const current = get(request$);
        if (current?.key === key) {
          return current.result;
        }
        const result = set(loadRequest$, key, signal);
        set(request$, { key, result });
        return result;
      },
    ),
    needsLoad$: computed((get) => {
      return get(request$)?.key !== get(requestKey$);
    }),
  };
}
