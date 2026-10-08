"use client";

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import type { Ref } from "react";

import { cn } from "../../lib/utils";
import { buttonBaseClassName } from "./button-base";
import { buttonVariants } from "./button";

interface ToggleProps<
  Value extends string,
> extends TogglePrimitive.Props<Value> {
  variant?: "filter" | "quiet" | "primary";
  size?: "xs" | "sm" | "default" | "lg";
  ref?: Ref<HTMLButtonElement>;
}

/** A styled Base UI Toggle, including its native group and event contracts. */
function Toggle<Value extends string>({
  className,
  variant = "filter",
  size = "sm",
  ...props
}: ToggleProps<Value>) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      {...props}
      className={(state) => {
        return cn(
          variant === "filter"
            ? [
                buttonBaseClassName,
                "inline-flex h-7 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border px-2.5 leading-none transition-colors focus-visible:outline-none focus-visible:ring-inset focus-visible:ring-offset-0 disabled:pointer-events-none disabled:opacity-50",
                state.pressed
                  ? "bg-muted text-foreground"
                  : "bg-background text-muted-foreground hover:bg-state-hover hover:text-foreground",
              ]
            : [
                buttonVariants({
                  variant:
                    variant === "quiet"
                      ? "quiet"
                      : state.pressed
                        ? "default"
                        : "outline",
                  size,
                }),
                variant === "quiet"
                  ? state.pressed && "bg-gray-50 text-foreground"
                  : state.pressed
                    ? "border border-primary"
                    : "border-border/60 text-muted-foreground",
              ],
          typeof className === "function" ? className(state) : className,
        );
      }}
    />
  );
}

export { Toggle };
