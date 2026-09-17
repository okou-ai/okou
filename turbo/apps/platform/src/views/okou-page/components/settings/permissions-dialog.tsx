// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Computed } from "ccstate";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetFooter,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Button,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  Input,
} from "@okouai/ui";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { PublicConnectorCatalogIcon } from "@okouai/api-contracts/contracts/connector-catalog";
import { groupFirewallMetadataPermissionsByCategory } from "@okouai/connectors/firewall-metadata/policy";
import {
  UNKNOWN_PERMISSION_GRANT,
  type FirewallPolicies,
  type FirewallPolicyValue,
} from "@okouai/connectors/firewall-contracts";
import type { UserPermissionGrantExpiresIn } from "@okouai/api-contracts/contracts/user-permission-grants";
import type {
  PlatformConnectorPermissionMetadata,
  PlatformUserPermissionGrant,
} from "../../../../signals/connector-domain.ts";
import { ConnectorIcon } from "./connector-icons.tsx";
import {
  clearPermissionDraftInheritedExpiration,
  createPermissionDraftContext,
  explicitGrantStateKey,
  hasAnyPermissionDraftChange,
  hasPermissionDraftDefaultDifference,
  hasPermissionDraftResetPersistedEffect,
  isPermissionDraftPristine,
  permissionDraftInitialPolicyKey,
  permissionDraftMetadataKey,
  resolvePermissionDraftExpiration,
  resolvePermissionDraftGroupConfiguration,
  resolvePermissionDraftListPolicy,
  resolvePermissionDraftPolicy,
  resolvePermissionDraftUnknownPolicy,
  setPermissionDraftConnectorPolicy,
  setPermissionDraftExpiration,
  setPermissionDraftGroupAllowExpiration,
  setPermissionDraftGroupAllowPolicy,
  setPermissionDraftGroupPolicy,
  setPermissionDraftPolicy,
  setPermissionDraftUnknownExpiration,
  setPermissionDraftUnknownPolicy,
  stagePermissionDraftConnectorRestore,
  type PermissionDraftContext,
  type PermissionDraftIntent,
} from "../../../../signals/okou-page/settings/permission-draft-intent.ts";
import { permissionGrantExpiryText } from "../../../../signals/permission-allow/permission-grant-expiration.ts";
import {
  applyPermissionDrawer$,
  permissionDrawerUiState$,
  permissionDrawerUiStateForKey,
  resetPermissionDrawerState$,
  setPermissionDrawerScrolled$,
  setPermissionDrawerSearch$,
  showMorePermissionDrawerRows$,
  togglePermissionDrawerGroup$,
  updatePermissionDrawerDraft$,
} from "../../../../signals/okou-page/settings/permissions-dialog.ts";
import type { PermissionPolicy } from "../../../../signals/okou-page/settings/permissions.ts";
import {
  Check,
  Ban,
  ChevronRight,
  Clock,
  ChevronDown,
  Loader2,
  Search,
  X,
} from "lucide-react";
import {
  PermissionPolicyMixedBadge,
  PermissionPolicyToggle,
} from "./permission-policy-toggle.tsx";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { i18n } from "../../../../i18n/index.ts";
import { IconTooltipButton } from "../../../components/icon-tooltip.tsx";

interface ConnectorPermission {
  name: string;
  description?: string;
}

interface PermissionsDrawerProps {
  agentId: string;
  connectorSlug: ConnectorSlug;
  connectorLabel: string;
  metadata$: Computed<Promise<PlatformConnectorPermissionMetadata | null>>;
  displayName: string;
  initialPolicies: FirewallPolicies;
  initialGrants: readonly PlatformUserPermissionGrant[];
  readOnly?: boolean;
  onApply: (
    intent: PermissionDraftIntent,
    options: PermissionDrawerApplyOptions,
  ) => Promise<void>;
  onClose: () => void;
}

interface PermissionDrawerApplyOptions {
  readonly metadata: PlatformConnectorPermissionMetadata;
}

type PermissionsSurface = "sheet" | "dialog";

interface PermissionsDrawerFooterProps {
  readonly surface: PermissionsSurface;
  readonly readOnly?: boolean;
  readonly resetAvailable: boolean;
  readonly saving: boolean;
  readonly canApply: boolean;
  readonly onReset: () => void;
  readonly onClose: () => void;
  readonly onApply: () => void;
}

interface InitialPermissionDrawerState {
  readonly explicitGrants: Map<string, PlatformUserPermissionGrant>;
  readonly initialPolicyKey: string;
}

type LoadedPermissionsDrawerContentProps = Pick<
  PermissionsDrawerProps,
  "initialPolicies" | "readOnly" | "onApply" | "onClose"
> & {
  readonly surface: PermissionsSurface;
  readonly metadata: PlatformConnectorPermissionMetadata;
  readonly initialState: InitialPermissionDrawerState;
};

function buildInitialPermissionDrawerState({
  agentId,
  connectorSlug,
  metadata,
  initialPolicies,
  initialGrants,
}: Pick<
  PermissionsDrawerProps,
  "agentId" | "connectorSlug" | "initialPolicies" | "initialGrants"
> & {
  readonly metadata: PlatformConnectorPermissionMetadata;
}): InitialPermissionDrawerState {
  const explicitGrants = buildExplicitGrantMap(connectorSlug, initialGrants);
  const grantStateKey = explicitGrantStateKey(explicitGrants);
  const context = createPermissionDraftContext({ metadata, initialPolicies });
  const initialPolicyStateKey = permissionDraftInitialPolicyKey(context);
  return {
    explicitGrants,
    initialPolicyKey: `${agentId}\u0000${connectorSlug}\u0000${permissionDraftMetadataKey(metadata)}\u0000${initialPolicyStateKey}\u0000${grantStateKey}`,
  };
}

