import { command, computed } from "ccstate";
import type { PlatformConnectorCatalogStatusItem } from "../../connector-domain.ts";
import { pageSignal$ } from "../../page-signal.ts";
import {
  connectedConnectorTargetKeys$,
  connectedConnectorsBadge$,
} from "../connector-accounts.ts";
import { openBuiltinAccountManager$ } from "./connector-account-dialogs.ts";
import { setManagedConnectorAccessSlug$ } from "./connector-access-management.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../../external/feature-switch.ts";
import { filteredDirectoryCustomConnectors$ } from "./connector-directory-custom.ts";
import {
  connectorCatalogDiscovery$,
  filteredConnectorCatalogItems$,
  builtinConnectFlowSlug$,
  builtinPollingOAuthAuthCodeSlug$,
  builtinPollingOAuthDeviceAuthSlug$,
} from "./connectors.ts";

function createDirectoryCardSignals(
  connector: PlatformConnectorCatalogStatusItem,
) {
  return {
    connector,
    targets$: connectedConnectorTargetKeys$,
    busy$: computed((get) => {
      const authCode = get(builtinPollingOAuthAuthCodeSlug$);
      const deviceAuth = get(builtinPollingOAuthDeviceAuthSlug$);
      const flow = get(builtinConnectFlowSlug$);
      return (
        authCode === connector.slug ||
        deviceAuth === connector.slug ||
        flow === connector.slug
      );
    }),
    openAccountManager$: command(({ get, set }) => {
      set(openBuiltinAccountManager$, connector, get(pageSignal$));
    }),
    manageAccess$: command(({ set }) => {
      set(setManagedConnectorAccessSlug$, connector.slug);
    }),
  };
}

export type DirectoryCardSignals = ReturnType<
  typeof createDirectoryCardSignals
>;
export type DirectoryCatalogItem = PlatformConnectorCatalogStatusItem & {
  readonly directorySignals: DirectoryCardSignals;
};

/**
 * The active catalog owns these interfaces, not React render or a global keyed
 * cache. Replacing the catalog releases its previous row interfaces.
 */
export const directoryCatalogItems$ = computed(
  async (get): Promise<readonly DirectoryCatalogItem[]> => {
    return (await get(filteredConnectorCatalogItems$)).map((connector) => {
      return {
        ...connector,
        directorySignals: createDirectoryCardSignals(connector),
      };
    });
  },
);

/** Scalar projections keep catalog/account waves inside their visible leaves. */
export const connectorDirectoryPageSignals = Object.freeze({
  catalogCount$: computed(async (get) => {
    return (await get(connectorCatalogDiscovery$)).totalConnectorCount;
  }),
  connectedCount$: computed(async (get) => {
    return (await get(connectedConnectorsBadge$)).count;
  }),
  customCount$: computed(async (get) => {
    return (await get(filteredDirectoryCustomConnectors$)).length;
  }),
  vncEnabled$: computed((get) => {
    return get(featureSwitch$)[FeatureSwitchKey.VncAccess] === true;
  }),
});
