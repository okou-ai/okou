import type { UserPermissionGrantExpiresIn } from "@okouai/api-contracts/contracts/user-permission-grants";
import {
  createFirewallMetadataPolicyResolver,
  type FirewallMetadataPolicyOverlay,
  type FirewallMetadataPolicyResolver,
} from "@okouai/connectors/firewall-metadata/policy";
import {
  UNKNOWN_PERMISSION_GRANT,
  type FirewallPolicy,
  type FirewallPolicies,
  type FirewallPolicyValue,
} from "@okouai/connectors/firewall-contracts";
import type {
  PlatformConnectorPermissionMetadata,
  PlatformUserPermissionGrant,
} from "../../connector-domain.ts";

export interface PermissionDraftIntent {
  readonly connectorPolicy: FirewallPolicyValue | undefined;
  readonly groupPolicies: Readonly<Record<string, FirewallPolicyValue>>;
  readonly permissionPolicies: Readonly<Record<string, FirewallPolicyValue>>;
  readonly restoredGroups: Readonly<Record<string, true>>;
  readonly restoredPermissions: Readonly<Record<string, true>>;
  readonly unknownPolicy: FirewallPolicyValue | undefined;
  readonly resetPending: boolean;
  readonly groupExpirations: Readonly<
    Record<string, UserPermissionGrantExpiresIn>
  >;
  readonly permissionExpirations: Readonly<
    Record<string, UserPermissionGrantExpiresIn>
  >;
  readonly clearedPermissionExpirations: Readonly<Record<string, true>>;
  readonly unknownExpiration: UserPermissionGrantExpiresIn | undefined;
}

export interface PermissionDraftContext {
  readonly metadata: PlatformConnectorPermissionMetadata;
  readonly defaultResolver: FirewallMetadataPolicyResolver;
  readonly initialResolver: FirewallMetadataPolicyResolver;
}

interface PermissionLike {
  readonly name: string;
}

interface PermissionGrantFingerprint {
  readonly permission: string;
  readonly action: PlatformUserPermissionGrant["action"];
  readonly expiration: string;
}

interface PolicyResolutionParams {
  readonly context: PermissionDraftContext;
  readonly draft: PermissionDraftIntent;
  readonly permissionName: string;
}

interface ExpirationResolutionParams {
  readonly context: PermissionDraftContext;
  readonly draft: PermissionDraftIntent;
  readonly permissionName: string;
}

type PermissionDraftGroupUniformAllowExpiration =
  | { readonly kind: "always" }
  | {
      readonly kind: "selected";
      readonly expiresIn: Exclude<UserPermissionGrantExpiresIn, "always">;
    }
  | { readonly kind: "persisted"; readonly expiresAt: string };

type PermissionDraftGroupAllowExpiration =
  PermissionDraftGroupUniformAllowExpiration | { readonly kind: "mixed" };

type PermissionDraftGroupConfiguration =
  | { readonly policy: "mixed" }
  | { readonly policy: Exclude<FirewallPolicyValue, "allow"> }
  | {
      readonly policy: "allow";
      readonly expiration: PermissionDraftGroupAllowExpiration;
    };

function firewallPolicyToOverlay(
  policy: FirewallPolicy | undefined,
): FirewallMetadataPolicyOverlay | undefined {
  if (!policy) {
    return undefined;
  }
  const { unknownPolicy } = policy;
  return {
    permissionOverrides: policy.policies,
    ...(unknownPolicy !== undefined ? { unknownPolicy } : {}),
  };
}

function omitKey<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): Record<string, T> {
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    return { ...record };
  }
  const next = { ...record };
  delete next[key];
  return next;
}

function omitKeys<T>(
  record: Readonly<Record<string, T>>,
  keys: ReadonlySet<string>,
): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!keys.has(key)) {
      next[key] = value;
    }
  }
  return next;
}

function permissionCategory(
  metadata: PlatformConnectorPermissionMetadata,
  permissionName: string,
): string | undefined {
  return metadata.categories?.categories[permissionName];
}

function resolveBasePermissionPolicy({
  context,
  draft,
  permissionName,
}: PolicyResolutionParams): FirewallPolicyValue {
  const resolver = draft.resetPending
    ? context.defaultResolver
    : context.initialResolver;
  return resolver.permission(permissionName);
}

function resolveInitialPermissionPolicy(
  context: PermissionDraftContext,
  permissionName: string,
): FirewallPolicyValue {
  return context.initialResolver.permission(permissionName);
}

