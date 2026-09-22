"use client";

import * as React from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { asChildRender } from "../../lib/base-ui-compat";
import { anchoredPopupTransitionClassName } from "./popup-motion";
import { cn } from "../../lib/utils";
import { resolveCollisionPadding } from "../../lib/safe-area";

function Popover(props: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

interface PopoverTriggerProps extends Omit<
  PopoverPrimitive.Trigger.Props,
  "render"
> {
  asChild?: boolean;
  render?: PopoverPrimitive.Trigger.Props["render"];
}

const PopoverTrigger = React.forwardRef<HTMLButtonElement, PopoverTriggerProps>(
  ({ asChild = false, children, render, ...props }, ref) => {
    const child = asChild ? asChildRender(children) : undefined;
    return (
      <PopoverPrimitive.Trigger
        ref={ref}
        data-slot="popover-trigger"
        render={child ?? render}
        {...props}
      >
        {asChild ? undefined : children}
      </PopoverPrimitive.Trigger>
    );
  },
);
PopoverTrigger.displayName = "PopoverTrigger";

interface PopoverCloseProps extends Omit<
  PopoverPrimitive.Close.Props,
  "render"
> {
  asChild?: boolean;
  render?: PopoverPrimitive.Close.Props["render"];
}

const PopoverClose = React.forwardRef<HTMLButtonElement, PopoverCloseProps>(
  ({ asChild = false, children, render, ...props }, ref) => {
    const child = asChild ? asChildRender(children) : undefined;
    return (
      <PopoverPrimitive.Close
        ref={ref}
        data-slot="popover-close"
        render={child ?? render}
        {...props}
      >
        {asChild ? undefined : children}
      </PopoverPrimitive.Close>
    );
  },
);
PopoverClose.displayName = "PopoverClose";

type PopoverPositionerProps = Pick<
  PopoverPrimitive.Positioner.Props,
  | "align"
  | "alignOffset"
  | "anchor"
  | "collisionAvoidance"
  | "collisionBoundary"
  | "collisionPadding"
  | "disableAnchorTracking"
  | "positionMethod"
  | "side"
  | "sideOffset"
  | "sticky"
>;

type PopoverContentProps = PopoverPrimitive.Popup.Props &
  PopoverPositionerProps & {
    avoidCollisions?: boolean;
    hideWhenDetached?: boolean;
    positionerClassName?: string;
  };

const PopoverContent = React.forwardRef<HTMLDivElement, PopoverContentProps>(
  (
    {
      align = "center",
      alignOffset = 0,
      anchor,
      avoidCollisions,
      children,
      className,
      collisionAvoidance,
      collisionBoundary,
      collisionPadding,
      disableAnchorTracking,
      hideWhenDetached = false,
      positionerClassName,
      positionMethod = "fixed",
      side = "bottom",
      sideOffset = 4,
      sticky,
      style,
      ...props
    },
    ref,
  ) => {
    const resolvedCollisionAvoidance =
      collisionAvoidance ??
      (avoidCollisions === false
        ? {
            align: "none" as const,
            fallbackAxisSide: "none" as const,
            side: "none" as const,
          }
        : undefined);

    return (
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          align={align}
          alignOffset={alignOffset}
          anchor={anchor}
          className={cn(
            hideWhenDetached && "data-anchor-hidden:invisible",
            positionerClassName,
          )}
          collisionAvoidance={resolvedCollisionAvoidance}
          collisionBoundary={collisionBoundary}
          collisionPadding={resolveCollisionPadding(collisionPadding)}
          disableAnchorTracking={disableAnchorTracking}
          positionMethod={positionMethod}
          side={side}
          sideOffset={sideOffset}
          sticky={sticky}
        >
          <PopoverPrimitive.Popup
            ref={ref}
            data-slot="popover-content"
            className={cn(
              anchoredPopupTransitionClassName,
              "w-72 rounded-[12px] border border-[hsl(var(--gray-400))] bg-card p-4 text-foreground outline-none",
              className,
            )}
            style={
              typeof style === "function"
                ? (state) => {
                    return {
                      boxShadow:
                        "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)",
                      ...style(state),
                    };
                  }
                : {
                    boxShadow:
                      "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)",
                    ...style,
                  }
            }
            {...props}
          >
            {children}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    );
  },
);
PopoverContent.displayName = "PopoverContent";

export { Popover, PopoverTrigger, PopoverContent, PopoverClose };
