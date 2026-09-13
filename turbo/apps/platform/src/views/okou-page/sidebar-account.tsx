// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import {
  useGet,
  useLoadable,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  LogOut,
  Plus,
  ChevronRight,
  Settings,
  ArrowRightLeft,
  DatabaseBackup,
  FlaskConical,
  Coins,
} from "lucide-react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  Button,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@okouai/ui";
import {
  clerk$,
  currentUserInfo$,
  openClerkAddAccount$,
} from "../../signals/auth.ts";
import {
  reloadAccountMenuSubscriptionUsageRows$,
  type AccountMenuSubscriptionUsageRowsCacheKey,
} from "../../signals/okou-page/account-menu-subscriptions.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  setSidebarExpanded$,
  type AccountAction,
} from "../../signals/okou-page/nav.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import {
  openSettingsDialogAt$,
  type SettingsSection,
} from "../../signals/okou-page/settings/settings-dialog.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import {
  billingStatusAsync$,
  reloadAccountMenuCreditBalances$,
  usagePackCreditsAsync$,
} from "../../signals/okou-page/billing.ts";
import {
  accountMenuCodexResetDialog$,
  personalActionPromise$,
  resetPersonalCodexSubscriptionUsage$,
  setAccountMenuCodexResetDialog$,
} from "../../signals/okou-page/settings/personal-model-providers.ts";
import { CodexResetUsageDialog } from "./components/preferences/codex-reset-usage-dialog.tsx";
import {
  AccountMenuSubscriptionsPanel,
  useSubscriptionUsageRows,
} from "./sidebar-subscriptions.tsx";
import { DropdownMenuModalItem } from "../components/dropdown-menu-modal-item.tsx";
import { UserAvatar } from "../components/avatar.tsx";
import { formatLocalizedNumber } from "../../i18n/format.ts";
import { i18n } from "../../i18n/index.ts";

interface SessionAccount {
  sessionId: string;
  name: string;
  email: string;
  initial: string;
  imageUrl: string | undefined;
  isActive: boolean;
}

function formatCreditBalance(credits: number): string {
  return i18n.t(
    ($) => {
      return $.settings.accountMenu.creditBalance;
    },
    {
      count: credits,
      value: formatLocalizedNumber(credits),
    },
  );
}

function useAccountSessions() {
  const { t } = useTranslation();
  const clerkLoadable = useLoadable(clerk$);
  const clerk = clerkLoadable.state === "hasData" ? clerkLoadable.data : null;

  const currentSessionId = clerk?.session?.id;
  const accounts: SessionAccount[] = (clerk?.client?.sessions ?? [])
    .filter((s) => {
      return s.status === "active";
    })
    .map((s) => {
      return {
        sessionId: s.id,
        name:
          s.user?.fullName ??
          t(($) => {
            return $.settings.accountMenu.userFallback;
          }),
        email: s.user?.primaryEmailAddress?.emailAddress ?? "",
        initial: s.user?.fullName
          ? s.user.fullName.charAt(0).toUpperCase()
          : "U",
        imageUrl: s.user?.imageUrl,
        isActive: s.id === currentSessionId,
      };
    });

  return { clerk, accounts };
}

interface AccountDisplay {
  name: string;
  email: string;
  initial: string;
  imageUrl: string | undefined;
}

function subscriptionRowsCacheKeyFrom({
  clerk,
  current,
  user,
}: {
  clerk: { session?: { id?: string } | null } | null;
  current: SessionAccount | undefined;
  user: { id: string } | undefined;
}): AccountMenuSubscriptionUsageRowsCacheKey {
  return clerk?.session?.id ?? current?.sessionId ?? user?.id ?? null;
}

function accountDisplayFrom(
  user:
    | {
        fullName: string | null;
        imageUrl: string | undefined;
        primaryEmailAddress: { emailAddress: string } | null;
      }
    | undefined,
  fallback: SessionAccount | undefined,
  userFallback: string,
): AccountDisplay {
  const name = user?.fullName ?? fallback?.name ?? userFallback;
  return {
    name,
    email: user?.primaryEmailAddress?.emailAddress ?? fallback?.email ?? "",
    initial: name.charAt(0).toUpperCase(),
    imageUrl: user?.imageUrl ?? fallback?.imageUrl,
  };
}