function grantExpirationFingerprint(
  grant: PlatformUserPermissionGrant,
): string {
  return grant.action === "allow" && grant.expiresAt
    ? `at:${grant.expiresAt}`
    : "always";
}

function selectedExpirationFingerprint(
  action: PlatformUserPermissionGrant["action"],
  selected: UserPermissionGrantExpiresIn | undefined,
): string {
  return action === "allow" && selected !== undefined && selected !== "always"
    ? `duration:${selected}`
    : "always";
}

function grantAction(
  policy: FirewallPolicyValue,
): PlatformUserPermissionGrant["action"] | null {
  switch (policy) {
    case "allow":
    case "deny": {
      return policy;
    }
    case "ask": {
      return null;
    }
  }
}

function comparePermissionGrantFingerprints(
  a: PermissionGrantFingerprint,
  b: PermissionGrantFingerprint,
): number {
  const permissionCompare = a.permission.localeCompare(b.permission);
  if (permissionCompare !== 0) {
    return permissionCompare;
  }
  const actionCompare = a.action.localeCompare(b.action);
  if (actionCompare !== 0) {
    return actionCompare;
  }
  return a.expiration.localeCompare(b.expiration);
}

function currentPermissionGrantFingerprint({
  permission,
  currentPolicy,
  defaultPolicy,
  selected,
}: {
  readonly permission: string;
  readonly currentPolicy: FirewallPolicyValue;
  readonly defaultPolicy: FirewallPolicyValue;
  readonly selected: UserPermissionGrantExpiresIn | undefined;
}): PermissionGrantFingerprint | null {
  const currentAction = grantAction(currentPolicy);
  const defaultAction = grantAction(defaultPolicy);
  if (!currentAction || !defaultAction) {
    return null;
  }
  const hasExpiringDefaultAllowGrant =
    currentAction === "allow" &&
    currentAction === defaultAction &&
    selected !== undefined &&
    selected !== "always";
  if (currentAction === defaultAction && !hasExpiringDefaultAllowGrant) {
    return null;
  }
  return {
    permission,
    action: currentAction,
    expiration: selectedExpirationFingerprint(currentAction, selected),
  };
}

function explicitGrantFingerprints(
  explicitGrants: ReadonlyMap<string, PlatformUserPermissionGrant>,
): readonly PermissionGrantFingerprint[] {
  return [...explicitGrants.entries()]
    .map(([permission, grant]) => {
      return {
        permission,
        action: grant.action,
        expiration: grantExpirationFingerprint(grant),
      };
    })
    .sort(comparePermissionGrantFingerprints);
}

function permissionGrantFingerprintsEqual(
  a: readonly PermissionGrantFingerprint[],
  b: readonly PermissionGrantFingerprint[],
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((item, index) => {
    const other = b[index];
    return (
      item.permission === other.permission &&
      item.action === other.action &&
      item.expiration === other.expiration
    );
  });
}

export function createEmptyPermissionDraftIntent(): PermissionDraftIntent {
  return {
    connectorPolicy: undefined,
    groupPolicies: {},
    permissionPolicies: {},
    restoredGroups: {},
    restoredPermissions: {},
    unknownPolicy: undefined,
    resetPending: false,
    groupExpirations: {},
    permissionExpirations: {},
    clearedPermissionExpirations: {},
    unknownExpiration: undefined,
  };
}

export function createPermissionDraftContext({
  metadata,
  initialPolicies,
}: {
  readonly metadata: PlatformConnectorPermissionMetadata;
  readonly initialPolicies: FirewallPolicies;
}): PermissionDraftContext {
  return {
    metadata,
    defaultResolver: createFirewallMetadataPolicyResolver(metadata),
    initialResolver: createFirewallMetadataPolicyResolver(
      metadata,
      firewallPolicyToOverlay(initialPolicies[metadata.connectorSlug]),
    ),
  };
}

export function permissionDraftMetadataKey(
  metadata: PlatformConnectorPermissionMetadata,
): string {
  return JSON.stringify({
    connectorSlug: metadata.connectorSlug,
    permissions: metadata.permissions.map((permission) => {
      return permission.name;
    }),
    permissionCount: metadata.permissionCount,
    defaultPolicy: metadata.defaultPolicy,
    categories: metadata.categories,
  });
}

