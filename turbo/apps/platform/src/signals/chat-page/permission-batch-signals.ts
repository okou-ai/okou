import { apiClient$ } from "../api-client.ts";
import {
  permissionActionTarget,
  verifyPermissionCallbackThread,
} from "../permission-allow/permission-action-target.ts";
import { runChatActionCallback$ } from "./action-callback.ts";
import { command, computed, state } from "ccstate";

import type { UserPermissionGrantExpiresIn } from "@okouai/api-contracts/validators/user-permission-grants";
import { firewallPermissionMetadataByConnector } from "../firewall-permission-metadata.ts";
import {
  findPermissionInMetadata,
  resolveUserPermissionGrantPolicy,
  permissionGrantsForConnectors,
  applyUserPermissionGrants$,
} from "../permission-allow/permission-allow-signals.ts";
import type {
  PlatformConnectorPermissionMetadata,
  PlatformUserPermissionGrant,
} from "../connector-domain.ts";
import { DEFAULT_USER_PERMISSION_GRANT_EXPIRES_IN } from "../permission-allow/permission-grant-expiration.ts";
import { createCardSignalsRegistry } from "./card-signal-map.ts";
import {
  permissionBatchActionResourceKey,
  type PermissionBatchActionDescriptor,
} from "./permission-batch-action-block.ts";

function createBatchResources(descriptor: PermissionBatchActionDescriptor) {
  const target$ = permissionActionTarget(descriptor.owner, descriptor.threadId);
  const grants$ = permissionGrantsForConnectors(
    descriptor.items.map((item) => {
      return item.connectorSlug;
    }),
  );
  const metadataResources = [
    ...new Set(
      descriptor.items.map((item) => {
        return item.connectorSlug;
      }),
    ),
  ].map((connectorSlug) => {
    return firewallPermissionMetadataByConnector({ connectorSlug });
  });
  const metadata$ = computed(
    async (get): Promise<readonly PlatformConnectorPermissionMetadata[]> => {
      const metadata = await Promise.all(
        metadataResources.map((resource$) => {
          return get(resource$);
        }),
      );
      const present: PlatformConnectorPermissionMetadata[] = [];
      for (const entry of metadata) {
        if (!entry) {
          throw new Error("Permission metadata is unavailable");
        }
        present.push(entry);
      }
      for (const item of descriptor.items) {
        const entry = present.find((candidate) => {
          return candidate.connectorSlug === item.connectorSlug;
        });
        if (!entry || !findPermissionInMetadata(entry, item.permission)) {
          throw new Error("Requested permission is unavailable");
        }
      }
      return present;
    },
  );
  return { target$, grants$, metadata$ };
}
type BatchResources = ReturnType<typeof createBatchResources>;

function createBatchState(descriptor: PermissionBatchActionDescriptor) {
  const expiresIn$ = state<UserPermissionGrantExpiresIn>(
    descriptor.expiresIn ?? DEFAULT_USER_PERMISSION_GRANT_EXPIRES_IN,
  );
  const dismissed$ = state(false);
  const setExpiresIn$ = command(
    ({ set }, value: UserPermissionGrantExpiresIn) => {
      set(expiresIn$, value);
    },
  );
  const dismiss$ = command(({ set }) => {
    set(dismissed$, true);
  });
  return {
    expiresIn$,
    dismissed$,
    setExpiresIn$,
    dismiss$,
  };
}
type BatchState = ReturnType<typeof createBatchState>;

function missingPermissionGroups(
  descriptor: PermissionBatchActionDescriptor,
  grants: readonly PlatformUserPermissionGrant[],
  metadata: readonly PlatformConnectorPermissionMetadata[],
  expiresIn: UserPermissionGrantExpiresIn,
) {
  return metadata.flatMap((entry) => {
    const missing = descriptor.items.filter((item) => {
      return (
        item.connectorSlug === entry.connectorSlug &&
        resolveUserPermissionGrantPolicy(grants, entry, item.permission) !==
          "allow"
      );
    });
    return missing.length
      ? [
          {
            connectorSlug: entry.connectorSlug,
            grants: missing.map((item) => {
              return {
                permission: item.permission,
                action: "allow" as const,
                expiresIn,
              };
            }),
          },
        ]
      : [];
  });
}