function renderAccountTrigger(
  display: AccountDisplay,
  collapsed: boolean,
  avatarShape: "circle" | "square",
) {
  if (collapsed) {
    return (
      <Button
        showTooltip
        type="button"
        variant="quiet"
        size="icon"
        aria-label={display.name}
        className="shrink-0 p-0"
      >
        <UserAvatar
          imageUrl={display.imageUrl}
          name={display.name}
          initial={display.initial}
          size="md+"
          shape={avatarShape}
        />
      </Button>
    );
  }
  // Geometry mirrors OrgSwitcher's trigger so the workspace row at the top
  // of the sidebar and the account row at the bottom read as one pair.
  return (
    <button
      type="button"
      className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-state-hover text-sidebar-foreground transition-colors"
    >
      <UserAvatar
        imageUrl={display.imageUrl}
        name={display.name}
        initial={display.initial}
        size="sm"
        shape={avatarShape}
      />
      <span className="min-w-0 flex-1 text-left text-sm font-medium leading-tight truncate">
        {display.name}
      </span>
    </button>
  );
}

function CurrentAccountHeader({
  display,
  visible,
}: {
  display: AccountDisplay;
  visible: boolean;
}) {
  if (!visible) {
    return null;
  }
  return (
    <>
      <div className="px-3 py-3">
        <div className="flex items-center gap-3">
          <UserAvatar
            imageUrl={display.imageUrl}
            name={display.name}
            initial={display.initial}
            size="lg"
          />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-foreground truncate">
              {display.name}
            </div>
            <div className="text-xs text-muted-foreground truncate">
              {display.email}
            </div>
          </div>
        </div>
      </div>
      <DropdownMenuSeparator />
    </>
  );
}

function AccountUsageGroup({
  onOpenCreditBalance,
  onResetCodexUsage,
  resetPending,
  subscriptionRowsCacheKey,
  subscriptionsEnabled,
}: {
  onOpenCreditBalance: () => void;
  onResetCodexUsage: (resetCredits: number | null) => void;
  resetPending: boolean;
  subscriptionRowsCacheKey: AccountMenuSubscriptionUsageRowsCacheKey;
  subscriptionsEnabled: boolean;
}) {
  const isAdminLoadable = useLastLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" && isAdminLoadable.data === true;

  if (subscriptionsEnabled) {
    return (
      <AccountUsageGroupWithSubscriptions
        combinedCredit={isAdmin}
        onOpenCreditBalance={onOpenCreditBalance}
        onResetCodexUsage={onResetCodexUsage}
        resetPending={resetPending}
        subscriptionRowsCacheKey={subscriptionRowsCacheKey}
      />
    );
  }
  return (
    <AccountCreditBalanceGroup
      combinedCredit={isAdmin}
      onOpenCreditBalance={onOpenCreditBalance}
    />
  );
}

/**
 * Administrators see the workspace balance combined with their member package
 * credits; members only see their own package credits.
 */
function useCreditBalance(combined: boolean): {
  readonly creditLabel: string | null;
  readonly loading: boolean;
} {
  const billingLoadable = useLastLoadable(billingStatusAsync$);
  const usagePackLoadable = useLastLoadable(usagePackCreditsAsync$);
  const organizationCredits =
    combined && billingLoadable.state === "hasData"
      ? billingLoadable.data.credits
      : null;
  const usagePackCredits =
    usagePackLoadable.state === "hasData"
      ? usagePackLoadable.data.totalCredits
      : null;
  const waitingForOrganization =
    combined &&
    billingLoadable.state === "loading" &&
    organizationCredits === null;
  const waitingForUsagePack =
    usagePackLoadable.state === "loading" && usagePackCredits === null;
  const credits = !combined
    ? usagePackCredits
    : organizationCredits !== null && !waitingForUsagePack
      ? organizationCredits + (usagePackCredits ?? 0)
      : null;
  return {
    creditLabel: credits !== null ? formatCreditBalance(credits) : null,
    loading: waitingForOrganization || waitingForUsagePack,
  };
}