export function permissionDraftInitialPolicyKey(
  context: PermissionDraftContext,
): string {
  return JSON.stringify({
    unknownPolicy: context.initialResolver.unknown(),
    permissions: context.metadata.permissions.map((permission) => {
      return [
        permission.name,
        context.initialResolver.permission(permission.name),
      ] as const;
    }),
  });
}

export function explicitGrantStateKey(
  grants: Map<string, PlatformUserPermissionGrant>,
): string {
  return JSON.stringify(
    [...grants.entries()]
      .map(([permission, grant]) => {
        return [permission, grant.action, grant.expiresAt] as const;
      })
      .sort((a, b) => {
        return a[0].localeCompare(b[0]);
      }),
  );
}

export function resolvePermissionDraftPolicy(
  params: PolicyResolutionParams,
): FirewallPolicyValue {
  const explicit = params.draft.permissionPolicies[params.permissionName];
  if (explicit !== undefined) {
    return explicit;
  }

  if (params.draft.restoredPermissions[params.permissionName]) {
    return resolveInitialPermissionPolicy(
      params.context,
      params.permissionName,
    );
  }

  const category = permissionCategory(
    params.context.metadata,
    params.permissionName,
  );
  if (category) {
    if (params.draft.restoredGroups[category]) {
      return resolveInitialPermissionPolicy(
        params.context,
        params.permissionName,
      );
    }

    const groupPolicy = params.draft.groupPolicies[category];
    if (groupPolicy !== undefined) {
      return groupPolicy;
    }
  }

  if (params.draft.connectorPolicy !== undefined) {
    return params.draft.connectorPolicy;
  }

  return resolveBasePermissionPolicy(params);
}

export function resolvePermissionDraftUnknownPolicy({
  context,
  draft,
}: {
  readonly context: PermissionDraftContext;
  readonly draft: PermissionDraftIntent;
}): FirewallPolicyValue {
  if (draft.unknownPolicy !== undefined) {
    return draft.unknownPolicy;
  }
  return draft.resetPending
    ? context.defaultResolver.unknown()
    : context.initialResolver.unknown();
}

export function resolvePermissionDraftListPolicy({
  context,
  draft,
  permissions,
}: {
  readonly context: PermissionDraftContext;
  readonly draft: PermissionDraftIntent;
  readonly permissions: readonly PermissionLike[];
}): FirewallPolicyValue | "mixed" {
  let first: FirewallPolicyValue | null = null;
  for (const permission of permissions) {
    const current = resolvePermissionDraftPolicy({
      context,
      draft,
      permissionName: permission.name,
    });
    if (first === null) {
      first = current;
      continue;
    }
    if (current !== first) {
      return "mixed";
    }
  }
  return first ?? "allow";
}

export function resolvePermissionDraftExpiration(
  params: ExpirationResolutionParams,
): UserPermissionGrantExpiresIn | undefined {
  const explicit = params.draft.permissionExpirations[params.permissionName];
  if (explicit !== undefined) {
    return explicit;
  }
  if (params.draft.restoredPermissions[params.permissionName]) {
    return undefined;
  }
  if (params.draft.clearedPermissionExpirations[params.permissionName]) {
    return undefined;
  }
  const category = permissionCategory(
    params.context.metadata,
    params.permissionName,
  );
  if (category && params.draft.restoredGroups[category]) {
    return undefined;
  }
  return category ? params.draft.groupExpirations[category] : undefined;
}

function resolvePermissionDraftGroupAllowExpiration({
  context,
  draft,
  permissionName,
  grant,
}: {
  readonly context: PermissionDraftContext;
  readonly draft: PermissionDraftIntent;
  readonly permissionName: string;
  readonly grant: PlatformUserPermissionGrant | undefined;
}): PermissionDraftGroupUniformAllowExpiration {
  const selected = resolvePermissionDraftExpiration({
    context,
    draft,
    permissionName,
  });
  if (selected === "always") {
    return { kind: "always" };
  }
  if (selected !== undefined) {
    return { kind: "selected", expiresIn: selected };
  }
  if (grant?.action === "allow" && grant.expiresAt) {
    return { kind: "persisted", expiresAt: grant.expiresAt };
  }
  return { kind: "always" };
}

