import type { ReactNode } from "react";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useLoadable,
  useSet,
} from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  Button,
  buttonVariants,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  surfaceVariants,
} from "@okouai/ui";
import {
  ArrowRightLeft,
  ChevronRight,
  Coins,
  DatabaseBackup,
  FlaskConical,
  LayoutGrid,
  LogOut,
  Plus,
  Route,
  Settings,
  Users,
  type LucideIcon,
} from "lucide-react";
import { defaultAgentName$ } from "../../signals/agent.ts";
import { assistantName$ } from "../../signals/branding.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { handleAccountAction$ } from "../../signals/okou-page/nav.ts";
import { pwaMeSubscriptionUsageRows$ } from "../../signals/okou-page/pwa-me-page.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { UserAvatar } from "../components/avatar.tsx";
import { Link } from "../router/link.tsx";
import { CodexResetUsageDialog } from "./components/preferences/codex-reset-usage-dialog.tsx";
import { OrgSwitcher } from "./org-switcher.tsx";
import {
  AccountSessionItems,
  useAccountActions,
  useAccountCodexReset,
  useAccountProfile,
  useCreditBalance,
} from "./sidebar-account.tsx";
import { AccountMenuSubscriptionsPanel } from "./sidebar-subscriptions.tsx";

type AccountProfile = ReturnType<typeof useAccountProfile>;
type AccountActions = ReturnType<typeof useAccountActions>;
type AccountReset = ReturnType<typeof useAccountCodexReset>;

function MeAction({
  icon: Icon,
  children,
  onClick,
}: {
  readonly icon: LucideIcon;
  readonly children: ReactNode;
  readonly onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="quiet"
      size="lg"
      iconSize="md"
      className="w-full justify-start gap-3 px-3 text-foreground"
      onClick={onClick}
    >
      <Icon aria-hidden />
      <span className="min-w-0 flex-1 truncate text-left">{children}</span>
      <ChevronRight aria-hidden className="text-muted-foreground" />
    </Button>
  );
}

function MeLink({
  icon: Icon,
  children,
  pathname,
  target,
}: {
  readonly icon: LucideIcon;
  readonly children: ReactNode;
  readonly pathname: "/agents" | "/workflows" | "/works" | "/export";
  readonly target?: "_blank";
}) {
  return (
    <Link
      pathname={pathname}
      target={target}
      className={buttonVariants({
        variant: "quiet",
        size: "lg",
        iconSize: "md",
        className: "w-full justify-start gap-3 px-3 text-foreground",
      })}
    >
      <Icon aria-hidden />
      <span className="min-w-0 flex-1 truncate text-left">{children}</span>
      <ChevronRight aria-hidden className="text-muted-foreground" />
    </Link>
  );
}

function MeSubscriptions({ reset }: { readonly reset: AccountReset }) {
  const subscriptions = useLoadable(pwaMeSubscriptionUsageRows$);
  const resolvedRows = useLastResolved(pwaMeSubscriptionUsageRows$);
  const rows = resolvedRows ?? [];
  const loading =
    subscriptions.state === "loading" && resolvedRows === undefined;

  if (!loading && rows.length === 0) {
    return null;
  }

  return (
    <div className="mt-1 border-t border-border pt-3">
      <AccountMenuSubscriptionsPanel
        loading={loading}
        rows={rows}
        resetPending={reset.actionPending || subscriptions.state !== "hasData"}
        onResetCodexUsage={reset.handleOpenCodexReset}
        resetControl="button"
      />
    </div>
  );
}

function MeUsage({
  profile,
  actions,
  reset,
}: {
  readonly profile: AccountProfile;
  readonly actions: AccountActions;
  readonly reset: AccountReset;
}) {
  const { t } = useTranslation();
  const isAdmin = useLastLoadable(isOrgAdmin$);
  const { creditLabel, loading } = useCreditBalance(
    isAdmin.state === "hasData" && isAdmin.data === true,
  );
  const usageLabel = t(($) => {
    return $.usage.displayNames.usage;
  });

  return (
    <section
      aria-label={usageLabel}
      className={surfaceVariants({ className: "p-1" })}
    >
      <MeAction icon={Coins} onClick={actions.handleOpenCreditBalance}>
        {loading ? usageLabel : (creditLabel ?? usageLabel)}
      </MeAction>
      {profile.subscriptionsEnabled && <MeSubscriptions reset={reset} />}
    </section>
  );
}

