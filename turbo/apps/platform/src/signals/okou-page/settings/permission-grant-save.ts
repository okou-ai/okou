import {
  UNKNOWN_PERMISSION_GRANT,
  type FirewallPolicies,
  type FirewallPolicyValue,
} from "@okouai/connectors/firewall-contracts";
import {
  expandFirewallMetadataDefaultPolicy,
  resolveFirewallMetadataPolicies,
} from "@okouai/connectors/firewall-metadata/policy";
import type {
  ApplyUserPermissionGrant,
  UserPermissionGrantAction,
  UserPermissionGrantExpiresIn,
} from "@okouai/api-contracts/contracts/user-permission-grants";
import {
  createPermissionDraftContext,
  materializePermissionDraftForLegacySave,
  type PermissionDraftIntent,
} from "./permission-draft-intent.ts";
import type {
  PlatformConnectorPermissionMetadata,
  PlatformUserPermissionGrant,
} from "../../connector-domain.ts";

function userGrantAction(
  policy: FirewallPolicyValue,
): UserPermissionGrantAction {
  if (policy === "ask") {
    throw new Error("User permission grants do not support ask");
  }
  return policy;
}

type GrantExpirationSelections = Readonly<
  Record<string, UserPermissionGrantExpiresIn>
>;

interface ChangedUserGrantPolicy {
  readonly permission: string;
  readonly action: UserPermissionGrantAction;
  readonly expiresIn?: UserPermissionGrantExpiresIn;
}

function selectedGrantExpiresIn(
  expiresInByPermission: GrantExpirationSelections,
  permission: string,
  action: UserPermissionGrantAction,
): UserPermissionGrantExpiresIn | undefined {
  if (action !== "allow") {
    return undefined;
  }
  return expiresInByPermission[permission];
}

function setChangedGrantPolicy(
  changes: Map<string, ChangedUserGrantPolicy>,
  permission: string,
  action: UserPermissionGrantAction,
  expiresIn: UserPermissionGrantExpiresIn | undefined,
): void {
  changes.set(permission, {
    permission,
    action,
    ...(action === "allow" && expiresIn ? { expiresIn } : {}),
  });
}

function addNamedPolicyChanges({
  changes,
  initial,
  current,
  expiresInByPermission,
}: {
  changes: Map<string, ChangedUserGrantPolicy>;
  initial: FirewallPolicies[string] | undefined;
  current: FirewallPolicies[string] | undefined;
  expiresInByPermission: GrantExpirationSelections;
}): void {
  for (const [permission, action] of Object.entries(current?.policies ?? {})) {
    if (initial?.policies[permission] !== action) {
      const grantAction = userGrantAction(action);
      setChangedGrantPolicy(
        changes,
        permission,
        grantAction,
        selectedGrantExpiresIn(expiresInByPermission, permission, grantAction),
      );
    }
  }
}

function addUnknownPolicyChange({
  changes,
  initial,
  current,
  expiresInByPermission,
}: {
  changes: Map<string, ChangedUserGrantPolicy>;
  initial: FirewallPolicies[string] | undefined;
  current: FirewallPolicies[string] | undefined;
  expiresInByPermission: GrantExpirationSelections;
}): void {
  const unknownPolicy = current?.unknownPolicy;
  if (unknownPolicy === undefined || initial?.unknownPolicy === unknownPolicy) {
    return;
  }
  const grantAction = userGrantAction(unknownPolicy);
  setChangedGrantPolicy(
    changes,
    UNKNOWN_PERMISSION_GRANT,
    grantAction,
    selectedGrantExpiresIn(
      expiresInByPermission,
      UNKNOWN_PERMISSION_GRANT,
      grantAction,
    ),
  );
}

function addExpirationOnlyChanges({
  changes,
  connectorSlug,
  initialGrants,
  current,
  expiresInByPermission,
}: {
  changes: Map<string, ChangedUserGrantPolicy>;
  connectorSlug: string;
  initialGrants: readonly PlatformUserPermissionGrant[];
  current: FirewallPolicies[string] | undefined;
  expiresInByPermission: GrantExpirationSelections;
}): void {
  for (const grant of initialGrants) {
    if (
      grant.connectorSlug !== connectorSlug ||
      changes.has(grant.permission)
    ) {
      continue;
    }
    const expiresIn = expiresInByPermission[grant.permission];
    if (!expiresIn) {
      continue;
    }
    if (expiresIn === "always" && !grant.expiresAt) {
      continue;
    }
    const currentPolicy =
      grant.permission === UNKNOWN_PERMISSION_GRANT
        ? current?.unknownPolicy
        : current?.policies[grant.permission];
    const action = userGrantAction(currentPolicy ?? grant.action);
    if (grant.action !== "allow" || action !== "allow") {
      continue;
    }
    changes.set(grant.permission, {
      permission: grant.permission,
      action,
      expiresIn,
    });
  }
}

