// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import {
  Search,
  ShieldCheck,
  Ellipsis,
  Plus,
  Clock,
  Check,
  X,
  UserPlus,
  AlertTriangle,
} from "lucide-react";
import {
  cn,
  Input,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Badge,
} from "@okouai/ui";
import {
  orgRoleSchema,
  type OrgRole,
} from "@okouai/api-contracts/contracts/org-members";
import type { UsagePackManagementResponse } from "@okouai/api-contracts/contracts/billing";
import {
  MINIMUM_USAGE_PACK_USD,
  type MemberUsagePackOption,
  type MemberUsageSelection,
} from "../../../../signals/okou-page/settings/usage-pack-pricing-state.ts";
import {
  orgMembers$,
  orgPendingInvitations$,
  orgMembershipRequests$,
  type OrgMember,
  type OrgPendingInvitation,
  type OrgMembershipRequest,
} from "../../../../signals/external/org-members.ts";
import { isOrgAdmin$ } from "../../../../signals/org.ts";
import { user$ } from "../../../../signals/auth.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { orgPlanCapabilities$ } from "../../../../signals/okou-page/org-plan-capabilities.ts";
import {
  memberSearch$,
  setMemberSearch$,
  inviteEmail$,
  setInviteEmail$,
  inviteTouched$,
  setInviteTouched$,
  inviteDialogOpen$,
  setInviteDialogOpen$,
  inviteRole$,
  setInviteRole$,
  memberUsagePackManagement$,
  showMemberUsagePack$,
  invitationUsagePackConfiguration$,
  inviteUsagePackUsd$,
  setInviteUsagePackUsd$,
  selfDemoteDialogOpen$,
  setSelfDemoteDialogOpen$,
  removeMemberDialogTarget$,
  setRemoveMemberDialogTarget$,
  revokeInvitationDialogTarget$,
  setRevokeInvitationDialogTarget$,
  inviteMember$,
  invitePurchasePreview$,
  closeInvitePurchasePreview$,
  confirmInvitePurchase$,
  changeRole$,
  selfDemote$,
  removeMember$,
  revokeInvitation$,
  acceptRequest$,
  rejectRequest$,
} from "../../../../signals/okou-page/settings/workspace-settings-state.ts";
import {
  openSettingsBillingPlans$,
  openSettingsUsagePackConfiguration$,
} from "../../../../signals/okou-page/settings/settings-dialog.ts";
import { formatLocalizedNumber, formatUsd } from "../../../../i18n/format.ts";
import { UserAvatar } from "../../../components/avatar.tsx";
import {
  parseUsagePackOption,
  usagePackOptionLabel,
} from "./usage-pack-options.ts";

const ROW_GRID = "grid gap-x-4 items-center";

function memberRowGrid(showUsagePack: boolean): string {
  return cn(
    ROW_GRID,
    showUsagePack
      ? "grid-cols-[minmax(0,1fr)_6rem_13rem_5.5rem_2rem]"
      : "grid-cols-[minmax(0,1fr)_6rem_5.5rem_2rem]",
  );
}

function MembersTableHeader({ showUsagePack }: { showUsagePack: boolean }) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        memberRowGrid(showUsagePack),
        "sticky top-0 z-10 px-5 py-2.5 text-[13px] font-medium text-foreground bg-card",
      )}
    >
      <div>
        {t(($) => {
          return $.settings.workspace.members.user;
        })}
      </div>
      <div>
        {t(($) => {
          return $.settings.workspace.members.joined;
        })}
      </div>
      {showUsagePack && (
        <div>
          {t(($) => {
            return $.settings.workspace.members.usagePack;
          })}
        </div>
      )}
      <div>
        {t(($) => {
          return $.settings.workspace.members.role;
        })}
      </div>
      <div />
    </div>
  );
}

function displayName(m: OrgMember): string {
  const parts = [m.firstName, m.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "";
}

function formatDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale).format(new Date(iso));
}

function formatBillingDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(iso));
}

