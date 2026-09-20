import { command, computed, state, type Command, type Computed } from "ccstate";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import type { PublicConnectorCatalogCategoryMetadata } from "@okouai/api-contracts/contracts/connector-catalog";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import {
  agentCustomConnectorsContract,
  type AgentCustomConnectorGrant,
} from "@okouai/api-contracts/contracts/agent-custom-connectors";
import { accept } from "../../lib/accept.ts";
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
import { firewallPermissionMetadataByConnector } from "../firewall-permission-metadata.ts";
import { userPermissionGrantsByAgent } from "../permission-allow/permission-allow-signals.ts";
import { withCleanup } from "../utils.ts";
import {
  agentConnectorAuthorizations,
  reloadAgentConnectorAuthorizations$,
} from "./agent-connector-authorizations.ts";
import { reloadOnboardingStatus$ } from "./onboarding.ts";
import type {
  PlatformConnectorCatalogStatusItem,
  PlatformConnectorPermissionMetadata,
  PlatformUserPermissionGrant,
} from "../connector-domain.ts";
import { relatedConnectorCatalog } from "../external/connectors.ts";
import {
  customConnectors$,
  customConnectorAuthorizationReloadVersion$,
  reloadCustomConnectorAuthorizedAgents$,
} from "./settings/custom-connectors.ts";
import {
  createComposerConnectorAccountSignals,
  type ComposerConnectorAccountSignals,
} from "./composer-connector-accounts.ts";
import { resetBuiltinManualGrantForm$ } from "./settings/connectors.ts";

export interface ComposerConnectorAuthorizationState {
  readonly agentId: string;
  readonly enabledConnectorSlugs: readonly ConnectorSlug[];
  readonly customConnectorGrants: readonly AgentCustomConnectorGrant[];
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
  readonly selectedCustomConnectorId: string | null;
  readonly addDialogSearch: string;
  readonly popoverSearch: string;
  readonly popoverSortOrder: readonly string[] | null;
  readonly permissionConnectorSlug: ConnectorSlug | null;
  readonly directoryTab: ConnectorDirectoryTab;
  readonly directoryCategory: string | null;
  readonly directoryDetailSlug: ConnectorSlug | null;
  /** Index into the connectors the arrow keys currently walk through. */
  readonly directoryActiveIndex: number;
}

/**
 * Which half of the directory is showing. There is no "yours": the composer's
 * connector popover already lists every connected connector with its accounts
 * and permissions, so the directory is the surface for adding one.
 */
export type ConnectorDirectoryTab = "discover" | "custom";

interface ComposerConnectorData {
  readonly relatedCatalogItems: readonly PlatformConnectorCatalogStatusItem[];
  readonly customConnectors: readonly CustomConnectorResponse[];
  readonly authorization: ComposerConnectorAuthorizationState;
  /**
   * How many connectors each category holds in total. Discovery returns a
   * slice per category, so the directory needs this to say what a shelf's
   * closing cell stands for without a second request.
   */
  readonly categoryConnectorCounts:
    | Readonly<Record<string, number>>
    | undefined;
  /**
   * The catalog's own category names. They ride on the same discovery response
   * as the connectors, so the directory never has to name a category before it
   * knows what that category is called.
   */
  readonly categoryMetadata: PublicConnectorCatalogCategoryMetadata | undefined;
}

export interface ComposerConnectorSignals {
  readonly data$: Computed<Promise<ComposerConnectorData>>;
  readonly connectorAuthorization$: Computed<
    Promise<ComposerConnectorAuthorizationState>
  >;
  readonly addDialogCatalogItems$: Computed<
    Promise<readonly PlatformConnectorCatalogStatusItem[]>
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
}

/** Browse reads ask for no keyword; the category, when set, scopes them. */
const emptyCatalogKeyword$ = computed(() => {
  return "";
});

const composerRelatedCatalog$ = relatedConnectorCatalog(emptyCatalogKeyword$);

const composerRelatedCatalogItems$ = computed(async (get) => {
  return (await get(composerRelatedCatalog$)).connectors;
});

interface AgentCustomConnectorAuthorizationRequestBroker {
  load(params: {
    readonly createClient: ApiClientFactory;
    readonly agentId: string;
    readonly reloadGeneration: number;
  }): Promise<readonly AgentCustomConnectorGrant[]>;
}

interface ResolvedAgentCustomConnectorAuthorizationRequest {
  readonly key: string;
  readonly value: readonly AgentCustomConnectorGrant[];
}

function agentCustomConnectorAuthorizationRequestKey(params: {
  readonly agentId: string;
  readonly reloadGeneration: number;
}): string {
  return JSON.stringify([params.reloadGeneration, params.agentId]);
}