function PermissionsDrawerHeader({
  icon,
  connectorLabel,
  displayName,
  surface,
}: Pick<PermissionsDrawerProps, "connectorLabel" | "displayName"> & {
  readonly icon: PublicConnectorCatalogIcon | undefined;
  readonly surface: PermissionsSurface;
}) {
  const { t } = useTranslation();
  const title = (
    <>
      {t(
        ($) => {
          return $.connectors.permissions.title;
        },
        { connector: connectorLabel },
      )}
      <span className="text-sm font-normal text-muted-foreground ml-1">
        {t(
          ($) => {
            return $.connectors.permissions.forTarget;
          },
          { target: displayName },
        )}
      </span>
    </>
  );
  const description = t(($) => {
    return $.connectors.permissions.descriptionAgent;
  });

  if (surface === "dialog") {
    return (
      <DialogHeader>
        <div className="flex items-center gap-3">
          <ConnectorIcon icon={icon} size={24} />
          <DialogTitle className="text-base">{title}</DialogTitle>
        </div>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
    );
  }

  return (
    <SheetHeader>
      <div className="flex items-center gap-3">
        <ConnectorIcon icon={icon} size={24} />
        <SheetTitle className="text-base">{title}</SheetTitle>
      </div>
      <SheetDescription>{description}</SheetDescription>
    </SheetHeader>
  );
}

function sortPermissions(
  perms: readonly ConnectorPermission[],
): ConnectorPermission[] {
  return [...perms].sort((a, b) => {
    const [aBase, aSuffix] = splitPermName(a.name);
    const [bBase, bSuffix] = splitPermName(b.name);
    const baseCmp = aBase.localeCompare(bBase);
    if (baseCmp !== 0) {
      return baseCmp;
    }
    if (aSuffix === "read" && bSuffix !== "read") {
      return -1;
    }
    if (bSuffix === "read" && aSuffix !== "read") {
      return 1;
    }
    return aSuffix.localeCompare(bSuffix);
  });
}

function splitPermName(name: string): [string, string] {
  const colonIdx = name.lastIndexOf(":");
  if (colonIdx > 0) {
    return [name.slice(0, colonIdx), name.slice(colonIdx + 1)];
  }
  const underIdx = name.lastIndexOf("_");
  if (underIdx > 0) {
    return [name.slice(0, underIdx), name.slice(underIdx + 1)];
  }
  return [name, ""];
}

const POLICY_OPTIONS = ["allow", "deny"] as const;

const PERMISSION_PAGE_SIZE = 100;

function getGroupPolicy(
  context: PermissionDraftContext,
  draft: PermissionDraftIntent,
  perms: ConnectorPermission[],
): PermissionPolicy | "mixed" {
  return resolvePermissionDraftListPolicy({
    context,
    draft,
    permissions: perms,
  });
}

function PolicyPill({
  policy,
  onChange,
  disabled,
}: {
  policy: FirewallPolicyValue | "mixed";
  onChange?: (p: PermissionPolicy) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex shrink-0 rounded-md overflow-hidden text-xs font-medium border border-surface-border">
      {POLICY_OPTIONS.map((option, idx) => {
        return (
          <button
            key={option}
            type="button"
            disabled={disabled}
            aria-pressed={policy === option}
            style={
              idx > 0
                ? {
                    borderLeft:
                      "var(--border-width-surface) solid hsl(var(--gray-400))",
                  }
                : undefined
            }
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onChange?.(option);
            }}
            className={`flex items-center gap-1 px-2.5 py-1.5 transition-colors ${
              policy === option
                ? option === "allow"
                  ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                  : "bg-rose-500/10 text-rose-700 dark:text-rose-400"
                : disabled
                  ? "text-muted-foreground/50"
                  : "text-muted-foreground hover:text-foreground hover:bg-state-hover"
            } ${disabled ? "cursor-default" : "cursor-pointer"}`}
          >
            {option === "allow" && <Check size={12} />}
            {option === "deny" && <Ban size={12} />}
            {option === "allow"
              ? t(($) => {
                  return $.connectors.permissions.actions.allow;
                })
              : t(($) => {
                  return $.connectors.permissions.actions.deny;
                })}
          </button>
        );
      })}
    </span>
  );
}

function buildSortedGroups(
  metadata: PlatformConnectorPermissionMetadata,
): { category: string; permissions: ConnectorPermission[] }[] | null {
  return (
    groupFirewallMetadataPermissionsByCategory(
      metadata.permissions,
      metadata,
    )?.map((group) => {
      return { ...group, permissions: sortPermissions(group.permissions) };
    }) ?? null
  );
}

function sortedPermissionsForMetadata(
  metadata: PlatformConnectorPermissionMetadata,
): ConnectorPermission[] {
  return sortPermissions(metadata.permissions);
}

function filterPermissionsForSearch(
  permissions: ConnectorPermission[],
  normalizedSearch: string,
): ConnectorPermission[] {
  if (normalizedSearch.length === 0) {
    return permissions;
  }
  return permissions.filter((permission) => {
    return (
      permission.name.toLowerCase().includes(normalizedSearch) ||
      (permission.description?.toLowerCase().includes(normalizedSearch) ??
        false)
    );
  });
}

function buildExplicitGrantMap(
  connectorSlug: string,
  grants: readonly PlatformUserPermissionGrant[],
): Map<string, PlatformUserPermissionGrant> {
  const result = new Map<string, PlatformUserPermissionGrant>();
  for (const grant of grants) {
    if (grant.connectorSlug === connectorSlug) {
      result.set(grant.permission, grant);
    }
  }
  return result;
}

