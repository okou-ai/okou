import type { ReactNode, Ref } from "react";
import {
  Button,
  cn,
  DropdownMenuTrigger,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui";
import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import { useChatHeaderTransitioning } from "./chat-header-actions.ts";

/**
 * What a chat header icon button does. Everything else, from its look and
 * tooltip to its open highlight and settling state, is shared.
 *
 * - `action` runs something and has no open state (Share).
 * - `sidebar` toggles a thread sidebar and is pressed while it shows
 *   (Automations, Browser).
 * - `popup` opens a popover or menu below itself and is open while it shows
 *   (Emails, Artifacts, More). It must sit inside that Popover or menu root.
 */
export type ChatHeaderIconButtonUsage =
  | { readonly kind: "action"; readonly onClick: () => void }
  | {
      readonly kind: "sidebar";
      readonly pressed: boolean;
      readonly onClick: () => void;
    }
  | { readonly kind: "popup"; readonly popup: "popover" | "menu" };

// A sidebar toggle is aria-pressed while its sidebar shows, and Base UI marks
// an open popup trigger with data-popup-open; both read as one selected state.
const OPEN_CLASS =
  "aria-pressed:bg-primary/10 aria-pressed:text-selected-foreground aria-pressed:hover:text-selected-foreground data-popup-open:bg-primary/10 data-popup-open:text-selected-foreground data-popup-open:hover:text-selected-foreground";

export function ChatHeaderIconButton({
  thread,
  icon,
  label,
  tooltip = label,
  ref,
  largeTarget = false,
  usage,
}: {
  readonly thread: ChatPanelSignals;
  readonly icon: ReactNode;
  readonly label: string;
  readonly tooltip?: string;
  readonly ref?: Ref<HTMLElement>;
  /** Touch layouts use a 44px target. */
  readonly largeTarget?: boolean;
  readonly usage: ChatHeaderIconButtonUsage;
}) {
  // The old pane can remain mounted while the next thread's metadata loads.
  const transitioning = useChatHeaderTransitioning(thread);
  const button = (
    <Button
      ref={ref}
      type="button"
      variant="quiet"
      size="icon-sm"
      iconSize="md"
      // Settling buttons stay focusable but take no presses.
      disabled={transitioning}
      focusableWhenDisabled
      aria-busy={transitioning}
      aria-label={label}
      aria-pressed={usage.kind === "sidebar" ? usage.pressed : undefined}
      onClick={usage.kind === "popup" ? undefined : usage.onClick}
      className={cn(
        "shrink-0 duration-150",
        OPEN_CLASS,
        largeTarget && "size-11",
      )}
    />
  );
  const trigger =
    usage.kind !== "popup" ? (
      button
    ) : usage.popup === "popover" ? (
      <PopoverTrigger render={button} />
    ) : (
      <DropdownMenuTrigger render={button} />
    );
  // A press closes the tooltip until the pointer leaves, so it never covers
  // the popup hung below the button.
  return (
    <TooltipProvider delay={300}>
      <Tooltip>
        <TooltipTrigger render={trigger}>{icon}</TooltipTrigger>
        <TooltipContent side="bottom">{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