function createAgentCustomConnectorAuthorizationRequestBroker(): AgentCustomConnectorAuthorizationRequestBroker {
  const pendingRequestsByClient = new WeakMap<
    ApiClientFactory,
    Map<string, Promise<readonly AgentCustomConnectorGrant[]>>
  >();
  const latestRequestedKeyByClient = new WeakMap<ApiClientFactory, string>();
  const latestResolvedByClient = new WeakMap<
    ApiClientFactory,
    ResolvedAgentCustomConnectorAuthorizationRequest
  >();

  return {
    load(params) {
      const key = agentCustomConnectorAuthorizationRequestKey(params);
      latestRequestedKeyByClient.set(params.createClient, key);
      const resolved = latestResolvedByClient.get(params.createClient);
      if (resolved?.key === key) {
        return Promise.resolve(resolved.value);
      }
      let pendingRequests = pendingRequestsByClient.get(params.createClient);
      if (!pendingRequests) {
        pendingRequests = new Map();
        pendingRequestsByClient.set(params.createClient, pendingRequests);
      }
      const pendingRequest = pendingRequests.get(key);
      if (pendingRequest) {
        return pendingRequest;
      }

      const load = async (): Promise<readonly AgentCustomConnectorGrant[]> => {
        const client = params.createClient(agentCustomConnectorsContract);
        const result = await accept(
          client.get({ params: { id: params.agentId } }),
          [200],
        );
        const value = result.body.grants;
        if (latestRequestedKeyByClient.get(params.createClient) === key) {
          latestResolvedByClient.set(params.createClient, { key, value });
        }
        return value;
      };
      const sharedRequest = withCleanup(load(), () => {
        pendingRequests.delete(key);
        if (pendingRequests.size === 0) {
          pendingRequestsByClient.delete(params.createClient);
        }
      });
      pendingRequests.set(key, sharedRequest);
      return sharedRequest;
    },
  };
}

const agentCustomConnectorAuthorizationRequestBroker$ = computed(() => {
  return createAgentCustomConnectorAuthorizationRequestBroker();
});

function initialComposerConnectorUiState(): ComposerConnectorUiState {
  return {
    showAddDialog: false,
    selectedConnectorSlug: null,
    selectedCustomConnectorId: null,
    addDialogSearch: "",
    popoverSearch: "",
    popoverSortOrder: null,
    permissionConnectorSlug: null,
    directoryTab: "discover",
    directoryCategory: null,
    directoryDetailSlug: null,
    directoryActiveIndex: 0,
  };
}

function createConnectorAuthorizationSignal(
  agentId: string,
): Computed<Promise<ComposerConnectorAuthorizationState>> {
  const authorizations$ = agentConnectorAuthorizations({ agentId });
  const customAuthorizations$ = computed(async (get) => {
    const reloadGeneration = get(customConnectorAuthorizationReloadVersion$);
    return await get(agentCustomConnectorAuthorizationRequestBroker$).load({
      createClient: get(apiClient$),
      agentId,
      reloadGeneration,
    });
  });

  return computed(async (get): Promise<ComposerConnectorAuthorizationState> => {
    const [authorizations, customConnectorGrants] = await Promise.all([
      get(authorizations$),
      get(customAuthorizations$),
    ]);
    return {
      agentId: authorizations.agentId,
      enabledConnectorSlugs: authorizations.enabledConnectorSlugs,
      customConnectorGrants,
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
      directoryActiveIndex: 0,
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
  const authorization$ = createConnectorAuthorizationSignal(agentId);
  const data$ = computed(async (get): Promise<ComposerConnectorData> => {
    const [catalog, customConnectors, authorization] = await Promise.all([
      get(composerRelatedCatalog$),
      get(customConnectors$),
      get(authorization$),
    ]);
    return {
      relatedCatalogItems: catalog.connectors,
      customConnectors,
      authorization,
      categoryConnectorCounts: catalog.categoryConnectorCounts,
      categoryMetadata: catalog.categoryMetadata,
    };
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
  const addDialogCatalogItems$ = computed(async (get) => {
    if (get(addDialogKeyword$).trim()) {
      return (await get(searchedCatalog$)).connectors;
    }
    if (get(addDialogCategory$)) {
      return (await get(categoryCatalog$)).connectors;
    }
    return await get(composerRelatedCatalogItems$);
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
    addDialogCatalogItems$,
    setConnectorAuthorization$: createConnectorAuthorizationCommand(
      agentId,
      data$,
    ),
    ...ui,
    connectorPermissionMetadata$,
    connectorPermissionGrants$,
    accounts: createComposerConnectorAccountSignals(threadId),
  };
}