export function OrgMembersTab() {
  const { t } = useTranslation();
  const membersLoadable = useLoadable(orgMembers$);
  const pendingLoadable = useLoadable(orgPendingInvitations$);
  const requestsLoadable = useLoadable(orgMembershipRequests$);
  const userLoadable = useLoadable(user$);
  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const usagePackManagementLoadable = useLoadable(memberUsagePackManagement$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;

  const search = useGet(memberSearch$);
  const setSearch = useSet(setMemberSearch$);

  const members =
    membersLoadable.state === "hasData" ? membersLoadable.data : [];
  const pendingInvitations =
    pendingLoadable.state === "hasData" ? pendingLoadable.data : [];
  const membershipRequests =
    requestsLoadable.state === "hasData" ? requestsLoadable.data : [];
  const currentUserId =
    userLoadable.state === "hasData" ? userLoadable.data?.id : undefined;
  const usagePackManagement =
    usagePackManagementLoadable.state === "hasData"
      ? usagePackManagementLoadable.data
      : null;
  const showUsagePack = useLastResolved(showMemberUsagePack$) === true;
  const usagePackAllocationByMemberId = new Map(
    usagePackManagement?.allocations.map((allocation) => {
      return [allocation.memberId, allocation] as const;
    }),
  );
  const isLoading = membersLoadable.state === "loading";

  const adminCount = members.filter((m) => {
    return m.role === "admin";
  }).length;

  const filtered = (() => {
    if (!search.trim()) {
      return members;
    }
    const q = search.toLowerCase();
    return members.filter((m) => {
      return (
        m.email.toLowerCase().includes(q) ||
        displayName(m).toLowerCase().includes(q)
      );
    });
  })();

  const filteredPending = (() => {
    if (!search.trim()) {
      return pendingInvitations;
    }
    const q = search.toLowerCase();
    return pendingInvitations.filter((inv) => {
      return inv.email.toLowerCase().includes(q);
    });
  })();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search
            size={15}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60"
          />
          <Input
            type="text"
            placeholder={t(($) => {
              return $.settings.workspace.members.search;
            })}
            value={search}
            onChange={(e) => {
              return setSearch(e.target.value);
            }}
            className="pl-9"
          />
        </div>
        {isAdmin && (
          <>
            <InviteDialog />
            <InvitePurchaseConfirmationDialog />
          </>
        )}
      </div>

      <div className="overflow-hidden rounded-xl bg-card okou-border">
        <MembersTableHeader showUsagePack={showUsagePack} />
        <div className="h-0 border-t border-t-gray-400 mx-5" />

        {isLoading && (
          <>
            <MemberRowSkeleton showUsagePack={showUsagePack} />
            <MemberRowSkeleton showUsagePack={showUsagePack} />
            <MemberRowSkeleton showUsagePack={showUsagePack} />
          </>
        )}

        {!isLoading &&
          filtered.length === 0 &&
          filteredPending.length === 0 &&
          membershipRequests.length === 0 && (
            <div className="flex items-center justify-center py-12">
              <span className="text-sm text-muted-foreground">
                {search.trim()
                  ? t(($) => {
                      return $.settings.workspace.members.emptySearch;
                    })
                  : t(($) => {
                      return $.settings.workspace.members.empty;
                    })}
              </span>
            </div>
          )}

        {!isLoading && membershipRequests.length > 0 && (
          <>
            <div className="px-5 pt-3 pb-1">
              <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                <UserPlus size={13} />
                {t(($) => {
                  return $.settings.workspace.members.joinRequests;
                })}
              </span>
            </div>
            {membershipRequests.map((req, i) => {
              return (
                <div key={req.id}>
                  {i > 0 && (
                    <div className="h-0 border-t border-t-gray-400 mx-5" />
                  )}
                  <MembershipRequestRow
                    request={req}
                    showUsagePack={showUsagePack}
                  />
                </div>
              );
            })}
            <div className="h-0 border-t border-t-gray-400 mx-5" />
          </>
        )}

        {!isLoading &&
          filtered.map((m, i) => {
            return (
              <div key={m.userId}>
                {(i > 0 || membershipRequests.length > 0) && (
                  <div className="h-0 border-t border-t-gray-400 mx-5" />
                )}
                <MemberRow
                  member={m}
                  isCurrentUser={m.userId === currentUserId}
                  isAdmin={isAdmin}
                  isOnlyAdmin={adminCount < 2}
                  showUsagePack={showUsagePack}
                  usagePackManagement={usagePackManagement}
                  usagePackAllocation={
                    usagePackAllocationByMemberId.get(m.userId) ?? null
                  }
                />
              </div>
            );
          })}

        {!isLoading &&
          filteredPending.map((inv, i) => {
            return (
              <div key={inv.id}>
                {(i > 0 ||
                  filtered.length > 0 ||
                  membershipRequests.length > 0) && (
                  <div className="h-0 border-t border-t-gray-400 mx-5" />
                )}
                <PendingInvitationRow
                  invitation={inv}
                  isAdmin={isAdmin}
                  showUsagePack={showUsagePack}
                />
              </div>
            );
          })}
      </div>
    </div>
  );
}

type InviteDialogMode =
  | "direct"
  | "error"
  | "loading"
  | "packages"
  | "setup"
  | "suspended"
  | "upgrade";

function resolveInviteDialogMode(args: {
  readonly capabilities:
    | {
        readonly legacyMemberInvitationAllowed: boolean | null;
        readonly status: "active" | "suspended";
      }
    | undefined;
  readonly catalogLoading: boolean;
  readonly catalogError: boolean;
  readonly usagePackConfigured: boolean;
  readonly packageSetupRequired: boolean;
}): InviteDialogMode {
  if (!args.capabilities) {
    return "loading";
  }
  if (args.capabilities.status === "suspended") {
    return "suspended";
  }
  if (args.capabilities.legacyMemberInvitationAllowed === false) {
    return "upgrade";
  }
  if (args.catalogLoading) {
    return "loading";
  }
  if (args.catalogError) {
    return "error";
  }
  if (args.usagePackConfigured) {
    return args.packageSetupRequired ? "setup" : "packages";
  }
  return "direct";
}

