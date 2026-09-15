import { useTranslation } from "react-i18next";
import { Plus, type LucideIcon } from "lucide-react";
import { Button } from "@okouai/ui/components/ui/button";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "@okouai/ui/components/ui/popover";

/** One row of the composer's add menu. */
export interface ComposerAddMenuItem {
  readonly id: string;
  readonly Icon: LucideIcon;
  readonly label: string;
  readonly onSelect: () => void;
  /**
   * Runs on hover, focus and press, before the click that opens whatever the
   * row leads to. The template picker downloads its cover images, so it warms
   * them here rather than after the menu has already closed.
   */
  readonly onPrewarm?: () => void;
}

/**
 * The composer toolbar's `+`: one entry point for what a message can gain,
 * rather than a button per capability. Attach, template and create workflow
 * each answered the same question from their own icon, and the toolbar had no
 * room left for the next one.
 *
 * Rows are single-line on purpose. Every label is already a noun the product
 * uses elsewhere, so a description line would only restate it.
 */
export function ComposerAddMenu({
  groups,
}: {
  /** Rendered in order, separated by a rule. */
  readonly groups: readonly (readonly ComposerAddMenuItem[])[];
}) {
  const { t } = useTranslation();
  const label = t(($) => {
    return $.chat.composer.add;
  });
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="quiet"
          size="icon-sm"
          iconSize="md"
          className="shrink-0"
          aria-label={label}
        >
          <Plus size={18} aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        className="w-56 p-1.5"
      >
        <div role="menu" aria-label={label}>
          {groups.map((group, index) => {
            return (
              <div key={group[0]?.id ?? index}>
                {index > 0 && <div className="my-1.5 h-px bg-divider" />}
                {group.map((item) => {
                  return (
                    <PopoverClose asChild key={item.id}>
                      <button
                        type="button"
                        role="menuitem"
                        className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-state-hover"
                        onPointerEnter={item.onPrewarm}
                        onFocus={item.onPrewarm}
                        onPointerDown={item.onPrewarm}
                        onClick={item.onSelect}
                      >
                        <item.Icon
                          size={16}
                          className="shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <span className="min-w-0 truncate">{item.label}</span>
                      </button>
                    </PopoverClose>
                  );
                })}
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
