import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";
import {
  ButtonBase,
  buttonBaseClassName,
  type ButtonBaseProps,
  type ButtonTooltipOptions,
} from "./button-base";

const buttonVariants = cva(
  [
    buttonBaseClassName,
    "inline-flex items-center justify-center gap-2 whitespace-nowrap ring-offset-background transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-pressed",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive-hover active:bg-destructive-pressed",
        // Halts something in flight without discarding it -- pausing a run.
        // `destructive` is reserved for deletes, so this takes the lighter
        // Coral stop and reads as an interruption rather than a warning.
        interrupt:
          "bg-interrupt text-interrupt-foreground hover:bg-interrupt-hover active:bg-interrupt-pressed",
        outline:
          "border border-[hsl(var(--gray-400))] bg-background hover:bg-state-hover active:bg-state-pressed text-foreground",
        neutral:
          "border border-control-border bg-control-surface text-foreground [&:hover]:bg-state-hover-overlay hover:bg-state-hover active:bg-state-pressed",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary-hover active:bg-secondary-pressed",
        ghost: "text-brand-text hover:bg-state-hover active:bg-state-pressed",
        // Neutral counterpart to `ghost`, for chrome that must not read as an
        // action: toolbar and composer icons, which inherit the muted ramp and
        // only gain weight on hover.
        quiet:
          "text-muted-foreground hover:bg-state-hover hover:text-foreground active:bg-state-pressed",
        link: "text-brand-text underline-offset-4 hover:underline active:text-brand-text/80",
      },
      size: {
        xs: "h-7 px-2.5",
        sm: "h-8 px-3",
        default: "h-9 px-4",
        lg: "h-10 px-6",
        "icon-2xs": "h-6 w-6",
        "icon-xs": "h-7 w-7",
        "icon-sm": "h-8 w-8",
        icon: "h-9 w-9",
        "icon-lg": "h-10 w-10",
      },
      // Icon buttons across the app draw 16px, 18px, or 20px glyphs. The base
      // `[&_svg]:size-4` covers 16px; the other two need an explicit opt-in so
      // callers stop hand-rolling `[&_svg]:size-[18px]` on every toolbar.
      iconSize: {
        sm: "[&_svg]:size-4",
        md: "[&_svg]:size-[18px]",
        lg: "[&_svg]:size-5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

interface StyledButtonProps
  extends
    Omit<ButtonBaseProps, "showTooltip" | "tooltipFullWidth">,
    VariantProps<typeof buttonVariants> {}

export type ButtonProps = StyledButtonProps & ButtonTooltipOptions;

const Button = React.forwardRef<HTMLElement, ButtonProps>(
  ({ className, iconSize, size, variant, ...props }, ref) => {
    return (
      <ButtonBase
        {...props}
        className={cn(buttonVariants({ variant, size, iconSize, className }))}
        ref={ref}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
