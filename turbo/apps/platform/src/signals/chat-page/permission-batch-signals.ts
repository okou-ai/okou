import { command, computed, state } from "ccstate";
import { userPermissionGrantsContract } from "@okouai/api-contracts/client/user-permission-grants";
import type {
  ApplyUserPermissionGrantsBatchRequest,
  UserPermissionGrantExpiresIn,
} from "@okouai/api-contracts/contracts/user-permission-grants";
import { chatThreadMetadataContract } from "@okouai/api-contracts/client/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept } from "../../lib/accept.ts";
import { agentById } from "../agent.ts";
import { apiClient$ } from "../api-client.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { firewallPermissionMetadataByConnector } from "../firewall-permission-metadata.ts";
import {
  findPermissionInMetadata,
  resolveUserPermissionGrantPolicy,
  userPermissionGrantsByAgent,
} from "../permission-allow/permission-allow-signals.ts";
import type {
  PlatformConnectorPermissionMetadata,
  PlatformUserPermissionGrant,
} from "../connector-domain.ts";
import { DEFAULT_USER_PERMISSION_GRANT_EXPIRES_IN } from "../permission-allow/permission-grant-expiration.ts";
import { runChatActionCallback$ } from "./action-callback.ts";
import { createCardSignalsRegistry } from "./card-signal-map.ts";
import { chatActionIdMatches } from "./chat-action-context.ts";
import {
  permissionBatchActionResourceKey,
  type PermissionBatchActionDescriptor,
} from "./permission-batch-action-block.ts";

function createBatchResources(descriptor: PermissionBatchActionDescriptor) {
  const agent$ = agentById(descriptor.agentId);
  const grants$ = userPermissionGrantsByAgent({ agentId: descriptor.agentId });
  const metadataResources = [
    ...new Set(
      descriptor.items.map((item) => {
        return item.connectorSlug;
      }),
    ),
  ].map((connectorSlug) => {
    return firewallPermissionMetadataByConnector({ connectorSlug });
  });
  const callbackTarget$ = computed(async (get) => {
    if (!descriptor.threadId) {
      return;
    }
    const client = get(apiClient$)(chatThreadMetadataContract);
    const result = await accept(
      client.get({ params: { id: descriptor.threadId } }),
      [200],
    );
    if (!chatActionIdMatches(result.body.agentId, descriptor.agentId)) {
      throw new Error(
        "Permission callback thread does not belong to this agent",
      );
    }
  });
  const metadata$ = computed(
    async (get): Promise<readonly PlatformConnectorPermissionMetadata[]> => {
      await get(callbackTarget$);
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
  return { agent$, grants$, metadata$ };
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

const assertBatchEnabled$ = command(async ({ get }, signal: AbortSignal) => {
  const features = await get(featureSwitch$);
  signal.throwIfAborted();
  if (!features[FeatureSwitchKey.BatchConnectorPermissions]) {
    throw new Error("Batch connector permissions are unavailable");
  }
});

function missingPermissionGroups(
  descriptor: PermissionBatchActionDescriptor,
  grants: readonly PlatformUserPermissionGrant[],
  metadata: readonly PlatformConnectorPermissionMetadata[],
  expiresIn: UserPermissionGrantExpiresIn,
): ApplyUserPermissionGrantsBatchRequest["groups"] {
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
  agentId: string,
  groups: ApplyUserPermissionGrantsBatchRequest["groups"],
  previous: readonly PlatformUserPermissionGrant[],
  returned: readonly PlatformUserPermissionGrant[],
): readonly PlatformUserPermissionGrant[] {
  // The response can contain only changed grants. Require every requested
  // change to be acknowledged before merging with the unchanged read snapshot.
  for (const group of groups) {
    for (const requested of group.grants) {
      const grant = returned.find((candidate) => {
        return (
          chatActionIdMatches(candidate.agentId, agentId) &&
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
      await set(assertBatchEnabled$, signal);
      if (get(local.dismissed$)) {
        return false;
      }
      const [agent, grants, metadata] = await Promise.all([
        get(resources.agent$),
        get(resources.grants$),
        get(resources.metadata$),
      ]);
      signal.throwIfAborted();
      if (!chatActionIdMatches(agent.agentId, descriptor.agentId)) {
        throw new Error("Permission agent does not match");
      }
      const groups = missingPermissionGroups(
        descriptor,
        grants,
        metadata,
        expiresIn,
      );
      let acknowledged = grants;
      if (groups.length) {
        const client = get(apiClient$)(userPermissionGrantsContract);
        const result = await accept(
          client.applyBatch({
            body: { agentId: descriptor.agentId, groups },
            fetchOptions: { signal },
          }),
          [200],
        );
        signal.throwIfAborted();
        acknowledged = mergeBatchAcknowledgements(
          descriptor.agentId,
          groups,
          grants,
          result.body,
        );
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
            agentId: descriptor.agentId,
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
    href: permissionBatchActionResourceKey(descriptor),
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
