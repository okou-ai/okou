import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import {
  Badge,
  Button,
  IconButton,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui";
import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Loader2, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { formatLocalizedNumber } from "../../i18n/format.ts";
import type {
  SubscriptionResetActionState,
  SubscriptionResetSignals,
} from "../../signals/chat-page/subscription-reset-block.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ChatCard } from "./components/chat-card.tsx";
import {
  fallbackSubscriptionUsage,
  formatAccountUsageReset,
  SubscriptionUsageRings,
} from "./components/preferences/subscription-usage-rings.tsx";
import { ConnectorEntryStatus } from "./components/settings/connector-entry-card.tsx";
import { ProviderIcon } from "./components/settings/provider-icons.tsx";
import { formatCodexResetCreditExpiry } from "./subscription-usage-format.ts";

export function SubscriptionResetCard({
  signals,
}: {
  readonly signals: SubscriptionResetSignals;
}) {
  return (
    <div className="@container w-full">
      <ChatCard
        data-testid="subscription-reset-card-shell"
        className="h-[136px] w-full @[640px]:h-[88px]"
      >
        <SubscriptionResetCardContent signals={signals} />
      </ChatCard>
    </div>
  );
}

function resetSupported(account: ModelProviderResponse | null): boolean {
  return (
    account?.type === "codex-oauth-token" &&
    account.subscriptionResetSupported === true
  );
}

function useResetNotice(
  account: ModelProviderResponse | null,
  actionState: SubscriptionResetActionState,
  readFailed: boolean,
  unavailable: boolean,
): string | null {
  const { t } = useTranslation();
  if (readFailed) {
    return t(($) => {
      return $.chat.subscriptionReset.loadFailed;
    });
  }
  if (unavailable) {
    return t(($) => {
      return $.chat.subscriptionReset.unavailable;
    });
  }
  if (!account) {
    return t(($) => {
      return $.chat.subscriptionReset.loading;
    });
  }
  if (!resetSupported(account)) {
    return t(($) => {
      return $.chat.subscriptionReset.unsupported;
    });
  }
  if (account.needsReconnect) {
    return t(($) => {
      return $.chat.subscriptionReset.reconnect;
    });
  }
  switch (actionState) {
    case "error": {
      return t(($) => {
        return $.chat.subscriptionReset.error;
      });
    }
    case "reset": {
      return t(($) => {
        return $.chat.subscriptionReset.reset;
      });
    }
    case "nothingToReset": {
      return t(($) => {
        return $.chat.subscriptionReset.nothingToReset;
      });
    }
    case "noCredit": {
      return t(($) => {
        return $.chat.subscriptionReset.noCredit;
      });
    }
    case "alreadyRedeemed": {
      return t(($) => {
        return $.chat.subscriptionReset.alreadyRedeemed;
      });
    }
    case "loading": {
      return t(($) => {
        return $.chat.subscriptionReset.resetting;
      });
    }
    case "idle": {
      return account.subscriptionResetCredits === 0
        ? t(($) => {
            return $.chat.subscriptionReset.noCredit;
          })
        : null;
    }
  }
}

function SubscriptionResetCardContent({
  signals,
}: {
  readonly signals: SubscriptionResetSignals;
}) {
  const loadable = useLoadable(signals.status$);
  const last = useLastLoadable(signals.status$);
  const actionState = useGet(signals.actionState$);
  const status =
    loadable.state === "hasData"
      ? loadable.data
      : last.state === "hasData"
        ? last.data
        : null;
  const account = status?.kind === "ready" ? status.account : null;
  const refreshing = loadable.state === "loading";
  const readFailed = loadable.state === "hasError";
  const notice = useResetNotice(
    account,
    actionState,
    readFailed,
    status?.kind === "unavailable",
  );
  return (
    <TooltipProvider delay={100}>
      <div
        data-testid="subscription-reset-card"
        aria-busy={refreshing || actionState === "loading"}
        className="flex h-full w-full flex-col justify-between gap-3 p-3 text-left @[640px]:flex-row @[640px]:items-center"
      >
        <SubscriptionResetIdentity
          account={account}
          notice={notice}
          loading={refreshing && !account}
        />
        <SubscriptionResetControls
          signals={signals}
          account={account}
          actionState={actionState}
          refreshing={refreshing}
          readFailed={readFailed}
          notice={notice}
        />
      </div>
    </TooltipProvider>
  );
}

function SubscriptionResetIdentity({
  account,
  notice,
  loading,
}: {
  readonly account: ModelProviderResponse | null;
  readonly notice: string | null;
  readonly loading: boolean;
}) {
  const { t } = useTranslation();
  const labels = useResetIdentity(account);
  return (
    <SubscriptionResetIdentityContent
      account={account}
      notice={notice}
      loading={loading}
      labels={labels}
      connected={t(($) => {
        return $.settings.models.personal.status.connected;
      })}
    />
  );
}

function useResetIdentity(account: ModelProviderResponse | null) {
  const { t } = useTranslation();
  const provider =
    account?.type === "codex-oauth-token" ? "Codex" : "Claude Code";
  const identity =
    account?.accountEmail ?? account?.workspaceName ?? account?.id;
  const plan = account?.planType?.trim();
  const title = account
    ? t(
        ($) => {
          return $.chat.subscriptionReset.account;
        },
        {
          provider,
          account: identity,
          plan:
            plan ??
            t(($) => {
              return $.chat.subscriptionReset.unknown;
            }),
        },
      )
    : t(($) => {
        return $.chat.subscriptionReset.title;
      });
  const reset = account ? formatAccountUsageReset(account) : null;
  const recovery = reset && "tooltipTitle" in reset ? reset.tooltipTitle : null;
  const absolute =
    reset && "absoluteText" in reset ? reset.absoluteText : undefined;
  return { provider, identity, plan, title, recovery, absolute };
}

function SubscriptionResetIdentityContent({
  account,
  notice,
  loading,
  labels: { provider, identity, plan, title, recovery, absolute },
  connected,
}: {
  readonly account: ModelProviderResponse | null;
  readonly notice: string | null;
  readonly loading: boolean;
  readonly labels: ReturnType<typeof useResetIdentity>;
  readonly connected: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-gray-50">
        {account ? (
          <ProviderIcon type={account.type} size={22} />
        ) : (
          <Skeleton className="size-5 rounded-md" />
        )}
      </div>
      <div className="min-w-0">
        <div className="flex h-5 min-w-0 items-center gap-2 text-sm font-medium">
          {loading ? (
            <Skeleton className="h-3 w-40 max-w-full" />
          ) : (
            <span className="min-w-0 truncate" title={title}>
              {account ? `${provider} · ${identity}` : title}
            </span>
          )}
          {plan ? (
            <Badge className="shrink-0 text-[11px] font-normal text-muted-foreground">
              {plan.charAt(0).toUpperCase() + plan.slice(1)}
            </Badge>
          ) : null}
        </div>
        <div className="mt-0.5 flex h-5 min-w-0 items-center gap-1 text-xs leading-5 text-muted-foreground">
          {notice ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <div
                    role="status"
                    className="min-w-0 truncate"
                    title={notice}
                  >
                    {notice}
                  </div>
                }
              />
              <TooltipContent>{notice}</TooltipContent>
            </Tooltip>
          ) : (
            <>
              <ConnectorEntryStatus
                label={connected}
                tone="success"
                className="shrink-0 gap-1 text-xs"
              />
              {recovery ? (
                <span className="min-w-0 truncate" title={absolute}>
                  · {recovery}
                </span>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function resetActionDisabled(
  account: ModelProviderResponse | null,
  actionState: SubscriptionResetActionState,
  readUnavailable: boolean,
): boolean {
  const terminal = actionState !== "idle" && actionState !== "error";
  const credits = account?.subscriptionResetCredits;
  return (
    terminal ||
    readUnavailable ||
    account?.needsReconnect === true ||
    (actionState !== "error" && !(credits && credits > 0))
  );
}

function useResetCreditLabel(account: ModelProviderResponse | null): string {
  const { t } = useTranslation();
  const credits = account?.subscriptionResetCredits;
  return credits === null || credits === undefined
    ? t(($) => {
        return $.chat.subscriptionReset.creditsUnknown;
      })
    : t(
        ($) => {
          return $.chat.subscriptionReset.credits;
        },
        { count: credits },
      );
}

function SubscriptionResetDetails({
  account,
  notice,
}: {
  readonly account: ModelProviderResponse;
  readonly notice: string | null;
}) {
  const { t } = useTranslation();
  const credits = useResetCreditLabel(account);
  const expiry =
    (account.subscriptionResetCredits ?? 0) > 0
      ? formatCodexResetCreditExpiry(
          account.subscriptionResetCreditsNextExpiresAt,
        )
      : null;
  return (
    <div className="space-y-2 border-t border-border pt-3 text-xs leading-5">
      <div className="break-all font-medium">
        {account.accountEmail ?? account.id}
      </div>
      <div>{credits}</div>
      {expiry ? (
        <div className="text-muted-foreground">
          {t(
            ($) => {
              return $.chat.subscriptionReset.expiresAt;
            },
            { time: expiry.absoluteText },
          )}
        </div>
      ) : null}
      {notice ? <div role="status">{notice}</div> : null}
      <div className="text-muted-foreground">
        {t(($) => {
          return $.chat.subscriptionReset.confirmation;
        })}
      </div>
    </div>
  );
}

function SubscriptionResetControls({
  signals,
  account,
  actionState,
  refreshing,
  readFailed,
  notice,
}: {
  readonly signals: SubscriptionResetSignals;
  readonly account: ModelProviderResponse | null;
  readonly actionState: SubscriptionResetActionState;
  readonly refreshing: boolean;
  readonly readFailed: boolean;
  readonly notice: string | null;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const [, confirm] = useLoadableSet(signals.confirm$);
  const refresh = useSet(signals.refresh$);
  const creditLabel = useResetCreditLabel(account);
  const pending = actionState === "loading";
  const credits = account?.subscriptionResetCredits;
  const disabled = resetActionDisabled(
    account,
    actionState,
    refreshing || readFailed,
  );
  const label = pending
    ? t(($) => {
        return $.chat.subscriptionReset.resetting;
      })
    : t(($) => {
        return $.chat.subscriptionReset.confirm;
      });
  return (
    <div className="flex h-9 w-full shrink-0 items-center justify-between gap-3 @[640px]:w-auto @[640px]:justify-end">
      <div className="flex min-w-16 shrink-0 items-center">
        {account ? (
          <SubscriptionUsageRings
            identity={account.accountEmail ?? account.id}
            usage={fallbackSubscriptionUsage(account)}
            className="ml-0"
            showUnknown
            details={
              <SubscriptionResetDetails account={account} notice={notice} />
            }
          />
        ) : (
          <div className="flex items-center gap-1.5" aria-hidden>
            <Skeleton className="size-7 rounded-full" />
            <Skeleton className="size-7 rounded-full" />
          </div>
        )}
      </div>
      <div className="flex h-9 shrink-0 items-center gap-2">
        <IconButton
          aria-label={t(($) => {
            return $.chat.subscriptionReset.retry;
          })}
          onClick={refresh}
          disabled={pending || refreshing}
          className="size-9 shrink-0 hover:bg-gray-50"
        >
          {refreshing ? (
            <Loader2 size={15} className="animate-spin" />
          ) : (
            <RotateCcw size={15} />
          )}
        </IconButton>
        <span className="sr-only">
          <span>{creditLabel}</span>
          <span>
            {t(($) => {
              return $.chat.subscriptionReset.confirmation;
            })}
          </span>
        </span>
        <div className="flex h-9 min-w-24 shrink-0 justify-end">
          {resetSupported(account) ? (
            <Button
              size="sm"
              variant="outline"
              aria-label={label}
              aria-description={`${creditLabel} ${t(($) => {
                return $.chat.subscriptionReset.confirmation;
              })}`}
              title={t(($) => {
                return $.chat.subscriptionReset.confirmation;
              })}
              disabled={disabled}
              className="h-9 min-w-24 shrink-0 gap-1.5"
              onClick={() => {
                detach(confirm(pageSignal), Reason.DomCallback);
              }}
            >
              {pending ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <RotateCcw size={14} />
              )}
              <span>{label}</span>
              <span aria-hidden>
                {credits === null || credits === undefined
                  ? "—"
                  : `· ${formatLocalizedNumber(credits)}`}
              </span>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
