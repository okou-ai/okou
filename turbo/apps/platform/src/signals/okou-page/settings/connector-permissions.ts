import { command, computed, state } from "ccstate";
import { connectorPermissionsContract } from "@okouai/api-contracts/client/connector-permissions";
import { connectorCatalogContract } from "@okouai/api-contracts/client/connector-catalog";
import type { FirewallPolicies } from "@okouai/connectors/firewall-contracts";
import { accept } from "../../../lib/accept.ts";
import { apiClient$, type ApiClientFactory } from "../../api-client.ts";
import type { ApplyConnectorPermissions } from "@okouai/api-contracts/contracts/connector-permissions";
import type {
  PlatformUserPermissionGrant,
  PlatformConnectorPermissionMetadata,
} from "../../connector-domain.ts";
import { onRef, resetSignal } from "../../utils.ts";
import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";
import type { PermissionDraftIntent } from "./permission-draft-intent.ts";
import { connectorPermissionDraftChanges } from "./permission-grant-save.ts";

export interface ConnectorPermissionsTarget {
  readonly target: Extract<ConnectorAccountTarget, { kind: "builtin" }>;
  readonly label: string;
}

async function readPermissionMetadata(
  client: ApiClientFactory,
  entry: ConnectorPermissionsTarget,
  signal: AbortSignal,
): Promise<PlatformConnectorPermissionMetadata | null> {
  const result = await accept(
    client(connectorCatalogContract).permissions({
      params: { connectorSlug: entry.target.connectorSlug },
      fetchOptions: { signal },
    }),
    [200, 404],
    signal,
  );
  return result.status === 200 ? result.body.permissions : null;
}

function permissionRequests(
  entry: ConnectorPermissionsTarget,
  ownerSignal: AbortSignal,
) {
  return {
    metadata: (client: ApiClientFactory) => {
      return readPermissionMetadata(client, entry, ownerSignal);
    },
    read: (client: ApiClientFactory) => {
      return accept(
        client(connectorPermissionsContract).get({
          query: entry.target,
          fetchOptions: { signal: ownerSignal },
        }),
        [200],
        ownerSignal,
      );
    },
    save: (
      client: ApiClientFactory,
      body: ApplyConnectorPermissions,
      parentSignal: AbortSignal,
    ) => {
      const signal = AbortSignal.any([ownerSignal, parentSignal]);
      return accept(
        client(connectorPermissionsContract).apply({
          body,
          fetchOptions: { signal },
        }),
        [200],
        signal,
      );
    },
  };
}

export function createConnectorPermissionsSignals(
  entry: ConnectorPermissionsTarget,
) {
  const dialogElement$ = state<HTMLElement | null>(null);
  const bindDialog$ = onRef(
    command(({ set }, element: HTMLElement, signal: AbortSignal) => {
      set(dialogElement$, element);
      signal.addEventListener(
        "abort",
        () => {
          set(dialogElement$, null);
        },
        { once: true },
      );
    }),
  );
  // The loading footer is replaced after the rules arrive. Keep initial focus
  // on the mounted popup so that this replacement cannot drop it onto the page.
  const initialFocus$ = command(({ get }) => {
    return get(dialogElement$) ?? false;
  });
  const requests$ = state<ReturnType<typeof permissionRequests> | null>(null);
  const resetOwner$ = resetSignal();
  const metadata$ = computed(async (get) => {
    const requests = get(requests$);
    return requests ? await requests.metadata(get(apiClient$)) : null;
  });
  const grants$ = computed(
    async (get): Promise<readonly PlatformUserPermissionGrant[] | null> => {
      const requests = get(requests$);
      if (!requests) {
        return null;
      }
      const [result, metadata] = await Promise.all([
        requests.read(get(apiClient$)),
        get(metadata$),
      ]);
      return metadata
        ? result.body.grants.map((grant) => {
            return {
              ...grant,
              connectorSlug: metadata.connectorSlug,
            };
          })
        : [];
    },
  );
  const open$ = command(({ set }, signal: AbortSignal) => {
    set(requests$, permissionRequests(entry, set(resetOwner$, signal)));
  });
  const editorMetadata$ = computed(async (get) => {
    const grants = await get(grants$);
    return grants === null ? null : await get(metadata$);
  });
  const close$ = command(({ set }) => {
    set(resetOwner$);
    set(requests$, null);
  });
  const save$ = command(
    async (
      { get },
      args: {
        readonly initialPolicies: FirewallPolicies;
        readonly initialGrants: readonly PlatformUserPermissionGrant[];
        readonly intent: PermissionDraftIntent;
      },
      signal: AbortSignal,
    ) => {
      const metadata = await get(metadata$);
      signal.throwIfAborted();
      if (!metadata) {
        throw new Error("Connector permission metadata is unavailable");
      }
      const changes = connectorPermissionDraftChanges({
        ...args,
        metadata,
        connectorSlug: metadata.connectorSlug,
      });
      const requests = get(requests$);
      if (!requests) {
        return;
      }
      await requests.save(
        get(apiClient$),
        {
          target: entry.target,
          mode: changes.mode,
          grants: [...changes.grants],
        },
        signal,
      );
    },
  );
  return {
    editorMetadata$,
    grants$,
    open$,
    close$,
    save$,
    bindDialog$,
    initialFocus$,
  };
}
