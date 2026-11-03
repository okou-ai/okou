import { command, computed, state } from "ccstate";
import { connectorPermissionsContract } from "@okouai/api-contracts/client/connector-permissions";
import { customConnectorByIdContract } from "@okouai/api-contracts/client/custom-connectors";
import { connectorCatalogContract } from "@okouai/api-contracts/client/connector-catalog";
import type { FirewallPolicies } from "@okouai/connectors/firewall-contracts";
import { accept } from "../../../lib/accept.ts";
import { apiClient$, type ApiClientFactory } from "../../api-client.ts";
import type { ApplyConnectorPermissions } from "@okouai/api-contracts/contracts/connector-permissions";
import type {
  PlatformUserPermissionGrant,
  PlatformConnectorPermissionMetadata,
} from "../../connector-domain.ts";
import { resetSignal } from "../../utils.ts";
import type { ChatConnectorMenuTarget } from "../chat-connector-access.ts";
import type { PermissionDraftIntent } from "./permission-draft-intent.ts";
import { connectorPermissionDraftChanges } from "./permission-grant-save.ts";

async function readPermissionMetadata(
  client: ApiClientFactory,
  entry: ChatConnectorMenuTarget,
  signal: AbortSignal,
): Promise<PlatformConnectorPermissionMetadata | null> {
  if (entry.target.kind === "builtin") {
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
  const result = entry.permissionBundleRef
    ? await accept(
        client(customConnectorByIdContract).permissions({
          params: { id: entry.target.customConnectorId },
          fetchOptions: { signal },
        }),
        [200, 404],
        signal,
      )
    : null;
  if (result?.status === 404) {
    return null;
  }
  const bundle = result?.body;
  const permissions = bundle?.permissions ?? [];
  return {
    connectorSlug: entry.target.customConnectorId,
    label: entry.label,
    icon: { url: "", invertInDarkMode: false },
    permissionCount: permissions.length,
    permissions,
    categories: null,
    defaultPolicy: {
      permissionDefault: "deny",
      permissionOverrides: Object.fromEntries(
        ["allow", "deny", "ask"].map((policy) => {
          return [
            policy,
            permissions
              .filter((permission) => {
                return bundle?.defaultPolicies[permission.name] === policy;
              })
              .map((permission) => {
                return permission.name;
              }),
          ];
        }),
      ),
      // Match customRuntimePermissionPolicy: bundles fail closed; connectors
      // without a bundle start with ordinary unrestricted routing.
      unknownPolicy: bundle ? "deny" : "allow",
    },
  };
}

function permissionRequests(
  entry: ChatConnectorMenuTarget,
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
  entry: ChatConnectorMenuTarget,
) {
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
  return { editorMetadata$, grants$, open$, close$, save$ };
}
