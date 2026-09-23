"use client";

import * as React from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";

import { anchoredPopupTransitionClassName } from "./popup-motion";
import { cn } from "../../lib/utils";
import { resolveCollisionPadding } from "../../lib/safe-area";

function TooltipProvider({
  delay = 0,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      {...props}
    />
  );
}

function Tooltip(props: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

const TooltipTrigger = React.forwardRef<
  HTMLButtonElement,
  TooltipPrimitive.Trigger.Props
>((props, ref) => {
  return (
    <TooltipPrimitive.Trigger
      ref={ref}
      data-slot="tooltip-trigger"
      {...props}
    />
  );
});
TooltipTrigger.displayName = "TooltipTrigger";

type TooltipPositionerProps = Pick<
  TooltipPrimitive.Positioner.Props,
  | "align"
  | "alignOffset"
  | "collisionAvoidance"
  | "collisionBoundary"
  | "collisionPadding"
  | "positionMethod"
  | "side"
  | "sideOffset"
>;

type TooltipContentProps = TooltipPrimitive.Popup.Props &
  TooltipPositionerProps;

const TooltipContent = React.forwardRef<HTMLDivElement, TooltipContentProps>(
  (
    {
      align = "center",
      alignOffset = 0,
      children,
      className,
      collisionAvoidance,
      collisionBoundary,
      collisionPadding,
      positionMethod = "fixed",
      side = "top",
      sideOffset = 4,
      style,
      ...props
    },
    ref,
  ) => {
    return (
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner
          align={align}
          alignOffset={alignOffset}
          collisionAvoidance={collisionAvoidance}
          collisionBoundary={collisionBoundary}
          collisionPadding={resolveCollisionPadding(collisionPadding)}
          positionMethod={positionMethod}
          side={side}
          sideOffset={sideOffset}
        >
          <TooltipPrimitive.Popup
            ref={ref}
            data-slot="tooltip-content"
            className={cn(
              anchoredPopupTransitionClassName,
              "max-w-xs overflow-hidden rounded-md px-2 py-1 text-xs data-instant:transition-none",
              className,
            )}
            style={
              typeof style === "function"
                ? (state) => {
                    return {
                      backgroundColor: "var(--tooltip-bg, #1a1a1a)",
                      color: "hsl(var(--on-filled))",
                      ...style(state),
                    };
                  }
                : {
                    backgroundColor: "var(--tooltip-bg, #1a1a1a)",
                    color: "hsl(var(--on-filled))",
                    ...style,
                  }
            }
            {...props}
          >
            {children}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    );
  },
);
TooltipContent.displayName = "TooltipContent";

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
