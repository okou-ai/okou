import { command, computed, state } from "ccstate";
import { activeUserPermissionGrantSnapshot } from "../../user-permission-grants.ts";
import type { PermissionDrawerSession } from "./permission-drawer-session.ts";

import {
  clearPermissionDraftInheritedExpiration,
  createEmptyPermissionDraftIntent,
  setPermissionDraftConnectorPolicy,
  setPermissionDraftExpiration,
  setPermissionDraftGroupAllowExpiration,
  setPermissionDraftGroupAllowPolicy,
  setPermissionDraftGroupPolicy,
  setPermissionDraftPolicy,
  setPermissionDraftUnknownExpiration,
  setPermissionDraftUnknownPolicy,
  stagePermissionDraftConnectorRestore,
  type PermissionDraftIntent,
} from "./permission-draft-intent.ts";

interface PermissionDrawerUiState {
  readonly key: string | null;
  readonly draft: PermissionDraftIntent;
  readonly expandedGroups: ReadonlySet<string>;
  readonly visibleCounts: Readonly<Record<string, number>>;
  readonly search: string;
  readonly scrolled: boolean;
}

interface InitialPermissionDrawerUiState {
  readonly draft?: PermissionDraftIntent;
  readonly search?: string;
}

function emptyPermissionDrawerUiState(
  key: string | null,
  initial?: InitialPermissionDrawerUiState,
): PermissionDrawerUiState {
  return {
    key,
    draft: initial?.draft ?? createEmptyPermissionDraftIntent(),
    expandedGroups: new Set(),
    visibleCounts: {},
    search: initial?.search ?? "",
    scrolled: false,
  };
}

export function permissionDrawerUiStateForKey(
  current: PermissionDrawerUiState,
  key: string,
  initial?: InitialPermissionDrawerUiState,
): PermissionDrawerUiState {
  return current.key === key
    ? current
    : emptyPermissionDrawerUiState(key, initial);
}

function stateForKey(
  current: PermissionDrawerUiState,
  key: string,
  initial?: InitialPermissionDrawerUiState,
): PermissionDrawerUiState {
  return current.key === key
    ? current
    : emptyPermissionDrawerUiState(key, initial);
}

const internalPermissionDrawerUiState$ = state<PermissionDrawerUiState>(
  emptyPermissionDrawerUiState(null),
);

export const permissionDrawerUiState$ = computed((get) => {
  return get(internalPermissionDrawerUiState$);
});

type DraftEditArgs<Edit extends (args: never) => PermissionDraftIntent> = Omit<
  Parameters<Edit>[0],
  "draft"
>;

/** One member edit to the drawer's permission draft. */
export type PermissionDrawerDraftEdit =
  | ({ readonly kind: "permission-policy" } & DraftEditArgs<
      typeof setPermissionDraftPolicy
    >)
  | ({ readonly kind: "connector-policy" } & DraftEditArgs<
      typeof setPermissionDraftConnectorPolicy
    >)
  | ({ readonly kind: "group-allow" } & DraftEditArgs<
      typeof setPermissionDraftGroupAllowPolicy
    >)
  | ({ readonly kind: "group-policy" } & DraftEditArgs<
      typeof setPermissionDraftGroupPolicy
    >)
  | ({ readonly kind: "group-allow-expiration" } & DraftEditArgs<
      typeof setPermissionDraftGroupAllowExpiration
    >)
  | { readonly kind: "restore-connector" }
  | ({ readonly kind: "permission-expiration" } & DraftEditArgs<
      typeof setPermissionDraftExpiration
    >)
  | ({ readonly kind: "clear-inherited-expiration" } & DraftEditArgs<
      typeof clearPermissionDraftInheritedExpiration
    >)
  | ({ readonly kind: "unknown-expiration" } & DraftEditArgs<
      typeof setPermissionDraftUnknownExpiration
    >)
  | ({ readonly kind: "unknown-policy" } & DraftEditArgs<
      typeof setPermissionDraftUnknownPolicy
    >);

