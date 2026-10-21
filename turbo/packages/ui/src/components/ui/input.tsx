import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";

import { cn } from "../../lib/utils";

type InputProps = React.ComponentProps<"input"> & {
  /**
   * Fixed text the value runs into, such as the domain after a subdomain. It
   * is drawn as a segment of the field, so the frame, focus ring and disabled
   * state cover it as well; `className` then styles that frame rather than the
   * bare input.
   */
  readonly suffix?: React.ReactNode;
};

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, suffix, ...props }, ref) => {
    if (suffix !== undefined) {
      return (
        <div
          data-slot="input-group"
          className={cn(
            "flex h-9 w-full overflow-hidden rounded-lg border border-[hsl(var(--gray-400))] bg-input text-sm text-foreground transition-colors focus-within:border-primary focus-within:ring-[3px] focus-within:ring-primary/10 has-disabled:cursor-not-allowed has-disabled:opacity-50",
            className,
          )}
        >
          <InputPrimitive
            type={type}
            data-slot="input"
            className="min-w-0 flex-1 bg-transparent px-3 py-2 placeholder:text-sm placeholder:text-muted-foreground outline-none disabled:cursor-not-allowed"
            ref={ref}
            {...props}
          />
          <span className="flex shrink-0 items-center border-l border-[hsl(var(--gray-400))] bg-muted/60 px-3 text-muted-foreground">
            {suffix}
          </span>
        </div>
      );
    }
    return (
      <InputPrimitive
        type={type}
        data-slot="input"
        className={cn(
          "flex h-9 w-full rounded-lg border border-[hsl(var(--gray-400))] bg-input px-3 py-2 text-sm text-foreground placeholder:text-sm placeholder:text-muted-foreground outline-none transition-colors focus:border-primary focus:ring-[3px] focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-50 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
          type === "password" &&
            "font-mono tracking-wider placeholder:font-sans placeholder:tracking-normal",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
