"use client";

import * as React from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";

import { MENU_ROW_HEIGHT_CLASS } from "./menu-row";
import { anchoredPopupTransitionClassName } from "./popup-motion";
import { cn } from "../../lib/utils";
import { resolveCollisionPadding } from "../../lib/safe-area";

function DropdownMenu(props: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuPortal(props: MenuPrimitive.Portal.Props) {
  return <MenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />;
}

const DropdownMenuTrigger = React.forwardRef<
  HTMLButtonElement,
  MenuPrimitive.Trigger.Props
>((props, ref) => {
  return (
    <MenuPrimitive.Trigger
      ref={ref}
      data-slot="dropdown-menu-trigger"
      {...props}
    />
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
  DropdownMenuPositionerProps;

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
      children,
      className,
      collisionAvoidance,
      collisionBoundary,
      collisionPadding,
      disableAnchorTracking,
      positionMethod = "fixed",
      side = "bottom",
      sideOffset = 4,
      sticky,
      ...props
    },
    ref,
  ) => {
    return (
      <DropdownMenuPortal>
        <MenuPrimitive.Positioner
          align={align}
          alignOffset={alignOffset}
          className="outline-none"
          collisionAvoidance={collisionAvoidance}
          collisionBoundary={collisionBoundary}
          collisionPadding={resolveCollisionPadding(collisionPadding)}
          disableAnchorTracking={disableAnchorTracking}
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

const DropdownMenuItem = React.forwardRef<
  HTMLElement,
  MenuPrimitive.Item.Props
>(({ className, ...props }, ref) => {
  return (
    <MenuPrimitive.Item
      ref={ref}
      data-slot="dropdown-menu-item"
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded-lg px-2 outline-none transition-colors hover:bg-state-hover data-highlighted:bg-state-hover data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        MENU_ROW_HEIGHT_CLASS,
        className,
      )}
      {...props}
    />
  );
});
DropdownMenuItem.displayName = "DropdownMenuItem";

function DropdownMenuRadioGroup(props: MenuPrimitive.RadioGroup.Props) {
  return (
    <MenuPrimitive.RadioGroup
      data-slot="dropdown-menu-radio-group"
      {...props}
    />
  );
}

const DropdownMenuRadioItem = React.forwardRef<
  HTMLElement,
  MenuPrimitive.RadioItem.Props
>(({ className, ...props }, ref) => {
  return (
    <MenuPrimitive.RadioItem
      ref={ref}
      data-slot="dropdown-menu-radio-item"
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded-lg px-2 outline-none transition-colors hover:bg-state-hover data-highlighted:bg-state-hover data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        MENU_ROW_HEIGHT_CLASS,
        className,
      )}
      {...props}
    />
  );
});
DropdownMenuRadioItem.displayName = "DropdownMenuRadioItem";

const DropdownMenuRadioItemIndicator = MenuPrimitive.RadioItemIndicator;

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
        "flex cursor-default select-none items-center gap-2 rounded-lg px-2 outline-none hover:bg-state-hover data-highlighted:bg-state-hover data-popup-open:bg-state-hover [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        MENU_ROW_HEIGHT_CLASS,
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuRadioItemIndicator,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
