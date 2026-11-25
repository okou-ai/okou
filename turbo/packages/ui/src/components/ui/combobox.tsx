"use client";

import { Autocomplete } from "@base-ui/react/autocomplete";
import * as React from "react";
import { cn } from "../../lib/utils";
import { SafeAreaCollisionPadding } from "../../lib/safe-area";
import { anchoredPopupTransitionClassName } from "./popup-motion";

/** Free-form shadcn/Base UI combobox; selection does not submit its form. */
const Combobox = Autocomplete.Root;
const ComboboxInputGroup = Autocomplete.InputGroup;

type ComboboxContentProps = Autocomplete.Popup.Props &
  Pick<Autocomplete.Positioner.Props, "anchor" | "align" | "sideOffset">;

const ComboboxContent = React.forwardRef<HTMLDivElement, ComboboxContentProps>(
  (
    { anchor, align = "start", sideOffset = 4, className, children, ...props },
    ref,
  ) => {
    return (
      <Autocomplete.Portal>
        <SafeAreaCollisionPadding requested={undefined}>
          {(padding) => {
            return (
              <Autocomplete.Positioner
                anchor={anchor}
                align={align}
                sideOffset={sideOffset}
                collisionPadding={padding}
              >
                <Autocomplete.Popup
                  ref={ref}
                  data-slot="combobox-content"
                  className={cn(
                    anchoredPopupTransitionClassName,
                    "w-(--anchor-width) max-w-(--available-width) overflow-hidden rounded-xl border border-surface-border bg-card p-1 text-foreground shadow-md outline-none",
                    className,
                  )}
                  {...props}
                >
                  {children}
                </Autocomplete.Popup>
              </Autocomplete.Positioner>
            );
          }}
        </SafeAreaCollisionPadding>
      </Autocomplete.Portal>
    );
  },
);
ComboboxContent.displayName = "ComboboxContent";

export { Combobox, ComboboxContent, ComboboxInputGroup };
