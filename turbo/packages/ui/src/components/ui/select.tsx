"use client";

import * as React from "react";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";

import { MENU_ROW_HEIGHT_CLASS } from "./menu-row";
import { anchoredPopupTransitionClassName } from "./popup-motion";
import { cn } from "../../lib/utils";
import { resolveCollisionPadding } from "../../lib/safe-area";

const Select = SelectPrimitive.Root;

function SelectGroup({ className, ...props }: SelectPrimitive.Group.Props) {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      className={cn("flex flex-col gap-1", className)}
      {...props}
    />
  );
}

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn("line-clamp-1 w-full text-left", className)}
      {...props}
    />
  );
}

interface SelectTriggerProps extends SelectPrimitive.Trigger.Props {
  variant?: "default" | "neutral";
}

const SelectTrigger = React.forwardRef<HTMLButtonElement, SelectTriggerProps>(
  ({ className, children, variant = "default", ...props }, ref) => {
    return (
      <SelectPrimitive.Trigger
        ref={ref}
        data-slot="select-trigger"
        className={cn(
          "flex h-9 w-full items-center justify-start gap-2 rounded-lg border border-[hsl(var(--gray-400))] bg-input px-3 py-2 text-sm text-foreground outline-none focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          variant === "neutral" &&
            "border border-control-border bg-control-surface text-foreground [&:hover]:bg-state-hover-overlay",
          className,
        )}
        {...props}
      >
        {children}
        <SelectPrimitive.Icon data-slot="select-icon">
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
    );
  },
);
SelectTrigger.displayName = "SelectTrigger";

const SelectScrollUpButton = React.forwardRef<
  HTMLDivElement,
  SelectPrimitive.ScrollUpArrow.Props
>(({ className, ...props }, ref) => {
  return (
    <SelectPrimitive.ScrollUpArrow
      ref={ref}
      data-slot="select-scroll-up-button"
      className={cn(
        "sticky top-0 z-10 flex cursor-default items-center justify-center bg-card py-1",
        className,
      )}
      {...props}
    >
      <ChevronUp className="h-4 w-4" />
    </SelectPrimitive.ScrollUpArrow>
  );
});
SelectScrollUpButton.displayName = "SelectScrollUpButton";

const SelectScrollDownButton = React.forwardRef<
  HTMLDivElement,
  SelectPrimitive.ScrollDownArrow.Props
>(({ className, ...props }, ref) => {
  return (
    <SelectPrimitive.ScrollDownArrow
      ref={ref}
      data-slot="select-scroll-down-button"
      className={cn(
        "sticky bottom-0 z-10 flex cursor-default items-center justify-center bg-card py-1",
        className,
      )}
      {...props}
    >
      <ChevronDown className="h-4 w-4" />
    </SelectPrimitive.ScrollDownArrow>
  );
});
SelectScrollDownButton.displayName = "SelectScrollDownButton";

type SelectPositionerProps = Pick<
  SelectPrimitive.Positioner.Props,
  | "align"
  | "alignItemWithTrigger"
  | "alignOffset"
  | "anchor"
  | "collisionAvoidance"
  | "collisionBoundary"
  | "collisionPadding"
  | "positionMethod"
  | "side"
  | "sideOffset"
  | "sticky"
>;

type SelectContentProps = SelectPrimitive.Popup.Props &
  SelectPositionerProps & {
    hideScrollButtons?: boolean;
    position?: "item-aligned" | "popper";
    viewportClassName?: string;
  };

const SelectContent = React.forwardRef<HTMLDivElement, SelectContentProps>(
  (
    {
      align = "center",
      alignItemWithTrigger,
      alignOffset = 0,
      anchor,
      children,
      className,
      collisionAvoidance,
      collisionBoundary,
      collisionPadding,
      hideScrollButtons = false,
      position = "popper",
      positionMethod = "fixed",
      side = "bottom",
      sideOffset = 4,
      sticky,
      style,
      viewportClassName,
      ...props
    },
    ref,
  ) => {
    const resolvedAlignItemWithTrigger =
      alignItemWithTrigger ?? position === "item-aligned";

    return (
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner
          align={align}
          alignItemWithTrigger={resolvedAlignItemWithTrigger}
          alignOffset={alignOffset}
          anchor={anchor}
          collisionAvoidance={collisionAvoidance}
          collisionBoundary={collisionBoundary}
          collisionPadding={resolveCollisionPadding(collisionPadding)}
          positionMethod={positionMethod}
          side={side}
          sideOffset={sideOffset}
          sticky={sticky}
        >
          <SelectPrimitive.Popup
            ref={ref}
            data-slot="select-content"
            className={cn(
              anchoredPopupTransitionClassName,
              "relative max-h-[min(24rem,var(--available-height))] min-w-[max(8rem,var(--anchor-width))] overflow-x-hidden overflow-y-auto rounded-[12px] border border-[hsl(var(--gray-400))] bg-card text-foreground outline-none data-[side=none]:data-starting-style:opacity-100 data-[side=none]:data-starting-style:[transform:scale(1)] data-[side=none]:transition-none",
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
            {!hideScrollButtons && <SelectScrollUpButton />}
            <SelectPrimitive.List
              data-slot="select-list"
              className={cn("flex flex-col gap-1 p-1", viewportClassName)}
            >
              {children}
            </SelectPrimitive.List>
            {!hideScrollButtons && <SelectScrollDownButton />}
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    );
  },
);
SelectContent.displayName = "SelectContent";

const SelectLabel = React.forwardRef<
  HTMLDivElement,
  SelectPrimitive.GroupLabel.Props
>(({ className, ...props }, ref) => {
  return (
    <SelectPrimitive.GroupLabel
      ref={ref}
      data-slot="select-label"
      className={cn("px-3 py-1.5 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
});
SelectLabel.displayName = "SelectLabel";

const SelectItem = React.forwardRef<HTMLElement, SelectPrimitive.Item.Props>(
  ({ className, children, ...props }, ref) => {
    return (
      <SelectPrimitive.Item
        ref={ref}
        data-slot="select-item"
        className={cn(
          "relative flex w-full cursor-pointer select-none items-center rounded-lg pl-2 pr-8 outline-none transition-colors hover:bg-state-hover hover:text-accent-foreground data-highlighted:bg-state-hover data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
          MENU_ROW_HEIGHT_CLASS,
          className,
        )}
        {...props}
      >
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
        <SelectPrimitive.ItemIndicator
          render={
            <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center" />
          }
        >
          <Check className="h-4 w-4" />
        </SelectPrimitive.ItemIndicator>
      </SelectPrimitive.Item>
    );
  },
);
SelectItem.displayName = "SelectItem";

const SelectSeparator = React.forwardRef<
  HTMLDivElement,
  SelectPrimitive.Separator.Props
>(({ className, ...props }, ref) => {
  return (
    <SelectPrimitive.Separator
      ref={ref}
      data-slot="select-separator"
      className={cn(
        "-mx-1 my-1 h-0 border-0 border-t border-t-gray-400",
        className,
      )}
      {...props}
    />
  );
});
SelectSeparator.displayName = "SelectSeparator";

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  SelectScrollUpButton,
  SelectScrollDownButton,
};
