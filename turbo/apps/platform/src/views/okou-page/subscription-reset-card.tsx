import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import { Button } from "@okouai/ui";
import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Loader2 } from "lucide-react";
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
  formatCodexResetCreditExpiry,
  formatSubscriptionUsageReset,
} from "./subscription-usage-format.ts";

export function SubscriptionResetCard({
  signals,
}: {
  readonly signals: SubscriptionResetSignals;
}) {
  return (
    <ChatCard className="h-[320px] w-full sm:h-[304px]">
      <SubscriptionResetCardContent signals={signals} />
    </ChatCard>
  );
}

function SubscriptionResetCardContent({
  signals,
}: {
  readonly signals: SubscriptionResetSignals;
}) {
  const { t } = useTranslation();
  const loadable = useLoadable(signals.status$);
  const last = useLastLoadable(signals.status$);
  const refresh = useSet(signals.refresh$);
  const status =
    loadable.state === "hasData"
      ? loadable.data
      : last.state === "hasData"
        ? last.data
        : null;
  if (status?.kind === "ready") {
    return (
      <ReadySubscriptionResetCard
        signals={signals}
        account={status.account}
        refreshing={loadable.state === "loading"}
        readFailed={loadable.state === "hasError"}
      />
    );
  }
  const message =
    status?.kind === "unavailable"
      ? t(($) => {
          return $.chat.subscriptionReset.unavailable;
        })
      : loadable.state === "hasError"
        ? t(($) => {
            return $.chat.subscriptionReset.loadFailed;
          })
        : t(($) => {
            return $.chat.subscriptionReset.loading;
          });
  return (
    <div className="flex h-full w-full flex-col justify-between gap-3 px-4 py-3">
      <h3 className="text-sm font-medium">
        {t(($) => {
          return $.chat.subscriptionReset.title;
        })}
      </h3>
      <p className="text-sm text-muted-foreground" role="status">
        {message}
      </p>
      <div className="flex justify-end">
        {loadable.state === "loading" ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-label={message} />
        ) : (
          <Button size="sm" variant="outline" onClick={refresh}>
            {t(($) => {
              return $.chat.subscriptionReset.retry;
            })}
          </Button>
        )}
      </div>
    </div>
  );
}

function UsageWindow({
  label,
  window,
}: {
  readonly label: string;
  readonly window:
    | NonNullable<ModelProviderResponse["subscriptionUsage"]>["fiveHour"]
    | undefined;
}) {
  const { t } = useTranslation();
  const remaining =
    window?.remainingPercent ??
    (window?.usedPercent === null || window?.usedPercent === undefined
      ? null
      : 100 - window.usedPercent);
  const percent =
    remaining === null || !Number.isFinite(remaining)
      ? t(($) => {
          return $.chat.subscriptionReset.unknown;
        })
      : formatLocalizedNumber(remaining / 100, {
          style: "percent",
          maximumFractionDigits: 1,
        });
  const reset = formatSubscriptionUsageReset(window?.resetAt ?? null);
  const time = reset
    ? "absoluteText" in reset
      ? reset.absoluteText
      : reset.fallbackText
    : t(($) => {
        return $.chat.subscriptionReset.unknown;
      });
  return (
    <div className="h-10 text-xs leading-5">
      <p>
        {t(
          ($) => {
            return $.chat.subscriptionReset.remaining;
          },
          { window: label, percent },
        )}
      </p>
      <p className="truncate text-muted-foreground" title={time}>
        {t(
          ($) => {
            return $.chat.subscriptionReset.resetAt;
          },
          { time },
        )}
      </p>
    </div>
  );
}

function ResetCreditDetails({
  account,
}: {
  readonly account: ModelProviderResponse;
}) {
  const { t } = useTranslation();
  const credits = account.subscriptionResetCredits;
  const expiry = formatCodexResetCreditExpiry(
    account.subscriptionResetCreditsNextExpiresAt,
  );
  return (
    <div className="h-10 text-xs leading-5">
      <p>
        {credits === null || credits === undefined
          ? t(($) => {
              return $.chat.subscriptionReset.creditsUnknown;
            })
          : t(
              ($) => {
                return $.chat.subscriptionReset.credits;
              },
              { count: credits },
            )}
      </p>
      {expiry ? (
        <p
          className="truncate text-muted-foreground"
          title={expiry.absoluteText}
        >
          {t(
            ($) => {
              return $.chat.subscriptionReset.expiresAt;
            },
            { time: expiry.absoluteText },
          )}
        </p>
      ) : null}
    </div>
  );
}

