import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Button, Input } from "@okouai/ui";
import { toast } from "@okouai/ui/components/ui/sonner";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import {
  buyCreditsCustomDollars$,
  buyCreditsSelection$,
  creditPurchaseOrigin$,
  setBuyCreditsCustomDollars$,
  setBuyCreditsSelection$,
  startCreditCheckout$,
  type BuyCreditsSelection,
  type CreditCheckoutSelection,
} from "../../../../signals/okou-page/billing.ts";
import { formatLocalizedNumber, formatUsd } from "../../../../i18n/format.ts";

const CREDITS_PER_DOLLAR = 1000;
const PRESETS = [10, 20, 50] as const;
const MIN_CUSTOM_USD = 1;
const MAX_CUSTOM_USD = 10_000;

type Preset = (typeof PRESETS)[number];

const settingsCardBorder = {
  border: "var(--border-width-surface) solid hsl(var(--gray-400))",
} as const;

const tileBaseClass =
  "flex flex-col rounded-xl bg-background px-4 py-3 text-left transition-colors";

function tileBorderClass(selected: boolean): string {
  return selected
    ? "border border-primary ring-2 ring-primary/20"
    : "okou-border hover:border-muted-foreground/30";
}

function PresetTile({
  dollars,
  selected,
  onSelect,
}: {
  dollars: Preset;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const credits = dollars * CREDITS_PER_DOLLAR;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`${tileBaseClass} ${tileBorderClass(selected)}`}
    >
      <span className="text-sm font-semibold text-foreground">
        {formatUsd(dollars, 0)}
      </span>
      <span className="mt-1 text-[13px] text-muted-foreground">
        {t(
          ($) => {
            return $.usage.units.credit;
          },
          { count: credits, value: formatLocalizedNumber(credits) },
        )}
      </span>
    </button>
  );
}

function CustomTile({
  selected,
  value,
  onSelect,
  onChange,
}: {
  selected: boolean;
  value: string;
  onSelect: () => void;
  onChange: (next: string) => void;
}) {
  const { t } = useTranslation();
  if (!selected) {
    return (
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={false}
        className={`${tileBaseClass} ${tileBorderClass(false)}`}
      >
        <span className="text-sm font-semibold text-foreground">
          {t(($) => {
            return $.billing.credits.custom;
          })}
        </span>
        <span className="mt-1 text-[13px] text-muted-foreground">
          {t(($) => {
            return $.billing.credits.anyAmount;
          })}
        </span>
      </button>
    );
  }
  return (
    <div className={`${tileBaseClass} ${tileBorderClass(true)}`}>
      <div className="flex items-baseline gap-1">
        <span className="text-sm font-semibold text-foreground">$</span>
        <Input
          type="text"
          inputMode="numeric"
          value={value}
          autoFocus
          onChange={(e) => {
            const next = e.target.value;
            if (next !== "" && !/^\d+$/.test(next)) {
              return;
            }
            onChange(next);
          }}
          placeholder="100"
          className="h-5 w-full border-0 bg-transparent p-0 text-sm font-semibold shadow-none focus-visible:ring-0"
          aria-label={t(($) => {
            return $.billing.credits.customAmountAria;
          })}
        />
      </div>
      <span className="mt-1 text-[13px] text-muted-foreground">
        {value === ""
          ? t(($) => {
              return $.billing.credits.anyAmount;
            })
          : t(
              ($) => {
                return $.usage.units.credit;
              },
              {
                count: Number(value) * CREDITS_PER_DOLLAR,
                value: formatLocalizedNumber(
                  Number(value) * CREDITS_PER_DOLLAR,
                ),
              },
            )}
      </span>
    </div>
  );
}

function TileGrid({
  selection,
  customDollars,
  onSelect,
  onCustomChange,
}: {
  selection: BuyCreditsSelection;
  customDollars: string;
  onSelect: (next: BuyCreditsSelection) => void;
  onCustomChange: (next: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
      {PRESETS.map((dollars) => {
        return (
          <PresetTile
            key={dollars}
            dollars={dollars}
            selected={selection === dollars}
            onSelect={() => {
              onSelect(dollars);
            }}
          />
        );
      })}
      <CustomTile
        selected={selection === "custom"}
        value={customDollars}
        onSelect={() => {
          onSelect("custom");
        }}
        onChange={onCustomChange}
      />
    </div>
  );
}

function resolveBuyDollars(
  selection: BuyCreditsSelection,
  customDollars: string,
): number | null {
  if (selection !== "custom") {
    return selection;
  }
  const value = Number(customDollars);
  const valid =
    customDollars !== "" &&
    Number.isInteger(value) &&
    value >= MIN_CUSTOM_USD &&
    value <= MAX_CUSTOM_USD;
  return valid ? value : null;
}

export function BuyCreditsSection() {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const [checkoutLoadable, checkout] = useLoadableSet(startCreditCheckout$);
  const purchaseOrigin = useGet(creditPurchaseOrigin$);
  const selection = useGet(buyCreditsSelection$);
  const customDollars = useGet(buyCreditsCustomDollars$);
  const setSelection = useSet(setBuyCreditsSelection$);
  const setCustomDollars = useSet(setBuyCreditsCustomDollars$);

  const preparing =
    checkoutLoadable.state === "loading" || purchaseOrigin === "billing";
  const buyDollars = resolveBuyDollars(selection, customDollars);
  const buyInvalid = buyDollars === null;
  const buyLabel = preparing
    ? t(($) => {
        return $.billing.common.preparing;
      })
    : buyDollars === null
      ? t(($) => {
          return $.billing.credits.quickBuy;
        })
      : t(
          ($) => {
            return $.billing.credits.quickBuyAmount;
          },
          { amount: formatUsd(buyDollars) },
        );

  const handleBuy = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (buyDollars === null) {
      toast.error(
        t(
          ($) => {
            return $.billing.credits.amountRangeError;
          },
          {
            minimum: formatUsd(MIN_CUSTOM_USD, 0),
            maximum: formatUsd(MAX_CUSTOM_USD, 0),
          },
        ),
      );
      return;
    }
    const credits = buyDollars * CREDITS_PER_DOLLAR;
    const payload: CreditCheckoutSelection =
      selection === "custom" ? { credits, customAmount: true } : { credits };
    const newTab = e.metaKey || e.ctrlKey;
    detach(
      checkout(payload, newTab, "billing", pageSignal),
      Reason.DomCallback,
    );
  };

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">
        {t(($) => {
          return $.billing.credits.title;
        })}
      </h3>
      <div
        className="overflow-hidden rounded-xl bg-card"
        style={settingsCardBorder}
      >
        <div className="flex flex-col gap-3 px-5 py-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              {t(($) => {
                return $.billing.credits.amount;
              })}
            </p>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              {t(
                ($) => {
                  return $.billing.credits.exchangeRate;
                },
                {
                  credits: formatLocalizedNumber(CREDITS_PER_DOLLAR),
                },
              )}
            </p>
          </div>
          <TileGrid
            selection={selection}
            customDollars={customDollars}
            onSelect={setSelection}
            onCustomChange={setCustomDollars}
          />
        </div>
        <div className="h-0 border-t border-t-gray-400 mx-5" />
        <div className="flex justify-end px-5 py-4">
          <Button
            type="button"
            size="sm"
            className={`h-9 px-4 text-sm font-medium ${
              buyInvalid ? "opacity-60" : ""
            }`}
            disabled={preparing}
            aria-disabled={buyInvalid}
            onClick={handleBuy}
          >
            {buyLabel}
          </Button>
        </div>
      </div>
    </section>
  );
}
