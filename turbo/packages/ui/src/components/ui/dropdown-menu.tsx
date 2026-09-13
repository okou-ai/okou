"use client";

import * as React from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";

import { asChildRender } from "../../lib/base-ui-compat";
import { anchoredPopupTransitionClassName } from "./popup-motion";
import { cn } from "../../lib/utils";

function DropdownMenu(props: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuPortal(props: MenuPrimitive.Portal.Props) {
  return <MenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />;
}

interface DropdownMenuTriggerProps extends Omit<
  MenuPrimitive.Trigger.Props,
  "render"
> {
  asChild?: boolean;
  render?: MenuPrimitive.Trigger.Props["render"];
}

const DropdownMenuTrigger = React.forwardRef<
  HTMLButtonElement,
  DropdownMenuTriggerProps
>(({ asChild = false, children, render, ...props }, ref) => {
  const child = asChild ? asChildRender(children) : undefined;
  return (
    <MenuPrimitive.Trigger
      ref={ref}
      data-slot="dropdown-menu-trigger"
      render={child ?? render}
      {...props}
    >
      {asChild ? undefined : children}
    </MenuPrimitive.Trigger>
  );
});
DropdownMenuTrigger.displayName = "DropdownMenuTrigger";

function DropdownMenuSub(props: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />;
}

type DropdownMenuPositionerProps = Pick<
  MenuPrimitive.Positioner.Props,
  | "align"
  | "alignOffset"
  | "collisionAvoidance"
  | "collisionBoundary"
  | "collisionPadding"
  | "disableAnchorTracking"
  | "positionMethod"
  | "side"
  | "sideOffset"
  | "sticky"
>;

type DropdownMenuContentProps = MenuPrimitive.Popup.Props &
  DropdownMenuPositionerProps & {
    avoidCollisions?: boolean;
    hideWhenDetached?: boolean;
    portalContainer?: HTMLElement | null;
    updatePositionStrategy?: "always" | "optimized";
  };

// Concentric corners: an inner radius must equal the outer radius minus the gap
// between them, or the two arcs cross instead of nesting. This surface is 12px
// with `p-1` (4px), so every row inside it is `rounded-lg` (8px). Keep the three
// values in step when changing any one of them.
const DropdownMenuContent = React.forwardRef<
  HTMLDivElement,
  DropdownMenuContentProps
>(
  (
    {
      align = "start",
      alignOffset = 0,
      avoidCollisions,
      children,
      className,
      collisionAvoidance,
      collisionBoundary,
      collisionPadding,
      disableAnchorTracking,
      hideWhenDetached = false,
      portalContainer,
      positionMethod = "fixed",
      side = "bottom",
      sideOffset = 4,
      sticky,
      updatePositionStrategy,
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
      <DropdownMenuPortal container={portalContainer}>
        <MenuPrimitive.Positioner
          align={align}
          alignOffset={alignOffset}
          className={cn(
            "outline-none",
            hideWhenDetached && "data-anchor-hidden:invisible",
          )}
          collisionAvoidance={resolvedCollisionAvoidance}
          collisionBoundary={collisionBoundary}
          collisionPadding={collisionPadding}
          disableAnchorTracking={
            disableAnchorTracking ?? updatePositionStrategy === "optimized"
          }
          positionMethod={positionMethod}
          side={side}
          sideOffset={sideOffset}
          sticky={sticky}
        >
          <MenuPrimitive.Popup
            ref={ref}
            data-slot="dropdown-menu-content"
            className={cn(
              anchoredPopupTransitionClassName,
              "max-h-[var(--available-height)] min-w-[8rem] overflow-x-hidden overflow-y-auto rounded-[12px] border border-[hsl(var(--gray-400))] bg-card p-1 text-foreground shadow-lg outline-none dark:shadow-[0_8px_40px_-8px_rgba(0,0,0,0.6)]",
              className,
            )}
            {...props}
          >
            {children}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </DropdownMenuPortal>
    );
  },
);
DropdownMenuContent.displayName = "DropdownMenuContent";

interface DropdownMenuItemProps extends Omit<
  MenuPrimitive.Item.Props,
  "onClick" | "onSelect"
> {
  onClick?: MenuPrimitive.Item.Props["onClick"];
  onSelect?: (event: Event) => void;
}

const DropdownMenuItem = React.forwardRef<HTMLElement, DropdownMenuItemProps>(
  ({ className, onClick, onSelect, ...props }, ref) => {
    return (
      <MenuPrimitive.Item
        ref={ref}
        data-slot="dropdown-menu-item"
        className={cn(
          "relative flex cursor-default select-none items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none transition-colors hover:bg-state-hover data-highlighted:bg-state-hover data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
          className,
        )}
        onClick={(event) => {
          onSelect?.(event.nativeEvent);
          if (event.nativeEvent.defaultPrevented) {
            event.preventBaseUIHandler();
          }
          onClick?.(event);
        }}
        {...props}
      />
    );
  },
);
DropdownMenuItem.displayName = "DropdownMenuItem";

const DropdownMenuSeparator = React.forwardRef<
  HTMLDivElement,
  MenuPrimitive.Separator.Props
>(({ className, ...props }, ref) => {
  return (
    <MenuPrimitive.Separator
      ref={ref}
      data-slot="dropdown-menu-separator"
      className={cn(
        "-mx-1 my-1 h-0 border-0 border-t border-t-gray-400",
        className,
      )}
      {...props}
    />
  );
});
DropdownMenuSeparator.displayName = "DropdownMenuSeparator";

const DropdownMenuSubTrigger = React.forwardRef<
  HTMLElement,
  MenuPrimitive.SubmenuTrigger.Props
>(({ className, ...props }, ref) => {
  return (
    <MenuPrimitive.SubmenuTrigger
      ref={ref}
      data-slot="dropdown-menu-sub-trigger"
      className={cn(
        "flex cursor-default select-none items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none hover:bg-state-hover data-highlighted:bg-state-hover data-popup-open:bg-state-hover [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
});
DropdownMenuSubTrigger.displayName = "DropdownMenuSubTrigger";

const DropdownMenuSubContent = React.forwardRef<
  HTMLDivElement,
  DropdownMenuContentProps
>(({ align = "start", alignOffset = -3, side = "right", ...props }, ref) => {
  return (
    <DropdownMenuContent
      ref={ref}
      data-slot="dropdown-menu-sub-content"
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={0}
      {...props}
    />
  );
});
DropdownMenuSubContent.displayName = "DropdownMenuSubContent";

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
