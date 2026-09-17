import { command, computed, state, type Computed } from "ccstate";
import {
  type ApplyUserPermissionGrant,
  type UserPermissionGrantApplyMode,
  type UserPermissionGrantExpiresIn,
  type UserPermissionGrantAction,
  userPermissionGrantsContract,
} from "@okouai/api-contracts/contracts/user-permission-grants";
import {
  UNKNOWN_PERMISSION_GRANT,
  type FirewallPolicyValue,
} from "@okouai/connectors/firewall-contracts";
import { apiClient$ } from "../api-client.ts";
import { pathParams$, searchParams$ } from "../route.ts";
import { accept } from "../../lib/accept.ts";
import { agentById, currentAgentId$ } from "../agent.ts";
import { firewallPermissionMetadataByConnector } from "../firewall-permission-metadata.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { retryTransientLoad } from "../utils.ts";
import { resolveActiveUserPermissionGrantPolicy } from "../user-permission-grants.ts";
import { parseUserPermissionGrantExpiresIn } from "./permission-grant-expiration.ts";
import { i18n } from "../../i18n/index.ts";
import type {
  PlatformConnectorPermissionMetadata,
  PlatformUserPermissionGrant,
} from "../connector-domain.ts";

// ---------------------------------------------------------------------------
// Route params
// ---------------------------------------------------------------------------

export const permissionAllowAgentId$ = computed((get) => {
  const params = get(pathParams$);
  const agentId = params?.agentId;
  return typeof agentId === "string" ? agentId : null;
});

export const permissionAllowConnectorSlug$ = computed((get) => {
  const searchParams = get(searchParams$);
  // Historical permission links may use ref from before CLI 9.270.1.
  return searchParams.get("connectorSlug") ?? searchParams.get("ref") ?? null;
});

export const permissionAllowPermission$ = computed((get) => {
  return get(searchParams$).get("permission") ?? null;
});

export const permissionAllowActionParam$ = computed((get) => {
  return get(searchParams$).get("action");
});

export const permissionAllowAction$ = computed((get) => {
  const action = get(permissionAllowActionParam$);
  return action === "allow" || action === "deny" ? action : null;
});

export const permissionAllowExpiresIn$ = computed((get) => {
  return parseUserPermissionGrantExpiresIn(get(searchParams$).get("expiresIn"));
});

// ---------------------------------------------------------------------------
// Agent data
// ---------------------------------------------------------------------------

export const permissionAllowAgent$ = computed((get) => {
  const agentId = get(permissionAllowAgentId$);
  if (!agentId) {
    return null;
  }
  return get(agentById(agentId));
});

// ---------------------------------------------------------------------------
// Permissions list (derived from firewall metadata)
// ---------------------------------------------------------------------------

export interface Permission {
  name: string;
  description?: string;
}

export function findPermissionInMetadata(
  metadata: PlatformConnectorPermissionMetadata,
  name: string,
): Permission | null {
  if (name === UNKNOWN_PERMISSION_GRANT) {
    return {
      name: UNKNOWN_PERMISSION_GRANT,
      description: i18n.t(($) => {
        return $.connectors.permissions.otherEndpoints;
      }),
    };
  }
  return (
    metadata.permissions.find((permission) => {
      return permission.name === name;
    }) ?? null
  );
}

// ---------------------------------------------------------------------------
// Current-user permission grants
// ---------------------------------------------------------------------------

const internalUserPermissionGrantsReload$ = state(0);

const onPermissionUpdated$ = command(({ set }) => {
  set(internalUserPermissionGrantsReload$, (version) => {
    return version + 1;
  });
  return false;
});

export const subscribePermissionUpdate$ = command(
  ({ set }, signal: AbortSignal) => {
    set(
      setAblyLoop$,
      {
        topic: "connectorPermissionUpdated",
        loopCommand$: onPermissionUpdated$,
      },
      signal,
    );
  },
);

