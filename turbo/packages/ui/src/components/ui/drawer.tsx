"use client";

import * as React from "react";
import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer";
import { X } from "lucide-react";

import { IconButton } from "./icon-button";
import { modalBackdropTransitionClassName } from "./popup-motion";
import { cn } from "../../lib/utils";

// This shared surface is a modal bottom drawer, not an all-direction sheet.
function Drawer<Payload = unknown>(
  props: Omit<DrawerPrimitive.Root.Props<Payload>, "modal" | "swipeDirection">,
) {
  return <DrawerPrimitive.Root {...props} modal swipeDirection="down" />;
}

interface DrawerContentProps extends Omit<
  DrawerPrimitive.Popup.Props,
  "className" | "style" | "render"
> {
  /** The translated accessible name for the close control. */
  readonly closeLabel: string;
  /** Keep overlays inside a native fullscreen host when one owns the viewer. */
  readonly portalContainer?: DrawerPrimitive.Portal.Props["container"];
}

const DrawerContent = React.forwardRef<HTMLDivElement, DrawerContentProps>(
  ({ children, closeLabel, portalContainer, ...props }, ref) => {
    return (
      // Keep the backdrop, drawer, and descendant popups in one modal context.
      <DrawerPrimitive.Portal
        container={portalContainer}
        data-slot="drawer-portal"
        className="relative z-50"
      >
        <DrawerPrimitive.Backdrop
          data-slot="drawer-overlay"
          forceRender
          className={cn(
            modalBackdropTransitionClassName,
            "fixed inset-0 bg-overlay/45 dark:bg-overlay/55 opacity-[calc(1-var(--drawer-swipe-progress,0))] data-swiping:duration-0 data-ending-style:duration-[calc(var(--drawer-swipe-strength,1)*150ms)] data-ending-style:data-swiping:duration-[calc(var(--drawer-swipe-strength,1)*150ms)] [@media(display-mode:standalone)]:-bottom-safe",
          )}
        />
        <DrawerPrimitive.Viewport
          data-slot="drawer-viewport"
          className="fixed inset-x-0 top-0 flex h-[var(--okou-viewport-height,100dvh)] min-h-0 items-end pt-safe-offset-6"
        >
          <DrawerPrimitive.Popup
            {...props}
            ref={ref}
            data-slot="drawer-popup"
            // Callers keep native popup behavior; geometry remains shared-owned.
            style={undefined}
            render={undefined}
            className={cn(
              "relative flex min-h-0 min-w-0 h-[var(--drawer-height,auto)] max-h-full w-full flex-col rounded-t-2xl border-t border-border bg-card text-foreground shadow-lg outline-none",
              "[transform:translateY(calc(var(--drawer-snap-point-offset,0px)+var(--drawer-swipe-movement-y,0px)))] data-starting-style:[transform:translateY(calc(100%+2px))] data-ending-style:[transform:translateY(calc(100%+2px))] data-starting-style:opacity-0 data-ending-style:opacity-0 motion-safe:transition-[transform,opacity] motion-safe:duration-150 motion-safe:ease-out motion-safe:data-swiping:duration-0 motion-safe:data-ending-style:duration-[calc(var(--drawer-swipe-strength,1)*150ms)] motion-safe:data-ending-style:data-swiping:duration-[calc(var(--drawer-swipe-strength,1)*150ms)]",
              // Fill swipe overshoot and the standalone home-indicator strip
              // without extending the content's layout or its scrolling bounds.
              "after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-12 after:bg-card [@media(display-mode:standalone)]:after:h-[max(3rem,var(--sab,env(safe-area-inset-bottom,0px)))]",
            )}
          >
            {/* Outside Content so mouse dragging does not steal text selection. */}
            <div
              data-slot="drawer-swipe-handle"
              aria-hidden="true"
              className="flex h-6 shrink-0 cursor-grab items-center justify-center active:cursor-grabbing"
            >
              <div className="h-1.5 w-24 rounded-full bg-muted" />
            </div>
            <DrawerPrimitive.Content
              data-slot="drawer-content"
              className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden pb-safe-offset-6 pr-safe-offset-6 pl-safe-offset-6"
            >
              {/* Header stays fixed; children own a min-h-0 flex-1 scrollport. */}
              <div className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-4">
                {children}
                <DrawerPrimitive.Close
                  data-slot="drawer-close"
                  render={
                    <IconButton
                      className="absolute top-0 right-0 opacity-70 hover:opacity-100"
                      aria-label={closeLabel}
                    />
                  }
                >
                  <X size={20} className="text-foreground" />
                </DrawerPrimitive.Close>
              </div>
            </DrawerPrimitive.Content>
          </DrawerPrimitive.Popup>
        </DrawerPrimitive.Viewport>
      </DrawerPrimitive.Portal>
    );
  },
);
DrawerContent.displayName = "DrawerContent";

function DrawerHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-header"
      className={cn("flex min-h-9 shrink-0 flex-col gap-1.5 pr-12", className)}
      {...props}
    />
  );
}

function DrawerTitle({ className, ...props }: DrawerPrimitive.Title.Props) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn(
        "text-lg font-semibold leading-none tracking-tight",
        className,
      )}
      {...props}
    />
  );
}

export { Drawer, DrawerContent, DrawerHeader, DrawerTitle };
