import { Button, cn } from "@okouai/ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui/components/ui/select";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";

import {
  FEISHU_SETUP_STEPS,
  feishuPlatform$,
  selectFeishuReviewStep$,
  type FeishuSetupStep,
} from "../../signals/okou-page/feishu.ts";

export function FeishuSetupProgress({
  step,
  readOnly,
}: {
  readonly step: FeishuSetupStep;
  readonly readOnly: boolean;
}) {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  const selectStep = useSet(selectFeishuReviewStep$);
  const currentIndex = FEISHU_SETUP_STEPS.indexOf(step);
  const progress = t(
    ($) => {
      return $.onboarding.common.stepProgress;
    },
    { current: currentIndex + 1, total: FEISHU_SETUP_STEPS.length },
  );
  const items = FEISHU_SETUP_STEPS.map((value) => {
    return {
      value,
      label: t(($) => {
        return $.connectors.providerSettings[platform].steps[value];
      }),
    };
  });

  return (
    <nav aria-label={progress} className="shrink-0 border-b border-border pb-3">
      <div className="flex min-h-9 items-center justify-between gap-3 @4xl/feishu-setup:hidden">
        <span className="shrink-0 text-xs text-muted-foreground">
          {progress}
        </span>
        {readOnly ? (
          <Select
            items={items}
            value={step}
            onValueChange={(value) => {
              if (value) {
                selectStep(value);
              }
            }}
          >
            <SelectTrigger
              variant="neutral"
              aria-label={progress}
              className="min-w-0 max-w-72 flex-1 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {items.map((item) => {
                return (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        ) : (
          <span className="min-w-0 text-right text-sm font-medium">
            {items[currentIndex]?.label}
          </span>
        )}
      </div>
      <ol className="hidden grid-cols-7 gap-1 @4xl/feishu-setup:grid">
        {items.map((item, index) => {
          const active = item.value === step;
          const label = (
            <>
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full border border-surface-border text-[10px]",
                  active && "border-foreground bg-foreground text-background",
                )}
              >
                {index + 1}
              </span>
              <span className="min-w-0 truncate">{item.label}</span>
            </>
          );
          const className = cn(
            "flex h-9 w-full min-w-0 items-center justify-center gap-2 rounded-lg px-2 text-xs font-medium",
            active ? "bg-gray-50 text-foreground" : "text-muted-foreground",
          );
          return (
            <li
              key={item.value}
              aria-current={active ? "step" : undefined}
              className="min-w-0"
            >
              {readOnly ? (
                <Button
                  type="button"
                  aria-label={item.label}
                  variant="quiet"
                  size="sm"
                  className={className}
                  onClick={() => {
                    selectStep(item.value);
                  }}
                >
                  {label}
                </Button>
              ) : (
                <span className={className}>{label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
