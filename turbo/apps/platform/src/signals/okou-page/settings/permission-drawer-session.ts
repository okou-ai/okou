import type { Command, Computed } from "ccstate";
import type { FirewallPolicies } from "@okouai/connectors/firewall-contracts";
import type {
  PlatformConnectorPermissionMetadata,
  PlatformUserPermissionGrant,
} from "../../connector-domain.ts";
import type { PermissionDraftIntent } from "./permission-draft-intent.ts";

/** A drawer's edit intent and the grants it is saved against. */
export interface PermissionDrawerChanges {
  readonly metadata: PlatformConnectorPermissionMetadata;
  readonly initialPolicies: FirewallPolicies;
  readonly initialGrants: readonly PlatformUserPermissionGrant[];
  readonly intent: PermissionDraftIntent;
}

/**
 * The owner of one open permission drawer. The drawer shows the grants read
 * from here; applying saves the intent against their current value and
 * closes the owner's surface, so the view passes neither a base nor a
 * continuation.
 */
export interface PermissionDrawerSession {
  /** `null` while the owner has nothing the member can edit. */
  readonly grants$: Computed<
    Promise<readonly PlatformUserPermissionGrant[] | null>
  >;
  readonly metadata$: Computed<
    Promise<PlatformConnectorPermissionMetadata | null>
  >;
  readonly save$: Command<
    Promise<void>,
    [PermissionDrawerChanges, AbortSignal]
  >;
  readonly close$: Command<void, []>;
}