function hasDraftExpirationSelections({
  context,
  draft,
  permissions,
}: {
  readonly context: PermissionDraftContext;
  readonly draft: PermissionDraftIntent;
  readonly permissions: readonly ConnectorPermission[];
}): boolean {
  if (draft.unknownExpiration !== undefined) {
    return true;
  }
  for (const permission of permissions) {
    if (
      resolvePermissionDraftExpiration({
        context,
        draft,
        permissionName: permission.name,
      }) !== undefined
    ) {
      return true;
    }
  }
  return false;
}

function canApplyPermissionPolicies({
  metadata,
  saving,
  hasChanges,
}: {
  metadata: PlatformConnectorPermissionMetadata;
  saving: boolean;
  hasChanges: boolean;
}): boolean {
  return metadata.permissionCount > 0 && !saving && hasChanges;
}

function UnknownEndpointsToggle({
  policyControl,
}: {
  policyControl: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="border-t border-border/40 -mx-6 px-3 pt-3 pb-1">
      <div className="flex items-center justify-between px-3">
        <div className="min-w-0 flex-1">
          <span className="text-xs font-medium text-foreground">
            {t(($) => {
              return $.connectors.permissions.otherEndpoints;
            })}
          </span>
          <p className="mt-0.5 text-xs text-muted-foreground leading-relaxed">
            {t(($) => {
              return $.connectors.permissions.otherEndpointsDescription;
            })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">{policyControl}</div>
      </div>
    </div>
  );
}

function permissionDurationLabel({
  expiresAt,
  selected,
}: {
  expiresAt: string | null;
  selected: UserPermissionGrantExpiresIn | undefined;
}): string {
  return (
    allowDurationStatusLabel(selected) ??
    compactGrantExpirationText(expiresAt) ??
    i18n.t(($) => {
      return $.connectors.permissions.always;
    })
  );
}

const ALLOW_DURATION_MENU_OPTIONS: readonly UserPermissionGrantExpiresIn[] = [
  "1h",
  "24h",
  "7d",
  "always",
];

function compactGrantExpirationText(expiresAt: string | null): string | null {
  const text = permissionGrantExpiryText(expiresAt);
  if (
    text ===
    i18n.t(($) => {
      return $.authorization.permission.expiration.lessThanHour;
    })
  ) {
    return i18n.t(($) => {
      return $.authorization.permission.expiration.lessThanHourShort;
    });
  }
  return (
    text?.replace(
      i18n.t(($) => {
        return $.authorization.permission.expiration.prefix;
      }),
      "",
    ) ?? null
  );
}

function allowDurationStatusLabel(
  selected: UserPermissionGrantExpiresIn | undefined,
): string | null {
  const option = ALLOW_DURATION_MENU_OPTIONS.find((item) => {
    return item === selected;
  });
  if (!option) {
    return null;
  }
  return option === "always"
    ? i18n.t(($) => {
        return $.connectors.permissions.always;
      })
    : option;
}

function allowDurationMenuLabel(option: UserPermissionGrantExpiresIn): string {
  switch (option) {
    case "1h": {
      return i18n.t(($) => {
        return $.connectors.permissions.allowDuration.oneHour;
      });
    }
    case "24h": {
      return i18n.t(($) => {
        return $.connectors.permissions.allowDuration.twentyFourHours;
      });
    }
    case "7d": {
      return i18n.t(($) => {
        return $.connectors.permissions.allowDuration.sevenDays;
      });
    }
    case "always": {
      return i18n.t(($) => {
        return $.connectors.permissions.allowDuration.always;
      });
    }
  }
}

function MenuItemCheck({ active }: { active: boolean }) {
  return active ? (
    <Check size={14} />
  ) : (
    <span className="h-3.5 w-3.5 shrink-0" />
  );
}

function menuOptionExpiresIn(
  value: UserPermissionGrantExpiresIn,
  allowGrant: PlatformUserPermissionGrant | undefined,
): UserPermissionGrantExpiresIn | null {
  if (value === "always" && !allowGrant?.expiresAt) {
    return null;
  }
  return value;
}

function isDurationMenuOptionActive({
  allowAlwaysActive,
  selected,
  value,
}: {
  allowAlwaysActive: boolean;
  selected: UserPermissionGrantExpiresIn | undefined;
  value: UserPermissionGrantExpiresIn;
}): boolean {
  if (selected !== undefined) {
    return selected === value;
  }
  return value === "always" && allowAlwaysActive;
}

function PermissionAllowDurationDropdown({
  permission,
  label,
  selected,
  allowAlwaysActive,
  saving,
  onSelect,
}: {
  permission: string;
  label: string;
  selected: UserPermissionGrantExpiresIn | undefined;
  allowAlwaysActive: boolean;
  saving: boolean;
  onSelect: (expiresIn: UserPermissionGrantExpiresIn) => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={saving}
          aria-label={t(
            ($) => {
              return $.connectors.permissions.allowOptions;
            },
            { permission },
          )}
          className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-[11px] font-medium border-surface-border transition-colors ${
            saving
              ? "cursor-default text-muted-foreground/50"
              : "cursor-pointer text-muted-foreground hover:bg-state-hover hover:text-foreground"
          }`}
        >
          <Clock size={12} className="shrink-0" />
          <span className="max-w-[90px] truncate">{label}</span>
          <ChevronDown size={12} className="shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-40" finalFocus={false}>
        {ALLOW_DURATION_MENU_OPTIONS.map((option) => {
          return (
            <DropdownMenuItem
              key={option}
              onSelect={() => {
                onSelect(option);
              }}
              className="flex items-center justify-between gap-4"
            >
              {allowDurationMenuLabel(option)}
              <MenuItemCheck
                active={isDurationMenuOptionActive({
                  allowAlwaysActive,
                  selected,
                  value: option,
                })}
              />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PermissionAllowDurationStatic({ label }: { label: string }) {
  return (
    <span className="inline-flex h-6 max-w-[150px] shrink-0 items-center gap-1.5 rounded-md border border-surface-border bg-muted/40 px-2 text-[11px] font-medium text-muted-foreground">
      <Clock size={12} className="shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}

function PermissionGrantPolicyControl({
  permission,
  policy,
  grant,
  selected,
  allowAlwaysActive,
  allowDurationMixed = false,
  expirationStatusExpiresAt,
  readOnly,
  saving,
  showCurrentExpirationStatus = true,
  onAllowClick,
  onClearExpiration,
  onAllowDurationChange,
  onPolicyChange,
}: {
  permission: string;
  policy: FirewallPolicyValue | "mixed";
  grant: PlatformUserPermissionGrant | undefined;
  selected: UserPermissionGrantExpiresIn | undefined;
  allowAlwaysActive: boolean;
  allowDurationMixed?: boolean;
  expirationStatusExpiresAt?: string | null;
  readOnly?: boolean;
  saving: boolean;
  showCurrentExpirationStatus?: boolean;
  onAllowClick?: () => void;
  onClearExpiration: () => void;
  onAllowDurationChange: (expiresIn: UserPermissionGrantExpiresIn) => void;
  onPolicyChange: (policy: PermissionPolicy) => void;
}) {
  const allowGrant = grant?.action === "allow" ? grant : undefined;
  const showExpirationStatus =
    showCurrentExpirationStatus && policy === "allow";
  const expirationStatusValue =
    expirationStatusExpiresAt ?? allowGrant?.expiresAt ?? null;
  const showSplitPolicy = !readOnly;
  const durationLabel = allowDurationMixed
    ? "Mixed"
    : permissionDurationLabel({
        expiresAt: expirationStatusValue,
        selected,
      });

  return (
    <div className="flex shrink-0 items-center gap-2">
      {!showSplitPolicy ? (
        <>
          {showExpirationStatus && (
            <PermissionAllowDurationStatic label={durationLabel} />
          )}
          <PolicyPill
            policy={policy}
            disabled={readOnly}
            onChange={(nextPolicy) => {
              onPolicyChange(nextPolicy);
            }}
          />
        </>
      ) : (
        <>
          {policy === "allow" &&
            (allowDurationMixed ? (
              <PermissionAllowDurationStatic label={durationLabel} />
            ) : (
              <PermissionAllowDurationDropdown
                permission={permission}
                label={durationLabel}
                selected={selected}
                allowAlwaysActive={allowAlwaysActive}
                saving={saving}
                onSelect={(expiresIn) => {
                  onAllowDurationChange(expiresIn);
                }}
              />
            ))}
          {policy === "mixed" && <PermissionPolicyMixedBadge />}
          <PermissionPolicyToggle
            policy={policy}
            disabled={saving}
            onAllow={() => {
              if (onAllowClick) {
                onAllowClick();
                return;
              }
              onPolicyChange("allow");
            }}
            onDeny={() => {
              onPolicyChange("deny");
              onClearExpiration();
            }}
          />
        </>
      )}
    </div>
  );
}

function hasAllowAlwaysPolicy(
  grant: PlatformUserPermissionGrant | undefined,
  policy: FirewallPolicyValue,
): boolean {
  return policy === "allow" && !(grant?.action === "allow" && grant.expiresAt);
}

function ShowMorePermissions({
  remaining,
  onClick,
}: {
  readonly remaining: number;
  readonly onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="px-3 py-2">
      <Button type="button" variant="outline" className="h-8" onClick={onClick}>
        {t(
          ($) => {
            return $.connectors.permissions.showMore;
          },
          { count: remaining },
        )}
      </Button>
    </div>
  );
}

function PermissionGroupHeader({
  context,
  draft,
  category,
  permissions,
  explicitGrants,
  expanded,
  readOnly,
  saving,
  onToggle,
  onGroupAllow,
  onGroupDeny,
  onGroupAllowDuration,
}: {
  context: PermissionDraftContext;
  draft: PermissionDraftIntent;
  category: string;
  permissions: ConnectorPermission[];
  explicitGrants: ReadonlyMap<string, PlatformUserPermissionGrant>;
  expanded: boolean;
  readOnly?: boolean;
  saving: boolean;
  onToggle: () => void;
  onGroupAllow: () => void;
  onGroupDeny: () => void;
  onGroupAllowDuration: (expiresIn: UserPermissionGrantExpiresIn) => void;
}) {
  const configuration = resolvePermissionDraftGroupConfiguration({
    context,
    draft,
    permissions,
    explicitGrants,
  });
  const expiration =
    configuration.policy === "allow" ? configuration.expiration : undefined;
  const selected =
    expiration?.kind === "selected" ? expiration.expiresIn : undefined;
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-1.5 text-xs font-medium text-foreground hover:text-foreground/80 transition-colors"
      >
        <ChevronRight
          size={14}
          className={`transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        {category} ({permissions.length})
      </button>
      {!readOnly && (
        <div className="ml-auto">
          <PermissionGrantPolicyControl
            permission={category}
            policy={configuration.policy}
            grant={undefined}
            selected={selected}
            allowAlwaysActive={expiration?.kind === "always"}
            allowDurationMixed={expiration?.kind === "mixed"}
            expirationStatusExpiresAt={
              expiration?.kind === "persisted"
                ? expiration.expiresAt
                : undefined
            }
            showCurrentExpirationStatus={false}
            saving={saving}
            onAllowClick={onGroupAllow}
            onClearExpiration={() => {
              // Denying a group already clears its own expiration.
            }}
            onAllowDurationChange={onGroupAllowDuration}
            onPolicyChange={(nextPolicy) => {
              if (nextPolicy === "deny") {
                onGroupDeny();
                return;
              }
              onGroupAllow();
            }}
          />
        </div>
      )}
    </div>
  );
}

function PermissionRows({
  context,
  draft,
  groups,
  permissions,
  expandedGroups,
  visibleCounts,
  explicitGrants,
  readOnly,
  saving,
  onToggleGroup,
  onGroupAllow,
  onGroupDeny,
  onGroupAllowDuration,
  onPolicyChange,
  onGrantExpirationChange,
  onClearInheritedExpiration,
  onShowMore,
}: {
  context: PermissionDraftContext;
  draft: PermissionDraftIntent;
  groups: { category: string; permissions: ConnectorPermission[] }[] | null;
  permissions: ConnectorPermission[];
  expandedGroups: ReadonlySet<string>;
  visibleCounts: Readonly<Record<string, number>>;
  explicitGrants: Map<string, PlatformUserPermissionGrant>;
  readOnly?: boolean;
  saving: boolean;
  onToggleGroup: (category: string) => void;
  onGroupAllow: (category: string, permissions: ConnectorPermission[]) => void;
  onGroupDeny: (category: string, permissions: ConnectorPermission[]) => void;
  onGroupAllowDuration: (
    category: string,
    permissions: ConnectorPermission[],
    expiresIn: UserPermissionGrantExpiresIn,
  ) => void;
  onPolicyChange: (name: string, policy: PermissionPolicy) => void;
  onGrantExpirationChange: (
    permission: string,
    expiresIn: UserPermissionGrantExpiresIn | null,
  ) => void;
  onClearInheritedExpiration: (permission: string) => void;
  onShowMore: (key: string) => void;
}) {
  if (groups) {
    return groups.map((group, groupIdx) => {
      const expanded = expandedGroups.has(group.category);
      const groupListKey = `group:${group.category}`;
      const groupVisibleCount =
        visibleCounts[groupListKey] ?? PERMISSION_PAGE_SIZE;
      const visiblePermissions = group.permissions.slice(0, groupVisibleCount);
      const hasMore = visiblePermissions.length < group.permissions.length;
      return (
        <div key={group.category}>
          {groupIdx > 0 && (
            <div className="mx-3 border-t border-border/40 my-1" />
          )}
          <PermissionGroupHeader
            context={context}
            draft={draft}
            category={group.category}
            permissions={group.permissions}
            explicitGrants={explicitGrants}
            expanded={expanded}
            readOnly={readOnly}
            saving={saving}
            onToggle={() => {
              onToggleGroup(group.category);
            }}
            onGroupAllow={() => {
              onGroupAllow(group.category, group.permissions);
            }}
            onGroupDeny={() => {
              onGroupDeny(group.category, group.permissions);
            }}
            onGroupAllowDuration={(expiresIn) => {
              onGroupAllowDuration(
                group.category,
                group.permissions,
                expiresIn,
              );
            }}
          />
          {expanded &&
            visiblePermissions.map((perm, idx) => {
              return (
                <PermissionRow
                  key={perm.name}
                  context={context}
                  draft={draft}
                  permission={perm}
                  showSeparator={idx > 0}
                  indent
                  explicitGrants={explicitGrants}
                  readOnly={readOnly}
                  saving={saving}
                  onPolicyChange={onPolicyChange}
                  onGrantExpirationChange={onGrantExpirationChange}
                  onClearInheritedExpiration={onClearInheritedExpiration}
                />
              );
            })}
          {expanded && hasMore && (
            <ShowMorePermissions
              remaining={group.permissions.length - visiblePermissions.length}
              onClick={() => {
                onShowMore(groupListKey);
              }}
            />
          )}
        </div>
      );
    });
  }

  const visibleCount = visibleCounts.permissions ?? PERMISSION_PAGE_SIZE;
  const visiblePermissions = permissions.slice(0, visibleCount);
  return (
    <>
      {visiblePermissions.map((perm, idx) => {
        return (
          <PermissionRow
            key={perm.name}
            context={context}
            draft={draft}
            permission={perm}
            showSeparator={idx > 0}
            explicitGrants={explicitGrants}
            readOnly={readOnly}
            saving={saving}
            onPolicyChange={onPolicyChange}
            onGrantExpirationChange={onGrantExpirationChange}
            onClearInheritedExpiration={onClearInheritedExpiration}
          />
        );
      })}
      {visiblePermissions.length < permissions.length && (
        <ShowMorePermissions
          remaining={permissions.length - visiblePermissions.length}
          onClick={() => {
            onShowMore("permissions");
          }}
        />
      )}
    </>
  );
}

function PermissionRow({
  context,
  draft,
  permission,
  showSeparator,
  indent,
  explicitGrants,
  readOnly,
  saving,
  onPolicyChange,
  onGrantExpirationChange,
  onClearInheritedExpiration,
}: {
  context: PermissionDraftContext;
  draft: PermissionDraftIntent;
  permission: ConnectorPermission;
  showSeparator: boolean;
  indent?: boolean;
  explicitGrants: Map<string, PlatformUserPermissionGrant>;
  readOnly?: boolean;
  saving: boolean;
  onPolicyChange: (name: string, policy: PermissionPolicy) => void;
  onGrantExpirationChange: (
    permission: string,
    expiresIn: UserPermissionGrantExpiresIn | null,
  ) => void;
  onClearInheritedExpiration: (permission: string) => void;
}) {
  const policy = resolvePermissionDraftPolicy({
    context,
    draft,
    permissionName: permission.name,
  });
  const grant = explicitGrants.get(permission.name);
  const selected = resolvePermissionDraftExpiration({
    context,
    draft,
    permissionName: permission.name,
  });
  const category = context.metadata.categories?.categories[permission.name];
  const hasGroupExpiration =
    category !== undefined && draft.groupExpirations[category] !== undefined;
  const allowGrant = grant?.action === "allow" ? grant : undefined;
  return (
    <div>
      {showSeparator && <div className="mx-3 border-t border-border/40" />}
      <div
        className={`flex items-center gap-2.5 px-3 py-2.5 rounded-md hover:bg-state-hover transition-colors ${indent ? "pl-8" : ""}`}
      >
        <div className="min-w-0 flex-1">
          <code className="block whitespace-normal break-words text-xs font-medium text-foreground [overflow-wrap:anywhere]">
            {permission.name}
          </code>
          {permission.description && (
            <p className="mt-0.5 text-xs text-muted-foreground leading-relaxed">
              {permission.description}
            </p>
          )}
        </div>
        <PermissionGrantPolicyControl
          permission={permission.name}
          policy={policy}
          grant={grant}
          selected={selected}
          allowAlwaysActive={hasAllowAlwaysPolicy(grant, policy)}
          readOnly={readOnly}
          saving={saving}
          onAllowClick={() => {
            onPolicyChange(permission.name, "allow");
          }}
          onClearExpiration={() => {
            if (hasGroupExpiration) {
              onClearInheritedExpiration(permission.name);
              return;
            }
            onGrantExpirationChange(permission.name, null);
          }}
          onAllowDurationChange={(expiresIn) => {
            const nextExpiresIn = menuOptionExpiresIn(expiresIn, allowGrant);
            if (
              expiresIn === "always" &&
              nextExpiresIn === null &&
              hasGroupExpiration
            ) {
              onClearInheritedExpiration(permission.name);
              return;
            }
            onGrantExpirationChange(permission.name, nextExpiresIn);
          }}
          onPolicyChange={(p) => {
            onPolicyChange(permission.name, p);
          }}
        />
      </div>
    </div>
  );
}

function PermissionsFooterShell({
  surface,
  className,
  children,
}: {
  readonly surface: PermissionsSurface;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  if (surface === "dialog") {
    return <DialogFooter className={className}>{children}</DialogFooter>;
  }
  return <SheetFooter className={className}>{children}</SheetFooter>;
}

function PermissionsDrawerFooter({
  surface,
  readOnly,
  resetAvailable,
  saving,
  canApply,
  onReset,
  onClose,
  onApply,
}: PermissionsDrawerFooterProps) {
  const { t } = useTranslation();

  if (readOnly) {
    return (
      <PermissionsFooterShell surface={surface}>
        <Button variant="outline" onClick={onClose}>
          {t(($) => {
            return $.connectors.actions.close;
          })}
        </Button>
      </PermissionsFooterShell>
    );
  }

  return (
    <PermissionsFooterShell
      surface={surface}
      className="gap-2 sm:justify-between sm:space-x-0"
    >
      <div>
        <Button
          variant="outline"
          onClick={onReset}
          disabled={saving || !resetAvailable}
        >
          {t(($) => {
            return $.connectors.permissions.restore;
          })}
        </Button>
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={onClose}>
          {t(($) => {
            return $.connectors.actions.cancel;
          })}
        </Button>
        <Button onClick={onApply} disabled={!canApply}>
          {saving
            ? t(($) => {
                return $.connectors.actions.saving;
              })
            : t(($) => {
                return $.connectors.actions.apply;
              })}
        </Button>
      </div>
    </PermissionsFooterShell>
  );
}

function LoadedPermissionsDrawerContent({
  initialPolicies,
  readOnly,
  onApply,
  onClose,
  surface,
  metadata,
  initialState,
}: LoadedPermissionsDrawerContentProps) {
  const { t } = useTranslation();
  const { explicitGrants, initialPolicyKey: stateKey } = initialState;
  const drawerUiState = permissionDrawerUiStateForKey(
    useGet(permissionDrawerUiState$),
    stateKey,
  );
  const setDraft = useSet(updatePermissionDrawerDraft$);
  const toggleGroup = useSet(togglePermissionDrawerGroup$);
  const showMore = useSet(showMorePermissionDrawerRows$);
  const setSearch = useSet(setPermissionDrawerSearch$);
  const setScrolled = useSet(setPermissionDrawerScrolled$);
  const resetPermissionDrawerState = useSet(resetPermissionDrawerState$);
  const [applyLoadable, applyDrawer] = useLoadableSet(applyPermissionDrawer$);
  const pageSignal = useGet(pageSignal$);
  const context = createPermissionDraftContext({ metadata, initialPolicies });
  const draft = drawerUiState.draft;
  const scrolled = drawerUiState.scrolled;
  const expandedGroups = drawerUiState.expandedGroups;
  const visibleCounts = drawerUiState.visibleCounts;
  const search = drawerUiState.search;
  const saving = applyLoadable.state === "loading";

  const effectiveExplicitGrants = draft.resetPending
    ? new Map<string, PlatformUserPermissionGrant>()
    : explicitGrants;
  const permissions = sortedPermissionsForMetadata(metadata);
  const groups = buildSortedGroups(metadata);
  const normalizedSearch = search.trim().toLowerCase();
  const searchActive = normalizedSearch.length > 0;
  const displayedPermissions = filterPermissionsForSearch(
    permissions,
    normalizedSearch,
  );
  const displayedGroups = searchActive ? null : groups;
  const unknownPolicy = resolvePermissionDraftUnknownPolicy({ context, draft });
  const draftPristine = isPermissionDraftPristine(draft);
  const hasDefaultPolicyChanges =
    !draftPristine &&
    hasPermissionDraftDefaultDifference({
      context,
      draft,
      permissions,
    });
  const hasExpirationDraftSelections = hasDraftExpirationSelections({
    context,
    draft,
    permissions,
  });
  const resetAvailable =
    explicitGrants.size > 0 ||
    hasDefaultPolicyChanges ||
    hasExpirationDraftSelections;
  const hasResetPersistedEffect = hasPermissionDraftResetPersistedEffect({
    context,
    draft,
    permissions,
    explicitGrants,
  });
  const hasPermissionChanges =
    hasResetPersistedEffect ||
    (!draftPristine &&
      hasAnyPermissionDraftChange({
        context,
        draft,
        permissions,
        explicitGrants,
      }));
  const canApply = canApplyPermissionPolicies({
    metadata,
    saving,
    hasChanges: hasPermissionChanges,
  });
  const unknownGrant = effectiveExplicitGrants.get(UNKNOWN_PERMISSION_GRANT);
  const unknownSelectedExpiration = draft.unknownExpiration;

  const handlePolicyChange = (name: string, policy: PermissionPolicy) => {
    setDraft(stateKey, (current) => {
      return setPermissionDraftPolicy({
        draft: current,
        permissionName: name,
        policy,
      });
    });
  };

  const handleSetAll = (policy: PermissionPolicy) => {
    setDraft(stateKey, (current) => {
      return setPermissionDraftConnectorPolicy({
        draft: current,
        policy,
        includeUnknown: true,
      });
    });
  };

  const handleGroupAllow = (
    category: string,
    groupPermissions: ConnectorPermission[],
  ) => {
    setDraft(stateKey, (current) => {
      return setPermissionDraftGroupAllowPolicy({
        draft: current,
        category,
        permissions: groupPermissions,
      });
    });
  };

  const handleGroupDeny = (
    category: string,
    groupPermissions: ConnectorPermission[],
  ) => {
    setDraft(stateKey, (current) => {
      return setPermissionDraftGroupPolicy({
        draft: current,
        category,
        permissions: groupPermissions,
        policy: "deny",
      });
    });
  };

  const handleGroupAllowDuration = (
    category: string,
    groupPermissions: ConnectorPermission[],
    expiresIn: UserPermissionGrantExpiresIn,
  ) => {
    setDraft(stateKey, (current) => {
      return setPermissionDraftGroupAllowExpiration({
        draft: current,
        category,
        permissions: groupPermissions,
        explicitGrants: effectiveExplicitGrants,
        expiresIn,
      });
    });
  };

  const handleResetConnector = () => {
    setDraft(stateKey, (current) => {
      return stagePermissionDraftConnectorRestore({ draft: current });
    });
  };

  const handleClose = () => {
    resetPermissionDrawerState();
    onClose();
  };

  const handleToggleGroup = (category: string) => {
    toggleGroup(stateKey, category);
  };

  const handleGrantExpirationChange = (
    permission: string,
    expiresIn: UserPermissionGrantExpiresIn | null,
  ) => {
    setDraft(stateKey, (current) => {
      return setPermissionDraftExpiration({
        draft: current,
        permissionName: permission,
        expiresIn,
      });
    });
  };

  const handleClearInheritedExpiration = (permission: string) => {
    setDraft(stateKey, (current) => {
      return clearPermissionDraftInheritedExpiration({
        draft: current,
        permissionName: permission,
      });
    });
  };

  const handleUnknownExpirationChange = (
    expiresIn: UserPermissionGrantExpiresIn | null,
  ) => {
    setDraft(stateKey, (current) => {
      return setPermissionDraftUnknownExpiration({
        draft: current,
        expiresIn,
      });
    });
  };

  const handleShowMore = (key: string) => {
    showMore(stateKey, key, PERMISSION_PAGE_SIZE);
  };

  const handleSearchChange = (value: string) => {
    setSearch(stateKey, value);
  };

  const handleApply = () => {
    if (saving) {
      return;
    }
    detach(
      applyDrawer(
        {
          intent: draft,
          metadata,
          onApply,
          onClose: handleClose,
        },
        pageSignal,
      ),
      Reason.DomCallback,
    );
  };

  return (
    <>
      <div className="flex flex-1 flex-col min-h-0">
        <div
          className={`flex flex-col gap-2 pb-3 -mx-6 px-6 transition-shadow ${scrolled ? "shadow-[0_4px_8px_-4px_rgba(0,0,0,0.08)]" : ""}`}
        >
          <div className="relative w-full">
            <Search
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
            />
            <Input
              value={search}
              onChange={(event) => {
                handleSearchChange(event.currentTarget.value);
              }}
              aria-label={t(($) => {
                return $.connectors.permissions.find;
              })}
              placeholder={t(($) => {
                return $.connectors.permissions.findPlaceholder;
              })}
              className="pl-9 pr-9"
            />
            {search && (
              <IconTooltipButton
                type="button"
                onClick={() => {
                  handleSearchChange("");
                }}
                className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground"
                aria-label={t(($) => {
                  return $.connectors.permissions.clearSearch;
                })}
              >
                <X size={13} />
              </IconTooltipButton>
            )}
          </div>
          {!groups && !searchActive && (
            <div className="flex items-center justify-between gap-2 overflow-y-auto [scrollbar-gutter:stable]">
              <span className="text-xs font-medium text-foreground">
                {readOnly
                  ? t(($) => {
                      return $.connectors.permissions.permissions;
                    })
                  : t(($) => {
                      return $.connectors.permissions.selectAll;
                    })}{" "}
                ({permissions.length})
              </span>
              {!readOnly && (
                <PolicyPill
                  policy={getGroupPolicy(context, draft, permissions)}
                  onChange={handleSetAll}
                />
              )}
            </div>
          )}
        </div>

        <div
          className={`flex-1 overflow-y-auto -mx-6 px-3 [scrollbar-gutter:stable] ${displayedGroups ? "pt-1" : ""}`}
          onScroll={(e) => {
            const target = e.currentTarget;
            setScrolled(stateKey, target.scrollTop > 0);
          }}
        >
          {searchActive && displayedPermissions.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">
              {t(
                ($) => {
                  return $.connectors.permissions.noResults;
                },
                { search: search.trim() },
              )}
            </p>
          ) : (
            <PermissionRows
              context={context}
              draft={draft}
              groups={displayedGroups}
              permissions={displayedPermissions}
              expandedGroups={expandedGroups}
              visibleCounts={visibleCounts}
              explicitGrants={effectiveExplicitGrants}
              readOnly={readOnly}
              saving={saving}
              onToggleGroup={handleToggleGroup}
              onGroupAllow={handleGroupAllow}
              onGroupDeny={handleGroupDeny}
              onGroupAllowDuration={handleGroupAllowDuration}
              onPolicyChange={handlePolicyChange}
              onGrantExpirationChange={handleGrantExpirationChange}
              onClearInheritedExpiration={handleClearInheritedExpiration}
              onShowMore={handleShowMore}
            />
          )}
        </div>

        <UnknownEndpointsToggle
          policyControl={
            <PermissionGrantPolicyControl
              permission={UNKNOWN_PERMISSION_GRANT}
              policy={unknownPolicy}
              grant={unknownGrant}
              selected={unknownSelectedExpiration}
              allowAlwaysActive={hasAllowAlwaysPolicy(
                unknownGrant,
                unknownPolicy,
              )}
              readOnly={readOnly}
              saving={saving}
              onAllowClick={() => {
                setDraft(stateKey, (current) => {
                  return setPermissionDraftUnknownPolicy({
                    draft: current,
                    policy: "allow",
                  });
                });
              }}
              onClearExpiration={() => {
                handleUnknownExpirationChange(null);
              }}
              onAllowDurationChange={(expiresIn) => {
                handleUnknownExpirationChange(
                  menuOptionExpiresIn(
                    expiresIn,
                    unknownGrant?.action === "allow" ? unknownGrant : undefined,
                  ),
                );
              }}
              onPolicyChange={(p) => {
                setDraft(stateKey, (current) => {
                  return setPermissionDraftUnknownPolicy({
                    draft: current,
                    policy: p,
                  });
                });
              }}
            />
          }
        />
      </div>

      <PermissionsDrawerFooter
        surface={surface}
        readOnly={readOnly}
        resetAvailable={resetAvailable}
        saving={saving}
        canApply={canApply}
        onReset={handleResetConnector}
        onClose={handleClose}
        onApply={handleApply}
      />
    </>
  );
}

function PermissionsContent({
  props,
  surface,
  onClose,
}: {
  readonly props: PermissionsDrawerProps;
  readonly surface: PermissionsSurface;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const metadataLoadable = useLoadable(props.metadata$);
  const loadedMetadata =
    metadataLoadable.state === "hasData" ? metadataLoadable.data : null;
  const loadedInitialState = loadedMetadata
    ? buildInitialPermissionDrawerState({
        agentId: props.agentId,
        connectorSlug: props.connectorSlug,
        metadata: loadedMetadata,
        initialPolicies: props.initialPolicies,
        initialGrants: props.initialGrants,
      })
    : null;
  const loading = metadataLoadable.state === "loading";
  const message =
    metadataLoadable.state === "hasError"
      ? t(($) => {
          return $.connectors.permissions.loadError;
        })
      : t(
          ($) => {
            return $.connectors.permissions.metadataMissing;
          },
          { connector: props.connectorSlug },
        );

  return (
    <>
      <PermissionsDrawerHeader
        icon={loadedMetadata?.icon}
        connectorLabel={props.connectorLabel}
        displayName={props.displayName}
        surface={surface}
      />

      {loadedMetadata && loadedInitialState ? (
        <LoadedPermissionsDrawerContent
          key={loadedInitialState.initialPolicyKey}
          {...props}
          surface={surface}
          metadata={loadedMetadata}
          initialState={loadedInitialState}
          onClose={onClose}
        />
      ) : (
        <>
          <div className="flex flex-1 items-center justify-center">
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 size={16} className="animate-spin" />
                {t(($) => {
                  return $.connectors.permissions.loading;
                })}
              </div>
            ) : (
              <p className="text-sm text-destructive">{message}</p>
            )}
          </div>

          <PermissionsFooterShell surface={surface}>
            <Button variant="outline" onClick={onClose}>
              {props.readOnly
                ? t(($) => {
                    return $.connectors.actions.close;
                  })
                : t(($) => {
                    return $.connectors.actions.cancel;
                  })}
            </Button>
          </PermissionsFooterShell>
        </>
      )}
    </>
  );
}

export function PermissionsDrawer(props: PermissionsDrawerProps) {
  const resetPermissionDrawerState = useSet(resetPermissionDrawerState$);
  const handleClose = () => {
    resetPermissionDrawerState();
    props.onClose();
  };

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        return !open && handleClose();
      }}
    >
      <SheetContent side="right">
        <PermissionsContent
          props={props}
          surface="sheet"
          onClose={handleClose}
        />
      </SheetContent>
    </Sheet>
  );
}

export function PermissionsDialog(props: PermissionsDrawerProps) {
  const resetPermissionDrawerState = useSet(resetPermissionDrawerState$);
  const handleClose = () => {
    resetPermissionDrawerState();
    props.onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        return !open && handleClose();
      }}
    >
      <DialogContent
        maxWidth={760}
        height={720}
        contentClassName="flex flex-col overflow-hidden"
      >
        <PermissionsContent
          props={props}
          surface="dialog"
          onClose={handleClose}
        />
      </DialogContent>
    </Dialog>
  );
}
