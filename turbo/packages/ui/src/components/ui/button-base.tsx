import * as React from "react";
import { Button as ButtonPrimitive } from "@base-ui/react/button";

import { cn } from "../../lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";

// Action and toggle buttons share typography, radius and keyboard focus.
// Their layout, selected treatment and disabled appearance remain independent.
export const buttonBaseClassName =
  "rounded-lg text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

export type ButtonTooltipOptions =
  { showTooltip: true; "aria-label": string } | { showTooltip?: false };

export interface ButtonBaseProps extends Omit<
  ButtonPrimitive.Props,
  "className" | "render"
> {
  className?: string;
  render?: ButtonPrimitive.Props["render"];
  showTooltip?: boolean;
  tooltipFullWidth?: boolean;
}

/** Wraps a prepared button while its owner keeps ref forwarding in JSX. */
export function withButtonTooltip(
  button: React.ReactElement,
  {
    disabled,
    showTooltip = false,
    tooltipFullWidth = false,
    "aria-label": label,
  }: Pick<
    ButtonBaseProps,
    "disabled" | "showTooltip" | "tooltipFullWidth" | "aria-label"
  >,
) {
  if (!showTooltip) return button;

  const trigger = disabled ? (
    <span className={cn("inline-flex", tooltipFullWidth && "w-full")}>
      {button}
    </span>
  ) : (
    button
  );

  return (
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger render={trigger} />
        <TooltipContent>
          <p className="text-xs">{label}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** Internal rendering and tooltip behavior shared by styled button controls. */
export const ButtonBase = React.forwardRef<HTMLElement, ButtonBaseProps>(
  (
    {
      children,
      className,
      nativeButton,
      render,
      showTooltip = false,
      tooltipFullWidth = false,
      ...props
    },
    ref,
  ) => {
    const { title: _title, ...buttonProps } = props;
    const button = (
      <ButtonPrimitive
        className={className}
        data-slot="button"
        nativeButton={nativeButton}
        ref={ref}
        render={render}
        {...buttonProps}
      >
        {children}
      </ButtonPrimitive>
    );

    return withButtonTooltip(button, {
      disabled: buttonProps.disabled,
      showTooltip,
      tooltipFullWidth,
      "aria-label": buttonProps["aria-label"],
    });
  },
);
ButtonBase.displayName = "ButtonBase";
