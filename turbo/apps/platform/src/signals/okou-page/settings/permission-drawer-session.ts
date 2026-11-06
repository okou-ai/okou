import { command, type Command, type Computed } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import type { FirewallPolicies } from "@okouai/connectors/firewall-contracts";
import type {
  PlatformConnectorPermissionMetadata,
  PlatformUserPermissionGrant,
} from "../../connector-domain.ts";
import { applyUserPermissionGrants$ } from "../../permission-allow/permission-allow-signals.ts";
import type { PermissionDraftIntent } from "./permission-draft-intent.ts";
import { connectorPermissionDraftChanges } from "./permission-grant-save.ts";

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

/** Saves the changes as one agent's grants for the drawer's connector. */
export function createAgentPermissionDrawerSave(
  agentId$: Computed<string | null>,
  appliedMessage: () => string,
): PermissionDrawerSession["save$"] {
  return command(
    async (
      { get, set },
      changes: PermissionDrawerChanges,
      signal: AbortSignal,
    ): Promise<void> => {
      const agentId = get(agentId$);
      if (!agentId) {
        throw new Error("Permission drawer has no agent to save for");
      }
      const connectorSlug = changes.metadata.connectorSlug;
      await set(
        applyUserPermissionGrants$,
        {
          agentId,
          connectorSlug,
          ...connectorPermissionDraftChanges({ ...changes, connectorSlug }),
        },
        signal,
      );
      signal.throwIfAborted();
      toast.success(appliedMessage());
    },
  );
}