function AccountUsageGroupWithSubscriptions({
  combinedCredit,
  onOpenCreditBalance,
  onResetCodexUsage,
  resetPending,
  subscriptionRowsCacheKey,
}: {
  combinedCredit: boolean;
  onOpenCreditBalance: () => void;
  onResetCodexUsage: (resetCredits: number | null) => void;
  resetPending: boolean;
  subscriptionRowsCacheKey: AccountMenuSubscriptionUsageRowsCacheKey;
}) {
  const { creditLabel, loading: creditLoading } =
    useCreditBalance(combinedCredit);
  const { loading: subscriptionsLoading, rows } = useSubscriptionUsageRows({
    cacheKey: subscriptionRowsCacheKey,
  });
  const showCredit = creditLoading || creditLabel !== null;
  const showSubscriptions = subscriptionsLoading || rows.length > 0;

  if (!showCredit && !showSubscriptions) {
    return null;
  }

  return (
    <>
      {showCredit ? (
        <CreditBalanceItem
          creditLabel={creditLabel}
          loading={creditLoading}
          onOpenCreditBalance={onOpenCreditBalance}
        />
      ) : null}
      {showCredit && showSubscriptions ? <DropdownMenuSeparator /> : null}
      {showSubscriptions ? (
        <AccountMenuSubscriptionsPanel
          loading={subscriptionsLoading}
          onResetCodexUsage={onResetCodexUsage}
          resetPending={resetPending}
          rows={rows}
        />
      ) : null}
      <DropdownMenuSeparator />
    </>
  );
}

function AccountCreditBalanceGroup({
  combinedCredit,
  onOpenCreditBalance,
}: {
  combinedCredit: boolean;
  onOpenCreditBalance: () => void;
}) {
  const { creditLabel, loading } = useCreditBalance(combinedCredit);

  if (!loading && creditLabel === null) {
    return null;
  }

  return (
    <>
      <CreditBalanceItem
        creditLabel={creditLabel}
        loading={loading}
        onOpenCreditBalance={onOpenCreditBalance}
      />
      <DropdownMenuSeparator />
    </>
  );
}

function CreditBalanceItem({
  creditLabel,
  loading,
  onOpenCreditBalance,
}: {
  creditLabel: string | null;
  loading: boolean;
  onOpenCreditBalance: () => void;
}) {
  return (
    <DropdownMenuModalItem
      onModalSelect={onOpenCreditBalance}
      className="gap-3 px-3 py-2.5"
      data-testid="account-menu-credit-balance"
    >
      <Coins size={18} className="" />
      <span className="min-w-0 flex-1 truncate text-sm tabular-nums">
        {loading ? (
          <span className="block h-4 w-24 rounded bg-muted/60" />
        ) : (
          creditLabel
        )}
      </span>
    </DropdownMenuModalItem>
  );
}

