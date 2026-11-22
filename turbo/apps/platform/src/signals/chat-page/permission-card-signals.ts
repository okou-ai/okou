import type { Computed } from "ccstate";
import type { ChatActionCallbackIds } from "./action-callback.ts";
import { permissionActionTarget } from "../permission-allow/permission-action-target.ts";
import type {
  PlatformConnectorPermissionMetadata,
  PlatformUserPermissionGrant,
} from "../connector-domain.ts";
import { firewallPermissionMetadataByConnector } from "../firewall-permission-metadata.ts";
import { permissionGrantsForConnectors } from "../permission-allow/permission-allow-signals.ts";
import {
  permissionActionResourceKey,
  type PermissionActionDescriptor,
} from "./permission-action-block.ts";
import {
  createCardSignalsRegistry,
  type CardSignalsRegistry,
} from "./card-signal-map.ts";

/**
 * Reactive resources backing one rendered permission action card. Created once
 * per normalized permission URL and held by the thread-scoped registry, so
 * card components keep stable signal identities across transcript evaluations.
 */
export interface PermissionSignals extends PermissionActionDescriptor {
  readonly href: string;
  readonly callbackIds: ChatActionCallbackIds;
  readonly target$: ReturnType<typeof permissionActionTarget>;
  readonly grants$: Computed<Promise<readonly PlatformUserPermissionGrant[]>>;
  readonly metadata$: Computed<
    Promise<PlatformConnectorPermissionMetadata | null>
  >;
}

type PermissionCardSignalsRegistry = CardSignalsRegistry<
  PermissionActionDescriptor,
  PermissionSignals
>;

function createPermissionSignals(
  descriptor: PermissionActionDescriptor,
): PermissionSignals {
  return {
    ...descriptor,
    href: permissionActionResourceKey(descriptor),
    callbackIds: {
      clientEventId: crypto.randomUUID(),
      chatThreadSortEventId: crypto.randomUUID(),
    },
    target$: permissionActionTarget(descriptor.owner, descriptor.threadId),
    grants$: permissionGrantsForConnectors([descriptor.connectorSlug]),
    metadata$: firewallPermissionMetadataByConnector({
      connectorSlug: descriptor.connectorSlug,
    }),
  };
}

export function createPermissionCardSignalsRegistry(): PermissionCardSignalsRegistry {
  return createCardSignalsRegistry(
    permissionActionResourceKey,
    createPermissionSignals,
  );
}
