import type { ReactNode } from "react";
import { ToggleButton, cn } from "@okouai/ui";

export const COMPOSER_SECTION_LABEL = cn(
  "min-w-0 truncate text-base font-medium",
  "in-data-[slot=capability-tray]:text-[13px] in-data-[slot=capability-tray]:leading-5 in-data-[slot=capability-tray]:text-muted-foreground",
);

export function ComposerOutputPicker<Value extends string>({
  label,
  options,
  selectedValue,
  onSelect,
  headerAction,
}: {
  readonly label: string;
  readonly options: readonly {
    readonly value: Value;
    readonly label: string;
  }[];
  readonly selectedValue: Value | null;
  readonly onSelect: (value: Value) => void;
  readonly headerAction?: ReactNode;
}) {
  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      role="group"
      aria-label={label}
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <p className={COMPOSER_SECTION_LABEL}>{label}</p>
        {headerAction}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {options.map((option) => {
          const selected = selectedValue === option.value;
          return (
            <ToggleButton
              key={option.value}
              selected={selected}
              layout="inline"
              aria-label={option.label}
              className={cn(
                "h-9 shrink-0 px-3 py-0",
                !selected && [
                  "border-control-border bg-transparent",
                  "in-data-[slot=capability-tray]:border-transparent in-data-[slot=capability-tray]:bg-card in-data-[slot=capability-tray]:shadow-segment-selected",
                ],
              )}
              onClick={() => {
                onSelect(option.value);
              }}
            >
              {option.label}
            </ToggleButton>
          );
        })}
      </div>
    </div>
  );
}
