import type { ComponentProps, ReactNode, Ref } from "react";
// Slash-workflow domain helpers and the suggestion menu's popover shell, shared
// by the chat composer. Kept in its own module so the TipTap workflow composer
// and the slash template panel can both reuse them without an import cycle.
import { FileText, Image, Presentation } from "lucide-react";
import { cn, PopoverContent } from "@okouai/ui";
import type {
  ComposerSlashWorkflow,
  ComposerSlashWorkflowMatch,
} from "../../signals/okou-page/workflow-composer-domain.ts";

export const COMPOSER_CREATE_ICONS = {
  image: Image,
  presentation: Presentation,
  document: FileText,
} as const;

export function slashWorkflowOptionId(workflowId: string): string {
  return `slash-workflow-option-${workflowId}`;
}

export function scrollSlashWorkflowIntoView(
  workflow: Pick<ComposerSlashWorkflow, "id"> | undefined,
): void {
  if (!workflow) {
    return;
  }

  window.requestAnimationFrame(() => {
    const option = document.getElementById(slashWorkflowOptionId(workflow.id));
    if (option && typeof option.scrollIntoView === "function") {
      option.scrollIntoView({ block: "nearest" });
    }
  });
}

/**
 * The name with the typed query emphasized. Shared with the slash panel so both
 * menus show the same match feedback while typing.
 */
export function SlashWorkflowName({
  workflow,
  className,
}: {
  readonly workflow: ComposerSlashWorkflowMatch;
  readonly className?: string;
}) {
  return (
    <span
      className={cn("truncate font-mono text-foreground", className)}
      data-slot="slash-workflow-name"
    >
      <span className="text-brand-text">/</span>
      {workflow.matchRanges.flatMap((range, index) => {
        return [
          workflow.name.slice(
            workflow.matchRanges[index - 1]?.end ?? 0,
            range.start,
          ),
          <span
            key={range.start}
            className="text-brand-text/60"
            data-slot="workflow-query-match"
          >
            {workflow.name.slice(range.start, range.end)}
          </span>,
        ];
      })}
      {workflow.name.slice(workflow.matchRanges.at(-1)?.end ?? 0)}
    </span>
  );
}

/**
 * The popover the slash suggestions open in. The two-pane template panel it
 * holds owns its own scrolling, workflow rows and footer.
 */
export function SlashWorkflowMenu({
  menuRef,
  anchor,
  bare = false,
  children,
}: {
  readonly menuRef: Ref<HTMLDivElement>;
  readonly anchor?: ComponentProps<typeof PopoverContent>["anchor"];
  /**
   * Draw no surface: the menu is a positioning box for cards of its own, and
   * the space between and beside them lets the pointer through.
   */
  readonly bare?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <PopoverContent
      ref={menuRef}
      anchor={anchor}
      // Composer-anchored menus always open above the composer, on the home
      // page as in a chat, and never flip below it.
      side="top"
      align="start"
      sideOffset={8}
      collisionAvoidance={{ side: "none" }}
      // Keep focus in the TipTap editor: the menu's keyboard navigation is
      // handled there, so the popover must never steal focus when it opens.
      initialFocus={false}
      // The selected row owns focus once the menu closes.
      finalFocus={false}
      // The preview never affects the menu's width. Base UI tracks the card's
      // width and available space when the composer or visual viewport resizes.
      className={cn(
        "flex max-h-[min(380px,var(--available-height))] w-(--anchor-width) flex-col overflow-hidden p-0",
        bare &&
          "pointer-events-none overflow-visible rounded-none border-0 bg-transparent shadow-none",
      )}
      data-testid="slash-workflow-menu"
    >
      {children}
    </PopoverContent>
  );
}