function MeNavigation({
  profile,
  actions,
}: {
  readonly profile: AccountProfile;
  readonly actions: AccountActions;
}) {
  const { t } = useTranslation();
  const assistantName = useGet(assistantName$);
  const defaultDisplayName =
    useLastResolved(defaultAgentName$) ?? assistantName;

  return (
    <div className={surfaceVariants({ className: "flex flex-col gap-1 p-1" })}>
      <MeAction icon={Settings} onClick={actions.handleOpenSettings}>
        {t(($) => {
          return $.settings.accountMenu.settings;
        })}
      </MeAction>
      <MeLink icon={Users} pathname={ROUTES.agents}>
        {t(($) => {
          return $.appShell.sidebar.navigation.agents;
        })}
      </MeLink>
      <MeLink icon={Route} pathname={ROUTES.workflows}>
        {t(($) => {
          return $.appShell.sidebar.navigation.workflows;
        })}
      </MeLink>
      <MeLink icon={LayoutGrid} pathname={ROUTES.works}>
        {t(
          ($) => {
            return $.appShell.sidebar.navigation.works;
          },
          { agentName: defaultDisplayName },
        )}
      </MeLink>
      {profile.labEnabled && (
        <MeAction
          icon={FlaskConical}
          onClick={() => {
            actions.handleAccountAction("lab");
          }}
        >
          {t(($) => {
            return $.settings.accountMenu.lab;
          })}
        </MeAction>
      )}
    </div>
  );
}

function MeAccounts({
  profile,
  actions,
}: {
  readonly profile: AccountProfile;
  readonly actions: AccountActions;
}) {
  const { t } = useTranslation();

  return (
    <div className={surfaceVariants({ className: "flex flex-col gap-1 p-1" })}>
      {profile.others.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="quiet"
                size="lg"
                iconSize="md"
                className="w-full justify-start gap-3 px-3 text-foreground"
              />
            }
          >
            <ArrowRightLeft aria-hidden />
            <span className="flex-1 text-left">
              {t(($) => {
                return $.settings.accountMenu.switchAccount;
              })}
            </span>
            <ChevronRight aria-hidden className="text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <AccountSessionItems
              accounts={profile.others}
              onSwitchSession={actions.handleSwitchSession}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <MeAction icon={Plus} onClick={actions.handleAddAccount}>
        {t(($) => {
          return $.settings.accountMenu.addAccount;
        })}
      </MeAction>
      <MeLink
        icon={DatabaseBackup}
        pathname={ROUTES.exportData}
        target="_blank"
      >
        {t(($) => {
          return $.settings.accountMenu.exportData;
        })}
      </MeLink>
      <MeAction
        icon={LogOut}
        onClick={() => {
          actions.handleAccountAction("signout");
        }}
      >
        {t(($) => {
          return $.settings.accountMenu.signOut;
        })}
      </MeAction>
    </div>
  );
}

export function PwaMePage() {
  const { t } = useTranslation();
  const profile = useAccountProfile();
  const onAccountAction = useSet(handleAccountAction$);
  const actions = useAccountActions(profile, onAccountAction);
  const reset = useAccountCodexReset(profile.subscriptionRowsCacheKey);
  const { accountDisplay } = profile;

  return (
    <div data-slot="pwa-me-page" className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 px-4 py-3">
        <h1 className="text-xl font-semibold text-foreground">
          {t(($) => {
            return $.appShell.pwaNavigation.me;
          })}
        </h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
          <section className={surfaceVariants({ className: "p-3" })}>
            <div className="flex items-center gap-3 px-1 pb-4 pt-1">
              <UserAvatar
                imageUrl={accountDisplay.imageUrl}
                name={accountDisplay.name}
                initial={accountDisplay.initial}
                size="xl"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-semibold text-foreground">
                  {accountDisplay.name}
                </p>
                <p className="truncate text-sm text-muted-foreground">
                  {accountDisplay.email}
                </p>
              </div>
            </div>
            <div className="border-t border-border pt-2">
              <OrgSwitcher />
            </div>
          </section>
          <MeUsage profile={profile} actions={actions} reset={reset} />
          <MeNavigation profile={profile} actions={actions} />
          <MeAccounts profile={profile} actions={actions} />
        </div>
      </div>
      <CodexResetUsageDialog
        open={reset.resetDialog.open}
        providerType={reset.resetDialog.type}
        resetCredits={reset.resetDialog.resetCredits}
        resetting={reset.actionPending}
        onOpenChange={reset.handleCodexResetOpenChange}
        onConfirm={reset.handleConfirmCodexReset}
      />
    </div>
  );
}