function resetSupported(account: ModelProviderResponse): boolean {
  return (
    account.type === "codex-oauth-token" &&
    account.subscriptionResetSupported === true
  );
}

function useResetNotice(
  account: ModelProviderResponse,
  actionState: SubscriptionResetActionState,
  readFailed: boolean,
): string {
  const { t } = useTranslation();
  if (readFailed) {
    return t(($) => {
      return $.chat.subscriptionReset.loadFailed;
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
    case "idle":
    case "loading": {
      return account.subscriptionResetCredits === 0
        ? t(($) => {
            return $.chat.subscriptionReset.noCredit;
          })
        : "";
    }
  }
}

function SubscriptionResetControls({
  signals,
  account,
  refreshing,
  readFailed,
}: {
  readonly signals: SubscriptionResetSignals;
  readonly account: ModelProviderResponse;
  readonly refreshing: boolean;
  readonly readFailed: boolean;
}) {
  const { t } = useTranslation();
  const actionState = useGet(signals.actionState$);
  const pageSignal = useGet(pageSignal$);
  const [, confirm] = useLoadableSet(signals.confirm$);
  const refresh = useSet(signals.refresh$);
  const notice = useResetNotice(account, actionState, readFailed);
  const pending = actionState === "loading";
  const terminal =
    actionState !== "idle" && actionState !== "error" && !pending;
  const credits = account.subscriptionResetCredits;
  const resetDisabled =
    pending ||
    terminal ||
    refreshing ||
    readFailed ||
    account.needsReconnect ||
    (actionState !== "error" && !(credits && credits > 0));
  return (
    <>
      <p className="h-12 text-xs leading-4 text-muted-foreground" role="status">
        {notice}
      </p>
      <div className="flex h-9 items-center justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={refresh}
          disabled={pending || refreshing}
        >
          {t(($) => {
            return $.chat.subscriptionReset.retry;
          })}
        </Button>
        {resetSupported(account) ? (
          <Button
            size="sm"
            disabled={resetDisabled}
            title={t(($) => {
              return $.chat.subscriptionReset.confirmation;
            })}
            onClick={() => {
              detach(confirm(pageSignal), Reason.DomCallback);
            }}
          >
            {pending
              ? t(($) => {
                  return $.chat.subscriptionReset.resetting;
                })
              : t(($) => {
                  return $.chat.subscriptionReset.confirm;
                })}
          </Button>
        ) : null}
      </div>
    </>
  );
}

function ReadySubscriptionResetCard({
  signals,
  account,
  refreshing,
  readFailed,
}: {
  readonly signals: SubscriptionResetSignals;
  readonly account: ModelProviderResponse;
  readonly refreshing: boolean;
  readonly readFailed: boolean;
}) {
  const { t } = useTranslation();
  const identity = t(
    ($) => {
      return $.chat.subscriptionReset.account;
    },
    {
      provider: account.type === "codex-oauth-token" ? "Codex" : "Claude Code",
      account: account.accountEmail ?? account.id,
      plan:
        account.planType ??
        t(($) => {
          return $.chat.subscriptionReset.unknown;
        }),
    },
  );
  return (
    <div className="flex h-full w-full flex-col justify-between gap-1 px-4 py-3">
      <h3 className="text-sm font-medium">
        {t(($) => {
          return $.chat.subscriptionReset.title;
        })}
      </h3>
      <p className="truncate text-xs text-muted-foreground" title={identity}>
        {identity}
      </p>
      <UsageWindow
        label={t(($) => {
          return $.chat.subscriptionReset.fiveHour;
        })}
        window={account.subscriptionUsage?.fiveHour}
      />
      <UsageWindow
        label={t(($) => {
          return $.chat.subscriptionReset.weekly;
        })}
        window={account.subscriptionUsage?.weekly}
      />
      <ResetCreditDetails account={account} />
      <SubscriptionResetControls
        signals={signals}
        account={account}
        refreshing={refreshing}
        readFailed={readFailed}
      />
    </div>
  );
}
