"use client";

import type { ComponentProps, ReactElement } from "react";
import { isVitestEnvironment } from "@okouai/core/test-environment";
import { getShortcutLabel } from "../../lib/keyboard-shortcuts";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";

// The provider's timeout is the grace period between adjacent tooltips.
const SHORTCUT_TOOLTIP_TIMING = isVitestEnvironment()
  ? { delay: 0, timeout: 0 }
  : { delay: 200 };

interface ShortcutItem {
  readonly shortcut: string;
  readonly trigger: ReactElement<{
    "aria-label": string;
    disabled?: boolean;
  }>;
}

export function ShortcutTooltipGroup({
  items,
  side = "bottom",
}: {
  readonly items: readonly ShortcutItem[];
  readonly side?: ComponentProps<typeof TooltipContent>["side"];
}) {
  return (
    <TooltipProvider {...SHORTCUT_TOOLTIP_TIMING}>
      <span className="inline-flex shrink-0 items-center gap-1">
        {items.map((item) => {
          return (
            <Tooltip key={item.shortcut} disabled={item.trigger.props.disabled}>
              <TooltipTrigger render={item.trigger} />
              <TooltipContent
                role="tooltip"
                side={side}
                className="flex flex-col items-center gap-1 py-1.5"
              >
                <span>{item.trigger.props["aria-label"]}</span>
                <kbd className="whitespace-nowrap font-sans text-xs opacity-70">
                  {getShortcutLabel(item.shortcut)}
                </kbd>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </span>
    </TooltipProvider>
  );
}