function InviteDialogFields({
  email,
  isValid,
  role,
  sending,
  setEmail,
  setRole,
  setTouched,
  setUsagePackUsd,
  touched,
  trimmed,
  usagePacks,
  usagePackUsd,
}: {
  readonly email: string;
  readonly isValid: boolean;
  readonly role: OrgRole;
  readonly sending: boolean;
  readonly setEmail: (value: string) => void;
  readonly setRole: (value: OrgRole) => void;
  readonly setTouched: (value: boolean) => void;
  readonly setUsagePackUsd: (value: MemberUsageSelection) => void;
  readonly touched: boolean;
  readonly trimmed: string;
  readonly usagePacks: readonly MemberUsagePackOption[] | null;
  readonly usagePackUsd: MemberUsageSelection;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Input
          placeholder={t(($) => {
            return $.settings.workspace.members.invite.emailPlaceholder;
          })}
          type="email"
          value={email}
          disabled={sending}
          onChange={(event) => {
            setEmail(event.target.value);
            setTouched(false);
          }}
          onBlur={() => {
            return setTouched(true);
          }}
        />
        {touched && trimmed && !isValid && (
          <p className="text-[13px] text-destructive">
            {t(($) => {
              return $.settings.workspace.members.invite.invalidEmail;
            })}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium">
          {t(($) => {
            return $.settings.workspace.members.invite.roleLabel;
          })}
        </label>
        <Select
          value={role}
          onValueChange={(value) => {
            return setRole(orgRoleSchema.parse(value));
          }}
          disabled={sending}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="member">
              {t(($) => {
                return $.settings.workspace.members.member;
              })}
            </SelectItem>
            <SelectItem value="admin">
              {t(($) => {
                return $.settings.workspace.members.admin;
              })}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      {usagePacks && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="invite-usage-pack" className="text-sm font-medium">
            {t(($) => {
              return $.billing.plans.usagePacks.memberPackages;
            })}
          </label>
          <Select
            value={String(usagePackUsd)}
            onValueChange={(value) => {
              return setUsagePackUsd(parseUsagePackOption(value, usagePacks));
            }}
            disabled={sending}
          >
            <SelectTrigger id="invite-usage-pack">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="w-max max-w-[calc(100vw-2rem)]">
              {usagePacks.map((usagePack) => {
                return (
                  <SelectItem
                    key={usagePack.usagePackUsd}
                    value={String(usagePack.usagePackUsd)}
                    className="whitespace-nowrap"
                  >
                    {usagePackOptionLabel(usagePack)}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}

function InviteDialogContent({
  mode,
  usagePacks,
  ...fieldProps
}: Omit<ComponentProps<typeof InviteDialogFields>, "usagePacks"> & {
  readonly mode: InviteDialogMode;
  readonly usagePacks: readonly MemberUsagePackOption[] | null;
}) {
  const { t } = useTranslation();
  if (mode === "suspended") {
    return (
      <>
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.settings.workspace.members.invite.suspended.title;
            })}
          </DialogTitle>
        </DialogHeader>
        <DialogDescription className="py-2 leading-6">
          {t(($) => {
            return $.settings.workspace.members.invite.suspended.description;
          })}
        </DialogDescription>
      </>
    );
  }
  if (mode === "upgrade") {
    return (
      <>
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.settings.workspace.members.invite.upgrade.title;
            })}
          </DialogTitle>
        </DialogHeader>
        <DialogDescription className="py-2 leading-6">
          {t(($) => {
            return $.settings.workspace.members.invite.upgrade.description;
          })}
        </DialogDescription>
      </>
    );
  }
  if (mode === "loading" || mode === "error") {
    return (
      <>
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.settings.workspace.members.invite.title;
            })}
          </DialogTitle>
        </DialogHeader>
        {mode === "loading" ? (
          <div className="h-24 animate-pulse rounded-lg bg-muted/40" />
        ) : (
          <DialogDescription className="py-2 leading-6">
            {t(($) => {
              return $.billing.plans.loadError;
            })}
          </DialogDescription>
        )}
      </>
    );
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {t(($) => {
            return $.settings.workspace.members.invite.title;
          })}
        </DialogTitle>
        <DialogDescription>
          {t(($) => {
            return $.settings.workspace.members.invite.description;
          })}
        </DialogDescription>
      </DialogHeader>
      <InviteDialogFields
        {...fieldProps}
        usagePacks={mode === "packages" || mode === "setup" ? usagePacks : null}
      />
    </>
  );
}

function InvitePrimaryActionLabel({
  mode,
  sending,
  usagePackUsd,
}: {
  readonly mode: InviteDialogMode;
  readonly sending: boolean;
  readonly usagePackUsd: MemberUsageSelection;
}) {
  const { t } = useTranslation();
  if (mode === "suspended") {
    return t(($) => {
      return $.settings.workspace.members.invite.suspended.action;
    });
  }
  if (mode === "upgrade") {
    return t(($) => {
      return $.settings.workspace.members.invite.upgrade.action;
    });
  }
  if (mode === "loading") {
    return t(($) => {
      return $.billing.common.preparing;
    });
  }
  if (mode === "error") {
    return t(($) => {
      return $.billing.common.unavailable;
    });
  }
  if (sending) {
    return t(($) => {
      return $.settings.workspace.members.invite.progress;
    });
  }
  if (mode === "setup") {
    return t(($) => {
      return $.billing.plans.usagePacks.configurePackages;
    });
  }
  if (mode === "packages" && usagePackUsd !== 0) {
    return t(($) => {
      return $.chat.actions.continue;
    });
  }
  return t(($) => {
    return $.settings.workspace.members.invite.send;
  });
}

