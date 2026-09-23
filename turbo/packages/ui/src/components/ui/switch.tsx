"use client";

import * as React from "react";
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "../../lib/utils";

const SIZES = {
  default: {
    root: "h-6 w-11",
    thumb: "h-5 w-5 data-checked:translate-x-5 data-unchecked:translate-x-0",
  },
  // The size settings rows align to, so a toggle sits on the same baseline as
  // a 20px label line without stretching the row.
  compact: {
    root: "h-5 w-9",
    thumb: "h-4 w-4 data-checked:translate-x-4 data-unchecked:translate-x-0",
  },
  sm: {
    root: "h-4 w-7",
    thumb: "h-3 w-3 data-checked:translate-x-3 data-unchecked:translate-x-0",
  },
} as const;

interface SwitchProps extends Omit<SwitchPrimitive.Root.Props, "className"> {
  className?: string;
  size?: keyof typeof SIZES;
}

const Switch = React.forwardRef<HTMLElement, SwitchProps>(
  ({ className, size = "default", ...props }, ref) => {
    const s = SIZES[size];
    return (
      <SwitchPrimitive.Root
        data-slot="switch"
        className={cn(
          "peer inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors outline-none data-checked:bg-primary-400 data-unchecked:bg-segment-track focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background data-disabled:cursor-not-allowed data-disabled:opacity-50",
          s.root,
          className,
        )}
        {...props}
        ref={ref}
      >
        <SwitchPrimitive.Thumb
          data-slot="switch-thumb"
          className={cn(
            "pointer-events-none block rounded-full bg-[#ffffff] shadow-lg ring-0 transition-transform",
            s.thumb,
          )}
        />
      </SwitchPrimitive.Root>
    );
  },
);
Switch.displayName = "Switch";

export { Switch };
