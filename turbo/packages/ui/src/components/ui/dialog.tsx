"use client";

import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";

import { asChildRender } from "../../lib/base-ui-compat";
import { IconButton } from "./icon-button";
import {
  dialogBackdropAnimationClassName,
  dialogPopupAnimationClassName,
} from "./popup-motion";
import { cn } from "../../lib/utils";

function Dialog(props: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

interface DialogTriggerProps extends Omit<
  DialogPrimitive.Trigger.Props,
  "render"
> {
  asChild?: boolean;
  render?: DialogPrimitive.Trigger.Props["render"];
}

const DialogTrigger = React.forwardRef<HTMLButtonElement, DialogTriggerProps>(
  ({ asChild = false, children, render, ...props }, ref) => {
    const child = asChild ? asChildRender(children) : undefined;
    return (
      <DialogPrimitive.Trigger
        ref={ref}
        data-slot="dialog-trigger"
        render={child ?? render}
        {...props}
      >
        {asChild ? undefined : children}
      </DialogPrimitive.Trigger>
    );
  },
);
DialogTrigger.displayName = "DialogTrigger";

function DialogPortal(props: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

interface DialogCloseProps extends Omit<DialogPrimitive.Close.Props, "render"> {
  asChild?: boolean;
  render?: DialogPrimitive.Close.Props["render"];
}

const DialogClose = React.forwardRef<HTMLButtonElement, DialogCloseProps>(
  ({ asChild = false, children, render, ...props }, ref) => {
    const child = asChild ? asChildRender(children) : undefined;
    return (
      <DialogPrimitive.Close
        ref={ref}
        data-slot="dialog-close"
        render={child ?? render}
        {...props}
      >
        {asChild ? undefined : children}
      </DialogPrimitive.Close>
    );
  },
);
DialogClose.displayName = "DialogClose";

const DialogOverlay = React.forwardRef<
  HTMLDivElement,
  DialogPrimitive.Backdrop.Props
>(({ className, ...props }, ref) => {
  return (
    <DialogPrimitive.Backdrop
      ref={ref}
      data-slot="dialog-overlay"
      className={cn(
        dialogBackdropAnimationClassName,
        "fixed inset-0 bg-overlay/45 dark:bg-overlay/55",
        className,
      )}
      {...props}
    />
  );
});
DialogOverlay.displayName = "DialogOverlay";

// These are upper bounds, not requested widths. The popup's w-full fills only
// the safe viewport. Keep rem units and responsive caps when migrating callers.
const dialogMaxWidthClasses = {
  sm: { base: "max-w-sm", sm: "sm:max-w-sm" },
  md: { base: "max-w-md", sm: "sm:max-w-md" },
  lg: { base: "max-w-lg", sm: "sm:max-w-lg" },
  xl: { base: "max-w-xl", sm: "sm:max-w-xl" },
  "2xl": { base: "max-w-2xl", sm: "sm:max-w-2xl" },
  "3xl": { base: "max-w-3xl", sm: "sm:max-w-3xl" },
  "4xl": { base: "max-w-4xl", sm: "sm:max-w-4xl" },
  "6xl": { base: "max-w-6xl", sm: "sm:max-w-6xl" },
  "25rem": { base: "max-w-[25rem]", sm: "sm:max-w-[25rem]" },
  "26.5rem": { base: "max-w-[26.5rem]", sm: "sm:max-w-[26.5rem]" },
  420: { base: "max-w-[420px]", sm: "sm:max-w-[420px]" },
  440: { base: "max-w-[440px]", sm: "sm:max-w-[440px]" },
  480: { base: "max-w-[480px]", sm: "sm:max-w-[480px]" },
  560: { base: "max-w-[560px]", sm: "sm:max-w-[560px]" },
  640: { base: "max-w-[640px]", sm: "sm:max-w-[640px]" },
  680: { base: "max-w-[680px]", sm: "sm:max-w-[680px]" },
  720: { base: "max-w-[720px]", sm: "sm:max-w-[720px]" },
  760: { base: "max-w-[760px]", sm: "sm:max-w-[760px]" },
  820: { base: "max-w-[820px]", sm: "sm:max-w-[820px]" },
  860: { base: "max-w-[860px]", sm: "sm:max-w-[860px]" },
  880: { base: "max-w-[880px]", sm: "sm:max-w-[880px]" },
  1120: { base: "max-w-[1120px]", sm: "sm:max-w-[1120px]" },
  1200: { base: "max-w-[1200px]", sm: "sm:max-w-[1200px]" },
  1440: { base: "max-w-[1440px]", sm: "sm:max-w-[1440px]" },
} as const;

const dialogHeightClasses = {
  content: "h-auto",
  fill: "h-full",
  600: "h-[600px]",
  688: "h-[688px]",
  720: "h-[720px]",
  760: "h-[760px]",
  800: "h-[800px]",
  1000: "h-[1000px]",
} as const;

interface DialogContentProps extends Omit<
  DialogPrimitive.Popup.Props,
  "className" | "style" | "render"
> {
  readonly closeLabel?: string;
  /** Styles the inner layout; viewport bounds and vertical scrolling stay owned here. */
  readonly contentClassName?: string;
  /** Maximum width; the available safe viewport may be narrower. */
  readonly maxWidth?: keyof typeof dialogMaxWidthClasses;
  /** Maximum width from the shared sm breakpoint onward. */
  readonly smMaxWidth?: keyof typeof dialogMaxWidthClasses;
  readonly height?: keyof typeof dialogHeightClasses;
  readonly mode?: "windowed" | "fullscreen";
  readonly surface?: "card" | "canvas" | "transparent";
  readonly overlayClassName?: string;
  readonly showCloseButton?: boolean;
}

const DialogContent = React.forwardRef<HTMLDivElement, DialogContentProps>(
  (
    {
      children,
      contentClassName,
      closeLabel = "Close",
      maxWidth = "lg",
      smMaxWidth,
      height = "content",
      mode = "windowed",
      surface = "card",
      overlayClassName,
      showCloseButton = true,
      ...props
    },
    ref,
  ) => {
    return (
      <DialogPortal>
        <DialogOverlay className={overlayClassName} forceRender />
        <DialogPrimitive.Viewport
          data-slot="dialog-viewport"
          className={cn(
            "fixed inset-x-0 top-0 flex h-[var(--okou-viewport-height,100dvh)] items-center justify-center overflow-hidden",
            mode === "windowed" && [
              "pt-[calc(var(--sat,env(safe-area-inset-top,0px))+1.5rem)]",
              "pr-[calc(var(--sar,env(safe-area-inset-right,0px))+1.5rem)]",
              "pb-[calc(var(--sab,env(safe-area-inset-bottom,0px))+1.5rem)]",
              "pl-[calc(var(--sal,env(safe-area-inset-left,0px))+1.5rem)]",
            ],
          )}
        >
          <DialogPrimitive.Popup
            {...props}
            ref={ref}
            data-slot="dialog-content"
            data-mode={mode}
            // Keep geometry owned here even when props arrive through a spread.
            style={undefined}
            render={undefined}
            className={cn(
              dialogPopupAnimationClassName,
              "relative flex min-h-0 min-w-0 w-full max-h-full max-w-full flex-col overflow-hidden outline-none contain-layout",
              surface === "card" && "bg-card",
              surface === "canvas" && "bg-background",
              mode === "windowed"
                ? [
                    dialogMaxWidthClasses[maxWidth].base,
                    smMaxWidth !== undefined &&
                      dialogMaxWidthClasses[smMaxWidth].sm,
                    dialogHeightClasses[height],
                    // 16px. A dialog is the largest floating surface in the
                    // product, and at 14px its corners read tighter than the
                    // cards it contains. Anything pinned to this edge derives
                    // its own radius from this one: inner = 16 - its inset.
                    "rounded-2xl",
                    surface === "card" &&
                      "border border-[hsl(var(--gray-400))] shadow-lg",
                    surface === "canvas" &&
                      "shadow-[0_24px_70px_rgba(0,0,0,0.30)]",
                  ]
                : [
                    "h-full w-full rounded-none",
                    "pt-[var(--sat,env(safe-area-inset-top,0px))]",
                    "pr-[var(--sar,env(safe-area-inset-right,0px))]",
                    "pb-[var(--sab,env(safe-area-inset-bottom,0px))]",
                    "pl-[var(--sal,env(safe-area-inset-left,0px))]",
                  ],
            )}
          >
            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              <DialogBody
                data-slot="dialog-inner"
                className={cn(
                  "grid gap-4 p-6",
                  contentClassName,
                  // A caller's clipping utility must not make footer actions
                  // unreachable when the safe viewport constrains the panel.
                  "overflow-y-auto!",
                )}
              >
                {children}
              </DialogBody>
              {showCloseButton ? (
                <DialogPrimitive.Close
                  data-slot="dialog-close"
                  render={
                    <IconButton
                      className="absolute top-4 right-4 opacity-70 hover:opacity-100"
                      aria-label={closeLabel}
                    />
                  }
                >
                  <X size={20} className="text-foreground" />
                </DialogPrimitive.Close>
              ) : null}
            </div>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPortal>
    );
  },
);
DialogContent.displayName = "DialogContent";

interface DialogBodyProps extends React.ComponentProps<"div"> {
  /** Disable when a child owns scrolling, such as a plan grid below a header. */
  scrollable?: boolean;
}

function DialogBody({
  className,
  scrollable = true,
  ...props
}: DialogBodyProps) {
  return (
    <div
      data-slot="dialog-body"
      className={cn(
        "min-h-0 min-w-0 flex-1",
        scrollable &&
          "overflow-auto [scrollbar-width:thin] [scrollbar-color:rgba(128,128,128,0.3)_transparent] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:my-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-[3px] [&::-webkit-scrollbar-thumb]:bg-[rgba(128,128,128,0.3)] [&::-webkit-scrollbar-thumb:hover]:bg-[rgba(128,128,128,0.5)]",
        className,
      )}
      {...props}
    />
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn(
        "flex flex-col space-y-1.5 text-center sm:text-left",
        className,
      )}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "text-lg font-semibold leading-none tracking-tight",
        className,
      )}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogBody,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
