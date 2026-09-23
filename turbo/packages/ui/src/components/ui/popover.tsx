"use client";

import * as React from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { anchoredPopupTransitionClassName } from "./popup-motion";
import { cn } from "../../lib/utils";
import { resolveCollisionPadding } from "../../lib/safe-area";

function Popover(props: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

const PopoverTrigger = React.forwardRef<
  HTMLButtonElement,
  PopoverPrimitive.Trigger.Props
>((props, ref) => {
  return (
    <PopoverPrimitive.Trigger
      ref={ref}
      data-slot="popover-trigger"
      {...props}
    />
  );
});
PopoverTrigger.displayName = "PopoverTrigger";

const PopoverClose = React.forwardRef<
  HTMLButtonElement,
  PopoverPrimitive.Close.Props
>((props, ref) => {
  return (
    <PopoverPrimitive.Close ref={ref} data-slot="popover-close" {...props} />
  );
});
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
    positionerClassName?: string;
  };

const PopoverContent = React.forwardRef<HTMLDivElement, PopoverContentProps>(
  (
    {
      align = "center",
      alignOffset = 0,
      anchor,
      children,
      className,
      collisionAvoidance,
      collisionBoundary,
      collisionPadding,
      disableAnchorTracking,
      positionerClassName,
      positionMethod = "fixed",
      side = "bottom",
      sideOffset = 4,
      sticky,
      ...props
    },
    ref,
  ) => {
    return (
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          align={align}
          alignOffset={alignOffset}
          anchor={anchor}
          className={positionerClassName}
          collisionAvoidance={collisionAvoidance}
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
              "w-72 rounded-[12px] border border-[hsl(var(--gray-400))] bg-card p-4 text-foreground shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] outline-none",
              className,
            )}
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
