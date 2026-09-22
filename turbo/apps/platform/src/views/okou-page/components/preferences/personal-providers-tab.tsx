import type { ReactNode } from "react";
import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { EllipsisVertical, Plus } from "lucide-react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Radio,
  RadioGroup,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@okouai/ui";
import type {
  ModelProviderResponse,
  ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  activatePersonalOAuthCredentialAccount$,
  deletePersonalOAuthCredentialAccount$,
  disconnectPersonalOAuthCredential$,
  personalAccountDisconnectDialog$,
  personalActionPromise$,
  personalConfiguredProviders$,
  resetPersonalCodexAccountSubscriptionUsage$,
  resetPersonalCodexSubscriptionUsage$,
  setPersonalAccountDisconnectDialog$,
  setSettingsCodexResetDialog$,
  settingsCodexResetDialog$,
} from "../../../../signals/okou-page/settings/personal-model-providers.ts";
import { modelPlanCapabilities$ } from "../../../../signals/okou-page/model-plan-capabilities.ts";
import { openSettingsBillingPlans$ } from "../../../../signals/okou-page/settings/settings-dialog.ts";
import { openClaudeCodeDeviceAuthDialogPersonal$ } from "../../../../signals/okou-page/settings/claude-code-device-auth.ts";
import { openCodexDeviceAuthDialogPersonal$ } from "../../../../signals/okou-page/settings/codex-device-auth.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { featureSwitch$ } from "../../../../signals/external/feature-switch.ts";
import { ConnectorEntryStatus } from "../settings/connector-entry-card.tsx";
import { ProviderIcon } from "../settings/provider-icons.tsx";
import { PersonalClaudeCodeDeviceAuthDialog } from "../settings/claude-code-device-auth-dialog.tsx";
import { PersonalCodexDeviceAuthDialog } from "../settings/codex-device-auth-dialog.tsx";
import { SettingsSectionHeading } from "../settings/settings-section-heading.tsx";
import { formatSubscriptionUsageReset } from "../../subscription-usage-format.ts";
import {
  CodexResetCreditsButton,
  CodexResetUsageDialog,
  formatCodexResetCredits,
} from "./codex-reset-usage-dialog.tsx";

type OAuthStatus = "connected" | "stale" | "missing";
type SubscriptionUsage = NonNullable<
  ModelProviderResponse["subscriptionUsage"]
>;
type SubscriptionUsageWindow = NonNullable<SubscriptionUsage["fiveHour"]>;

export function PersonalProvidersTab() {
  return (
    <div className="flex flex-col gap-8">
      <OAuthCredentialsSection />
      <PersonalClaudeCodeDeviceAuthDialog />
      <PersonalCodexDeviceAuthDialog />
    </div>
  );
}

function PersonalModelsHeading({
  accountTable = false,
  action,
}: {
  readonly accountTable?: boolean;
  readonly action?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <SettingsSectionHeading
      title={t(($) => {
        return accountTable
          ? $.settings.models.personal.accountsSectionTitle
          : $.settings.models.personal.sectionTitle;
      })}
      description={t(($) => {
        return accountTable
          ? $.settings.models.personal.accountsDescription
          : $.settings.models.personal.description;
      })}
      action={action}
    />
  );
}