function allBatchPermissionsAllowed(
  descriptor: PermissionBatchActionDescriptor,
  grants: readonly PlatformUserPermissionGrant[],
  metadata: readonly PlatformConnectorPermissionMetadata[],
): boolean {
  return descriptor.items.every((item) => {
    const entry = metadata.find((candidate) => {
      return candidate.connectorSlug === item.connectorSlug;
    });
    return Boolean(
      entry &&
      resolveUserPermissionGrantPolicy(grants, entry, item.permission) ===
        "allow",
    );
  });
}

function mergeBatchAcknowledgements(
  groups: ReturnType<typeof missingPermissionGroups>,
  previous: readonly PlatformUserPermissionGrant[],
  returned: readonly PlatformUserPermissionGrant[],
): readonly PlatformUserPermissionGrant[] {
  // The response can contain only changed grants. Require every requested
  // change to be acknowledged before merging with the unchanged read snapshot.
  for (const group of groups) {
    for (const requested of group.grants) {
      const grant = returned.find((candidate) => {
        return (
          candidate.connectorSlug === group.connectorSlug &&
          candidate.permission === requested.permission
        );
      });
      if (!grant || grant.action !== "allow") {
        throw new Error(
          "Batch permission response did not acknowledge every grant",
        );
      }
    }
  }
  return [
    ...previous.filter((grant) => {
      return !returned.some((candidate) => {
        return (
          candidate.connectorSlug === grant.connectorSlug &&
          candidate.permission === grant.permission
        );
      });
    }),
    ...returned,
  ];
}

function createBatchSaveCommand(
  descriptor: PermissionBatchActionDescriptor,
  resources: BatchResources,
  local: BatchState,
) {
  const callbackIds = {
    clientEventId: crypto.randomUUID(),
    chatThreadSortEventId: crypto.randomUUID(),
  };
  const performSave$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
      const expiresIn = get(local.expiresIn$);
      signal.throwIfAborted();
      if (get(local.dismissed$)) {
        return false;
      }
      const [, grants, metadata] = await Promise.all([
        get(resources.target$),
        get(resources.grants$),
        get(resources.metadata$),
      ]);
      signal.throwIfAborted();
      if (descriptor.threadId) {
        await verifyPermissionCallbackThread(
          get(apiClient$),
          descriptor.threadId,
          signal,
        );
      }
      const groups = missingPermissionGroups(
        descriptor,
        grants,
        metadata,
        expiresIn,
      );
      let acknowledged = grants;

      signal.throwIfAborted();
      if (groups.length) {
        const saved: PlatformUserPermissionGrant[] = [];
        for (const group of groups) {
          saved.push(
            ...(await set(
              applyUserPermissionGrants$,
              {
                owner: descriptor.owner,
                connectorSlug: group.connectorSlug,
                mode: "patch",
                grants: group.grants,
              },
              signal,
            )),
          );
        }
        acknowledged = mergeBatchAcknowledgements(groups, grants, saved);
      }
      if (!allBatchPermissionsAllowed(descriptor, acknowledged, metadata)) {
        throw new Error(
          "Batch permission response does not allow the requested permissions",
        );
      }
      if (descriptor.threadId && descriptor.callbackPrompt) {
        await set(
          runChatActionCallback$,
          {
            threadId: descriptor.threadId,
            callbackPrompt: descriptor.callbackPrompt,
            callbackIds,
          },
          signal,
        );
      }
      return true;
    },
  );
  return performSave$;
}

/** Constructed by the thread registry or route graph, never during React render. */
export function createPermissionBatchSignals(
  descriptor: PermissionBatchActionDescriptor,
) {
  const resources = createBatchResources(descriptor);
  const local = createBatchState(descriptor);
  const confirm$ = createBatchSaveCommand(descriptor, resources, local);
  return {
    ...descriptor,
    descriptor,
    ...resources,
    expiresIn$: local.expiresIn$,
    dismissed$: local.dismissed$,
    setExpiresIn$: local.setExpiresIn$,
    dismiss$: local.dismiss$,
    confirm$,
  };
}

export type PermissionBatchSignals = ReturnType<
  typeof createPermissionBatchSignals
>;

export function createPermissionBatchCardSignalsRegistry() {
  return createCardSignalsRegistry(
    permissionBatchActionResourceKey,
    createPermissionBatchSignals,
  );
}