function applyPermissionDrawerDraftEdit(
  draft: PermissionDraftIntent,
  edit: PermissionDrawerDraftEdit,
): PermissionDraftIntent {
  switch (edit.kind) {
    case "permission-policy": {
      return setPermissionDraftPolicy({ ...edit, draft });
    }
    case "connector-policy": {
      return setPermissionDraftConnectorPolicy({ ...edit, draft });
    }
    case "group-allow": {
      return setPermissionDraftGroupAllowPolicy({ ...edit, draft });
    }
    case "group-policy": {
      return setPermissionDraftGroupPolicy({ ...edit, draft });
    }
    case "group-allow-expiration": {
      return setPermissionDraftGroupAllowExpiration({ ...edit, draft });
    }
    case "restore-connector": {
      return stagePermissionDraftConnectorRestore({ draft });
    }
    case "permission-expiration": {
      return setPermissionDraftExpiration({ ...edit, draft });
    }
    case "clear-inherited-expiration": {
      return clearPermissionDraftInheritedExpiration({ ...edit, draft });
    }
    case "unknown-expiration": {
      return setPermissionDraftUnknownExpiration({ ...edit, draft });
    }
    case "unknown-policy": {
      return setPermissionDraftUnknownPolicy({ ...edit, draft });
    }
  }
}

export const editPermissionDrawerDraft$ = command(
  (
    { get, set },
    key: string,
    edit: PermissionDrawerDraftEdit,
    initial?: InitialPermissionDrawerUiState,
  ) => {
    const current = stateForKey(
      get(internalPermissionDrawerUiState$),
      key,
      initial,
    );
    set(internalPermissionDrawerUiState$, {
      ...current,
      draft: applyPermissionDrawerDraftEdit(current.draft, edit),
    });
  },
);

export const togglePermissionDrawerGroup$ = command(
  (
    { get, set },
    key: string,
    category: string,
    initial?: InitialPermissionDrawerUiState,
  ) => {
    const current = stateForKey(
      get(internalPermissionDrawerUiState$),
      key,
      initial,
    );
    const expandedGroups = new Set(current.expandedGroups);
    if (expandedGroups.has(category)) {
      expandedGroups.delete(category);
    } else {
      expandedGroups.add(category);
    }
    set(internalPermissionDrawerUiState$, {
      ...current,
      expandedGroups,
    });
  },
);

export const showMorePermissionDrawerRows$ = command(
  (
    { get, set },
    key: string,
    rowKey: string,
    pageSize: number,
    initial?: InitialPermissionDrawerUiState,
  ) => {
    const current = stateForKey(
      get(internalPermissionDrawerUiState$),
      key,
      initial,
    );
    set(internalPermissionDrawerUiState$, {
      ...current,
      visibleCounts: {
        ...current.visibleCounts,
        [rowKey]: (current.visibleCounts[rowKey] ?? pageSize) + pageSize,
      },
    });
  },
);

export const setPermissionDrawerSearch$ = command(
  (
    { get, set },
    key: string,
    search: string,
    initial?: InitialPermissionDrawerUiState,
  ) => {
    const current = stateForKey(
      get(internalPermissionDrawerUiState$),
      key,
      initial,
    );
    const visibleCounts = { ...current.visibleCounts };
    delete visibleCounts.permissions;
    set(internalPermissionDrawerUiState$, {
      ...current,
      search,
      visibleCounts,
    });
  },
);

export const setPermissionDrawerScrolled$ = command(
  (
    { get, set },
    key: string,
    scrolled: boolean,
    initial?: InitialPermissionDrawerUiState,
  ) => {
    const current = stateForKey(
      get(internalPermissionDrawerUiState$),
      key,
      initial,
    );
    set(internalPermissionDrawerUiState$, {
      ...current,
      scrolled,
    });
  },
);

export const resetPermissionDrawerState$ = command(({ set }) => {
  set(internalPermissionDrawerUiState$, emptyPermissionDrawerUiState(null));
});

/** Leaves the drawer: its edits are discarded with its owner's surface. */
export const dismissPermissionDrawer$ = command(
  ({ set }, session: PermissionDrawerSession) => {
    set(resetPermissionDrawerState$);
    set(session.close$);
  },
);

/**
 * Saves the drawer's draft against the owner's current grants, then leaves
 * the drawer. `key` names the draft the member edited.
 */
export const applyPermissionDrawer$ = command(
  async (
    { get, set },
    session: PermissionDrawerSession,
    key: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const intent = stateForKey(
      get(internalPermissionDrawerUiState$),
      key,
    ).draft;
    const [grants, metadata] = await Promise.all([
      get(session.grants$),
      get(session.metadata$),
    ]);
    signal.throwIfAborted();
    if (!grants || !metadata) {
      throw new Error("Permission drawer has no grants to save against");
    }
    const snapshot = activeUserPermissionGrantSnapshot(grants);
    await set(
      session.save$,
      {
        metadata,
        initialPolicies: snapshot.policies ?? {},
        initialGrants: snapshot.grants,
        intent,
      },
      signal,
    );
    signal.throwIfAborted();
    set(dismissPermissionDrawer$, session);
  },
);
