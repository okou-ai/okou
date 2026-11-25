import { workflowsCollectionContract } from "@okouai/api-contracts/client/workflows";
import type { ComposerWorkflow } from "@okouai/api-contracts/contracts/workflows";
import { command, computed, state, type Computed } from "ccstate";
import { array, string, uuid } from "zod";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { authenticatedSessionKey$, clerk$ } from "../auth.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import { rootVersion$ } from "../root-signal.ts";
import { jsonParseOr } from "../utils.ts";
import {
  workflowTokenPattern,
  type SlashWorkflowRange,
} from "./workflow-composer-domain.ts";

const recentWorkflowIdsSchema = array(string());
const workflowIdSchema = uuid();
const recentWorkflowStorage = localStorageSignals("recent-workflows");

function readRecentWorkflowIds(value: string | null): readonly string[] {
  const parsed = recentWorkflowIdsSchema.safeParse(
    jsonParseOr<unknown>(value ?? "[]", null),
  );
  return parsed.success ? parsed.data : [];
}

function normalizeWorkflowIds(ids: readonly string[]): string[] {
  return [
    ...new Set(
      ids.map((id) => {
        return id.trim().toLowerCase();
      }),
    ),
  ].filter((id) => {
    return workflowIdSchema.safeParse(id).success;
  });
}

// Only the current session/root retains readiness and its ordered writes. Token
// refreshes do not replace this graph; switching identity does.
const recentWorkflowOwner$ = computed(async (get) => {
  const sessionKey = get(authenticatedSessionKey$);
  get(rootVersion$);
  const createClient = get(apiClient$);
  const clerk = await get(clerk$);
  const orgId = clerk.organization?.id;
  const userId = clerk.user?.id;
  if (!sessionKey || !orgId || !userId) {
    throw new DOMException("Workflow recency owner changed", "AbortError");
  }
  const assertCurrent = () => {
    if (
      !clerk.organization ||
      !clerk.user ||
      !clerk.session ||
      JSON.stringify([
        clerk.organization.id,
        clerk.user.id,
        clerk.session.id,
      ]) !== sessionKey
    ) {
      throw new DOMException("Workflow recency owner changed", "AbortError");
    }
  };
  assertCurrent();
  return {
    assertCurrent,
    client: createClient(workflowsCollectionContract, {
      getTokenGuard: () => {
        assertCurrent();
        return assertCurrent;
      },
    }),
    storageKey: `recent-workflows:${orgId}:${userId}`,
    storage: localStorageSignals(`recent-workflows:${orgId}:${userId}`),
    readiness$: state<Promise<void> | undefined>(undefined),
    writes$: state<Promise<void> | undefined>(undefined),
    revision$: state(0),
  };
});

type RecentWorkflowOwner = Awaited<
  ReturnType<typeof recentWorkflowOwner$.read>
>;

const isActiveRecentWorkflowOwner$ = command(
  async (
    { get },
    owner: RecentWorkflowOwner,
    signal: AbortSignal,
  ): Promise<boolean> => {
    signal.throwIfAborted();
    owner.assertCurrent();
    const current = await get(recentWorkflowOwner$);
    signal.throwIfAborted();
    owner.assertCurrent();
    return current === owner;
  },
);

interface RecentWorkflowUse {
  readonly workflowIds: readonly string[];
  readonly sessionKey: string | null;
  readonly rootVersion: number;
}

const readLocalRecentWorkflows$ = command(
  ({ set }, owner: RecentWorkflowOwner): string[] => {
    return normalizeWorkflowIds(
      readRecentWorkflowIds(
        set(owner.storage.readFresh$) ?? set(recentWorkflowStorage.readFresh$),
      ),
    );
  },
);

const synchronizeRecentWorkflows$ = command(
  async (
    { get, set },
    owner: RecentWorkflowOwner,
    signal: AbortSignal,
  ): Promise<void> => {
    // Snapshot before yielding so initialization cannot erase a new local use.
    const revision = get(owner.revision$);
    if (!(await set(isActiveRecentWorkflowOwner$, owner, signal))) {
      return;
    }
    const localIds = set(readLocalRecentWorkflows$, owner);
    const response = await accept(
      owner.client.recent({ fetchOptions: { signal } }),
      [200],
      signal,
      { showErrorToast: false },
    );
    if (!(await set(isActiveRecentWorkflowOwner$, owner, signal))) {
      return;
    }
    // A failed read never authorizes import. Only an explicit null does; [] is
    // already initialized and must replace even a nonempty browser history.
    let canonical = response.body.workflowIds;
    if (canonical === null && localIds.length > 0) {
      const imported = await accept(
        owner.client.importRecent({
          body: { workflowIds: localIds },
          fetchOptions: { signal },
        }),
        [200],
        signal,
        { showErrorToast: false },
      );
      if (!(await set(isActiveRecentWorkflowOwner$, owner, signal))) {
        return;
      }
      canonical = imported.body.workflowIds;
    }
    if (revision === get(owner.revision$)) {
      set(owner.storage.set$, JSON.stringify(canonical ?? []));
    }
    set(recentWorkflowStorage.clear$);
  },
);

