import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import type { PublicConnectorCatalogDiscoveryResponse } from "@okouai/api-contracts/contracts/connector-catalog";
import type { BuiltinConnectorBrief } from "@okouai/api-contracts/contracts/connected-connectors";
import { pageSignal$ } from "../page-signal.ts";
import { onRef, resetSignal } from "../utils.ts";
import { createConnectorResourceSignals } from "./connector-overview.ts";
import type { PlatformConnectorCatalogStatusItem } from "../connector-domain.ts";
import {
  relatedConnectorCatalog,
  subscribeBuiltinConnectorChanges$,
  withConnectorCompletion,
} from "../external/connectors.ts";
import { customConnectors$ } from "./settings/custom-connectors.ts";
import {
  createComposerConnectorAccountSignals,
  type ComposerConnectorAccountSignals,
} from "./composer-connector-accounts.ts";
import { resetBuiltinManualGrantForm$ } from "./settings/connectors.ts";
import { createChatConnectorAccessSignals } from "./chat-connector-access.ts";

import { createPhoneUseAccessSignals } from "./phone-use-access.ts";

export interface ComposerConnectorUiState {
  readonly showAddDialog: boolean;
  readonly selectedConnectorSlug: ConnectorSlug | null;
  readonly selectedConnector: PlatformConnectorCatalogStatusItem | null;
  readonly selectedCustomConnectorId: string | null;
  readonly addDialogSearch: string;
  readonly popoverSearch: string;
  readonly popoverOpen: boolean;
  readonly phoneUseSetupOpen: boolean;
  readonly remoteAccessDialogOpen: boolean;
  readonly remoteAccessScopeId: string;
  readonly remoteAccessFilter: "all" | "allowed";
  readonly remoteAccessEditedHosts: readonly string[];
  readonly popoverSortOrder: readonly string[] | null;
  readonly directoryTab: ConnectorDirectoryTab;
  readonly directoryCategory: string | null;
  readonly directoryDetailSlug: ConnectorSlug | null;
}

/**
 * Which half of the directory is showing. There is no "yours": the composer's
 * connector popover already lists every connected connector with its accounts
 * and permissions, so the directory is the surface for adding one.
 */
export type ConnectorDirectoryTab = "discover" | "custom";

export interface ComposerConnectorSignals {
  readonly resources: ReturnType<typeof createConnectorResourceSignals>;
  readonly phoneAccess: ReturnType<typeof createPhoneUseAccessSignals>;
  readonly addDialogCatalog$: Computed<
    Promise<PublicConnectorCatalogDiscoveryResponse | null>
  >;
  readonly addDialogBrowseCatalog$: Computed<
    Promise<PublicConnectorCatalogDiscoveryResponse | null>
  >;
  readonly addDialogCatalogItems$: Computed<
    Promise<readonly PlatformConnectorCatalogStatusItem[]>
  >;
  readonly addDialogCustomConnectors$: Computed<
    Promise<readonly CustomConnectorResponse[]>
  >;
  readonly connectorUiState$: Computed<ComposerConnectorUiState>;
  readonly popoverOpen$: Computed<boolean>;
  readonly phoneUseSetupOpen$: Computed<boolean>;
  readonly remoteAccessDialogOpen$: Computed<boolean>;
  readonly remoteAccessScopeId$: Computed<string>;
  readonly dialogsOpen$: Computed<boolean>;
  readonly openAccountManager$: Command<
    Promise<void>,
    [ConnectorAccountTarget, AbortSignal]
  >;
  readonly openAddConnectorsDialog$: Command<Promise<void>, [AbortSignal]>;
  readonly openConnectorPermissions$: Command<
    Promise<void>,
    [BuiltinConnectorBrief, AbortSignal]
  >;
  readonly directoryFinalFocus$: Command<HTMLElement | boolean, []>;
  readonly setPopoverOpen$: Command<Promise<void>, [boolean, AbortSignal]>;
  readonly searchConnectors$: Command<Promise<void>, [string, AbortSignal]>;
  readonly openRemoteAccessDialog$: Command<Promise<void>, [AbortSignal]>;
  readonly closeRemoteAccessDialog$: Command<Promise<void>, [AbortSignal]>;
  readonly triggerElement$: Computed<HTMLElement | null>;
  readonly setTriggerRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  readonly updateConnectorUiState$: Command<
    Promise<void>,
    [Partial<ComposerConnectorUiState>, AbortSignal]
  >;
  readonly accounts: ComposerConnectorAccountSignals;
  readonly chatAccess: ReturnType<typeof createChatConnectorAccessSignals>;
  readonly reloadAccountPreference$: Command<void, []>;
}

/** Browse reads ask for no keyword; the category, when set, scopes them. */
const emptyCatalogKeyword$ = computed(() => {
  return "";
});
const browseCatalog$ = relatedConnectorCatalog(emptyCatalogKeyword$);

