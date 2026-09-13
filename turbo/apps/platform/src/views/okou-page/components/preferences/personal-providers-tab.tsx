import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { EllipsisVertical, Plus, RotateCcw } from "lucide-react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui";
import type {
  ModelProviderResponse,
  ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  activatePersonalOAuthCredentialAccount$,
  deletePersonalOAuthCredentialAccount$,
  disconnectPersonalOAuthCredential$,
  personalActionPromise$,
  personalConfiguredProviders$,
  resetPersonalCodexAccountSubscriptionUsage$,
  resetPersonalCodexSubscriptionUsage$,
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
import { ProviderIcon } from "../settings/provider-icons.tsx";
import { PersonalClaudeCodeDeviceAuthDialog } from "../settings/claude-code-device-auth-dialog.tsx";
import { PersonalCodexDeviceAuthDialog } from "../settings/codex-device-auth-dialog.tsx";
import { SettingsSectionHeading } from "../settings/settings-section-heading.tsx";
import { DropdownMenuModalItem } from "../../../components/dropdown-menu-modal-item.tsx";
import { formatSubscriptionUsageReset } from "../../subscription-usage-format.ts";
import {
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

function PersonalModelsHeading() {
  const { t } = useTranslation();
  return (
    <SettingsSectionHeading
      title={t(($) => {
        return $.settings.models.personal.sectionTitle;
      })}
      description={t(($) => {
        return $.settings.models.personal.description;
      })}
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
  const deleteAccount = useSet(deletePersonalOAuthCredentialAccount$);
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

  const openAccountAuth = (
    type: ModelProviderType,
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

  return (
    <section className="flex flex-col gap-4">
      <PersonalModelsHeading />
      <TooltipProvider delayDuration={100}>
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
            PERSONAL_ACCOUNT_PROVIDER_TYPES.map((type) => {
              return (
                <OAuthAccountGroup
                  key={type}
                  type={type}
                  accounts={providers.filter((provider) => {
                    return provider.type === type;
                  })}
                  actionPending={actionPending}
                  actionLabel={
                    supportByok
                      ? t(($) => {
                          return $.settings.models.personal.addAccount;
                        })
                      : t(($) => {
                          return $.settings.models.actions.upgradePro;
                        })
                  }
                  onAdd={() => {
                    openAccountAuth(type);
                  }}
                  onActivate={(id) => {
                    detach(activateAccount(id, pageSignal), Reason.DomCallback);
                  }}
                  onReconnect={(id) => {
                    openAccountAuth(type, id);
                  }}
                  onRemove={(id) => {
                    detach(deleteAccount(id, pageSignal), Reason.DomCallback);
                  }}
                  onReset={(account) => {
                    setResetDialog({
                      open: true,
                      resetCredits: account.subscriptionResetCredits ?? null,
                      accountId: account.id,
                    });
                  }}
                />
              );
            })
          )}
        </div>
      </TooltipProvider>
      <CodexResetDialogController
        actionPending={actionPending}
        mode="account"
      />
    </section>
  );
}

function OAuthAccountGroup({
  type,
  accounts,
  actionPending,
  actionLabel,
  onAdd,
  onActivate,
  onReconnect,
  onRemove,
  onReset,
}: {
  readonly type: ModelProviderType;
  readonly accounts: readonly ModelProviderResponse[];
  readonly actionPending: boolean;
  readonly actionLabel: string;
  readonly onAdd: () => void;
  readonly onActivate: (id: string) => void;
  readonly onReconnect: (id: string) => void;
  readonly onRemove: (id: string) => void;
  readonly onReset: (account: ModelProviderResponse) => void;
}) {
  const { t } = useTranslation();
  const isCodex = type === "codex-oauth-token";
  const title = isCodex
    ? t(($) => {
        return $.settings.models.personal.codexTitle;
      })
    : t(($) => {
        return $.settings.models.personal.claudeTitle;
      });
  const description = isCodex
    ? t(($) => {
        return $.settings.models.personal.codexDescription;
      })
    : t(($) => {
        return $.settings.models.personal.claudeDescription;
      });

  return (
    <div className="[&:not(:first-child)]:border-t [&:not(:first-child)]:border-border/50">
      <div className="flex items-center gap-3 px-5 py-4">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          <ProviderIcon type={type} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {title}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {description}
          </p>
        </div>
        <Button
          type="button"
          variant="neutral"
          size="sm"
          className="h-9 shrink-0 gap-1.5 rounded-lg"
          disabled={actionPending || accounts.length >= 10}
          onClick={onAdd}
        >
          <Plus size={14} />
          {actionLabel}
        </Button>
      </div>
      {accounts.length === 0 ? (
        <p className="border-t border-border/50 px-5 py-4 text-xs text-muted-foreground">
          {t(($) => {
            return $.settings.models.personal.noAccounts;
          })}
        </p>
      ) : (
        <div
          className="border-t border-border/50"
          role="radiogroup"
          aria-label={title}
        >
          {accounts.map((account, index) => {
            return (
              <OAuthAccountRow
                key={account.id}
                account={account}
                fallbackIndex={index + 1}
                actionPending={actionPending}
                onActivate={() => {
                  onActivate(account.id);
                }}
                onReconnect={() => {
                  onReconnect(account.id);
                }}
                onRemove={() => {
                  onRemove(account.id);
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
  );
}

function OAuthAccountRow({
  account,
  fallbackIndex,
  actionPending,
  onActivate,
  onReconnect,
  onRemove,
  onReset,
}: {
  readonly account: ModelProviderResponse;
  readonly fallbackIndex: number;
  readonly actionPending: boolean;
  readonly onActivate: () => void;
  readonly onReconnect: () => void;
  readonly onRemove: () => void;
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
  return (
    <div
      data-testid={`oauth-account-${account.id}`}
      className={`relative px-5 py-3.5 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-border/40 ${account.isActive ? "bg-gray-50" : ""}`}
    >
      {account.isActive ? (
        <span
          aria-hidden="true"
          className="absolute inset-y-3 left-0 w-[3px] rounded-r-full bg-foreground"
        />
      ) : null}
      <div className="grid grid-cols-[1.75rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1 sm:flex sm:gap-3">
        <Button
          showTooltip
          type="button"
          role="radio"
          variant="quiet"
          size="icon-xs"
          className="shrink-0 rounded-full border border-border hover:border-foreground/40 disabled:cursor-default disabled:opacity-100"
          aria-label={
            account.isActive
              ? t(($) => {
                  return $.settings.models.personal.activeAccount;
                })
              : t(($) => {
                  return $.settings.models.personal.useAccount;
                })
          }
          aria-checked={account.isActive}
          disabled={account.isActive || actionPending}
          onClick={onActivate}
        >
          {account.isActive ? (
            <span className="h-2 w-2 rounded-full bg-foreground" />
          ) : null}
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {plan ? (
            <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-brand-text">
              {plan}
            </span>
          ) : null}
          {detail ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  className="min-w-0 truncate rounded-md px-1 py-0.5 -mx-1 -my-0.5 text-sm font-medium text-foreground outline-none transition-colors hover:bg-state-hover focus-visible:bg-state-hover"
                >
                  {identity}
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="start" sideOffset={8}>
                {detail}
              </TooltipContent>
            </Tooltip>
          ) : (
            <span className="min-w-0 truncate text-sm font-medium text-foreground">
              {identity}
            </span>
          )}
          {account.needsReconnect ? (
            <span className="shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
              {t(($) => {
                return $.settings.models.personal.status.stale;
              })}
            </span>
          ) : null}
        </div>
        <div className="col-start-2 flex min-w-0 items-center justify-end gap-3 sm:ml-auto sm:shrink-0">
          {account.type === "codex-oauth-token" ? (
            <OAuthAccountResetCredits account={account} />
          ) : null}
          {!account.needsReconnect ? (
            <SubscriptionUsageRings identity={identity} usage={usage} />
          ) : null}
          <OAuthAccountMenu
            account={account}
            actionPending={actionPending}
            onReconnect={onReconnect}
            onRemove={onRemove}
            onReset={onReset}
          />
        </div>
      </div>
    </div>
  );
}

function OAuthAccountResetCredits({
  account,
}: {
  readonly account: ModelProviderResponse;
}) {
  const { t } = useTranslation();
  const resetCredits = account.subscriptionResetCredits ?? null;
  const label = formatCodexResetCredits(resetCredits);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label={label}
          className="mr-auto flex h-7 min-w-0 cursor-default items-center gap-1.5 rounded-md px-1 text-xs tabular-nums text-muted-foreground outline-none transition-colors hover:bg-state-hover focus-visible:bg-state-hover sm:mr-0"
        >
          <RotateCcw size={14} className="shrink-0" aria-hidden />
          <span className="truncate">
            {resetCredits === null
              ? t(($) => {
                  return $.settings.models.reset.remainingUnknown;
                })
              : label}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="end"
        sideOffset={8}
        className="border shadow-md"
        style={{
          backgroundColor: "hsl(var(--popover))",
          color: "hsl(var(--popover-foreground))",
        }}
      >
        {formatCodexResetCredits(
          resetCredits,
          account.subscriptionResetCreditsNextExpiresAt,
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function OAuthAccountMenu({
  account,
  actionPending,
  onReconnect,
  onRemove,
  onReset,
}: {
  readonly account: ModelProviderResponse;
  readonly actionPending: boolean;
  readonly onReconnect: () => void;
  readonly onRemove: () => void;
  readonly onReset: () => void;
}) {
  const { t } = useTranslation();
  const resetCredits = account.subscriptionResetCredits ?? null;
  const menuItems: OAuthMenuItem[] = [
    ...(account.type === "codex-oauth-token"
      ? [
          {
            kind: "status" as const,
            label: formatCodexResetCredits(
              resetCredits,
              account.subscriptionResetCreditsNextExpiresAt,
            ),
          },
          { kind: "separator" as const },
          {
            label: t(($) => {
              return $.settings.models.actions.resetUsage;
            }),
            disabled: actionPending || resetCredits === 0,
            onSelect: onReset,
            opensModal: true,
          },
        ]
      : []),
    {
      label: t(($) => {
        return $.settings.models.personal.reconnectAccount;
      }),
      disabled: actionPending,
      onSelect: onReconnect,
      opensModal: true,
    },
    ...(!account.isActive
      ? [
          {
            label: t(($) => {
              return $.settings.models.personal.removeAccount;
            }),
            disabled: actionPending,
            onSelect: onRemove,
          },
        ]
      : []),
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          showTooltip
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:bg-state-hover hover:text-foreground"
          aria-label={t(($) => {
            return $.settings.shared.moreOptions;
          })}
        >
          <EllipsisVertical size={14} />
        </Button>
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
  identity,
  usage,
}: {
  readonly identity: string;
  readonly usage: SubscriptionUsage | null | undefined;
}) {
  const windows = usageWindows(usage);

  if (windows.length === 0) {
    return null;
  }

  return (
    <span className="ml-auto flex min-w-16 shrink-0 items-center justify-end gap-1.5">
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
      <TooltipTrigger asChild>
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
      </TooltipTrigger>
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
      <DropdownMenuModalItem
        disabled={item.disabled}
        onModalSelect={item.onSelect}
      >
        {item.label}
      </DropdownMenuModalItem>
    );
  }
  return (
    <DropdownMenuItem
      disabled={item.disabled}
      onSelect={() => {
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
                <DropdownMenuTrigger asChild>
                  <Button
                    showTooltip
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:bg-state-hover hover:text-foreground"
                    aria-label={t(($) => {
                      return $.settings.shared.moreOptions;
                    })}
                  >
                    <EllipsisVertical size={14} />
                  </Button>
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