function InviteDialogActions({
  isValid,
  mode,
  onCancel,
  onPrimary,
  sending,
  usagePackUsd,
}: {
  readonly isValid: boolean;
  readonly mode: InviteDialogMode;
  readonly onCancel: () => void;
  readonly onPrimary: () => void;
  readonly sending: boolean;
  readonly usagePackUsd: MemberUsageSelection;
}) {
  const { t } = useTranslation();
  const submitsInvitation = mode === "direct" || mode === "packages";
  const primaryDisabled =
    mode === "loading" ||
    mode === "error" ||
    (submitsInvitation && (!isValid || sending));
  return (
    <DialogFooter>
      <Button variant="outline" size="sm" onClick={onCancel} disabled={sending}>
        {t(($) => {
          return $.settings.shared.cancel;
        })}
      </Button>
      <Button size="sm" disabled={primaryDisabled} onClick={onPrimary}>
        <InvitePrimaryActionLabel
          mode={mode}
          sending={sending}
          usagePackUsd={usagePackUsd}
        />
      </Button>
    </DialogFooter>
  );
}

function InviteDialog() {
  const { t } = useTranslation();
  const email = useGet(inviteEmail$);
  const setEmail = useSet(setInviteEmail$);
  const open = useGet(inviteDialogOpen$);
  const setOpen = useSet(setInviteDialogOpen$);
  const role = useGet(inviteRole$);
  const setRole = useSet(setInviteRole$);
  const selectedUsagePackUsd = useGet(inviteUsagePackUsd$);
  const setUsagePackUsd = useSet(setInviteUsagePackUsd$);
  const capabilities = useLastResolved(orgPlanCapabilities$);
  const openBillingPlans = useSet(openSettingsBillingPlans$);
  const [, openUsagePackConfiguration] = useLoadableSet(
    openSettingsUsagePackConfiguration$,
  );
  const catalogLoadable = useLoadable(invitationUsagePackConfiguration$);
  const configuration =
    catalogLoadable.state === "hasData" ? catalogLoadable.data : null;
  const usagePacks = configuration?.options ?? null;
  const usagePackUsd =
    selectedUsagePackUsd ?? (usagePacks === null ? 0 : MINIMUM_USAGE_PACK_USD);
  const mode = resolveInviteDialogMode({
    capabilities,
    catalogLoading: catalogLoadable.state === "loading",
    catalogError: catalogLoadable.state === "hasError",
    usagePackConfigured: usagePacks !== null,
    packageSetupRequired:
      configuration !== null &&
      !configuration.hasSubscription &&
      usagePackUsd !== 0,
  });
  const [loadable, doInvite] = useLoadableSet(inviteMember$);
  const sending = loadable.state === "loading";
  const pageSignal = useGet(pageSignal$);

  const trimmed = email.trim();
  const isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);

  const touched = useGet(inviteTouched$);
  const setTouched = useSet(setInviteTouched$);

  const handleSend = () => {
    detach(
      doInvite(
        trimmed,
        role,
        mode === "packages" ? usagePackUsd : null,
        pageSignal,
      ),
      Reason.DomCallback,
    );
  };

  const openPackageConfiguration = () => {
    setOpen(false);
    if (mode === "setup") {
      detach(openUsagePackConfiguration(pageSignal), Reason.DomCallback);
    } else {
      openBillingPlans();
    }
  };

  const handlePrimary = () => {
    if (mode === "setup" || mode === "suspended" || mode === "upgrade") {
      openPackageConfiguration();
      return;
    }
    handleSend();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!sending) {
          setOpen(v);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5 rounded-lg">
          <Plus size={14} />
          {t(($) => {
            return $.settings.workspace.members.addMember;
          })}
        </Button>
      </DialogTrigger>
      <DialogContent
        closeLabel={t(($) => {
          return $.settings.shared.close;
        })}
      >
        <InviteDialogContent
          email={email}
          isValid={isValid}
          mode={mode}
          role={role}
          sending={sending}
          setEmail={setEmail}
          setRole={setRole}
          setTouched={setTouched}
          setUsagePackUsd={setUsagePackUsd}
          touched={touched}
          trimmed={trimmed}
          usagePacks={usagePacks}
          usagePackUsd={usagePackUsd}
        />
        <InviteDialogActions
          isValid={isValid}
          mode={mode}
          onCancel={() => {
            return setOpen(false);
          }}
          onPrimary={handlePrimary}
          sending={sending}
          usagePackUsd={usagePackUsd}
        />
      </DialogContent>
    </Dialog>
  );
}