function remoteAccessDialogState(
  open: boolean,
): Pick<
  ComposerConnectorUiState,
  "remoteAccessDialogOpen" | "remoteAccessFilter" | "remoteAccessEditedHosts"
> {
  return {
    remoteAccessDialogOpen: open,
    remoteAccessFilter: "all",
    remoteAccessEditedHosts: [],
  };
}

function initialComposerConnectorUiState(): ComposerConnectorUiState {
  return {
    showAddDialog: false,
    selectedConnectorSlug: null,
    selectedConnector: null,
    selectedCustomConnectorId: null,
    addDialogSearch: "",
    popoverSearch: "",
    popoverOpen: false,
    phoneUseSetupOpen: false,
    ...remoteAccessDialogState(false),
    remoteAccessScopeId: `remote-access-${crypto.randomUUID()}`,
    popoverSortOrder: null,
    directoryTab: "discover",
    directoryCategory: null,
    directoryDetailSlug: null,
  };
}

function createConnectorNavigation(
  chatAccess: ReturnType<typeof createChatConnectorAccessSignals>,
  ui: Pick<
    ComposerConnectorSignals,
    "connectorUiState$" | "updateConnectorUiState$" | "triggerElement$"
  >,
) {
  const openConnectorPermissions$ = command(
    ({ set }, connector: BuiltinConnectorBrief) => {
      set(chatAccess.setPermissions$, {
        target: { kind: "builtin", connectorSlug: connector.slug },
        label: connector.label,
      });
      set(ui.updateConnectorUiState$, {
        showAddDialog: false,
      });
    },
  );
  const directoryFinalFocus$ = command(({ get }) => {
    const state = get(ui.connectorUiState$);
    if (
      get(chatAccess.permissions$) ||
      state.selectedConnectorSlug ||
      state.selectedCustomConnectorId
    ) {
      return false;
    }
    return get(ui.triggerElement$) ?? true;
  });
  return {
    openConnectorPermissions$,
    directoryFinalFocus$,
    searchConnectors$: command(
      async ({ get, set }, search: string, signal: AbortSignal) => {
        if (get(chatAccess.target$)) {
          set(chatAccess.closeTarget$);
        }
        await set(
          ui.updateConnectorUiState$,
          { popoverSearch: search },
          signal,
        );
      },
    ),
  };
}

function createConnectorUiSelectors(
  connectorUiState$: Computed<ComposerConnectorUiState>,
): Pick<
  ComposerConnectorSignals,
  | "popoverOpen$"
  | "phoneUseSetupOpen$"
  | "remoteAccessDialogOpen$"
  | "remoteAccessScopeId$"
  | "dialogsOpen$"
> {
  return {
    popoverOpen$: computed((get) => {
      return get(connectorUiState$).popoverOpen;
    }),
    phoneUseSetupOpen$: computed((get) => {
      return get(connectorUiState$).phoneUseSetupOpen;
    }),
    remoteAccessDialogOpen$: computed((get) => {
      return get(connectorUiState$).remoteAccessDialogOpen;
    }),
    remoteAccessScopeId$: computed((get) => {
      return get(connectorUiState$).remoteAccessScopeId;
    }),
    dialogsOpen$: computed((get) => {
      const uiState = get(connectorUiState$);
      return (
        uiState.showAddDialog ||
        uiState.phoneUseSetupOpen ||
        uiState.selectedConnector !== null ||
        uiState.selectedCustomConnectorId !== null
      );
    }),
  };
}

function createConnectorTriggerSignals(
  chatAccess: ReturnType<typeof createChatConnectorAccessSignals>,
) {
  const internalTriggerElement$ = state<HTMLElement | null>(null);
  const triggerElement$ = computed((get) => {
    return get(internalTriggerElement$);
  });
  const setTriggerRef$ = onRef(
    command(({ set }, element: HTMLElement, signal: AbortSignal) => {
      set(internalTriggerElement$, element);
      signal.addEventListener("abort", () => {
        set(internalTriggerElement$, null);
        set(chatAccess.accountManager.close$);
      });
    }),
  );
  return { triggerElement$, setTriggerRef$ };
}

