import * as React from "react";
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { useRender } from "@base-ui/react/use-render";

import { asChildRender } from "../../lib/base-ui-compat";
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
  | { showTooltip: true; "aria-label": string }
  | { showTooltip?: false };

export interface ButtonBaseProps extends Omit<
  ButtonPrimitive.Props,
  "className" | "render"
> {
  asChild?: boolean;
  className?: string;
  render?: ButtonPrimitive.Props["render"];
  showTooltip?: boolean;
  tooltipFullWidth?: boolean;
}

interface ButtonAsChildProps {
  children: React.ReactNode;
  className?: string;
  props: Omit<
    ButtonPrimitive.Props,
    "children" | "className" | "nativeButton" | "ref" | "render"
  >;
  ref: React.ForwardedRef<HTMLElement>;
}

function ButtonAsChild({
  children,
  className,
  props,
  ref,
}: ButtonAsChildProps) {
  return useRender({
    defaultTagName: "button",
    props: {
      ...props,
      className,
      "data-slot": "button",
    },
    ref,
    render: asChildRender(children),
  });
}

/** Internal rendering and tooltip behavior shared by styled button controls. */
export const ButtonBase = React.forwardRef<HTMLElement, ButtonBaseProps>(
  (
    {
      asChild = false,
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
    const { title: _title, ...propsWithoutTitle } = props;
    const buttonProps = showTooltip ? propsWithoutTitle : props;
    const button = asChild ? (
      <ButtonAsChild className={className} props={buttonProps} ref={ref}>
        {children}
      </ButtonAsChild>
    ) : (
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

    if (!showTooltip) return button;

    const trigger = buttonProps.disabled ? (
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
            <p className="text-xs">{buttonProps["aria-label"]}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  },
);
ButtonBase.displayName = "ButtonBase";
