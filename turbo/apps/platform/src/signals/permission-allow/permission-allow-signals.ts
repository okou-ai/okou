import { command, computed, state } from "ccstate";
import type {
  ApplyUserPermissionGrant,
  UserPermissionGrantApplyMode,
  UserPermissionGrantExpiresIn,
  UserPermissionGrantAction,
} from "@okouai/api-contracts/validators/user-permission-grants";
import { connectorPermissionsContract } from "@okouai/api-contracts/client/connector-permissions";

import {
  UNKNOWN_PERMISSION_GRANT,
  type FirewallPolicyValue,
} from "@okouai/connectors/firewall-contracts";
import { apiClient$ } from "../api-client.ts";
import {
  chatActionCallbackFromUrl,
  runChatActionCallback$,
  type ChatActionCallback,
  type ChatActionCallbackIds,
} from "../chat-page/action-callback.ts";
import { searchParams$ } from "../route.ts";
import { accept } from "../../lib/accept.ts";
import { clerk$ } from "../auth.ts";
import {
  memberPermissionOwner,
  type PermissionActionOwner,
} from "../chat-page/permission-action-owner.ts";
import {
  permissionActionTarget,
  memberPermissionClientOptions,
  verifyPermissionCallbackThread,
} from "./permission-action-target.ts";
import { firewallPermissionMetadataByConnector } from "../firewall-permission-metadata.ts";
import { setAblyLoop$ } from "../realtime.ts";
import {
  isActiveUserPermissionGrant,
  resolveActiveUserPermissionGrantPolicy,
} from "../user-permission-grants.ts";
import { parseUserPermissionGrantExpiresIn } from "./permission-grant-expiration.ts";
import { i18n } from "../../i18n/index.ts";
import type {
  PlatformConnectorPermissionMetadata,
  PlatformUserPermissionGrant,
} from "../connector-domain.ts";

// ---------------------------------------------------------------------------
// Route params
// ---------------------------------------------------------------------------

export const permissionAllowOwner$ = computed(
  (get): PermissionActionOwner | null => {
    return memberPermissionOwner(get(searchParams$));
  },
);

export const permissionAllowCallback$ = computed((get) => {
  const params = get(searchParams$);
  return chatActionCallbackFromUrl(
    { searchParams: params },
    { threadId: params.get("threadId") ?? "" },
  );
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
// Permission target
// ---------------------------------------------------------------------------

export const permissionAllowTarget$ = computed((get) => {
  const owner = get(permissionAllowOwner$);
  const callback = get(permissionAllowCallback$);
  if (!owner || !callback) {
    return Promise.resolve(null);
  }
  return get(permissionActionTarget(owner, callback.threadId));
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

/** Confirmation cards read the member's grants for the requested connectors. */
export function permissionGrantsForConnectors(
  connectorSlugs: readonly string[],
) {
  return computed(
    async (get): Promise<readonly PlatformUserPermissionGrant[]> => {
      get(internalUserPermissionGrantsReload$);

      const client = get(apiClient$)(connectorPermissionsContract);
      const grants = await Promise.all(
        [...new Set(connectorSlugs)].map(async (connectorSlug) => {
          const result = await accept(
            client.get({ query: { kind: "builtin", connectorSlug } }),
            [200, 404],
          );
          return result.status === 200
            ? result.body.grants.map((grant) => {
                return { connectorSlug, ...grant };
              })
            : [];
        }),
      );
      return grants.flat();
    },
  );
}

export const permissionAllowUserPermissionGrants$ = computed(async (get) => {
  if (!get(permissionAllowOwner$)) {
    return [];
  }
  const connectorSlug = get(permissionAllowConnectorSlug$);
  return connectorSlug
    ? await get(permissionGrantsForConnectors([connectorSlug]))
    : [];
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
      owner?: PermissionActionOwner;
      connectorSlug: string;
      mode: UserPermissionGrantApplyMode;
      grants: readonly ApplyUserPermissionGrant[];
    },
    signal: AbortSignal,
  ): Promise<readonly PlatformUserPermissionGrant[]> => {
    signal.throwIfAborted();
    const options =
      params.owner?.kind === "member"
        ? memberPermissionClientOptions(await get(clerk$), params.owner)
        : undefined;
    const result = await accept(
      get(apiClient$)(connectorPermissionsContract, options).apply({
        body: {
          target: { kind: "builtin", connectorSlug: params.connectorSlug },
          mode: params.mode,
          grants: [...params.grants],
        },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    set(onPermissionUpdated$);
    return result.body.grants
      .filter((grant) => {
        return params.grants.some((requested) => {
          return requested.permission === grant.permission;
        });
      })
      .map((grant) => {
        return { connectorSlug: params.connectorSlug, ...grant };
      });
  },
);

interface ApplyUserPermissionGrantParams {
  owner?: PermissionActionOwner;
  connectorSlug: string;
  permission: string;
  action: UserPermissionGrantAction;
  expiresIn?: UserPermissionGrantExpiresIn;
}

export const applyUserPermissionGrant$ = command(
  async (
    { set },
    params: ApplyUserPermissionGrantParams,
    signal: AbortSignal,
  ): Promise<PlatformUserPermissionGrant> => {
    const grants = await set(
      applyUserPermissionGrants$,
      {
        owner: params.owner,
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
    if (
      !grant ||
      grant.action !== params.action ||
      !isActiveUserPermissionGrant(grant)
    ) {
      throw new Error(
        "Permission response did not acknowledge the requested change",
      );
    }
    return grant;
  },
);

export const applyPermissionAndResumeChat$ = command(
  async (
    { get, set },
    params: ApplyUserPermissionGrantParams & { owner: PermissionActionOwner },
    callback: ChatActionCallback & {
      readonly callbackIds?: ChatActionCallbackIds;
    },
    signal: AbortSignal,
  ): Promise<PlatformUserPermissionGrant> => {
    if (callback.threadId) {
      await verifyPermissionCallbackThread(
        get(apiClient$),
        callback.threadId,
        signal,
      );
    }
    const grant = await set(applyUserPermissionGrant$, params, signal);
    signal.throwIfAborted();
    if (callback.callbackPrompt && callback.threadId) {
      await set(
        runChatActionCallback$,
        {
          threadId: callback.threadId,
          callbackPrompt: callback.callbackPrompt,
          callbackIds: callback.callbackIds,
        },
        signal,
      );
    }
    return grant;
  },
);
