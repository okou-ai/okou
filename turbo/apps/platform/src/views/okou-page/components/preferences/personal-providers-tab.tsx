import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { EllipsisVertical, Plus } from "lucide-react";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  Skeleton,
  cn,
} from "@okouai/ui";
import type {
  ModelProviderResponse,
  ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  activatePersonalOAuthCredentialAccount$,
  deletePersonalOAuthCredentialAccount$,
  personalAccountDisconnectDialog$,
  personalActionPromise$,
  personalConfiguredProviders$,
  resetPersonalCodexAccountSubscriptionUsage$,
  setPersonalAccountDisconnectDialog$,
  setSettingsCodexResetDialog$,
  settingsCodexResetDialog$,
} from "../../../../signals/okou-page/settings/personal-model-providers.ts";
import { subscriptionUsageWindows } from "../../../../lib/subscription-usage-windows.ts";
import { modelPlanCapabilities$ } from "../../../../signals/okou-page/model-plan-capabilities.ts";
import { openSettingsBillingPlans$ } from "../../../../signals/okou-page/settings/settings-dialog.ts";
import { openClaudeCodeDeviceAuthDialogPersonal$ } from "../../../../signals/okou-page/settings/claude-code-device-auth.ts";
import { openCodexDeviceAuthDialogPersonal$ } from "../../../../signals/okou-page/settings/codex-device-auth.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { orgModelPolicies$ } from "../../../../signals/external/org-model-policies.ts";
import { reloadPersonalModelProviders$ } from "../../../../signals/external/personal-model-providers.ts";
import { ConnectorEntryStatus } from "../settings/connector-entry-card.tsx";
import { ProviderIcon } from "../settings/provider-icons.tsx";
import { PersonalClaudeCodeDeviceAuthDialog } from "../settings/claude-code-device-auth-dialog.tsx";
import { PersonalCodexDeviceAuthDialog } from "../settings/codex-device-auth-dialog.tsx";
import { SettingsSectionHeading } from "../settings/settings-section-heading.tsx";
import { formatSubscriptionUsageReset } from "../../subscription-usage-format.ts";
import {
  CodexResetCreditsButton,
  CodexResetUsageDialog,
} from "./codex-reset-usage-dialog.tsx";

type SubscriptionUsage = NonNullable<
  ModelProviderResponse["subscriptionUsage"]
>;
type SubscriptionUsageWindow = NonNullable<SubscriptionUsage["fiveHour"]>;

export function PersonalProvidersTab() {
  return (
    <div className="flex flex-col gap-8">
      <OAuthAccountGroupsSection />
      <PersonalClaudeCodeDeviceAuthDialog />
      <PersonalCodexDeviceAuthDialog />
    </div>
  );
}

function PersonalModelsHeading({ auto = false }: { readonly auto?: boolean }) {
  const { t } = useTranslation();
  if (auto) {
    return (
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            {t(($) => {
              return $.settings.models.personal.autoTitle;
            })}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(($) => {
              return $.settings.models.personal.autoDescription;
            })}
          </p>
        </div>
      </div>
    );
  }
  return (
    <SettingsSectionHeading
      title={t(($) => {
        return $.settings.models.personal.accountsSectionTitle;
      })}
      description={t(($) => {
        return $.settings.models.personal.accountsDescription;
      })}
    />
  );
}

const PERSONAL_ACCOUNT_PROVIDER_TYPES = [
  "claude-code-oauth-token",
  "codex-oauth-token",
] as const satisfies readonly ModelProviderType[];

type PersonalAccountProviderType =
  (typeof PERSONAL_ACCOUNT_PROVIDER_TYPES)[number];

type PersonalProviderAccountGroup = {
  readonly type: PersonalAccountProviderType;
  readonly title: string;
  readonly accounts: readonly ModelProviderResponse[];
};