function permissionDraftGroupAllowExpirationsEqual(
  first: PermissionDraftGroupUniformAllowExpiration,
  second: PermissionDraftGroupUniformAllowExpiration,
): boolean {
  if (first.kind !== second.kind) {
    return false;
  }
  switch (first.kind) {
    case "always": {
      return true;
    }
    case "selected": {
      return second.kind === "selected" && first.expiresIn === second.expiresIn;
    }
    case "persisted": {
      return (
        second.kind === "persisted" && first.expiresAt === second.expiresAt
      );
    }
  }
}

export function resolvePermissionDraftGroupConfiguration({
  context,
  draft,
  permissions,
  explicitGrants,
}: {
  readonly context: PermissionDraftContext;
  readonly draft: PermissionDraftIntent;
  readonly permissions: readonly PermissionLike[];
  readonly explicitGrants: ReadonlyMap<string, PlatformUserPermissionGrant>;
}): PermissionDraftGroupConfiguration {
  if (permissions.length === 0) {
    return { policy: "allow", expiration: { kind: "always" } };
  }

  const firstPermission = permissions[0];
  const firstPolicy = resolvePermissionDraftPolicy({
    context,
    draft,
    permissionName: firstPermission.name,
  });
  if (firstPolicy !== "allow") {
    for (let i = 1; i < permissions.length; i++) {
      const currentPolicy = resolvePermissionDraftPolicy({
        context,
        draft,
        permissionName: permissions[i].name,
      });
      if (currentPolicy !== firstPolicy) {
        return { policy: "mixed" };
      }
    }
    return { policy: firstPolicy };
  }

  const firstExpiration = resolvePermissionDraftGroupAllowExpiration({
    context,
    draft,
    permissionName: firstPermission.name,
    grant: explicitGrants.get(firstPermission.name),
  });
  let expirationMixed = false;
  for (let i = 1; i < permissions.length; i++) {
    const permission = permissions[i];
    const currentPolicy = resolvePermissionDraftPolicy({
      context,
      draft,
      permissionName: permission.name,
    });
    if (currentPolicy !== "allow") {
      return { policy: "mixed" };
    }
    const currentExpiration = resolvePermissionDraftGroupAllowExpiration({
      context,
      draft,
      permissionName: permission.name,
      grant: explicitGrants.get(permission.name),
    });
    if (
      !permissionDraftGroupAllowExpirationsEqual(
        firstExpiration,
        currentExpiration,
      )
    ) {
      expirationMixed = true;
    }
  }
  return {
    policy: "allow",
    expiration: expirationMixed ? { kind: "mixed" } : firstExpiration,
  };
}

export function setPermissionDraftPolicy({
  draft,
  permissionName,
  policy,
}: {
  readonly draft: PermissionDraftIntent;
  readonly permissionName: string;
  readonly policy: FirewallPolicyValue;
}): PermissionDraftIntent {
  return {
    ...draft,
    permissionPolicies: {
      ...draft.permissionPolicies,
      [permissionName]: policy,
    },
    restoredPermissions: omitKey(draft.restoredPermissions, permissionName),
  };
}

export function setPermissionDraftConnectorPolicy({
  draft,
  policy,
  includeUnknown,
}: {
  readonly draft: PermissionDraftIntent;
  readonly policy: FirewallPolicyValue;
  readonly includeUnknown: boolean;
}): PermissionDraftIntent {
  return {
    ...draft,
    connectorPolicy: policy,
    groupPolicies: {},
    permissionPolicies: {},
    restoredGroups: {},
    restoredPermissions: {},
    ...(includeUnknown ? { unknownPolicy: policy } : {}),
    ...(policy === "deny"
      ? {
          groupExpirations: {},
          permissionExpirations: {},
          clearedPermissionExpirations: {},
          unknownExpiration: undefined,
        }
      : {}),
  };
}

export function setPermissionDraftGroupPolicy({
  draft,
  category,
  permissions,
  policy,
}: {
  readonly draft: PermissionDraftIntent;
  readonly category: string;
  readonly permissions: readonly PermissionLike[];
  readonly policy: FirewallPolicyValue;
}): PermissionDraftIntent {
  const permissionNames = new Set(
    permissions.map((permission) => {
      return permission.name;
    }),
  );
  const nextPermissionExpirations =
    policy === "deny"
      ? Object.fromEntries(
          Object.entries(draft.permissionExpirations).filter(([name]) => {
            return !permissionNames.has(name);
          }),
        )
      : draft.permissionExpirations;
  const nextClearedPermissionExpirations =
    policy === "deny"
      ? Object.fromEntries(
          Object.entries(draft.clearedPermissionExpirations).filter(
            ([name]) => {
              return !permissionNames.has(name);
            },
          ),
        )
      : draft.clearedPermissionExpirations;

  return {
    ...draft,
    groupPolicies: {
      ...draft.groupPolicies,
      [category]: policy,
    },
    permissionPolicies: omitKeys(draft.permissionPolicies, permissionNames),
    restoredGroups: omitKey(draft.restoredGroups, category),
    restoredPermissions: omitKeys(draft.restoredPermissions, permissionNames),
    groupExpirations:
      policy === "deny"
        ? omitKey(draft.groupExpirations, category)
        : draft.groupExpirations,
    permissionExpirations: nextPermissionExpirations,
    clearedPermissionExpirations: nextClearedPermissionExpirations,
  };
}