export function resolveUserPermissionGrantPolicy(
  grants: readonly PlatformUserPermissionGrant[],
  metadata: PlatformConnectorPermissionMetadata,
  permission: string,
): FirewallPolicyValue | undefined {
  return resolveActiveUserPermissionGrantPolicy(grants, metadata, permission);
}

interface UserPermissionGrantsByAgentParams {
  agentId: string;
}

export function userPermissionGrantsByAgent(
  params: UserPermissionGrantsByAgentParams,
): Computed<Promise<readonly PlatformUserPermissionGrant[]>> {
  return computed(async (get) => {
    get(internalUserPermissionGrantsReload$);
    const client = get(apiClient$)(userPermissionGrantsContract);
    const result = await retryTransientLoad(() => {
      return accept(
        client.list({
          query: params,
        }),
        [200],
      );
    });
    return result.body;
  });
}

export function userPermissionGrantsByAgentIfExists(
  params: UserPermissionGrantsByAgentParams,
): Computed<Promise<readonly PlatformUserPermissionGrant[] | null>> {
  return computed(async (get) => {
    get(internalUserPermissionGrantsReload$);
    const client = get(apiClient$)(userPermissionGrantsContract);
    const result = await retryTransientLoad(() => {
      return accept(
        client.list({
          query: params,
        }),
        [200, 404],
      );
    });
    return result.status === 404 ? null : result.body;
  });
}

export const permissionAllowUserPermissionGrants$ = computed(async (get) => {
  const agentId = get(permissionAllowAgentId$);
  if (!agentId) {
    return [];
  }
  return await get(userPermissionGrantsByAgent({ agentId }));
});

/** The current agent-detail route's permission grants. */
export const currentAgentUserPermissionGrants$ = computed(async (get) => {
  const agentId = get(currentAgentId$);
  if (!agentId) {
    return [];
  }
  return await get(userPermissionGrantsByAgent({ agentId }));
});

/** Firewall metadata selected by the permission-allow route. */
export const permissionAllowFirewallPermissionMetadata$ = computed(
  async (get) => {
    const connectorSlug = get(permissionAllowConnectorSlug$);
    if (!connectorSlug) {
      return null;
    }
    return await get(firewallPermissionMetadataByConnector({ connectorSlug }));
  },
);

export const applyUserPermissionGrants$ = command(
  async (
    { get, set },
    params: {
      agentId?: string;
      connectorSlug: string;
      mode: UserPermissionGrantApplyMode;
      grants: readonly ApplyUserPermissionGrant[];
    },
    signal: AbortSignal,
  ): Promise<readonly PlatformUserPermissionGrant[]> => {
    if (!params.agentId) {
      throw new Error("Permission grant scope is required");
    }
    const client = get(apiClient$)(userPermissionGrantsContract);
    const result = await accept(
      client.apply({
        body: {
          agentId: params.agentId,
          connectorSlug: params.connectorSlug,
          mode: params.mode,
          grants: [...params.grants],
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(internalUserPermissionGrantsReload$, (prev) => {
      return prev + 1;
    });
    return result.body;
  },
);

export const applyUserPermissionGrant$ = command(
  async (
    { set },
    params: {
      agentId?: string;
      connectorSlug: string;
      permission: string;
      action: UserPermissionGrantAction;
      expiresIn?: UserPermissionGrantExpiresIn;
    },
    signal: AbortSignal,
  ): Promise<PlatformUserPermissionGrant> => {
    const grants = await set(
      applyUserPermissionGrants$,
      {
        agentId: params.agentId,
        connectorSlug: params.connectorSlug,
        mode: "patch",
        grants: [
          params.action === "allow"
            ? {
                permission: params.permission,
                action: "allow",
                ...(params.expiresIn ? { expiresIn: params.expiresIn } : {}),
              }
            : {
                permission: params.permission,
                action: "deny",
              },
        ],
      },
      signal,
    );
    const grant = grants[0];
    if (!grant) {
      throw new Error("User permission grant apply did not return a grant");
    }
    return grant;
  },
);
