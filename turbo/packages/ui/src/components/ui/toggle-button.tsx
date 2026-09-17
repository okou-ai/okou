import type { ComponentProps } from "react";
import { cva } from "class-variance-authority";

import { cn } from "../../lib/utils";
import {
  ButtonBase,
  buttonBaseClassName,
  type ButtonTooltipOptions,
} from "./button-base";

const toggleButtonVariants = cva(
  [
    buttonBaseClassName,
    "border transition-all duration-200 focus:outline-none disabled:opacity-60 disabled:cursor-not-allowed",
  ],
  {
    variants: {
      layout: {
        inline: "flex items-center gap-2 px-3.5 py-2",
        tile: "block w-full min-w-0 px-3 py-2.5",
      },
      selected: {
        true: "border-primary/40 bg-primary/10 text-selected-foreground dark:border-primary/50 dark:bg-primary/15",
        // Preserve the opaque fill and the legacy hover layer on touch devices.
        false:
          "border-control-border bg-control-surface text-muted-foreground [&:hover]:bg-state-hover-overlay hover:text-foreground",
      },
    },
  },
);

interface ToggleButtonBaseProps extends Omit<
  ComponentProps<"button">,
  "aria-pressed"
> {
  selected: boolean;
  layout?: "inline" | "tile";
}

export type ToggleButtonProps = ToggleButtonBaseProps & ButtonTooltipOptions;

/** A controlled pressed-state button; callers own activation and group selection. */
export function ToggleButton({
  selected,
  layout = "inline",
  className,
  ...props
}: ToggleButtonProps) {
  return (
    <ButtonBase
      type="button"
      {...props}
      aria-pressed={selected}
      className={cn(toggleButtonVariants({ selected, layout }), className)}
      tooltipFullWidth={layout === "tile"}
    />
  );
}