function addDefaultAllowExpirationChanges({
  changes,
  connectorSlug,
  initialGrants,
  current,
  expiresInByPermission,
}: {
  changes: Map<string, ChangedUserGrantPolicy>;
  connectorSlug: string;
  initialGrants: readonly PlatformUserPermissionGrant[];
  current: FirewallPolicies[string] | undefined;
  expiresInByPermission: GrantExpirationSelections;
}): void {
  const initialGrantPermissions = new Set(
    initialGrants
      .filter((grant) => {
        return grant.connectorSlug === connectorSlug;
      })
      .map((grant) => {
        return grant.permission;
      }),
  );
  for (const [permission, expiresIn] of Object.entries(expiresInByPermission)) {
    if (
      expiresIn === "always" ||
      changes.has(permission) ||
      initialGrantPermissions.has(permission)
    ) {
      continue;
    }
    const currentPolicy =
      permission === UNKNOWN_PERMISSION_GRANT
        ? current?.unknownPolicy
        : current?.policies[permission];
    if (currentPolicy === "ask") {
      continue;
    }
    const action = userGrantAction(currentPolicy ?? "allow");
    if (action !== "allow") {
      continue;
    }
    changes.set(permission, {
      permission,
      action,
      expiresIn,
    });
  }
}

function changedUserGrantPolicies({
  connectorSlug,
  metadata,
  initialPolicies,
  initialGrants,
  policies,
  expiresInByPermission,
}: {
  connectorSlug: string;
  metadata: PlatformConnectorPermissionMetadata;
  initialPolicies: FirewallPolicies;
  initialGrants: readonly PlatformUserPermissionGrant[];
  policies: FirewallPolicies;
  expiresInByPermission: GrantExpirationSelections;
}): ChangedUserGrantPolicy[] {
  const initial = resolveFirewallMetadataPolicies(initialPolicies, [
    metadata,
  ])?.[connectorSlug];
  const current = policies[connectorSlug];
  const changes = new Map<string, ChangedUserGrantPolicy>();

  addNamedPolicyChanges({
    changes,
    initial,
    current,
    expiresInByPermission,
  });
  addUnknownPolicyChange({
    changes,
    initial,
    current,
    expiresInByPermission,
  });

  addExpirationOnlyChanges({
    changes,
    connectorSlug,
    initialGrants,
    current,
    expiresInByPermission,
  });
  addDefaultAllowExpirationChanges({
    changes,
    connectorSlug,
    initialGrants,
    current,
    expiresInByPermission,
  });

  return [...changes.values()];
}

function defaultFirewallPoliciesForConnector(
  metadata: PlatformConnectorPermissionMetadata,
): FirewallPolicies {
  return {
    [metadata.connectorSlug]: expandFirewallMetadataDefaultPolicy(metadata),
  };
}

function applyGrantFromChangedPolicy(
  policy: ChangedUserGrantPolicy,
): ApplyUserPermissionGrant {
  return policy.action === "allow"
    ? {
        permission: policy.permission,
        action: "allow",
        ...(policy.expiresIn ? { expiresIn: policy.expiresIn } : {}),
      }
    : { permission: policy.permission, action: "deny" };
}

function buildAppliedUserGrantPolicies({
  connectorSlug,
  metadata,
  initialPolicies,
  initialGrants,
  policies,
  expiresInByPermission,
  resetPending,
}: {
  connectorSlug: string;
  metadata: PlatformConnectorPermissionMetadata;
  initialPolicies: FirewallPolicies;
  initialGrants: readonly PlatformUserPermissionGrant[];
  policies: FirewallPolicies;
  expiresInByPermission: GrantExpirationSelections;
  resetPending: boolean;
}): readonly ApplyUserPermissionGrant[] {
  const basePolicies = resetPending
    ? defaultFirewallPoliciesForConnector(metadata)
    : initialPolicies;
  const baseGrants = resetPending ? [] : initialGrants;
  return changedUserGrantPolicies({
    connectorSlug,
    metadata,
    initialPolicies: basePolicies,
    initialGrants: baseGrants,
    policies,
    expiresInByPermission,
  }).map(applyGrantFromChangedPolicy);
}

/** Serialize the same editor intent for the member/connector grant endpoint. */
export function connectorPermissionDraftChanges(args: {
  readonly connectorSlug: string;
  readonly metadata: PlatformConnectorPermissionMetadata;
  readonly initialPolicies: FirewallPolicies;
  readonly initialGrants: readonly PlatformUserPermissionGrant[];
  readonly intent: PermissionDraftIntent;
}) {
  const { policies, expiresInByPermission } =
    materializePermissionDraftForLegacySave({
      context: createPermissionDraftContext(args),
      draft: args.intent,
      permissions: args.metadata.permissions,
    });
  return {
    mode: args.intent.resetPending ? ("replace" as const) : ("patch" as const),
    grants: buildAppliedUserGrantPolicies({
      ...args,
      policies,
      expiresInByPermission,
      resetPending: args.intent.resetPending,
    }),
  };
}
