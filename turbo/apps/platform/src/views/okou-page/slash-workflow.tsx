import type { ComponentProps, ReactNode, Ref } from "react";
// Slash-workflow domain helpers and the suggestion menu's popover shell, shared
// by the chat composer. Kept in its own module so the TipTap workflow composer
// and the slash template panel can both reuse them without an import cycle.
import { Image, Presentation } from "lucide-react";
import { cn, PopoverContent } from "@okouai/ui";
import type {
  ComposerSlashWorkflow,
  ComposerSlashWorkflowMatch,
} from "../../signals/okou-page/workflow-composer-domain.ts";

export const COMPOSER_CREATE_ICONS = {
  image: Image,
  presentation: Presentation,
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
  children,
}: {
  readonly menuRef: Ref<HTMLDivElement>;
  readonly anchor?: ComponentProps<typeof PopoverContent>["anchor"];
  readonly children: ReactNode;
}) {
  return (
    <PopoverContent
      ref={menuRef}
      anchor={anchor}
      side="top"
      align="start"
      sideOffset={8}
      // Keep focus in the TipTap editor: the menu's keyboard navigation is
      // handled there, so the popover must never steal focus when it opens.
      initialFocus={false}
      // The selected row owns focus once the menu closes.
      finalFocus={false}
      // The index alone, at a width it never leaves. Its detail pane is a
      // flyout anchored to this box rather than a column inside it, so opening
      // one cannot resize the box Base UI pins — a content-width popover
      // re-pinned itself against the viewport edge and slid the whole index out
      // from under the pointer that opened the row.
      className="flex h-[min(380px,var(--available-height))] w-[260px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden p-0"
      data-testid="slash-workflow-menu"
    >
      {children}
    </PopoverContent>
  );
}
