import { command, computed, state, type Command, type Computed } from "ccstate";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import type { PublicConnectorCatalogDiscoveryResponse } from "@okouai/api-contracts/contracts/connector-catalog";
import type { ComposerConnectorOverview } from "@okouai/api-contracts/contracts/composer-connectors";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { agentCustomConnectorsContract } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { firewallPermissionMetadataByConnector } from "../firewall-permission-metadata.ts";
import { userPermissionGrantsByAgent } from "../permission-allow/permission-allow-signals.ts";
import { withCleanup } from "../utils.ts";
import { reloadAgentConnectorAuthorizations$ } from "./agent-connector-authorizations.ts";
import {
  composerAgentConnectors,
  invalidateComposerAgentConnectors$,
} from "./composer-agent-connectors.ts";
import { composerConnectorOverview$ } from "./composer-connector-overview.ts";
import { reloadOnboardingStatus$ } from "./onboarding.ts";
import type {
  PlatformConnectorCatalogStatusItem,
  PlatformConnectorPermissionMetadata,
  PlatformUserPermissionGrant,
} from "../connector-domain.ts";
import { relatedConnectorCatalog } from "../external/connectors.ts";
import {
  customConnectors$,
  reloadCustomConnectorAuthorizedAgents$,
} from "./settings/custom-connectors.ts";
import {
  createComposerConnectorAccountSignals,
  type ComposerConnectorAccountSignals,
} from "./composer-connector-accounts.ts";
import { resetBuiltinManualGrantForm$ } from "./settings/connectors.ts";
import { sshAccessForAgent } from "../ssh.ts";
import { vncAccessForAgent } from "../vnc-access.ts";

export interface ComposerConnectorAuthorizationState {
  readonly agentId: string;
  readonly enabledConnectorSlugs: readonly ConnectorSlug[];
  readonly customConnectorIds: readonly string[];
}

export type ComposerConnectorAuthorizationTarget =
  | {
      readonly kind: "builtin";
      readonly connectorSlug: ConnectorSlug;
    }
  | {
      readonly kind: "custom";
      readonly connectorId: string;
      readonly permissionBundleRef: string | null;
    };