export function setPermissionDraftGroupAllowPolicy({
  draft,
  category,
  permissions,
}: {
  readonly draft: PermissionDraftIntent;
  readonly category: string;
  readonly permissions: readonly PermissionLike[];
}): PermissionDraftIntent {
  return setPermissionDraftGroupPolicy({
    draft,
    category,
    permissions,
    policy: "allow",
  });
}

export function setPermissionDraftUnknownPolicy({
  draft,
  policy,
}: {
  readonly draft: PermissionDraftIntent;
  readonly policy: FirewallPolicyValue;
}): PermissionDraftIntent {
  return {
    ...draft,
    unknownPolicy: policy,
    ...(policy === "deny" ? { unknownExpiration: undefined } : {}),
  };
}

export function stagePermissionDraftConnectorRestore({
  draft,
}: {
  readonly draft: PermissionDraftIntent;
}): PermissionDraftIntent {
  return {
    ...draft,
    connectorPolicy: undefined,
    groupPolicies: {},
    permissionPolicies: {},
    restoredGroups: {},
    restoredPermissions: {},
    unknownPolicy: undefined,
    resetPending: true,
    groupExpirations: {},
    permissionExpirations: {},
    clearedPermissionExpirations: {},
    unknownExpiration: undefined,
  };
}

export function setPermissionDraftExpiration({
  draft,
  permissionName,
  expiresIn,
}: {
  readonly draft: PermissionDraftIntent;
  readonly permissionName: string;
  readonly expiresIn: UserPermissionGrantExpiresIn | null;
}): PermissionDraftIntent {
  return {
    ...draft,
    permissionExpirations:
      expiresIn === null
        ? omitKey(draft.permissionExpirations, permissionName)
        : {
            ...draft.permissionExpirations,
            [permissionName]: expiresIn,
          },
    clearedPermissionExpirations: omitKey(
      draft.clearedPermissionExpirations,
      permissionName,
    ),
    restoredPermissions: omitKey(draft.restoredPermissions, permissionName),
  };
}

export function clearPermissionDraftInheritedExpiration({
  draft,
  permissionName,
}: {
  readonly draft: PermissionDraftIntent;
  readonly permissionName: string;
}): PermissionDraftIntent {
  return {
    ...draft,
    permissionExpirations: omitKey(draft.permissionExpirations, permissionName),
    clearedPermissionExpirations: {
      ...draft.clearedPermissionExpirations,
      [permissionName]: true,
    },
    restoredPermissions: omitKey(draft.restoredPermissions, permissionName),
  };
}

function setPermissionDraftGroupExpiration({
  draft,
  category,
  permissions,
  expiresIn,
}: {
  readonly draft: PermissionDraftIntent;
  readonly category: string;
  readonly permissions: readonly PermissionLike[];
  readonly expiresIn: UserPermissionGrantExpiresIn | null;
}): PermissionDraftIntent {
  const permissionNames = new Set(
    permissions.map((permission) => {
      return permission.name;
    }),
  );
  return {
    ...draft,
    groupExpirations:
      expiresIn === null
        ? omitKey(draft.groupExpirations, category)
        : {
            ...draft.groupExpirations,
            [category]: expiresIn,
          },
    restoredGroups: omitKey(draft.restoredGroups, category),
    permissionExpirations: omitKeys(
      draft.permissionExpirations,
      permissionNames,
    ),
    clearedPermissionExpirations: omitKeys(
      draft.clearedPermissionExpirations,
      permissionNames,
    ),
    restoredPermissions: omitKeys(draft.restoredPermissions, permissionNames),
  };
}