const initializeRecentWorkflows$ = command(
  ({ get, set }, owner: RecentWorkflowOwner, signal: AbortSignal) => {
    const previous = get(owner.readiness$);
    if (previous) {
      return previous;
    }
    const readiness = set(synchronizeRecentWorkflows$, owner, signal);
    set(owner.readiness$, readiness);
    return readiness;
  },
);

/** Optional root-owned bootstrap; consumers share this one initial request. */
export const setupRecentWorkflowSync$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const owner = await get(recentWorkflowOwner$);
    signal.throwIfAborted();
    await set(initializeRecentWorkflows$, owner, signal);
  },
);

export function createRecentWorkflowIds(
  activeSlashRange$: Computed<SlashWorkflowRange | null>,
) {
  return computed(async (get): Promise<readonly string[]> => {
    const range = get(activeSlashRange$);
    if (!range) {
      return [];
    }
    const owner = await get(recentWorkflowOwner$);
    // Optional sync errors retain the browser cache, not an invented empty
    // server result. Bootstrap owns and reports the original rejection.
    await Promise.allSettled([get(owner.readiness$)]);
    owner.assertCurrent();
    // Each query owns a read-only snapshot. Fresh storage signals deliberately
    // do not subscribe to writes, so an open query/IME never changes its order.
    const storage = localStorageSignals(owner.storageKey);
    const value = get(storage.get$);
    const legacy = localStorageSignals("recent-workflows");
    return normalizeWorkflowIds(
      readRecentWorkflowIds(value ?? get(legacy.get$)),
    );
  });
}

export const prepareRecentWorkflowIds$ = command(
  (
    { get },
    workflowIds: readonly string[],
    signal: AbortSignal,
  ): RecentWorkflowUse => {
    signal.throwIfAborted();
    return {
      workflowIds,
      sessionKey: get(authenticatedSessionKey$),
      rootVersion: get(rootVersion$),
    };
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
    return set(prepareRecentWorkflowIds$, workflowIds, signal);
  },
);

const persistRecentWorkflowUse$ = command(
  async (
    { get, set },
    owner: RecentWorkflowOwner,
    use: { readonly workflowIds: string[]; readonly revision: number },
    previous: Promise<void>,
    signal: AbortSignal,
  ): Promise<void> => {
    // A failed read/write is not retried, but must not strand later accepted
    // uses. The next use still merges against the server's authoritative value.
    await Promise.allSettled([previous]);
    signal.throwIfAborted();
    if (!(await set(isActiveRecentWorkflowOwner$, owner, signal))) {
      return;
    }
    const response = await accept(
      owner.client.recordRecentUse({
        body: { workflowIds: use.workflowIds },
        fetchOptions: { signal },
      }),
      [200],
      signal,
      { showErrorToast: false },
    );
    if (!(await set(isActiveRecentWorkflowOwner$, owner, signal))) {
      return;
    }
    // An earlier canonical response must not erase a newer local promotion.
    if (use.revision === get(owner.revision$)) {
      set(owner.storage.set$, JSON.stringify(response.body.workflowIds));
    }
    set(recentWorkflowStorage.clear$);
  },
);

export const recordRecentWorkflowUse$ = command(
  async (
    { get, set },
    use: RecentWorkflowUse,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const owner = await get(recentWorkflowOwner$);
    signal.throwIfAborted();
    if (
      use.sessionKey !== get(authenticatedSessionKey$) ||
      use.rootVersion !== get(rootVersion$)
    ) {
      throw new DOMException("Workflow recency owner changed", "AbortError");
    }
    const { workflowIds } = use;
    owner.assertCurrent();
    const readiness = set(initializeRecentWorkflows$, owner, signal);
    const revision = get(owner.revision$) + 1;
    set(owner.revision$, revision);
    set(
      owner.storage.set$,
      JSON.stringify([
        ...new Set([
          ...normalizeWorkflowIds(workflowIds),
          ...set(readLocalRecentWorkflows$, owner),
        ]),
      ]),
    );
    set(recentWorkflowStorage.clear$);
    const write = set(
      persistRecentWorkflowUse$,
      owner,
      { workflowIds: normalizeWorkflowIds(workflowIds), revision },
      get(owner.writes$) ?? readiness,
      signal,
    );
    set(owner.writes$, write);
    await write;
  },
);
