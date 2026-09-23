import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui/components/ui/select";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { PRESENTATION_SLIDE_COUNTS } from "../../signals/okou-page/composer-create.ts";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";

export function ComposerPresentationOptions({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const mode = useGet(signals.create.mode$);
  const slideCount = useGet(signals.create.presentationSlideCount$);
  const setSlideCount = useSet(signals.create.setPresentationSlideCount$);

  if (mode !== "presentation") {
    return null;
  }

  const items = PRESENTATION_SLIDE_COUNTS.map((value) => {
    return {
      value,
      label:
        value === "auto"
          ? t(($) => {
              return $.chat.composer.create.slideCountAuto;
            })
          : t(
              ($) => {
                return $.chat.composer.create.slideCountRange;
              },
              {
                range: value.replace("-", "–"),
              },
            ),
    };
  });

  return (
    <Select
      items={items}
      value={slideCount}
      onValueChange={(value, details) => {
        if (value === null) {
          details.cancel();
          return;
        }
        setSlideCount(value);
      }}
    >
      <SelectTrigger
        aria-label={t(($) => {
          return $.chat.composer.create.slideCount;
        })}
        className="h-8 w-auto shrink-0 gap-1 border-transparent bg-transparent px-2 text-xs text-muted-foreground hover:bg-state-hover [&>[data-slot=select-icon]>svg]:size-3"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent side="top" align="start">
        {items.map((item) => {
          return (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