export function setPermissionDraftGroupAllowExpiration({
  draft,
  category,
  permissions,
  explicitGrants,
  expiresIn,
}: {
  readonly draft: PermissionDraftIntent;
  readonly category: string;
  readonly permissions: readonly PermissionLike[];
  readonly explicitGrants: ReadonlyMap<string, PlatformUserPermissionGrant>;
  readonly expiresIn: UserPermissionGrantExpiresIn | null;
}): PermissionDraftIntent {
  if (expiresIn !== "always") {
    return setPermissionDraftGroupExpiration({
      draft,
      category,
      permissions,
      expiresIn,
    });
  }

  let next = setPermissionDraftGroupExpiration({
    draft,
    category,
    permissions,
    expiresIn: null,
  });
  for (const permission of permissions) {
    const grant = explicitGrants.get(permission.name);
    if (grant?.action === "allow" && grant.expiresAt) {
      next = setPermissionDraftExpiration({
        draft: next,
        permissionName: permission.name,
        expiresIn: "always",
      });
    }
  }
  return next;
}

export function setPermissionDraftUnknownExpiration({
  draft,
  expiresIn,
}: {
  readonly draft: PermissionDraftIntent;
  readonly expiresIn: UserPermissionGrantExpiresIn | null;
}): PermissionDraftIntent {
  return {
    ...draft,
    unknownExpiration: expiresIn ?? undefined,
  };
}

export function isPermissionDraftPristine(
  draft: PermissionDraftIntent,
): boolean {
  return (
    draft.connectorPolicy === undefined &&
    draft.unknownPolicy === undefined &&
    !draft.resetPending &&
    Object.keys(draft.groupPolicies).length === 0 &&
    Object.keys(draft.permissionPolicies).length === 0 &&
    Object.keys(draft.restoredGroups).length === 0 &&
    Object.keys(draft.restoredPermissions).length === 0 &&
    Object.keys(draft.groupExpirations).length === 0 &&
    Object.keys(draft.permissionExpirations).length === 0 &&
    Object.keys(draft.clearedPermissionExpirations).length === 0 &&
    draft.unknownExpiration === undefined
  );
}

function hasPermissionDraftPermissionChange({
  context,
  draft,
  permissionName,
  selected,
  grant,
}: {
  readonly context: PermissionDraftContext;
  readonly draft: PermissionDraftIntent;
  readonly permissionName: string;
  readonly selected: UserPermissionGrantExpiresIn | undefined;
  readonly grant: PlatformUserPermissionGrant | undefined;
}): boolean {
  const policy = resolvePermissionDraftPolicy({
    context,
    draft,
    permissionName,
  });
  if (policy !== resolveInitialPermissionPolicy(context, permissionName)) {
    return true;
  }
  if (selected === undefined || policy !== "allow") {
    return false;
  }
  if (grant?.action === "allow") {
    return selected !== "always" || Boolean(grant.expiresAt);
  }
  return selected !== "always";
}

function hasPermissionDraftUnknownChange({
  context,
  draft,
  selected,
  grant,
}: {
  readonly context: PermissionDraftContext;
  readonly draft: PermissionDraftIntent;
  readonly selected: UserPermissionGrantExpiresIn | undefined;
  readonly grant: PlatformUserPermissionGrant | undefined;
}): boolean {
  const policy = resolvePermissionDraftUnknownPolicy({ context, draft });
  if (policy !== context.initialResolver.unknown()) {
    return true;
  }
  if (selected === undefined || policy !== "allow") {
    return false;
  }
  if (grant?.action === "allow") {
    return selected !== "always" || Boolean(grant.expiresAt);
  }
  return selected !== "always";
}

function hasPermissionDraftGroupChange({
  context,
  draft,
  permissions,
  explicitGrants,
}: {
  readonly context: PermissionDraftContext;
  readonly draft: PermissionDraftIntent;
  readonly permissions: readonly PermissionLike[];
  readonly explicitGrants: ReadonlyMap<string, PlatformUserPermissionGrant>;
}): boolean {
  return permissions.some((permission) => {
    return hasPermissionDraftPermissionChange({
      context,
      draft,
      permissionName: permission.name,
      selected: resolvePermissionDraftExpiration({
        context,
        draft,
        permissionName: permission.name,
      }),
      grant: explicitGrants.get(permission.name),
    });
  });
}