function OAuthCredentialsSection() {
  const featureSwitches = useGet(featureSwitch$);
  return featureSwitches[FeatureSwitchKey.PersonalModelProviderAccounts] ? (
    <OAuthAccountGroupsSection />
  ) : (
    <LegacyOAuthCredentialsSection />
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
  const setDisconnectDialog = useSet(setPersonalAccountDisconnectDialog$);
  const setResetDialog = useSet(setSettingsCodexResetDialog$);
  const pageSignal = useGet(pageSignal$);

  const isLoading =
    providersLoadable.state === "loading" ||
    modelCapabilitiesLoadable.state === "loading";
  const providers =
    providersLoadable.state === "hasData" ? providersLoadable.data : [];
  const supportByok =
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

  const addAccountAction = (
    <AddPersonalAccountAction
      accountGroups={accountGroups}
      actionPending={actionPending}
      isLoading={isLoading}
      supportByok={supportByok}
      onAdd={openAccountAuth}
      onUpgrade={openBillingPlans}
    />
  );

  return (
    <section className="flex flex-col gap-4">
      <PersonalModelsHeading accountTable action={addAccountAction} />
      <TooltipProvider delay={100}>
        <PersonalProviderAccountsTable
          accountGroups={accountGroups}
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
      <CodexResetDialogController
        actionPending={actionPending}
        mode="account"
      />
    </section>
  );
}

function AddPersonalAccountAction({
  accountGroups,
  actionPending,
  isLoading,
  supportByok,
  onAdd,
  onUpgrade,
}: {
  readonly accountGroups: readonly PersonalProviderAccountGroup[];
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
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="neutral"
            size="sm"
            className="h-9 gap-2 rounded-lg"
            disabled={
              isLoading ||
              actionPending ||
              accountGroups.every((group) => {
                return group.accounts.length >= 10;
              })
            }
          />
        }
      >
        <Plus size={14} />
        {t(($) => {
          return $.settings.models.personal.addAccount;
        })}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {accountGroups.map((group) => {
          return (
            <DropdownMenuItem
              key={group.type}
              disabled={actionPending || group.accounts.length >= 10}
              onClick={() => {
                onAdd(group.type);
              }}
            >
              <ProviderIcon type={group.type} size={16} />
              {group.title}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PersonalProviderAccountsTable({
  accountGroups,
  actionPending,
  isLoading,
  onActivate,
  onReconnect,
  onDisconnect,
  onReset,
}: {
  readonly accountGroups: readonly PersonalProviderAccountGroup[];
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
            key={group.type}
            group={group}
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
  group,
  actionPending,
  isLoading,
  onActivate,
  onReconnect,
  onDisconnect,
  onReset,
}: {
  readonly group: PersonalProviderAccountGroup;
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
  const activeId = group.accounts.find((account) => {
    return account.isActive;
  })?.id;

  return (
    <section aria-labelledby={headingId}>
      <div className="overflow-hidden rounded-xl border border-surface-border bg-card">
        <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gray-50 dark:bg-gray-100">
            <ProviderIcon type={group.type} size={18} />
          </span>
          <h4 id={headingId} className="text-sm font-medium text-foreground">
            {group.title}
          </h4>
        </div>
        <RadioGroup
          aria-labelledby={headingId}
          value={activeId ?? ""}
          disabled={actionPending}
          onValueChange={(id: string) => {
            if (id !== activeId) {
              onActivate(id);
            }
          }}
        >
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
                      key={account.id}
                      account={account}
                      fallbackIndex={index + 1}
                      actionPending={actionPending}
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
        </RadioGroup>
      </div>
    </section>
  );
}

const PERSONAL_ACCOUNT_ROW_CLASS =
  "relative grid grid-cols-[minmax(0,1fr)_auto_36px] items-center gap-x-3 gap-y-2 rounded-lg px-3 py-3.5 transition-colors after:pointer-events-none after:absolute after:bottom-0 after:left-12 after:right-3 after:h-px after:bg-divider/50 after:content-[''] last:after:hidden hover:bg-gray-50 dark:hover:bg-gray-100 lg:grid-cols-[minmax(0,1fr)_96px_236px_36px]";

function OAuthAccountTableRow({
  account,
  fallbackIndex,
  actionPending,
  onReconnect,
  onDisconnect,
  onReset,
}: {
  readonly account: ModelProviderResponse;
  readonly fallbackIndex: number;
  readonly actionPending: boolean;
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
        <Radio
          value={account.id}
          aria-label={
            account.isActive
              ? t(($) => {
                  return $.settings.models.personal.activeAccount;
                })
              : t(($) => {
                  return $.settings.models.personal.useAccount;
                })
          }
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
        {!account.needsReconnect && usageWindows(usage).length > 0 ? (
          <SubscriptionUsageRings
            identity={identity}
            usage={usage}
            className="ml-0 justify-start"
          />
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
        {account.type === "codex-oauth-token" ? (
          <CodexResetCreditsButton
            className="ml-auto"
            resetCredits={account.subscriptionResetCredits ?? null}
            resetCreditsNextExpiresAt={
              account.subscriptionResetCreditsNextExpiresAt
            }
            resetPending={actionPending}
            onReset={onReset}
          />
        ) : null}
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
  const menuItems: OAuthMenuItem[] = [
    {
      label: t(($) => {
        return $.settings.models.personal.reconnectAccount;
      }),
      disabled: actionPending,
      onSelect: onReconnect,
      opensModal: true,
    },
    {
      label: t(($) => {
        return $.settings.models.personal.disconnectAccount;
      }),
      disabled: actionPending,
      onSelect: onDisconnect,
      opensModal: true,
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
        {menuItems.map((item, index) => {
          const key =
            item.kind === "separator"
              ? `separator-${index}`
              : `${item.kind ?? "item"}-${item.label}`;
          return <OAuthMenuEntry key={key} item={item} />;
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

function LegacyOAuthCredentialsSection() {
  const { t } = useTranslation();
  const providersLoadable = useLastLoadable(personalConfiguredProviders$);
  const modelCapabilitiesLoadable = useLastLoadable(modelPlanCapabilities$);
  const openBillingPlans = useSet(openSettingsBillingPlans$);
  const openClaudeCodeDeviceAuthDialog = useSet(
    openClaudeCodeDeviceAuthDialogPersonal$,
  );
  const openCodexDeviceAuthDialog = useSet(openCodexDeviceAuthDialogPersonal$);
  const disconnectCredential = useSet(disconnectPersonalOAuthCredential$);
  const setResetDialog = useSet(setSettingsCodexResetDialog$);
  const actionLoadable = useLoadable(personalActionPromise$);
  const pageSignal = useGet(pageSignal$);

  const isLoading =
    providersLoadable.state === "loading" ||
    modelCapabilitiesLoadable.state === "loading";
  const providers =
    providersLoadable.state === "hasData" ? providersLoadable.data : [];
  const supportByok =
    modelCapabilitiesLoadable.state !== "hasData" ||
    modelCapabilitiesLoadable.data.supportByok;
  const claudeCode = findProvider(providers, "claude-code-oauth-token");
  const openAI = findProvider(providers, "codex-oauth-token");
  const openAIStatus = getOpenAIStatus(openAI);
  const actionPending = actionLoadable.state === "loading";
  const codexResetCredits = openAI?.subscriptionResetCredits ?? null;
  const providerActionLabel = supportByok
    ? t(($) => {
        return $.settings.shared.connect;
      })
    : t(($) => {
        return $.settings.models.actions.upgradePro;
      });

  const connectClaudeCode = () => {
    if (!supportByok) {
      openBillingPlans();
      return;
    }
    const args = claudeCode?.needsReconnect
      ? {
          mode: "reconnect" as const,
          modelProviderId: claudeCode.id,
        }
      : { mode: "connect" as const };
    detach(
      openClaudeCodeDeviceAuthDialog(args, pageSignal),
      Reason.DomCallback,
    );
  };
  const connectOpenAI = () => {
    if (!supportByok) {
      openBillingPlans();
      return;
    }
    const args = openAI?.needsReconnect
      ? {
          mode: "reconnect" as const,
          modelProviderId: openAI.id,
        }
      : { mode: "connect" as const };
    detach(openCodexDeviceAuthDialog(args, pageSignal), Reason.DomCallback);
  };

  return (
    <section className="flex flex-col gap-4">
      <PersonalModelsHeading />
      <div
        className="overflow-hidden rounded-xl bg-card"
        style={{
          border: "var(--border-width-surface) solid hsl(var(--gray-400))",
        }}
      >
        {isLoading ? (
          <>
            <OAuthCredentialRowSkeleton />
            <OAuthCredentialRowSkeleton />
          </>
        ) : (
          <>
            <ClaudeOAuthCredentialRow
              actionPending={actionPending}
              actionLabel={providerActionLabel}
              provider={claudeCode}
              status={getOpenAIStatus(claudeCode)}
              onAction={connectClaudeCode}
              onDisconnect={() => {
                detach(
                  disconnectCredential("claude-code-oauth-token", pageSignal),
                  Reason.DomCallback,
                );
              }}
            />
            <CodexOAuthCredentialRow
              actionPending={actionPending}
              actionLabel={providerActionLabel}
              provider={openAI}
              resetCredits={codexResetCredits}
              status={openAIStatus}
              onAction={connectOpenAI}
              onDisconnect={() => {
                detach(
                  disconnectCredential("codex-oauth-token", pageSignal),
                  Reason.DomCallback,
                );
              }}
              onOpenReset={() => {
                setResetDialog({
                  open: true,
                  resetCredits: codexResetCredits,
                  accountId: null,
                });
              }}
            />
            <CodexResetDialogController
              actionPending={actionPending}
              mode="legacy"
            />
          </>
        )}
      </div>
    </section>
  );
}

function CodexResetDialogController({
  actionPending,
  mode,
}: {
  readonly actionPending: boolean;
  readonly mode: "account" | "legacy";
}) {
  const resetDialog = useGet(settingsCodexResetDialog$);
  const setResetDialog = useSet(setSettingsCodexResetDialog$);
  const resetCodexAccount = useSet(resetPersonalCodexAccountSubscriptionUsage$);
  const resetCodexSubscriptionUsage = useSet(
    resetPersonalCodexSubscriptionUsage$,
  );
  const pageSignal = useGet(pageSignal$);

  const confirmReset = () => {
    const resetPromise =
      mode === "account"
        ? resetDialog.accountId
          ? resetCodexAccount(resetDialog.accountId, pageSignal)
          : null
        : resetCodexSubscriptionUsage(pageSignal);
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

function ClaudeOAuthCredentialRow({
  actionPending,
  actionLabel,
  provider,
  status,
  onAction,
  onDisconnect,
}: {
  actionPending: boolean;
  actionLabel: string;
  provider: ModelProviderResponse | undefined;
  status: OAuthStatus;
  onAction: () => void;
  onDisconnect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <OAuthCredentialRow
      type="claude-code-oauth-token"
      title={t(($) => {
        return $.settings.models.personal.claudeTitle;
      })}
      description={t(($) => {
        return $.settings.models.personal.claudeDescription;
      })}
      provider={provider}
      status={status}
      actionLabel={actionLabel}
      menuItems={
        provider
          ? [
              {
                label: t(($) => {
                  return $.settings.shared.replace;
                }),
                onSelect: onAction,
                opensModal: true,
              },
              {
                label: t(($) => {
                  return $.settings.shared.disconnect;
                }),
                disabled: actionPending,
                onSelect: onDisconnect,
              },
            ]
          : []
      }
      onAction={onAction}
      testId="oauth-card-claude-code-oauth-token"
    />
  );
}

function CodexOAuthCredentialRow({
  actionPending,
  actionLabel,
  provider,
  resetCredits,
  status,
  onAction,
  onDisconnect,
  onOpenReset,
}: {
  actionPending: boolean;
  actionLabel: string;
  provider: ModelProviderResponse | undefined;
  resetCredits: number | null;
  status: OAuthStatus;
  onAction: () => void;
  onDisconnect: () => void;
  onOpenReset: () => void;
}) {
  const { t } = useTranslation();
  const resetCreditLabel = formatCodexResetCredits(
    resetCredits,
    provider?.subscriptionResetCreditsNextExpiresAt,
  );
  return (
    <OAuthCredentialRow
      type="codex-oauth-token"
      title={t(($) => {
        return $.settings.models.personal.codexTitle;
      })}
      description={t(($) => {
        return $.settings.models.personal.codexDescription;
      })}
      provider={provider}
      status={status}
      actionLabel={actionLabel}
      menuItems={
        provider
          ? [
              {
                kind: "status",
                label: resetCreditLabel,
              },
              {
                kind: "separator",
              },
              {
                label: t(($) => {
                  return $.settings.models.actions.resetUsage;
                }),
                disabled: actionPending || resetCredits === 0,
                onSelect: onOpenReset,
                opensModal: true,
              },
              {
                label: t(($) => {
                  return $.settings.shared.replace;
                }),
                onSelect: onAction,
                opensModal: true,
              },
              {
                label: t(($) => {
                  return $.settings.shared.disconnect;
                }),
                disabled: actionPending,
                onSelect: onDisconnect,
              },
            ]
          : []
      }
      onAction={onAction}
      testId="oauth-card-codex-oauth-token"
    />
  );
}

function findProvider(
  providers: ModelProviderResponse[],
  type: ModelProviderType,
): ModelProviderResponse | undefined {
  return providers.find((provider) => {
    return provider.type === type;
  });
}

function getOpenAIStatus(
  provider: ModelProviderResponse | undefined,
): OAuthStatus {
  if (provider?.needsReconnect) {
    return "stale";
  }
  return provider ? "connected" : "missing";
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

function formatConnectedStatusDetail(
  provider: ModelProviderResponse,
): string | null {
  const details = [formatSubscriptionPlan(provider)].filter(
    (detail): detail is string => {
      return detail !== null;
    },
  );

  if (details.length === 0) {
    return null;
  }
  return details.join(", ");
}

function hasUsageWindow(
  window: SubscriptionUsage["fiveHour"],
): window is SubscriptionUsageWindow {
  return (
    window !== null &&
    (window.remainingPercent !== null ||
      window.usedPercent !== null ||
      window.resetAt !== null)
  );
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
  if (usageWindows(provider.subscriptionUsage).length > 0) {
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

function usageWindows(usage: SubscriptionUsage | null | undefined): readonly {
  readonly kind: "fiveHour" | "week";
  readonly window: SubscriptionUsageWindow;
}[] {
  return [
    { kind: "fiveHour" as const, window: usage?.fiveHour ?? null },
    { kind: "week" as const, window: usage?.weekly ?? null },
  ].filter(
    (
      item,
    ): item is {
      kind: "fiveHour" | "week";
      window: SubscriptionUsageWindow;
    } => {
      return hasUsageWindow(item.window);
    },
  );
}

function usageTone(remainingPercent: number | null): {
  readonly barClassName: string;
  readonly ringClassName: string;
  readonly ringTrackClassName: string;
  readonly textClassName: string;
  readonly trackClassName: string;
} {
  if (remainingPercent !== null && remainingPercent < 20) {
    return {
      barClassName: "bg-red-500",
      ringClassName: "stroke-red-500",
      ringTrackClassName: "stroke-red-500/15",
      textClassName: "text-red-600 dark:text-red-400",
      trackClassName: "bg-red-500/15",
    };
  }
  if (remainingPercent !== null && remainingPercent < 50) {
    return {
      barClassName: "bg-amber-500",
      ringClassName: "stroke-amber-500",
      ringTrackClassName: "stroke-amber-500/15",
      textClassName: "text-amber-600 dark:text-amber-400",
      trackClassName: "bg-amber-500/15",
    };
  }
  return {
    barClassName: "bg-emerald-500",
    ringClassName: "stroke-emerald-500",
    ringTrackClassName: "stroke-emerald-500/15",
    textClassName: "text-emerald-600 dark:text-emerald-400",
    trackClassName: "bg-emerald-500/15",
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
  const windows = usageWindows(usage);

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
        style={{
          backgroundColor: "hsl(var(--popover))",
          color: "hsl(var(--popover-foreground))",
        }}
        className="min-w-48 border shadow-md"
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

function SubscriptionUsageMeter({
  usage,
}: {
  usage: SubscriptionUsage | null | undefined;
}) {
  const { t } = useTranslation();
  const windows = usageWindows(usage);

  if (windows.length === 0) {
    return null;
  }

  return (
    <div className="w-full rounded-lg bg-muted/30 px-3 py-2.5">
      <div className="space-y-2">
        {windows.map(({ kind, window }) => {
          const windowLabel =
            kind === "week"
              ? t(($) => {
                  return $.settings.models.personal.status.week;
                })
              : t(($) => {
                  return $.settings.models.personal.status.fiveHour;
                });
          const remainingPercent =
            window.remainingPercent ??
            (window.usedPercent === null ? null : 100 - window.usedPercent);
          const displayPercent = formatUsagePercent(remainingPercent);
          const reset = formatSubscriptionUsageReset(window.resetAt);
          const tone = usageTone(remainingPercent);
          return (
            <div key={kind} className="space-y-1">
              <div className="flex min-w-0 items-center justify-between gap-2 text-[11px] leading-none">
                <span className="font-medium text-foreground">
                  {windowLabel}
                </span>
                {displayPercent ? (
                  <span className={`font-medium ${tone.textClassName}`}>
                    {t(
                      ($) => {
                        return $.settings.models.personal.status.left;
                      },
                      {
                        percent: displayPercent,
                      },
                    )}
                  </span>
                ) : null}
              </div>
              <div
                className={`h-1.5 overflow-hidden rounded-full ${tone.trackClassName}`}
              >
                <span
                  className={`block h-full rounded-full transition-[width] ${tone.barClassName}`}
                  style={{
                    width:
                      remainingPercent === null
                        ? "0%"
                        : `${Math.min(100, Math.max(0, remainingPercent))}%`,
                  }}
                />
              </div>
              {reset !== null ? (
                "fallbackText" in reset ? (
                  <div className="truncate text-[10px] leading-none text-muted-foreground">
                    {reset.fallbackText}
                  </div>
                ) : (
                  <div className="flex min-w-0 items-center justify-between gap-2 text-[10px] leading-none text-muted-foreground">
                    <span className="min-w-0 truncate">
                      {reset.absoluteResetText}
                    </span>
                    <span className="shrink-0 rounded bg-background/70 px-1.5 py-0.5 font-medium text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border)/0.6)]">
                      {reset.relativeText}
                    </span>
                  </div>
                )
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

type OAuthMenuItem =
  | {
      readonly kind: "separator";
    }
  | {
      readonly kind: "status";
      readonly label: string;
    }
  | {
      readonly kind?: "item";
      readonly label: string;
      readonly disabled?: boolean;
      readonly onSelect?: () => void;
      readonly opensModal?: boolean;
    };

function OAuthMenuEntry({ item }: { item: OAuthMenuItem }) {
  if (item.kind === "separator") {
    return <DropdownMenuSeparator />;
  }
  if (item.kind === "status") {
    return (
      <DropdownMenuItem
        disabled
        className="text-xs text-muted-foreground data-[disabled]:opacity-100"
      >
        {item.label}
      </DropdownMenuItem>
    );
  }
  if (item.opensModal && item.onSelect) {
    return (
      <DropdownMenuItem disabled={item.disabled} onClick={item.onSelect}>
        {item.label}
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuItem
      disabled={item.disabled}
      onClick={() => {
        item.onSelect?.();
      }}
    >
      {item.label}
    </DropdownMenuItem>
  );
}

function OAuthCredentialRow({
  type,
  title,
  description,
  provider,
  status,
  actionLabel,
  disabled = false,
  menuItems,
  onAction,
  testId,
}: {
  type: ModelProviderType;
  title: string;
  description: string;
  provider: ModelProviderResponse | undefined;
  status: OAuthStatus;
  actionLabel: string;
  disabled?: boolean;
  menuItems: OAuthMenuItem[];
  onAction: () => void;
  testId: string;
}) {
  const { t } = useTranslation();
  const connectedDetail = provider
    ? formatConnectedStatusDetail(provider)
    : null;
  const usage = provider ? fallbackSubscriptionUsage(provider) : null;
  return (
    <div
      data-testid={testId}
      className="px-5 py-4 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-border/50"
    >
      <div className="flex items-center gap-3">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          <ProviderIcon type={type} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p
            data-testid="connector-card-label"
            className="truncate text-sm font-medium text-foreground"
          >
            {title}
          </p>
          <p
            data-testid="connector-help-text"
            className="mt-0.5 truncate text-xs text-muted-foreground"
          >
            {description}
          </p>
        </div>
        {status === "missing" ? (
          <Button
            type="button"
            variant="neutral"
            size="sm"
            className="h-9 shrink-0 rounded-lg"
            aria-label={t(
              ($) => {
                return $.settings.models.personal.actionForProvider;
              },
              {
                action: actionLabel,
                provider: title,
              },
            )}
            disabled={disabled}
            onClick={onAction}
          >
            {actionLabel}
          </Button>
        ) : (
          <div className="ml-auto flex items-center justify-end gap-1.5">
            <OAuthFooterStatus
              status={status}
              detail={status === "connected" ? connectedDetail : null}
            />
            {menuItems.length > 0 && (
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
                    const key =
                      item.kind === "separator" ? "separator" : item.label;
                    return <OAuthMenuEntry key={key} item={item} />;
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
      </div>
      {status === "connected" && usageWindows(usage).length > 0 ? (
        <div className="mt-3">
          <SubscriptionUsageMeter usage={usage} />
        </div>
      ) : null}
    </div>
  );
}

function OAuthFooterStatus({
  status,
  detail,
}: {
  status: OAuthStatus;
  detail: string | null;
}) {
  const { t } = useTranslation();
  if (status === "connected") {
    return (
      <span className="flex min-w-0 items-center gap-2 truncate text-xs text-muted-foreground">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
        <span className="min-w-0 truncate">
          {detail
            ? t(
                ($) => {
                  return $.settings.models.personal.status.connectedWithDetail;
                },
                {
                  detail,
                },
              )
            : t(($) => {
                return $.settings.models.personal.status.connected;
              })}
        </span>
      </span>
    );
  }
  if (status === "stale") {
    return (
      <span className="flex min-w-0 items-center gap-2 truncate text-xs text-amber-600 dark:text-amber-400">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
        {t(($) => {
          return $.settings.models.personal.status.stale;
        })}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2 text-xs text-muted-foreground truncate">
      {t(($) => {
        return $.settings.shared.connect;
      })}
    </span>
  );
}

function OAuthCredentialRowSkeleton() {
  return (
    <div
      data-testid="oauth-card-skeleton"
      className="flex animate-pulse items-center gap-3 px-5 py-4 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-border/50"
    >
      <span className="h-5 w-5 shrink-0 rounded bg-muted/50" />
      <div className="min-w-0 flex-1">
        <span className="block h-4 w-32 rounded bg-muted/50" />
        <span className="mt-1.5 block h-3 w-48 rounded bg-muted/30" />
      </div>
      <span className="h-9 w-20 shrink-0 rounded bg-muted/30" />
    </div>
  );
}