function OAuthAccountGroupsSection() {
  const { t } = useTranslation();
  const providersLoadable = useLastLoadable(personalConfiguredProviders$);
  const modelCapabilitiesLoadable = useLastLoadable(modelPlanCapabilities$);
  const actionLoadable = useLoadable(personalActionPromise$);
  const openBillingPlans = useSet(openSettingsBillingPlans$);
  const openClaudeCodeDeviceAuthDialog = useSet(
    openClaudeCodeDeviceAuthDialogPersonal$,
  );
  const openCodexDeviceAuthDialog = useSet(openCodexDeviceAuthDialogPersonal$);
  const activateAccount = useSet(activatePersonalOAuthCredentialAccount$);
  const mode = useLastLoadable(orgModelPolicies$);
  const setDisconnectDialog = useSet(setPersonalAccountDisconnectDialog$);
  const setResetDialog = useSet(setSettingsCodexResetDialog$);
  const pageSignal = useGet(pageSignal$);

  const auto = mode.state === "hasData" && mode.data.modelMode === "auto";
  const isLoading =
    providersLoadable.state === "loading" ||
    (!auto && modelCapabilitiesLoadable.state === "loading");
  const providers =
    providersLoadable.state === "hasData" ? providersLoadable.data : [];
  const supportByok =
    auto ||
    modelCapabilitiesLoadable.state !== "hasData" ||
    modelCapabilitiesLoadable.data.supportByok;
  const actionPending = actionLoadable.state === "loading";
  const accountGroups: readonly PersonalProviderAccountGroup[] =
    PERSONAL_ACCOUNT_PROVIDER_TYPES.map((type) => {
      return {
        type,
        title:
          type === "codex-oauth-token"
            ? t(($) => {
                return $.settings.models.personal.codexTitle;
              })
            : t(($) => {
                return $.settings.models.personal.claudeTitle;
              }),
        accounts: providers.filter((provider) => {
          return provider.type === type;
        }),
      };
    });

  const openAccountAuth = (
    type: PersonalAccountProviderType,
    modelProviderId?: string,
  ) => {
    if (!supportByok) {
      openBillingPlans();
      return;
    }
    const args = modelProviderId
      ? { mode: "reconnect" as const, modelProviderId }
      : { mode: "connect" as const };
    const request =
      type === "codex-oauth-token"
        ? openCodexDeviceAuthDialog(args, pageSignal)
        : openClaudeCodeDeviceAuthDialog(args, pageSignal);
    detach(request, Reason.DomCallback);
  };

  if (auto && providersLoadable.state !== "hasData") {
    return (
      <AutoPersonalAccountsReadState
        failed={providersLoadable.state === "hasError"}
      />
    );
  }
  return (
    <section className="flex flex-col gap-4">
      <PersonalModelsHeading auto={auto} />
      <TooltipProvider delay={100}>
        <PersonalProviderAccountsTable
          showReconnectAction={auto}
          accountGroups={accountGroups}
          supportByok={supportByok}
          onConnect={openAccountAuth}
          onUpgrade={openBillingPlans}
          actionPending={actionPending}
          isLoading={isLoading}
          onActivate={(id) => {
            detach(activateAccount(id, pageSignal), Reason.DomCallback);
          }}
          onReconnect={openAccountAuth}
          onDisconnect={(account, fallbackIndex) => {
            setDisconnectDialog({ account, fallbackIndex });
          }}
          onReset={(account) => {
            setResetDialog({
              open: true,
              resetCredits: account.subscriptionResetCredits ?? null,
              accountId: account.id,
            });
          }}
        />
      </TooltipProvider>
      <PersonalAccountDisconnectDialogController
        actionPending={actionPending}
      />
      <CodexResetDialogController actionPending={actionPending} />
    </section>
  );
}