export interface ComposerConnectorUiState {
  readonly showAddDialog: boolean;
  readonly selectedConnectorSlug: ConnectorSlug | null;
  readonly selectedConnector: PlatformConnectorCatalogStatusItem | null;
  readonly selectedCustomConnectorId: string | null;
  readonly addDialogSearch: string;
  readonly popoverSearch: string;
  readonly popoverOpen: boolean;
  readonly popoverHasOpened: boolean;
  readonly popoverSortOrder: readonly string[] | null;
  readonly permissionConnectorSlug: ConnectorSlug | null;
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

interface ComposerConnectorData {
  readonly overview: ComposerConnectorOverview;
  readonly authorization: ComposerConnectorAuthorizationState;
}

export interface ComposerConnectorSignals {
  readonly data$: Computed<Promise<ComposerConnectorData>>;
  readonly connectorAuthorization$: Computed<
    Promise<ComposerConnectorAuthorizationState>
  >;
  readonly addDialogCatalog$: Computed<
    Promise<PublicConnectorCatalogDiscoveryResponse | null>
  >;
  readonly addDialogCatalogItems$: Computed<
    Promise<readonly PlatformConnectorCatalogStatusItem[]>
  >;
  readonly addDialogCustomConnectors$: Computed<
    Promise<readonly CustomConnectorResponse[]>
  >;
  readonly setConnectorAuthorization$: Command<
    Promise<void>,
    [ComposerConnectorAuthorizationTarget, boolean, AbortSignal]
  >;
  readonly connectorUiState$: Computed<ComposerConnectorUiState>;
  readonly openAddConnectorsDialog$: Command<void, []>;
  readonly updateConnectorUiState$: Command<
    void,
    [Partial<ComposerConnectorUiState>]
  >;
  readonly connectorPermissionMetadata$: Computed<
    Promise<PlatformConnectorPermissionMetadata | null>
  >;
  readonly connectorPermissionGrants$: Computed<
    Promise<readonly PlatformUserPermissionGrant[]>
  >;
  readonly accounts: ComposerConnectorAccountSignals;
  readonly sshAccess$: Computed<Promise<{ readonly enabled: boolean } | null>>;
  readonly vncAccess$: Computed<Promise<{ readonly enabled: boolean } | null>>;
}

/** Browse reads ask for no keyword; the category, when set, scopes them. */
const emptyCatalogKeyword$ = computed(() => {
  return "";
});
const browseCatalog$ = relatedConnectorCatalog(emptyCatalogKeyword$);

function initialComposerConnectorUiState(): ComposerConnectorUiState {
  return {
    showAddDialog: false,
    selectedConnectorSlug: null,
    selectedConnector: null,
    selectedCustomConnectorId: null,
    addDialogSearch: "",
    popoverSearch: "",
    popoverOpen: false,
    popoverHasOpened: false,
    popoverSortOrder: null,
    permissionConnectorSlug: null,
    directoryTab: "discover",
    directoryCategory: null,
    directoryDetailSlug: null,
  };
}

function createConnectorAuthorizationSignal(
  agentId: string,
): Computed<Promise<ComposerConnectorAuthorizationState>> {
  const authorizations$ = composerAgentConnectors(agentId);
  return computed(async (get): Promise<ComposerConnectorAuthorizationState> => {
    const authorizations = await get(authorizations$);
    return {
      agentId,
      enabledConnectorSlugs: authorizations.enabledConnectorSlugs,
      customConnectorIds: authorizations.customConnectorIds,
    };
  });
}

function createBuiltinConnectorAuthorizationCommand(
  agentId: string,
): Command<Promise<void>, [ConnectorSlug, boolean, AbortSignal]> {
  return command(
    async (
      { get, set },
      connectorSlug: ConnectorSlug,
      authorized: boolean,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      const client = get(apiClient$)(userBuiltinConnectorsContract);
      await withCleanup(
        accept(
          client.update({
            params: { id: agentId },
            body: {
              enabledConnectorSlugs: [connectorSlug],
              operation: authorized ? "add" : "remove",
            },
            fetchOptions: { signal },
          }),
          [200],
        ),
        () => {
          set(reloadAgentConnectorAuthorizations$);
          set(invalidateComposerAgentConnectors$, agentId);
        },
      );
      signal.throwIfAborted();
      await set(reloadOnboardingStatus$);
      signal.throwIfAborted();
    },
  );
}

function createCustomConnectorAuthorizationCommand(
  agentId: string,
): Command<Promise<void>, [string, boolean, AbortSignal]> {
  return command(
    async (
      { get, set },
      connectorId: string,
      authorized: boolean,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      const client = get(apiClient$)(agentCustomConnectorsContract);
      await withCleanup(
        accept(
          client.update({
            params: { id: agentId },
            body: {
              grants: [
                {
                  customConnectorId: connectorId,
                  permissionNames: [],
                },
              ],
              operation: authorized ? "add" : "remove",
            },
            fetchOptions: { signal },
          }),
          [200],
        ),
        () => {
          set(reloadCustomConnectorAuthorizedAgents$);
          set(invalidateComposerAgentConnectors$, agentId);
        },
      );
    },
  );
}

function createConnectorAuthorizationCommand(
  agentId: string,
  data$: Computed<Promise<ComposerConnectorData>>,
): ComposerConnectorSignals["setConnectorAuthorization$"] {
  const setBuiltinAuthorization$ =
    createBuiltinConnectorAuthorizationCommand(agentId);
  const setCustomAuthorization$ =
    createCustomConnectorAuthorizationCommand(agentId);
  return command(
    async (
      { get, set },
      target: ComposerConnectorAuthorizationTarget,
      authorized: boolean,
      signal: AbortSignal,
    ): Promise<void> => {
      if (target.kind === "builtin") {
        await set(
          setBuiltinAuthorization$,
          target.connectorSlug,
          authorized,
          signal,
        );
      } else if (authorized && target.permissionBundleRef) {
        return;
      } else {
        await set(
          setCustomAuthorization$,
          target.connectorId,
          authorized,
          signal,
        );
      }
      await get(data$);
      signal.throwIfAborted();
    },
  );
}

function createConnectorUiSignals(): Pick<
  ComposerConnectorSignals,
  "connectorUiState$" | "updateConnectorUiState$" | "openAddConnectorsDialog$"
> {
  const internalUiState$ = state(initialComposerConnectorUiState());
  const connectorUiState$ = computed((get): ComposerConnectorUiState => {
    return get(internalUiState$);
  });
  const updateConnectorUiState$ = command(
    ({ set }, patch: Partial<ComposerConnectorUiState>): void => {
      if (patch.selectedConnectorSlug) {
        set(resetBuiltinManualGrantForm$, patch.selectedConnectorSlug);
      }
      set(internalUiState$, (current) => {
        return { ...current, ...patch };
      });
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
  return {
    connectorUiState$,
    updateConnectorUiState$,
    openAddConnectorsDialog$,
  };
}

export function createComposerConnectorSignals(
  agentId: string,
  threadId?: string,
): ComposerConnectorSignals {
  const ui = createConnectorUiSignals();
  const sshAccessForAgent$ = sshAccessForAgent(agentId);
  const vncAccessForAgent$ = vncAccessForAgent(agentId);
  const sshAccess$ = computed(async (get) => {
    return get(ui.connectorUiState$).popoverHasOpened
      ? await get(sshAccessForAgent$)
      : null;
  });
  const vncAccess$ = computed(async (get) => {
    return get(ui.connectorUiState$).popoverHasOpened
      ? await get(vncAccessForAgent$)
      : null;
  });
  const authorization$ = createConnectorAuthorizationSignal(agentId);
  const data$ = computed(async (get): Promise<ComposerConnectorData> => {
    const [overview, authorization] = await Promise.all([
      get(composerConnectorOverview$),
      get(authorization$),
    ]);
    return { overview, authorization };
  });
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
    return await get(browseCatalog$);
  });
  const addDialogCatalogItems$ = computed(async (get) => {
    return (await get(addDialogCatalog$))?.connectors ?? [];
  });
  const addDialogCustomConnectors$ = computed(async (get) => {
    const uiState = get(ui.connectorUiState$);
    if (!uiState.showAddDialog && !uiState.selectedCustomConnectorId) {
      return [];
    }
    return await get(customConnectors$);
  });
  const connectorPermissionMetadata$ = computed(async (get) => {
    const connectorSlug = get(ui.connectorUiState$).permissionConnectorSlug;
    if (!connectorSlug) {
      return null;
    }
    return await get(firewallPermissionMetadataByConnector({ connectorSlug }));
  });
  const connectorPermissionGrants$ = computed(
    async (get): Promise<readonly PlatformUserPermissionGrant[]> => {
      return await get(userPermissionGrantsByAgent({ agentId }));
    },
  );

  return {
    data$,
    connectorAuthorization$: authorization$,
    addDialogCatalog$,
    addDialogCatalogItems$,
    addDialogCustomConnectors$,
    setConnectorAuthorization$: createConnectorAuthorizationCommand(
      agentId,
      data$,
    ),
    ...ui,
    connectorPermissionMetadata$,
    connectorPermissionGrants$,
    accounts: createComposerConnectorAccountSignals(threadId),
    sshAccess$,
    vncAccess$,
  };
}