function UnifiedSettingsGroup({
  labEnabled,
  onAccountAction,
  onOpenSettings,
}: {
  labEnabled: boolean;
  onAccountAction: (action: AccountAction) => void;
  onOpenSettings: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <DropdownMenuModalItem
        onModalSelect={onOpenSettings}
        className="gap-3 px-3 py-2.5"
      >
        <Settings size={18} className="" />
        <span>
          {t(($) => {
            return $.settings.accountMenu.settings;
          })}
        </span>
      </DropdownMenuModalItem>
      {labEnabled && (
        <DropdownMenuItem
          onClick={() => {
            return onAccountAction("lab");
          }}
          className="gap-3 px-3 py-2.5"
        >
          <FlaskConical size={18} className="" />
          <span>
            {t(($) => {
              return $.settings.accountMenu.lab;
            })}
          </span>
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
    </>
  );
}

function AccountManagementGroup({
  others,
  onSwitchSession,
  onAddAccount,
}: {
  others: SessionAccount[];
  onSwitchSession: (sessionId: string) => void;
  onAddAccount: () => void;
}) {
  const { t } = useTranslation();
  if (others.length === 0) {
    return (
      <DropdownMenuItem onClick={onAddAccount} className="gap-3 px-3 py-2.5">
        <Plus size={18} className="" />
        <span>
          {t(($) => {
            return $.settings.accountMenu.addAccount;
          })}
        </span>
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="gap-3 px-3 py-2.5">
        <ArrowRightLeft size={18} className="" />
        <span className="flex-1">
          {t(($) => {
            return $.settings.accountMenu.switchAccount;
          })}
        </span>
        <ChevronRight size={14} className="" />
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-[220px]">
        {others.map((account) => {
          return (
            <DropdownMenuItem
              key={account.sessionId}
              onClick={() => {
                return onSwitchSession(account.sessionId);
              }}
              className="gap-3 px-3 py-2.5"
            >
              <UserAvatar
                imageUrl={account.imageUrl}
                name={account.name}
                initial={account.initial}
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-foreground truncate">
                  {account.name}
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  {account.email}
                </div>
              </div>
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onAddAccount} className="gap-3 px-3 py-2.5">
          <Plus size={18} className="" />
          <span>
            {t(($) => {
              return $.settings.accountMenu.addAccount;
            })}
          </span>
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function ExtraAccountActions() {
  const { t } = useTranslation();
  return (
    <DropdownMenuItem
      onClick={() => {
        return window.open(`${window.location.origin}/export`, "_blank");
      }}
      className="gap-3 px-3 py-2.5"
    >
      <DatabaseBackup size={18} className="" />
      <span>
        {t(($) => {
          return $.settings.accountMenu.exportData;
        })}
      </span>
    </DropdownMenuItem>
  );
}

function SignOutItem({
  onAccountAction,
}: {
  onAccountAction: (action: AccountAction) => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenuItem
      onClick={() => {
        return onAccountAction("signout");
      }}
      className="gap-3 px-3 py-2.5"
    >
      <LogOut size={18} className="" />
      <span>
        {t(($) => {
          return $.settings.accountMenu.signOut;
        })}
      </span>
    </DropdownMenuItem>
  );
}

export function AccountDropdown({
  onAccountAction,
  collapsed = false,
  hidePreferences = false,
  renderCodexResetDialog = true,
}: {
  onAccountAction?: (action: AccountAction) => void;
  collapsed?: boolean;
  hidePreferences?: boolean;
  renderCodexResetDialog?: boolean;
}) {
  const { t } = useTranslation();
  const { clerk, accounts } = useAccountSessions();
  const userInfoLoadable = useLoadable(currentUserInfo$);
  const user =
    userInfoLoadable.state === "hasData" ? userInfoLoadable.data : undefined;
  const features = useLastResolved(featureSwitch$);
  const labEnabled = features?.[FeatureSwitchKey.Lab] ?? false;
  const subscriptionsEnabled =
    features?.[FeatureSwitchKey.SidebarSubscriptionUsage] ?? false;
  // The account mark aligns with the rounded-square workspace logo in the rail.
  const avatarShape = "square";
  const openSettings = useSet(openSettingsDialogAt$);
  const reloadSubscriptions = useSet(reloadAccountMenuSubscriptionUsageRows$);
  const reloadCreditBalances = useSet(reloadAccountMenuCreditBalances$);
  const resetCodexSubscriptionUsage = useSet(
    resetPersonalCodexSubscriptionUsage$,
  );
  const resetDialog = useGet(accountMenuCodexResetDialog$);
  const setResetDialog = useSet(setAccountMenuCodexResetDialog$);
  const actionLoadable = useLoadable(personalActionPromise$);
  const setSidebarExpanded = useSet(setSidebarExpanded$);
  const pageSignal = useGet(pageSignal$);
  const openClerkAddAccount = useSet(openClerkAddAccount$);

  const current = accounts.find((a) => {
    return a.isActive;
  });
  const subscriptionRowsCacheKey = subscriptionRowsCacheKeyFrom({
    clerk,
    current,
    user,
  });
  const accountDisplay = accountDisplayFrom(
    user,
    current,
    t(($) => {
      return $.settings.accountMenu.userFallback;
    }),
  );
  const others = accounts.filter((a) => {
    return !a.isActive;
  });
  const actionPending = actionLoadable.state === "loading";

  const handleAccountAction = (action: AccountAction) => {
    if (action === "signout") {
      const sessionId = clerk?.session?.id;
      const signInUrl = clerk?.buildSignInUrl({ redirectUrl: location.href });
      detach(
        clerk?.signOut({ sessionId, redirectUrl: signInUrl }),
        Reason.DomCallback,
      );
      return;
    }
    onAccountAction?.(action);
  };

  const handleSwitchSession = (sessionId: string) => {
    const okou = window._okou;
    if (!okou) {
      throw new Error("Platform lifecycle was not initialized");
    }
    detach(
      okou.switchClerkSession(sessionId),
      Reason.DomCallback,
      "switch Clerk session",
    );
  };

  const handleAddAccount = () => {
    detach(
      openClerkAddAccount(pageSignal),
      Reason.DomCallback,
      "open Clerk add account dialog",
    );
  };

  const openSettingsSection = (section: SettingsSection) => {
    setSidebarExpanded(false);
    detach(openSettings(section, pageSignal), Reason.DomCallback);
  };

  const handleOpenSettings = () => {
    openSettingsSection("preference");
  };

  const handleOpenCreditBalance = () => {
    openSettingsSection("usage");
  };

  const handleOpenCodexReset = (resetCredits: number | null) => {
    setResetDialog({ open: true, resetCredits });
  };

  const handleConfirmCodexReset = () => {
    detach(
      (async () => {
        await resetCodexSubscriptionUsage(pageSignal);
        await reloadSubscriptions(subscriptionRowsCacheKey, pageSignal);
        setResetDialog({ ...resetDialog, open: false });
      })(),
      Reason.DomCallback,
    );
  };

  const handleCodexResetOpenChange = (open: boolean) => {
    setResetDialog({
      ...resetDialog,
      open,
    });
  };

  const handleMenuOpenChange = (open: boolean) => {
    if (!open) {
      return;
    }
    if (hidePreferences) {
      return;
    }
    // Refresh credit balances every time the menu opens so the displayed
    // remaining credits reflect the latest usage.
    detach(
      reloadCreditBalances(pageSignal),
      Reason.DomCallback,
      "reload account menu credit balances",
    );
    if (!subscriptionsEnabled) {
      return;
    }

    detach(
      reloadSubscriptions(subscriptionRowsCacheKey, pageSignal),
      Reason.DomCallback,
      "reload account menu subscriptions",
    );
  };

  return (
    <>
      <DropdownMenu onOpenChange={handleMenuOpenChange}>
        <DropdownMenuTrigger asChild>
          {renderAccountTrigger(accountDisplay, collapsed, avatarShape)}
        </DropdownMenuTrigger>

        <DropdownMenuContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-[240px]"
        >
          <CurrentAccountHeader
            display={accountDisplay}
            visible={current !== undefined || user !== undefined}
          />
          {!hidePreferences && (
            <AccountUsageGroup
              onOpenCreditBalance={handleOpenCreditBalance}
              onResetCodexUsage={handleOpenCodexReset}
              resetPending={actionPending}
              subscriptionRowsCacheKey={subscriptionRowsCacheKey}
              subscriptionsEnabled={subscriptionsEnabled}
            />
          )}
          {!hidePreferences && (
            <UnifiedSettingsGroup
              labEnabled={labEnabled}
              onAccountAction={handleAccountAction}
              onOpenSettings={handleOpenSettings}
            />
          )}
          <AccountManagementGroup
            others={others}
            onSwitchSession={handleSwitchSession}
            onAddAccount={handleAddAccount}
          />
          <ExtraAccountActions />
          <DropdownMenuSeparator />
          <SignOutItem onAccountAction={handleAccountAction} />
        </DropdownMenuContent>
      </DropdownMenu>
      {renderCodexResetDialog && (
        <CodexResetUsageDialog
          open={resetDialog.open}
          resetCredits={resetDialog.resetCredits}
          resetting={actionPending}
          onOpenChange={handleCodexResetOpenChange}
          onConfirm={handleConfirmCodexReset}
        />
      )}
    </>
  );
}