function AutoPersonalAccountsReadState({
  failed,
}: {
  readonly failed: boolean;
}) {
  const { t } = useTranslation();
  const reload = useSet(reloadPersonalModelProviders$);
  const providers = useLoadable(personalConfiguredProviders$);
  return (
    <section className="flex flex-col gap-6">
      <PersonalModelsHeading auto />
      {failed ? (
        <div className="flex flex-col items-start gap-4" role="alert">
          <p className="text-sm text-muted-foreground">
            {t(($) => {
              return $.settings.models.personal.loadError;
            })}
          </p>
          <Button
            variant="neutral"
            disabled={providers.state === "loading"}
            onClick={() => {
              return reload();
            }}
          >
            {t(($) => {
              return $.settings.models.personal.retry;
            })}
          </Button>
        </div>
      ) : (
        <div
          role="status"
          aria-label={t(($) => {
            return $.settings.models.personal.loadingAccounts;
          })}
          className="rounded-xl border border-surface-border bg-card p-4"
        >
          <Skeleton className="h-4 w-32" />
          <OAuthAccountTableRowSkeleton />
        </div>
      )}
    </section>
  );
}

function ConnectPersonalAccountAction({
  group,
  actionPending,
  isLoading,
  supportByok,
  onAdd,
  onUpgrade,
}: {
  readonly group: PersonalProviderAccountGroup;
  readonly actionPending: boolean;
  readonly isLoading: boolean;
  readonly supportByok: boolean;
  readonly onAdd: (type: PersonalAccountProviderType) => void;
  readonly onUpgrade: () => void;
}) {
  const { t } = useTranslation();
  if (!supportByok) {
    return (
      <Button
        type="button"
        variant="neutral"
        size="sm"
        className="h-9 rounded-lg"
        disabled={isLoading || actionPending}
        onClick={() => {
          onUpgrade();
        }}
      >
        {t(($) => {
          return $.settings.models.actions.upgradePro;
        })}
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant="neutral"
      size="sm"
      className="h-9 gap-2 rounded-lg"
      disabled={isLoading || actionPending || group.accounts.length >= 10}
      onClick={() => {
        onAdd(group.type);
      }}
    >
      <Plus size={14} />
      {t(($) => {
        return $.settings.models.personal.connectAccount;
      })}
    </Button>
  );
}

function PersonalProviderAccountsTable({
  showReconnectAction,
  accountGroups,
  supportByok,
  onConnect,
  onUpgrade,
  actionPending,
  isLoading,
  onActivate,
  onReconnect,
  onDisconnect,
  onReset,
}: {
  readonly showReconnectAction: boolean;
  readonly accountGroups: readonly PersonalProviderAccountGroup[];
  readonly supportByok: boolean;
  readonly onConnect: (type: PersonalAccountProviderType) => void;
  readonly onUpgrade: () => void;
  readonly actionPending: boolean;
  readonly isLoading: boolean;
  readonly onActivate: (id: string) => void;
  readonly onReconnect: (
    type: PersonalAccountProviderType,
    modelProviderId: string,
  ) => void;
  readonly onDisconnect: (
    account: ModelProviderResponse,
    fallbackIndex: number,
  ) => void;
  readonly onReset: (account: ModelProviderResponse) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      {accountGroups.map((group) => {
        return (
          <PersonalProviderAccountTable
            showReconnectAction={showReconnectAction}
            key={group.type}
            group={group}
            supportByok={supportByok}
            onConnect={onConnect}
            onUpgrade={onUpgrade}
            actionPending={actionPending}
            isLoading={isLoading}
            onActivate={onActivate}
            onReconnect={onReconnect}
            onDisconnect={onDisconnect}
            onReset={onReset}
          />
        );
      })}
    </div>
  );
}

function PersonalProviderAccountTable({
  showReconnectAction,
  group,
  supportByok,
  onConnect,
  onUpgrade,
  actionPending,
  isLoading,
  onActivate,
  onReconnect,
  onDisconnect,
  onReset,
}: {
  readonly showReconnectAction: boolean;
  readonly group: PersonalProviderAccountGroup;
  readonly supportByok: boolean;
  readonly onConnect: (type: PersonalAccountProviderType) => void;
  readonly onUpgrade: () => void;
  readonly actionPending: boolean;
  readonly isLoading: boolean;
  readonly onActivate: (id: string) => void;
  readonly onReconnect: (
    type: PersonalAccountProviderType,
    modelProviderId: string,
  ) => void;
  readonly onDisconnect: (
    account: ModelProviderResponse,
    fallbackIndex: number,
  ) => void;
  readonly onReset: (account: ModelProviderResponse) => void;
}) {
  const { t } = useTranslation();
  const headingId = `personal-provider-accounts-${group.type}`;

  return (
    <section aria-labelledby={headingId}>
      <div className="overflow-hidden rounded-xl border border-surface-border bg-card">
        <div className="flex flex-wrap items-center gap-2 border-b border-border/50 px-3 py-2.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gray-50 dark:bg-gray-100">
            <ProviderIcon type={group.type} size={18} />
          </span>
          <h4
            id={headingId}
            className="flex-1 text-sm font-medium text-foreground"
          >
            {group.title}
          </h4>
          <ConnectPersonalAccountAction
            group={group}
            actionPending={actionPending}
            isLoading={isLoading}
            supportByok={supportByok}
            onAdd={onConnect}
            onUpgrade={onUpgrade}
          />
        </div>
        <div role="table" aria-labelledby={headingId}>
          {isLoading ? (
            <div role="rowgroup" className="p-2">
              <OAuthAccountTableRowSkeleton />
            </div>
          ) : group.accounts.length === 0 ? (
            <div role="rowgroup" className="p-2">
              <div role="row" className="rounded-lg px-3 py-5">
                <div role="cell" className="text-xs text-muted-foreground">
                  {t(($) => {
                    return $.settings.models.personal.noAccounts;
                  })}
                </div>
              </div>
            </div>
          ) : (
            <div role="rowgroup" className="p-2">
              {group.accounts.map((account, index) => {
                return (
                  <OAuthAccountTableRow
                    showReconnectAction={showReconnectAction}
                    key={account.id}
                    account={account}
                    fallbackIndex={index + 1}
                    actionPending={actionPending}
                    onActivate={() => {
                      onActivate(account.id);
                    }}
                    onReconnect={() => {
                      onReconnect(group.type, account.id);
                    }}
                    onDisconnect={() => {
                      onDisconnect(account, index + 1);
                    }}
                    onReset={() => {
                      onReset(account);
                    }}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

const PERSONAL_ACCOUNT_ROW_CLASS =
  "relative grid grid-cols-[minmax(0,1fr)_auto_36px] items-center gap-x-3 gap-y-2 rounded-lg px-3 py-3.5 transition-colors after:pointer-events-none after:absolute after:bottom-0 after:left-12 after:right-3 after:h-px after:bg-divider/50 after:content-[''] last:after:hidden hover:bg-gray-50 dark:hover:bg-gray-100 lg:grid-cols-[minmax(0,1fr)_96px_236px_36px]";

function OAuthAccountTableRow({
  showReconnectAction,
  account,
  fallbackIndex,
  actionPending,
  onActivate,
  onReconnect,
  onDisconnect,
  onReset,
}: {
  readonly showReconnectAction: boolean;
  readonly account: ModelProviderResponse;
  readonly fallbackIndex: number;
  readonly actionPending: boolean;
  readonly onActivate: () => void;
  readonly onReconnect: () => void;
  readonly onDisconnect: () => void;
  readonly onReset: () => void;
}) {
  const { t } = useTranslation();
  const usage = fallbackSubscriptionUsage(account);
  const identity =
    account.accountEmail ??
    account.workspaceName ??
    t(
      ($) => {
        return $.settings.models.personal.accountFallback;
      },
      { number: fallbackIndex },
    );
  const plan = formatSubscriptionPlan(account);
  const detail =
    account.workspaceName === identity ? null : account.workspaceName;
  const statusLabel = account.needsReconnect
    ? t(($) => {
        return $.settings.models.personal.status.stale;
      })
    : t(($) => {
        return $.settings.models.personal.status.connected;
      });

  return (
    <div
      role="row"
      data-testid={`oauth-account-${account.id}`}
      className={PERSONAL_ACCOUNT_ROW_CLASS}
    >
      <div
        role="cell"
        className="col-start-1 col-end-3 row-start-1 flex min-w-0 items-center gap-3 lg:col-end-2"
      >
        <OAuthAccountActivateButton
          actionPending={actionPending}
          detail={detail}
          identity={identity}
          isActive={account.isActive ?? false}
          onActivate={onActivate}
        />
        <OAuthAccountIdentity
          detail={detail}
          identity={identity}
          needsReconnect={account.needsReconnect}
          statusLabel={statusLabel}
        />
      </div>
      <div
        role="cell"
        className="col-start-1 row-start-2 flex items-center pl-7 lg:col-start-2 lg:row-start-1 lg:pl-0"
      >
        {plan ? (
          <Badge className="text-[11px] font-normal text-muted-foreground">
            {plan}
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </div>
      <div
        role="cell"
        className="col-start-2 col-end-4 row-start-2 flex min-w-0 items-center justify-end gap-3 lg:col-start-3 lg:col-end-4 lg:row-start-1 lg:justify-start"
      >
        {account.needsReconnect && showReconnectAction ? (
          <Button
            variant="neutral"
            size="sm"
            disabled={actionPending}
            onClick={onReconnect}
          >
            {t(($) => {
              return $.settings.models.personal.reconnectAccount;
            })}
          </Button>
        ) : !account.needsReconnect &&
          subscriptionUsageWindows(usage).length > 0 ? (
          <SubscriptionUsageRings
            identity={identity}
            usage={usage}
            className="ml-0 justify-start"
          />
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
        <OAuthAccountResetControl
          account={account}
          resetPending={actionPending}
          onReset={onReset}
        />
      </div>
      <div
        role="cell"
        className="col-start-3 row-start-1 flex items-center justify-end lg:col-start-4"
      >
        <OAuthAccountMenu
          actionPending={actionPending}
          onReconnect={onReconnect}
          onDisconnect={onDisconnect}
        />
      </div>
    </div>
  );
}

function OAuthAccountResetControl({
  account,
  resetPending,
  onReset,
}: {
  readonly account: ModelProviderResponse;
  readonly resetPending: boolean;
  readonly onReset: () => void;
}) {
  if (
    account.type !== "codex-oauth-token" ||
    account.subscriptionResetCredits === undefined ||
    account.subscriptionResetCredits === 0
  ) {
    return null;
  }
  return (
    <CodexResetCreditsButton
      className="ml-auto"
      resetCredits={account.subscriptionResetCredits}
      resetCreditsNextExpiresAt={account.subscriptionResetCreditsNextExpiresAt}
      resetPending={resetPending}
      onReset={onReset}
    />
  );
}

// Activating an account is a server-side switch, so it stays an explicit
// command: a button that reports the confirmed account with `aria-pressed`,
// never a radio whose arrow keys would change the account while browsing.
function OAuthAccountActivateButton({
  actionPending,
  detail,
  identity,
  isActive,
  onActivate,
}: {
  readonly actionPending: boolean;
  readonly detail: string | null | undefined;
  readonly identity: string;
  readonly isActive: boolean;
  readonly onActivate: () => void;
}) {
  const { t } = useTranslation();
  const action = isActive
    ? t(($) => {
        return $.settings.models.personal.activeAccount;
      })
    : t(($) => {
        return $.settings.models.personal.useAccount;
      });

  return (
    <Button
      showTooltip
      type="button"
      variant="quiet"
      size="icon-2xs"
      className={cn(
        "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-border bg-input transition-colors hover:border-foreground/40 hover:bg-input disabled:cursor-default disabled:opacity-100",
        isActive && "border-primary bg-primary hover:bg-primary",
      )}
      aria-label={`${action}: ${identity}${detail ? ` (${detail})` : ""}`}
      aria-pressed={isActive}
      disabled={isActive || actionPending}
      onClick={onActivate}
    >
      {isActive ? (
        <span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--on-filled))]" />
      ) : null}
    </Button>
  );
}

function OAuthAccountIdentity({
  detail,
  identity,
  needsReconnect,
  statusLabel,
}: {
  readonly detail: string | null | undefined;
  readonly identity: string;
  readonly needsReconnect: boolean;
  readonly statusLabel: string;
}) {
  return (
    <div className="min-w-0">
      {detail ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                tabIndex={0}
                className="block min-w-0 truncate rounded-md px-1 py-0.5 -mx-1 -my-0.5 text-sm font-medium text-foreground outline-none transition-colors hover:bg-state-hover focus-visible:bg-state-hover"
              >
                {identity}
              </span>
            }
          />
          <TooltipContent side="bottom" align="start" sideOffset={8}>
            {detail}
          </TooltipContent>
        </Tooltip>
      ) : (
        <span className="block min-w-0 truncate text-sm font-medium text-foreground">
          {identity}
        </span>
      )}
      <ConnectorEntryStatus
        label={statusLabel}
        tone={needsReconnect ? "warning" : "success"}
        className="mt-0.5 text-xs text-muted-foreground"
      />
    </div>
  );
}

function OAuthAccountTableRowSkeleton() {
  return (
    <div
      role="row"
      data-testid="oauth-account-table-skeleton"
      className={cn(PERSONAL_ACCOUNT_ROW_CLASS, "hover:bg-transparent")}
    >
      <div
        role="cell"
        className="col-start-1 col-end-3 row-start-1 flex animate-pulse items-center gap-3 lg:col-end-2"
      >
        <span className="h-4 w-4 shrink-0 rounded-full bg-muted/50" />
        <div>
          <span className="block h-4 w-36 rounded bg-muted/50" />
          <span className="mt-1.5 block h-3 w-20 rounded bg-muted/30" />
        </div>
      </div>
      <div
        role="cell"
        className="col-start-1 row-start-2 flex items-center pl-7 lg:col-start-2 lg:row-start-1 lg:pl-0"
      >
        <span className="block h-5 w-12 animate-pulse rounded bg-muted/30" />
      </div>
      <div
        role="cell"
        className="col-start-2 col-end-4 row-start-2 flex animate-pulse items-center justify-end gap-1.5 lg:col-start-3 lg:col-end-4 lg:row-start-1 lg:justify-start"
      >
        <span className="h-7 w-7 rounded-full bg-muted/30" />
        <span className="h-7 w-7 rounded-full bg-muted/30" />
      </div>
      <div
        role="cell"
        className="col-start-3 row-start-1 flex items-center justify-end lg:col-start-4"
      >
        <span className="block h-8 w-8 animate-pulse rounded-lg bg-muted/30" />
      </div>
    </div>
  );
}

function OAuthAccountMenu({
  actionPending,
  onReconnect,
  onDisconnect,
}: {
  readonly actionPending: boolean;
  readonly onReconnect: () => void;
  readonly onDisconnect: () => void;
}) {
  const { t } = useTranslation();
  const menuItems = [
    {
      label: t(($) => {
        return $.settings.models.personal.reconnectAccount;
      }),
      disabled: actionPending,
      onSelect: onReconnect,
    },
    {
      label: t(($) => {
        return $.settings.models.personal.disconnectAccount;
      }),
      disabled: actionPending,
      onSelect: onDisconnect,
    },
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            showTooltip
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:bg-state-hover hover:text-foreground"
            aria-label={t(($) => {
              return $.settings.shared.moreOptions;
            })}
          />
        }
      >
        <EllipsisVertical size={14} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {menuItems.map((item) => {
          return (
            <DropdownMenuItem
              key={item.label}
              disabled={item.disabled}
              onClick={item.onSelect}
            >
              {item.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PersonalAccountDisconnectDialogController({
  actionPending,
}: {
  readonly actionPending: boolean;
}) {
  const { t } = useTranslation();
  const dialog = useGet(personalAccountDisconnectDialog$);
  const setDialog = useSet(setPersonalAccountDisconnectDialog$);
  const deleteAccount = useSet(deletePersonalOAuthCredentialAccount$);
  const pageSignal = useGet(pageSignal$);

  if (!dialog) {
    return null;
  }

  const identity =
    dialog.account.accountEmail ??
    dialog.account.workspaceName ??
    t(
      ($) => {
        return $.settings.models.personal.accountFallback;
      },
      { number: dialog.fallbackIndex },
    );

  const confirmDisconnect = () => {
    detach(
      (async () => {
        await deleteAccount(dialog.account.id, pageSignal);
        setDialog(null);
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !actionPending) {
          setDialog(null);
        }
      }}
    >
      <DialogContent
        maxWidth="md"
        closeLabel={t(($) => {
          return $.settings.shared.close;
        })}
      >
        <DialogHeader>
          <DialogTitle className="line-clamp-2 break-words pr-8 leading-snug">
            {t(
              ($) => {
                return $.settings.models.personal.disconnectTitle;
              },
              { account: identity },
            )}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.settings.models.personal.disconnectDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={actionPending}
            onClick={() => {
              setDialog(null);
            }}
          >
            {t(($) => {
              return $.settings.shared.cancel;
            })}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={actionPending}
            onClick={confirmDisconnect}
          >
            {actionPending
              ? t(($) => {
                  return $.settings.models.personal.disconnecting;
                })
              : t(($) => {
                  return $.settings.models.personal.disconnectAccount;
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CodexResetDialogController({
  actionPending,
}: {
  readonly actionPending: boolean;
}) {
  const resetDialog = useGet(settingsCodexResetDialog$);
  const setResetDialog = useSet(setSettingsCodexResetDialog$);
  const resetCodexAccount = useSet(resetPersonalCodexAccountSubscriptionUsage$);
  const pageSignal = useGet(pageSignal$);

  const confirmReset = () => {
    const resetPromise = resetDialog.accountId
      ? resetCodexAccount(resetDialog.accountId, pageSignal)
      : null;
    if (!resetPromise) {
      return;
    }
    detach(
      (async () => {
        await resetPromise;
        setResetDialog({
          ...resetDialog,
          open: false,
        });
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <CodexResetUsageDialog
      open={resetDialog.open}
      resetCredits={resetDialog.resetCredits}
      resetting={actionPending}
      onOpenChange={(open) => {
        setResetDialog({
          ...resetDialog,
          open,
        });
      }}
      onConfirm={confirmReset}
    />
  );
}

function formatSubscriptionPlan(
  provider: ModelProviderResponse,
): string | null {
  const plan = provider.planType?.trim();
  if (!plan) {
    return null;
  }
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

function formatUsagePercent(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

function fallbackSubscriptionUsage(
  provider: ModelProviderResponse,
): SubscriptionUsage | null {
  if (subscriptionUsageWindows(provider.subscriptionUsage).length > 0) {
    return provider.subscriptionUsage ?? null;
  }

  const resetAt = provider.subscriptionNextResetAt?.trim();
  if (!resetAt) {
    return null;
  }

  const resetPeriod = provider.subscriptionResetPeriod?.trim().toLowerCase();
  const window = {
    usedPercent: null,
    remainingPercent: null,
    resetAt,
    windowSeconds: resetPeriod?.includes("5") ? 18_000 : 604_800,
  };

  return resetPeriod?.includes("5")
    ? { fiveHour: window, weekly: null }
    : { fiveHour: null, weekly: window };
}

function usageTone(remainingPercent: number | null): {
  readonly ringClassName: string;
  readonly ringTrackClassName: string;
  readonly textClassName: string;
} {
  if (remainingPercent !== null && remainingPercent < 20) {
    return {
      ringClassName: "stroke-red-500",
      ringTrackClassName: "stroke-red-500/15",
      textClassName: "text-red-600 dark:text-red-400",
    };
  }
  if (remainingPercent !== null && remainingPercent < 50) {
    return {
      ringClassName: "stroke-amber-500",
      ringTrackClassName: "stroke-amber-500/15",
      textClassName: "text-amber-600 dark:text-amber-400",
    };
  }
  return {
    ringClassName: "stroke-emerald-500",
    ringTrackClassName: "stroke-emerald-500/15",
    textClassName: "text-emerald-600 dark:text-emerald-400",
  };
}

function SubscriptionUsageRings({
  className,
  identity,
  usage,
}: {
  readonly className?: string;
  readonly identity: string;
  readonly usage: SubscriptionUsage | null | undefined;
}) {
  const windows = subscriptionUsageWindows(usage);

  if (windows.length === 0) {
    return null;
  }

  return (
    <span
      className={cn(
        "ml-auto flex min-w-16 shrink-0 items-center justify-end gap-1.5",
        className,
      )}
    >
      {windows.map(({ kind, window }) => {
        return (
          <SubscriptionUsageRing
            key={kind}
            identity={identity}
            kind={kind}
            window={window}
          />
        );
      })}
    </span>
  );
}

function SubscriptionUsageRing({
  identity,
  kind,
  window,
}: {
  readonly identity: string;
  readonly kind: "fiveHour" | "week";
  readonly window: SubscriptionUsageWindow;
}) {
  const { t } = useTranslation();
  const windowLabel =
    kind === "week"
      ? t(($) => {
          return $.settings.models.personal.status.week;
        })
      : t(($) => {
          return $.settings.models.personal.status.fiveHour;
        });
  const shortWindowLabel =
    kind === "week" ? windowLabel.charAt(0) : windowLabel;
  const remainingPercent =
    window.remainingPercent ??
    (window.usedPercent === null ? null : 100 - window.usedPercent);
  const displayPercent = formatUsagePercent(remainingPercent);
  const progress =
    remainingPercent === null
      ? 0
      : Math.min(100, Math.max(0, remainingPercent));
  const reset = formatSubscriptionUsageReset(window.resetAt);
  const tone = usageTone(remainingPercent);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            role="progressbar"
            aria-label={t(
              ($) => {
                return $.settings.accountMenu.subscriptions.usageRemaining;
              },
              { provider: identity, window: windowLabel },
            )}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={remainingPercent ?? undefined}
            className="relative flex h-7 w-7 shrink-0 cursor-default items-center justify-center rounded-full outline-none transition-colors hover:bg-state-hover focus-visible:ring-2 focus-visible:ring-ring"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 28 28"
              className="h-7 w-7 -rotate-90"
            >
              <circle
                cx="14"
                cy="14"
                r="11"
                fill="none"
                strokeWidth="3"
                className={tone.ringTrackClassName}
              />
              <circle
                cx="14"
                cy="14"
                r="11"
                fill="none"
                pathLength="100"
                strokeDasharray="100"
                strokeDashoffset={100 - progress}
                strokeLinecap="round"
                strokeWidth="3"
                className={`${tone.ringClassName} transition-[stroke-dashoffset]`}
              />
            </svg>
            <span className="absolute max-w-5 truncate text-[7px] font-semibold leading-none text-muted-foreground">
              {shortWindowLabel}
            </span>
          </span>
        }
      />
      <TooltipContent
        side="bottom"
        sideOffset={8}
        className="min-w-48 border shadow-md bg-popover! text-popover-foreground!"
      >
        <div className="flex items-center justify-between gap-4">
          <span className="font-medium text-foreground">{windowLabel}</span>
          <span className={`font-medium ${tone.textClassName}`}>
            {displayPercent
              ? t(
                  ($) => {
                    return $.settings.models.personal.status.left;
                  },
                  { percent: displayPercent },
                )
              : "--"}
          </span>
        </div>
        <SubscriptionUsageResetTooltip reset={reset} />
      </TooltipContent>
    </Tooltip>
  );
}

function SubscriptionUsageResetTooltip({
  reset,
}: {
  readonly reset: ReturnType<typeof formatSubscriptionUsageReset>;
}) {
  const { t } = useTranslation();
  if (reset === null) {
    return (
      <p className="mt-1 text-[10px] text-muted-foreground">
        {t(($) => {
          return $.settings.accountMenu.subscriptions.resetTimeUnavailable;
        })}
      </p>
    );
  }
  if ("fallbackText" in reset) {
    return (
      <p className="mt-1 text-[10px] text-muted-foreground">
        {reset.fallbackText}
      </p>
    );
  }
  return (
    <div className="mt-1 space-y-0.5">
      <p className="text-xs font-medium text-foreground">
        {reset.tooltipTitle}
      </p>
      <p className="text-[10px] text-muted-foreground">{reset.absoluteText}</p>
    </div>
  );
}
