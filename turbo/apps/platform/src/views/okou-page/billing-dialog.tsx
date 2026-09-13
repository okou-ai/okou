// TODO(#8609): split AutoRechargeSection to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import {
  useGet,
  useSet,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Input, Switch } from "@okouai/ui";
import {
  autoRechargeConfig$,
  autoRechargeDirty$,
  discardAutoRecharge$,
  pendingEnabled$,
  setPendingEnabled$,
  formThreshold$,
  formAmount$,
  setFormThreshold$,
  setFormAmount$,
  saveAutoRecharge$,
} from "../../signals/okou-page/billing.ts";
import { UnsavedBar } from "./components/org-manage/unsaved-bar.tsx";
import { formatUsd } from "../../i18n/format.ts";

const CREDITS_PER_DOLLAR = 1000;

const settingsCardBorder = {
  border: "var(--border-width-surface) solid hsl(var(--gray-400))",
} as const;

export function AutoRechargeSection({
  allowed,
  loading = false,
}: {
  allowed: boolean;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const configLoadable = useLastLoadable(autoRechargeConfig$);
  const config =
    configLoadable.state === "hasData"
      ? configLoadable.data
      : { enabled: false, threshold: "", amount: "" };

  const pendingEnabled = useGet(pendingEnabled$);
  const setPendingEnabled = useSet(setPendingEnabled$);

  const thresholdValue = useLastResolved(formThreshold$) ?? config.threshold;
  const amountValue = useLastResolved(formAmount$) ?? config.amount;
  const setThreshold = useSet(setFormThreshold$);
  const setAmount = useSet(setFormAmount$);

  const dirty = useLastResolved(autoRechargeDirty$) ?? false;
  const discard = useSet(discardAutoRecharge$);
  const [saveLoadable, doSave] = useLoadableSet(saveAutoRecharge$);
  const saving = saveLoadable.state === "loading";

  if (!allowed) {
    return null;
  }

  const { enabled } = config;
  const displayEnabled = pendingEnabled !== null ? pendingEnabled : enabled;
  const amountNum = Number(amountValue);
  const amountParsed = Number.isFinite(amountNum) ? amountNum : 0;
  const dollarAmount = formatUsd(
    amountParsed > 0 ? amountParsed / CREDITS_PER_DOLLAR : 0,
  );

  const parseFormNumbers = () => {
    const tVal = Number(thresholdValue);
    const aVal = Number(amountValue);
    return {
      threshold:
        thresholdValue !== "" && Number.isFinite(tVal)
          ? tVal
          : Number(config.threshold),
      amount: amountValue !== "" && Number.isFinite(aVal) ? aVal : amountNum,
    };
  };

  const getFormValues = (): {
    enabled: boolean;
    threshold?: number;
    amount?: number;
  } | null => {
    const { threshold: t, amount: a } = parseFormNumbers();
    if (!loading && (!displayEnabled || (t > 0 && a >= CREDITS_PER_DOLLAR))) {
      return {
        enabled: displayEnabled,
        ...(displayEnabled ? { threshold: t, amount: a } : {}),
      };
    }
    return null;
  };

  const handleSave = () => {
    const values = getFormValues();
    if (!values) {
      return;
    }
    detach(doSave(values, pageSignal), Reason.DomCallback);
  };

  const inputRowClass = "h-9 w-[200px] shrink-0";

  return (
    <>
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-foreground">
          {t(($) => {
            return $.billing.autoRecharge.title;
          })}
        </h3>
        <div
          className="overflow-hidden rounded-xl bg-card"
          style={settingsCardBorder}
        >
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                {t(($) => {
                  return $.billing.autoRecharge.automaticTopUps;
                })}
              </p>
              <p className="text-[13px] text-muted-foreground mt-0.5">
                {t(($) => {
                  return $.billing.autoRecharge.description;
                })}
              </p>
            </div>
            <Switch
              checked={displayEnabled}
              onCheckedChange={(v) => {
                setPendingEnabled(v === enabled ? null : v);
              }}
              disabled={loading || saving}
              className="shrink-0"
              aria-label={t(($) => {
                return $.billing.autoRecharge.enableAria;
              })}
            />
          </div>
          {displayEnabled && (
            <>
              <div className="h-0 border-t border-t-gray-400 mx-5" />
              <div className="flex items-center justify-between gap-4 px-5 py-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    {t(($) => {
                      return $.billing.autoRecharge.thresholdTitle;
                    })}
                  </p>
                  <p className="text-[13px] text-muted-foreground mt-0.5">
                    {t(($) => {
                      return $.billing.autoRecharge.thresholdDescription;
                    })}
                  </p>
                </div>
                <Input
                  type="text"
                  inputMode="numeric"
                  value={thresholdValue}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v !== "" && !/^\d+$/.test(v)) {
                      return;
                    }
                    setThreshold(v);
                  }}
                  placeholder={t(($) => {
                    return $.billing.autoRecharge.thresholdPlaceholder;
                  })}
                  className={inputRowClass}
                  aria-label={t(($) => {
                    return $.billing.autoRecharge.thresholdAria;
                  })}
                />
              </div>
              <div className="h-0 border-t border-t-gray-400 mx-5" />
              <div className="flex items-center justify-between gap-4 px-5 py-4">
                <div className="min-w-0 flex flex-col gap-1">
                  <span className="text-xl font-semibold tabular-nums tracking-tight text-foreground">
                    {dollarAmount}
                  </span>
                  <p className="text-[13px] font-normal text-muted-foreground">
                    {t(($) => {
                      return $.billing.autoRecharge.amountTitle;
                    })}
                  </p>
                </div>
                <div className="relative w-[200px] shrink-0">
                  <Input
                    type="text"
                    inputMode="numeric"
                    value={amountValue}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v !== "" && !/^\d+$/.test(v)) {
                        return;
                      }
                      setAmount(v);
                    }}
                    placeholder="100000"
                    className={`${inputRowClass} pr-[4.25rem] tabular-nums`}
                    aria-label={t(($) => {
                      return $.billing.autoRecharge.amountAria;
                    })}
                  />
                  <span
                    className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[13px] text-muted-foreground"
                    aria-hidden
                  >
                    {t(($) => {
                      return $.billing.common.credits;
                    })}
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
      </section>
      {dirty && (
        <UnsavedBar
          onDiscard={discard}
          onSave={handleSave}
          saving={saving}
          saveDisabled={getFormValues() === null}
          testId="auto-recharge-unsaved-bar"
        />
      )}
    </>
  );
}