function InvitePurchaseConfirmationDialogContent() {
  const { t } = useTranslation();
  const preview = useGet(invitePurchasePreview$);
  const close = useSet(closeInvitePurchasePreview$);
  const [confirmationLoadable, confirm] = useLoadableSet(
    confirmInvitePurchase$,
  );
  const pageSignal = useGet(pageSignal$);
  const confirming = confirmationLoadable.state === "loading";
  const error = confirmationLoadable.state === "hasError";
  const inviteAsSummary = preview
    ? t(
        ($) => {
          return $.settings.workspace.members.invite.purchase.inviteAsSummary;
        },
        {
          role:
            preview.role === "admin"
              ? t(($) => {
                  return $.settings.workspace.members.admin;
                })
              : t(($) => {
                  return $.settings.workspace.members.member;
                }),
          credits: t(
            ($) => {
              return $.billing.plans.usagePacks.packCredits;
            },
            {
              credits: formatLocalizedNumber(preview.payment.totalCredits),
            },
          ),
        },
      )
    : null;

  return (
    <Dialog
      open={preview !== null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !confirming) {
          close();
        }
      }}
    >
      <DialogContent
        maxWidth="26.5rem"
        contentClassName="gap-0"
        closeLabel={t(($) => {
          return $.settings.shared.close;
        })}
      >
        <DialogHeader className="pb-4">
          <DialogTitle>
            {t(($) => {
              return $.settings.workspace.members.invite.purchase.title;
            })}
          </DialogTitle>
        </DialogHeader>
        {preview && (
          <div className="divide-y divide-border/70 border-y border-border/70">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 py-3 text-sm">
              <span className="text-muted-foreground">
                {t(($) => {
                  return $.settings.workspace.members.invite.purchase.invitee;
                })}
              </span>
              <span className="max-w-64 truncate text-right font-medium text-foreground">
                {preview.email}
              </span>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 py-3 text-sm">
              <span className="text-muted-foreground">
                {t(($) => {
                  return $.settings.workspace.members.invite.purchase.inviteAs;
                })}
              </span>
              <span className="text-right font-medium text-foreground">
                {inviteAsSummary}
              </span>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 py-3 text-sm">
              <span className="text-muted-foreground">
                {t(($) => {
                  return $.settings.workspace.members.invite.purchase.dueToday;
                })}
              </span>
              <span className="text-right text-xl font-semibold tabular-nums tracking-tight text-foreground">
                {formatUsd(preview.payment.immediateAmountCents / 100)}
              </span>
            </div>
          </div>
        )}
        {error && (
          <p className="mt-3 text-xs text-destructive">
            {t(($) => {
              return $.settings.workspace.members.invite.purchase.error;
            })}
          </p>
        )}
        <DialogFooter className="pt-4">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={confirming}
            onClick={close}
          >
            {t(($) => {
              return $.settings.shared.cancel;
            })}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={confirming || !preview}
            onClick={() => {
              detach(confirm(pageSignal), Reason.DomCallback);
            }}
          >
            {confirming
              ? t(($) => {
                  return $.billing.common.updating;
                })
              : t(($) => {
                  return $.settings.workspace.members.invite.purchase
                    .payAndInvite;
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InvitePurchaseConfirmationDialog() {
  const preview = useGet(invitePurchasePreview$);
  if (!preview) {
    return null;
  }
  return (
    <InvitePurchaseConfirmationDialogContent key={preview.payment.purchaseId} />
  );
}

type ManagedUsagePackAllocation =
  UsagePackManagementResponse["allocations"][number];

function UsagePackCell({
  allocation,
  fallbackPeriodEnd,
}: {
  allocation: ManagedUsagePackAllocation | null;
  fallbackPeriodEnd: string | null;
}) {
  const { i18n, t } = useTranslation();
  if (!allocation) {
    return (
      <div className="text-[13px] text-muted-foreground">
        {t(($) => {
          return $.billing.plans.usagePacks.noPackage;
        })}
      </div>
    );
  }

  const pendingChange = allocation.pendingChange;
  const downgradeTarget =
    (pendingChange?.kind === "downgrade" ||
      pendingChange?.kind === "removal") &&
    pendingChange.status !== "previewed"
      ? (pendingChange.targetUsagePackUsd ?? 0)
      : null;
  const effectiveAt =
    pendingChange?.effectiveAt ??
    allocation.currentPeriodEnd ??
    fallbackPeriodEnd;
  const downgradeSummary =
    downgradeTarget === null
      ? null
      : effectiveAt
        ? t(
            ($) => {
              return $.billing.plans.usagePacks.management.downgradesToDate;
            },
            {
              package:
                downgradeTarget === 0
                  ? t(($) => {
                      return $.billing.plans.usagePacks.noPackage;
                    })
                  : formatUsd(downgradeTarget, 0),
              date: formatBillingDate(
                effectiveAt,
                i18n.resolvedLanguage ?? i18n.language,
              ),
            },
          )
        : t(
            ($) => {
              return $.billing.plans.usagePacks.management.downgradesToPeriod;
            },
            {
              package:
                downgradeTarget === 0
                  ? t(($) => {
                      return $.billing.plans.usagePacks.noPackage;
                    })
                  : formatUsd(downgradeTarget, 0),
            },
          );

  return (
    <div className="min-w-0 tabular-nums">
      <div className="text-[13px] text-muted-foreground">
        {t(
          ($) => {
            return $.billing.plans.pricePerMonth;
          },
          { price: formatUsd(allocation.usagePackUsd, 0) },
        )}
      </div>
      {downgradeSummary && (
        <p className="mt-0.5 text-[11px] font-medium leading-4 text-yellow-700 dark:text-yellow-300">
          {downgradeSummary}
        </p>
      )}
    </div>
  );
}

function MemberRow({
  member,
  isCurrentUser,
  isAdmin,
  isOnlyAdmin,
  showUsagePack,
  usagePackManagement,
  usagePackAllocation,
}: {
  member: OrgMember;
  isCurrentUser: boolean;
  isAdmin: boolean;
  isOnlyAdmin: boolean;
  showUsagePack: boolean;
  usagePackManagement: UsagePackManagementResponse | null;
  usagePackAllocation: ManagedUsagePackAllocation | null;
}) {
  const { i18n, t } = useTranslation();
  const name = displayName(member);
  const initial = (name || member.email).charAt(0).toUpperCase();
  const canManage = isAdmin && !isCurrentUser;
  const canSelfDemote =
    isAdmin && isCurrentUser && member.role === "admin" && !isOnlyAdmin;

  return (
    <div className={cn(memberRowGrid(showUsagePack), "py-3 px-5")}>
      <div className="flex items-center gap-3 min-w-0">
        <UserAvatar
          imageUrl={member.imageUrl}
          initial={initial}
          name={name || member.email}
        />
        <div className="min-w-0">
          {name && (
            <span className="flex items-center gap-1.5 text-sm font-medium text-foreground truncate">
              {name}
              {isCurrentUser && (
                <span
                  data-testid="current-user-indicator"
                  className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium bg-muted text-muted-foreground leading-none"
                >
                  {t(($) => {
                    return $.settings.workspace.members.you;
                  })}
                </span>
              )}
            </span>
          )}
          <p className="text-[13px] text-muted-foreground truncate">
            {member.email}
          </p>
        </div>
      </div>
      <div className="text-[13px] text-muted-foreground tabular-nums">
        {formatDate(member.joinedAt, i18n.resolvedLanguage ?? i18n.language)}
      </div>
      {showUsagePack && (
        <UsagePackCell
          allocation={usagePackAllocation}
          fallbackPeriodEnd={usagePackManagement?.currentPeriodEnd ?? null}
        />
      )}
      <div>
        <Badge className="text-xs font-medium text-muted-foreground">
          <ShieldCheck
            className={
              member.role === "admin"
                ? "text-blue-500"
                : "text-muted-foreground/40"
            }
          />
          {member.role === "admin"
            ? t(($) => {
                return $.settings.workspace.members.admin;
              })
            : t(($) => {
                return $.settings.workspace.members.member;
              })}
        </Badge>
      </div>
      <div className="flex justify-end">
        {canManage && (
          <MemberActions
            member={member}
            showUsagePack={showUsagePack}
            usagePackManagement={usagePackManagement}
          />
        )}
        {isAdmin && isCurrentUser && (canSelfDemote || showUsagePack) && (
          <SelfDemoteAction
            canSelfDemote={canSelfDemote}
            email={member.email}
            showUsagePack={showUsagePack}
          />
        )}
      </div>
    </div>
  );
}

function AdjustUsagePackMenuItem() {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const [loadable, openConfiguration] = useLoadableSet(
    openSettingsUsagePackConfiguration$,
  );
  return (
    <DropdownMenuItem
      className="whitespace-nowrap"
      disabled={loadable.state === "loading"}
      onSelect={(event) => {
        event.preventDefault();
        detach(openConfiguration(pageSignal), Reason.DomCallback);
      }}
    >
      {t(($) => {
        return $.billing.plans.usagePacks.configurePackages;
      })}
    </DropdownMenuItem>
  );
}

function SelfDemoteAction({
  canSelfDemote,
  email,
  showUsagePack,
}: {
  canSelfDemote: boolean;
  email: string;
  showUsagePack: boolean;
}) {
  const { t } = useTranslation();
  const open = useGet(selfDemoteDialogOpen$);
  const setOpen = useSet(setSelfDemoteDialogOpen$);
  const [loadable, doSelfDemote] = useLoadableSet(selfDemote$);
  const loading = loadable.state === "loading";
  const pageSignal = useGet(pageSignal$);

  const handleConfirm = () => {
    detach(doSelfDemote(email, pageSignal), Reason.DomCallback);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!loading) {
          setOpen(v);
        }
      }}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            showTooltip
            aria-label={t(
              ($) => {
                return $.settings.workspace.members.actionsFor;
              },
              {
                email,
              },
            )}
            variant="quiet"
            size="icon-xs"
          >
            <Ellipsis size={15} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-max min-w-48 max-w-[calc(100vw-2rem)]"
          finalFocus={false}
        >
          {showUsagePack && <AdjustUsagePackMenuItem />}
          {canSelfDemote && (
            <DropdownMenuItem
              onSelect={() => {
                setOpen(true);
              }}
            >
              {t(($) => {
                return $.settings.workspace.members.selfDemote.action;
              })}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <DialogContent
        closeLabel={t(($) => {
          return $.settings.shared.close;
        })}
      >
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.settings.workspace.members.selfDemote.title;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.settings.workspace.members.selfDemote.description;
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              return setOpen(false);
            }}
            disabled={loading}
          >
            {t(($) => {
              return $.settings.shared.cancel;
            })}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={loading}
            onClick={handleConfirm}
          >
            {loading
              ? t(($) => {
                  return $.settings.workspace.members.selfDemote.progress;
                })
              : t(($) => {
                  return $.settings.workspace.members.selfDemote.confirm;
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MemberActions({
  member,
  showUsagePack,
  usagePackManagement,
}: {
  member: OrgMember;
  showUsagePack: boolean;
  usagePackManagement: UsagePackManagementResponse | null;
}) {
  const { t } = useTranslation();
  const newRole: OrgRole = member.role === "admin" ? "member" : "admin";
  const removeTarget = useGet(removeMemberDialogTarget$);
  const setRemoveTarget = useSet(setRemoveMemberDialogTarget$);
  const open = removeTarget === member.email;
  const [loadable, doRemove] = useLoadableSet(removeMember$);
  const [changeRoleLoadable, doChangeRole] = useLoadableSet(changeRole$);
  const changingRole = changeRoleLoadable.state === "loading";
  const removing = loadable.state === "loading";
  const pageSignal = useGet(pageSignal$);
  const hasUsagePack =
    usagePackManagement?.allocations.some((allocation) => {
      return allocation.memberId === member.userId;
    }) ?? false;

  const handleRemove = () => {
    detach(doRemove(member.email, pageSignal), Reason.DomCallback);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!removing) {
          setRemoveTarget(v ? member.email : null);
        }
      }}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            showTooltip
            aria-label={t(
              ($) => {
                return $.settings.workspace.members.actionsFor;
              },
              {
                email: member.email,
              },
            )}
            disabled={changingRole}
            variant="quiet"
            size="icon-xs"
            className="disabled:opacity-50"
          >
            <Ellipsis size={15} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-max min-w-48 max-w-[calc(100vw-2rem)]"
          finalFocus={false}
        >
          {showUsagePack && <AdjustUsagePackMenuItem />}
          <DropdownMenuItem
            onClick={() => {
              return detach(
                doChangeRole(member.email, newRole, pageSignal),
                Reason.DomCallback,
              );
            }}
          >
            {newRole === "admin"
              ? t(($) => {
                  return $.settings.workspace.members.roleActions.makeAdmin;
                })
              : t(($) => {
                  return $.settings.workspace.members.roleActions.makeMember;
                })}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={() => {
              setRemoveTarget(member.email);
            }}
          >
            {t(($) => {
              return $.settings.workspace.members.remove.action;
            })}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DialogContent
        closeLabel={t(($) => {
          return $.settings.shared.close;
        })}
      >
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.settings.workspace.members.remove.title;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(
              ($) => {
                return $.settings.workspace.members.remove.confirmDescription;
              },
              {
                email: member.email,
              },
            )}
          </DialogDescription>
        </DialogHeader>
        {hasUsagePack && (
          <div className="flex items-start gap-2.5 rounded-lg border border-amber-200/70 bg-amber-50/70 px-3 py-2.5 text-amber-700 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-300">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <div className="min-w-0 text-xs leading-relaxed">
              <p className="font-semibold">
                {t(($) => {
                  return $.settings.workspace.members.remove
                    .usagePackImpactTitle;
                })}
              </p>
              <p className="mt-1">
                {t(($) => {
                  return $.settings.workspace.members.remove
                    .usagePackImpactDescription;
                })}
              </p>
              <p className="mt-1.5">
                {t(($) => {
                  return $.settings.workspace.members.remove
                    .usagePackRefundDescription;
                })}
              </p>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              return setRemoveTarget(null);
            }}
            disabled={removing}
          >
            {t(($) => {
              return $.settings.shared.cancel;
            })}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={removing}
            onClick={handleRemove}
          >
            {removing
              ? t(($) => {
                  return $.settings.workspace.members.remove.progress;
                })
              : t(($) => {
                  return $.settings.shared.remove;
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PendingInvitationRow({
  invitation,
  isAdmin,
  showUsagePack,
}: {
  invitation: OrgPendingInvitation;
  isAdmin: boolean;
  showUsagePack: boolean;
}) {
  const { i18n, t } = useTranslation();
  const initial = invitation.email.charAt(0).toUpperCase();
  const revokeTarget = useGet(revokeInvitationDialogTarget$);
  const setRevokeTarget = useSet(setRevokeInvitationDialogTarget$);
  const open = revokeTarget === invitation.id;
  const [loadable, doRevoke] = useLoadableSet(revokeInvitation$);
  const revoking = loadable.state === "loading";
  const pageSignal = useGet(pageSignal$);

  const handleRevoke = () => {
    detach(doRevoke(invitation.id, pageSignal), Reason.DomCallback);
  };

  return (
    <div className={cn(memberRowGrid(showUsagePack), "py-3 px-5")}>
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted/50 text-xs font-medium text-muted-foreground border border-dashed border-border">
          {initial}
        </div>
        <div className="min-w-0">
          <p className="text-sm text-foreground truncate">{invitation.email}</p>
        </div>
      </div>
      <div className="text-[13px] text-muted-foreground tabular-nums">
        {formatDate(
          invitation.createdAt,
          i18n.resolvedLanguage ?? i18n.language,
        )}
      </div>
      {showUsagePack && (
        <div className="text-[13px] text-muted-foreground tabular-nums">
          {invitation.usagePackUsd === undefined
            ? "—"
            : t(
                ($) => {
                  return $.billing.plans.pricePerMonth;
                },
                { price: formatUsd(invitation.usagePackUsd, 0) },
              )}
        </div>
      )}
      <div>
        <Badge className="text-xs font-medium text-muted-foreground">
          <Clock className="text-amber-500" />
          {t(($) => {
            return $.settings.workspace.members.pending;
          })}
        </Badge>
      </div>
      <div className="flex justify-end">
        {isAdmin && (
          <Dialog
            open={open}
            onOpenChange={(v) => {
              if (!revoking) {
                setRevokeTarget(v ? invitation.id : null);
              }
            }}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  showTooltip
                  aria-label={t(
                    ($) => {
                      return $.settings.workspace.members.actionsFor;
                    },
                    { email: invitation.email },
                  )}
                  variant="quiet"
                  size="icon-xs"
                >
                  <Ellipsis size={15} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-48"
                finalFocus={false}
              >
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => {
                    setRevokeTarget(invitation.id);
                  }}
                >
                  {t(($) => {
                    return $.settings.workspace.members.revoke.action;
                  })}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <DialogContent
              closeLabel={t(($) => {
                return $.settings.shared.close;
              })}
            >
              <DialogHeader>
                <DialogTitle>
                  {t(($) => {
                    return $.settings.workspace.members.revoke.title;
                  })}
                </DialogTitle>
                <DialogDescription>
                  {t(
                    ($) => {
                      return $.settings.workspace.members.revoke
                        .confirmDescription;
                    },
                    { email: invitation.email },
                  )}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    return setRevokeTarget(null);
                  }}
                  disabled={revoking}
                >
                  {t(($) => {
                    return $.settings.shared.cancel;
                  })}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={revoking}
                  onClick={handleRevoke}
                >
                  {revoking
                    ? t(($) => {
                        return $.settings.workspace.members.revoke.progress;
                      })
                    : t(($) => {
                        return $.settings.workspace.members.revoke.button;
                      })}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>
    </div>
  );
}

function MembershipRequestRow({
  request,
  showUsagePack,
}: {
  request: OrgMembershipRequest;
  showUsagePack: boolean;
}) {
  const { i18n, t } = useTranslation();
  const name = [request.firstName, request.lastName].filter(Boolean).join(" ");
  const initial = (name || request.email).charAt(0).toUpperCase();
  const [acceptLoadable, doAccept] = useLoadableSet(acceptRequest$);
  const [rejectLoadable, doReject] = useLoadableSet(rejectRequest$);
  const loading =
    acceptLoadable.state === "loading" || rejectLoadable.state === "loading";
  const pageSignal = useGet(pageSignal$);

  const handleAccept = () => {
    detach(doAccept(request.id, pageSignal), Reason.DomCallback);
  };

  const handleReject = () => {
    detach(doReject(request.id, pageSignal), Reason.DomCallback);
  };

  return (
    <div className={cn(memberRowGrid(showUsagePack), "py-3 px-5")}>
      <div className="flex items-center gap-3 min-w-0">
        <UserAvatar
          imageUrl={request.imageUrl}
          initial={initial}
          name={name || request.email}
        />
        <div className="min-w-0">
          {name && (
            <span className="text-sm font-medium text-foreground truncate block">
              {name}
            </span>
          )}
          <p className="text-[13px] text-muted-foreground truncate">
            {request.email}
          </p>
        </div>
      </div>
      <div className="text-[13px] text-muted-foreground tabular-nums">
        {formatDate(request.createdAt, i18n.resolvedLanguage ?? i18n.language)}
      </div>
      {showUsagePack && (
        <div className="text-[13px] text-muted-foreground">—</div>
      )}
      <div>
        <Badge className="text-xs font-medium text-muted-foreground">
          <UserPlus className="text-blue-500" />
          {t(($) => {
            return $.settings.workspace.members.membershipRequest.role;
          })}
        </Badge>
      </div>
      <div className="flex justify-end gap-1">
        <button
          className="flex h-7 w-7 items-center justify-center rounded-md text-green-600 hover:bg-green-50 dark:hover:bg-green-950/30 transition-colors disabled:opacity-50"
          onClick={handleAccept}
          disabled={loading}
          title={t(($) => {
            return $.settings.workspace.members.membershipRequest.acceptTitle;
          })}
        >
          <Check size={15} />
        </button>
        <button
          className="flex h-7 w-7 items-center justify-center rounded-md text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
          onClick={handleReject}
          disabled={loading}
          title={t(($) => {
            return $.settings.workspace.members.membershipRequest.rejectTitle;
          })}
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}

function MemberRowSkeleton({ showUsagePack }: { showUsagePack: boolean }) {
  return (
    <div
      className={cn(memberRowGrid(showUsagePack), "py-3 px-5 animate-pulse")}
    >
      <div className="flex items-center gap-3">
        <div className="h-8 w-8 shrink-0 rounded-full bg-muted/50" />
        <div className="flex flex-col gap-1">
          <div className="h-4 w-24 rounded bg-muted/50" />
          <div className="h-3 w-36 rounded bg-muted/30" />
        </div>
      </div>
      <div className="h-4 w-20 rounded bg-muted/30" />
      {showUsagePack && <div className="h-4 w-16 rounded bg-muted/30" />}
      <div className="h-5 w-14 rounded bg-muted/30" />
      <div />
    </div>
  );
}