export function hasAnyPermissionDraftChange({
  context,
  draft,
  permissions,
  explicitGrants,
}: {
  readonly context: PermissionDraftContext;
  readonly draft: PermissionDraftIntent;
  readonly permissions: readonly PermissionLike[];
  readonly explicitGrants: ReadonlyMap<string, PlatformUserPermissionGrant>;
}): boolean {
  if (
    hasPermissionDraftUnknownChange({
      context,
      draft,
      selected: draft.unknownExpiration,
      grant: explicitGrants.get(UNKNOWN_PERMISSION_GRANT),
    })
  ) {
    return true;
  }
  return hasPermissionDraftGroupChange({
    context,
    draft,
    permissions,
    explicitGrants,
  });
}

export function hasPermissionDraftDefaultDifference({
  context,
  draft,
  permissions,
}: {
  readonly context: PermissionDraftContext;
  readonly draft: PermissionDraftIntent;
  readonly permissions: readonly PermissionLike[];
}): boolean {
  if (
    resolvePermissionDraftUnknownPolicy({ context, draft }) !==
    context.defaultResolver.unknown()
  ) {
    return true;
  }
  return permissions.some((permission) => {
    return (
      resolvePermissionDraftPolicy({
        context,
        draft,
        permissionName: permission.name,
      }) !== context.defaultResolver.permission(permission.name)
    );
  });
}

export function hasPermissionDraftResetPersistedEffect({
  context,
  draft,
  permissions,
  explicitGrants,
}: {
  readonly context: PermissionDraftContext;
  readonly draft: PermissionDraftIntent;
  readonly permissions: readonly PermissionLike[];
  readonly explicitGrants: ReadonlyMap<string, PlatformUserPermissionGrant>;
}): boolean {
  if (!draft.resetPending) {
    return false;
  }
  const currentFingerprints: PermissionGrantFingerprint[] = [];
  for (const permission of permissions) {
    const fingerprint = currentPermissionGrantFingerprint({
      permission: permission.name,
      currentPolicy: resolvePermissionDraftPolicy({
        context,
        draft,
        permissionName: permission.name,
      }),
      defaultPolicy: context.defaultResolver.permission(permission.name),
      selected: resolvePermissionDraftExpiration({
        context,
        draft,
        permissionName: permission.name,
      }),
    });
    if (fingerprint) {
      currentFingerprints.push(fingerprint);
    }
  }
  const unknownFingerprint = currentPermissionGrantFingerprint({
    permission: UNKNOWN_PERMISSION_GRANT,
    currentPolicy: resolvePermissionDraftUnknownPolicy({ context, draft }),
    defaultPolicy: context.defaultResolver.unknown(),
    selected: draft.unknownExpiration,
  });
  if (unknownFingerprint) {
    currentFingerprints.push(unknownFingerprint);
  }
  return !permissionGrantFingerprintsEqual(
    explicitGrantFingerprints(explicitGrants),
    currentFingerprints.sort(comparePermissionGrantFingerprints),
  );
}

export function materializePermissionDraftForLegacySave({
  context,
  draft,
  permissions,
}: {
  readonly context: PermissionDraftContext;
  readonly draft: PermissionDraftIntent;
  readonly permissions: readonly PermissionLike[];
}): {
  readonly policies: FirewallPolicies;
  readonly expiresInByPermission: Readonly<
    Record<string, UserPermissionGrantExpiresIn>
  >;
} {
  const connectorPolicies: Record<string, FirewallPolicyValue> = {};
  const expiresInByPermission: Record<string, UserPermissionGrantExpiresIn> =
    {};
  for (const permission of permissions) {
    const policy = resolvePermissionDraftPolicy({
      context,
      draft,
      permissionName: permission.name,
    });
    connectorPolicies[permission.name] = policy;
    const expiresIn = resolvePermissionDraftExpiration({
      context,
      draft,
      permissionName: permission.name,
    });
    if (policy === "allow" && expiresIn !== undefined) {
      expiresInByPermission[permission.name] = expiresIn;
    }
  }
  const unknownPolicy = resolvePermissionDraftUnknownPolicy({ context, draft });
  if (unknownPolicy === "allow" && draft.unknownExpiration !== undefined) {
    expiresInByPermission[UNKNOWN_PERMISSION_GRANT] = draft.unknownExpiration;
  }

  return {
    policies: {
      [context.metadata.connectorSlug]: {
        policies: connectorPolicies,
        unknownPolicy,
      },
    },
    expiresInByPermission,
  };
}
