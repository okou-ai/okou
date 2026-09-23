"use client";

import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import type { Ref } from "react";

import { cn } from "../../lib/utils";

function ToggleGroup<Value extends string>({
  className,
  ...props
}: ToggleGroupPrimitive.Props<Value> & { ref?: Ref<HTMLDivElement> }) {
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      {...props}
      className={(state) => {
        return cn(
          "flex items-center gap-1.5",
          typeof className === "function" ? className(state) : className,
        );
      }}
    />
  );
}

export { ToggleGroup };