function createConnectorUiStateCommands(
  internalUiState$: State<ComposerConnectorUiState>,
  resources: ReturnType<typeof createConnectorResourceSignals>,
) {
  const resetBuiltinSubscription$ = resetSignal();
  const applyConnectorUiState$ = command(
    (
      { get, set },
      patch: Partial<ComposerConnectorUiState>,
      features: Awaited<ReturnType<typeof featureSwitches$.read>>,
      signal: AbortSignal,
    ): void => {
      const chatAccounts =
        features[FeatureSwitchKey.ConnectorChatAccountAccess];
      const current = get(internalUiState$);
      const next = { ...current, ...patch };
      const hadResourceConsumer =
        current.popoverOpen || current.remoteAccessDialogOpen;
      const hasResourceConsumer =
        next.popoverOpen || next.remoteAccessDialogOpen;
      const wasOpen =
        (!chatAccounts && hadResourceConsumer) ||
        current.showAddDialog ||
        current.selectedConnectorSlug !== null;
      const isOpen =
        (!chatAccounts && hasResourceConsumer) ||
        next.showAddDialog ||
        next.selectedConnectorSlug !== null;
      if (isOpen && !wasOpen) {
        const signal = set(resetBuiltinSubscription$, get(pageSignal$));
        set(subscribeBuiltinConnectorChanges$, signal);
      } else if (!isOpen && wasOpen) {
        set(resetBuiltinSubscription$);
      }
      // The remote dialog takes over the same resources without cancelling
      // their owner when the connector popover closes.
      if (hasResourceConsumer && !hadResourceConsumer) {
        set(resources.open$, !chatAccounts, signal);
      } else if (!hasResourceConsumer && hadResourceConsumer) {
        set(resources.close$);
      }
      if (patch.selectedConnectorSlug) {
        set(resetBuiltinManualGrantForm$, patch.selectedConnectorSlug);
      }
      set(internalUiState$, next);
    },
  );
  const updateConnectorUiState$ = command(
    async (
      { get, set },
      patch: Partial<ComposerConnectorUiState>,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      // Search, sorting and filters only edit local UI state. The four
      // resource-owning fields below need the current account-mode switch.
      if (
        !("popoverOpen" in patch) &&
        !("remoteAccessDialogOpen" in patch) &&
        !("showAddDialog" in patch) &&
        !("selectedConnectorSlug" in patch)
      ) {
        set(internalUiState$, (current) => {
          return { ...current, ...patch };
        });
        return;
      }
      const features = await get(featureSwitches$);
      signal.throwIfAborted();
      set(applyConnectorUiState$, patch, features, signal);
    },
  );
  return { applyConnectorUiState$, updateConnectorUiState$ };
}

function createConnectorUiSignals(
  resources: ReturnType<typeof createConnectorResourceSignals>,
  accounts: ComposerConnectorAccountSignals,
  chatAccess: ReturnType<typeof createChatConnectorAccessSignals>,
): Pick<
  ComposerConnectorSignals,
  | "connectorUiState$"
  | "updateConnectorUiState$"
  | "openAddConnectorsDialog$"
  | "openAccountManager$"
  | "openConnectorPermissions$"
  | "directoryFinalFocus$"
  | "setPopoverOpen$"
  | "searchConnectors$"
  | "openRemoteAccessDialog$"
  | "closeRemoteAccessDialog$"
  | "triggerElement$"
  | "setTriggerRef$"
