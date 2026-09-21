"use client";

import * as React from "react";
import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";

import { asChildRender } from "../../lib/base-ui-compat";
import {
  modalBackdropTransitionClassName,
  sheetPopupTransitionClassName,
} from "./popup-motion";
import { cn } from "../../lib/utils";
import { IconButton } from "./icon-button";

function Sheet(props: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

interface SheetTriggerProps extends Omit<
  SheetPrimitive.Trigger.Props,
  "render"
> {
  asChild?: boolean;
  render?: SheetPrimitive.Trigger.Props["render"];
}

const SheetTrigger = React.forwardRef<HTMLButtonElement, SheetTriggerProps>(
  ({ asChild = false, children, render, ...props }, ref) => {
    const child = asChild ? asChildRender(children) : undefined;
    return (
      <SheetPrimitive.Trigger
        ref={ref}
        data-slot="sheet-trigger"
        render={child ?? render}
        {...props}
      >
        {asChild ? undefined : children}
      </SheetPrimitive.Trigger>
    );
  },
);
SheetTrigger.displayName = "SheetTrigger";

interface SheetCloseProps extends Omit<SheetPrimitive.Close.Props, "render"> {
  asChild?: boolean;
  render?: SheetPrimitive.Close.Props["render"];
}

const SheetClose = React.forwardRef<HTMLButtonElement, SheetCloseProps>(
  ({ asChild = false, children, render, ...props }, ref) => {
    const child = asChild ? asChildRender(children) : undefined;
    return (
      <SheetPrimitive.Close
        ref={ref}
        data-slot="sheet-close"
        render={child ?? render}
        {...props}
      >
        {asChild ? undefined : children}
      </SheetPrimitive.Close>
    );
  },
);
SheetClose.displayName = "SheetClose";

function SheetPortal(props: SheetPrimitive.Portal.Props) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

const SheetOverlay = React.forwardRef<
  HTMLDivElement,
  SheetPrimitive.Backdrop.Props
>(({ className, ...props }, ref) => {
  return (
    <SheetPrimitive.Backdrop
      ref={ref}
      data-slot="sheet-overlay"
      className={cn(
        modalBackdropTransitionClassName,
        "fixed inset-0 z-50 bg-overlay/45 dark:bg-overlay/55",
        className,
      )}
      {...props}
    />
  );
});
SheetOverlay.displayName = "SheetOverlay";

interface SheetContentProps extends SheetPrimitive.Popup.Props {
  overlayClassName?: string;
  side?: "top" | "bottom" | "left" | "right";
}

const SheetContent = React.forwardRef<HTMLDivElement, SheetContentProps>(
  (
    { children, className, overlayClassName, side = "right", ...props },
    ref,
  ) => {
    return (
      <SheetPortal>
        <SheetOverlay className={overlayClassName} forceRender />
        <SheetPrimitive.Popup
          ref={ref}
          data-slot="sheet-content"
          data-side={side}
          className={cn(
            sheetPopupTransitionClassName,
            "fixed z-50 flex flex-col gap-4 overflow-x-hidden bg-card p-6 outline-none",
            // The sheet is portalled and fixed, so it is laid out past the
            // shell's padding box and owes its own insets. Only the edges it
            // actually meets take one: a right sheet's left edge sits mid-screen,
            // where the left inset would be a gap rather than a clearance.
            side === "right" &&
              "pt-safe-offset-6 pr-safe-offset-6 pb-safe-offset-6 inset-y-0 right-0 h-full w-3/4 data-starting-style:translate-x-full data-ending-style:translate-x-full shadow-[-8px_0_24px_-12px_rgba(0,0,0,0.1)] sm:max-w-lg dark:shadow-[-16px_0_48px_-8px_rgba(0,0,0,0.5)]",
            side === "left" &&
              "pt-safe-offset-6 pb-safe-offset-6 pl-safe-offset-6 inset-y-0 left-0 h-full w-3/4 data-starting-style:-translate-x-full data-ending-style:-translate-x-full shadow-[8px_0_24px_-12px_rgba(0,0,0,0.1)] sm:max-w-md dark:shadow-[16px_0_48px_-8px_rgba(0,0,0,0.5)]",
            side === "top" &&
              "pt-safe-offset-6 pr-safe-offset-6 pl-safe-offset-6 inset-x-0 top-0 data-starting-style:-translate-y-full data-ending-style:-translate-y-full",
            side === "bottom" &&
              "pr-safe-offset-6 pb-safe-offset-6 pl-safe-offset-6 inset-x-0 bottom-0 data-starting-style:translate-y-full data-ending-style:translate-y-full",
            className,
          )}
          {...props}
        >
          {children}
          <SheetPrimitive.Close
            data-slot="sheet-close"
            render={
              <IconButton
                // Offsets on an absolutely positioned child resolve against the
                // padding box, so the popup's own insets do not move this
                // control. It clears the same edges the popup does.
                className={cn(
                  "absolute opacity-70 hover:opacity-100",
                  side === "bottom" ? "top-4" : "top-safe-offset-4",
                  side === "left" ? "right-4" : "right-safe-offset-4",
                )}
                aria-label="Close"
              />
            }
          >
            <X size={20} className="text-foreground" />
          </SheetPrimitive.Close>
        </SheetPrimitive.Popup>
      </SheetPortal>
    );
  },
);
SheetContent.displayName = "SheetContent";

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col space-y-2 text-left", className)}
      {...props}
    />
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("text-lg font-semibold text-foreground", className)}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: SheetPrimitive.Description.Props) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetPortal,
  SheetOverlay,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