> & { clearPermissions$: Command<void, []> } {
  const internalUiState$ = state(initialComposerConnectorUiState());
  const { triggerElement$, setTriggerRef$ } =
    createConnectorTriggerSignals(chatAccess);
  const connectorUiState$ = computed((get): ComposerConnectorUiState => {
    return get(internalUiState$);
  });
  const updateConnectorUiState$ = command(
    ({ get, set }, patch: Partial<ComposerConnectorUiState>): void => {
      const current = get(internalUiState$);
      const next = { ...current, ...patch };
      const hadResourceConsumer =
        current.popoverOpen || current.remoteAccessDialogOpen;
      const hasResourceConsumer =
        next.popoverOpen || next.remoteAccessDialogOpen;
      const wasOpen =
        current.showAddDialog || current.selectedConnectorSlug !== null;
      const isOpen = next.showAddDialog || next.selectedConnectorSlug !== null;
      if (isOpen && !wasOpen) {
        const signal = set(resetBuiltinSubscription$, get(pageSignal$));
        set(subscribeBuiltinConnectorChanges$, signal);
      } else if (!isOpen && wasOpen) {
        set(resetBuiltinSubscription$);
      }
      // The remote dialog takes over the same resources without cancelling
      // their owner when the connector popover closes.
      if (hasResourceConsumer && !hadResourceConsumer) {
        set(resources.open$, false, get(pageSignal$));
      } else if (!hasResourceConsumer && hadResourceConsumer) {
        set(resources.close$);
      }
      if (patch.selectedConnectorSlug) {
        set(resetBuiltinManualGrantForm$, patch.selectedConnectorSlug);
      }
      set(internalUiState$, next);
    },
  );
  const openAddConnectorsDialog$ = command(({ set }): void => {
    // Ordinary entry starts a fresh browsing session without changing explicit
    // connector/account targets or the lifetime of an ongoing connection.
    set(updateConnectorUiState$, {
      showAddDialog: true,
      addDialogSearch: "",
      directoryTab: "discover",
      directoryCategory: null,
      directoryDetailSlug: null,
    });
  });
  const setPopoverOpen$ = command(({ get, set }, open: boolean): void => {
    if (open) {
      set(updateConnectorUiState$, { popoverOpen: true });
      set(chatAccess.open$, get(pageSignal$));
    } else {
      set(accounts.closeMenu$);
      set(chatAccess.close$);
      set(updateConnectorUiState$, {
        popoverOpen: false,
        popoverSearch: "",
        popoverSortOrder: null,
      });
    }
  });
  const openAccountManager$ = command(
    async ({ set }, target: ConnectorAccountTarget, signal: AbortSignal) => {
      if (await set(chatAccess.accountManager.open$, target, signal)) {
        await set(setPopoverOpen$, false, signal);
      }
    },
  );
  const openRemoteAccessDialog$ = command(
    ({ set }, signal: AbortSignal): Promise<void> => {
      set(accounts.closeMenu$);
      set(chatAccess.close$);
      return set(
        updateConnectorUiState$,
        {
          popoverOpen: false,
          popoverSearch: "",
          popoverSortOrder: null,
          ...remoteAccessDialogState(true),
        },
        signal,
      );
    },
  );
  const closeRemoteAccessDialog$ = command(
    ({ set }, signal: AbortSignal): Promise<void> => {
      return set(
        updateConnectorUiState$,
        { remoteAccessDialogOpen: false },
        signal,
      );
    },
  );
  return {
    connectorUiState$,
    updateConnectorUiState$,
    openAddConnectorsDialog$,
    ...createConnectorNavigation(chatAccess, {
      connectorUiState$,
      updateConnectorUiState$,
      triggerElement$,
    }),
    setPopoverOpen$,
    openAccountManager$,
    openRemoteAccessDialog$,
    closeRemoteAccessDialog$,
    triggerElement$,
    setTriggerRef$,
    clearPermissions$: command(({ set }) => {
      set(internalUiState$, (current) => {
        return {
          ...current,
          permissionConnectorSlug: null,
          permissionConnector: null,
        };
      });
    }),
  };
}

export function createComposerConnectorSignals(
  threadId?: string,
): ComposerConnectorSignals {
  const resources = createConnectorResourceSignals(threadId);
  const phoneAccess = createPhoneUseAccessSignals(resources, threadId);
  const accounts = createComposerConnectorAccountSignals(threadId);
  const chatAccess = createChatConnectorAccessSignals(threadId);
  const ui = createConnectorUiSignals(resources, accounts, chatAccess);
  const addDialogKeyword$ = computed((get) => {
    return get(ui.connectorUiState$).addDialogSearch;
  });
  const addDialogCategory$ = computed((get) => {
    return get(ui.connectorUiState$).directoryCategory;
  });
  const searchedCatalog$ = relatedConnectorCatalog(addDialogKeyword$);
  /**
   * A chosen category is fetched by name, so the directory holds all of it.
   * The browse response carries a slice per category, which is what the
   * shelves want and what a category page must not settle for: the count the
   * chip offers on the way in is the number this has to deliver.
   */
  const categoryCatalog$ = relatedConnectorCatalog(
    emptyCatalogKeyword$,
    addDialogCategory$,
  );
  const addDialogBrowseCatalog$ = computed(async (get) => {
    return get(ui.connectorUiState$).showAddDialog
      ? await get(browseCatalog$)
      : null;
  });
  const addDialogCatalog$ = computed(async (get) => {
    if (!get(ui.connectorUiState$).showAddDialog) {
      return null;
    }
    if (get(addDialogKeyword$).trim()) {
      return await get(searchedCatalog$);
    }
    if (get(addDialogCategory$)) {
      return await get(categoryCatalog$);
    }
    return await get(addDialogBrowseCatalog$);
  });
  const addDialogCatalogItems$ = computed(async (get) => {
    return (
      (await get(addDialogCatalog$))?.connectors.map(withConnectorCompletion) ??
      []
    );
  });
  const addDialogCustomConnectors$ = computed(async (get) => {
    const uiState = get(ui.connectorUiState$);
    if (!uiState.showAddDialog && !uiState.selectedCustomConnectorId) {
      return [];
    }
    return await get(customConnectors$);
  });
  return {
    resources,
    phoneAccess,
    addDialogCatalog$,
    addDialogBrowseCatalog$,
    addDialogCatalogItems$,
    addDialogCustomConnectors$,
    ...ui,
    ...createConnectorUiSelectors(ui.connectorUiState$),
    accounts,
    chatAccess,
    reloadAccountPreference$: command(({ set }) => {
      set(accounts.reloadPreference$);
      set(chatAccess.reload$);
    }),
  };
}
