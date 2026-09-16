import { useTranslation } from "react-i18next";
import { Plus, type LucideIcon } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@okouai/ui";

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
 * A group always carries at least one row. Saying so in the type is what lets
 * the group key read `group[0].id` directly instead of inventing a key for an
 * empty group the caller cannot build.
 */
export type ComposerAddMenuGroup = readonly [
  ComposerAddMenuItem,
  ...ComposerAddMenuItem[],
];

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
  readonly groups: readonly ComposerAddMenuGroup[];
}) {
  const { t } = useTranslation();
  const label = t(($) => {
    return $.chat.composer.add;
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
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
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        aria-label={label}
        className="w-56"
      >
        {/* Flat on purpose: Base UI reads its items from the popup's own
            children, so a wrapper element per group would sit between them and
            break the menu's keyboard navigation. */}
        {groups.flatMap((group, index) => {
          const separator =
            index > 0
              ? [<DropdownMenuSeparator key={`separator-${group[0].id}`} />]
              : [];
          return [
            ...separator,
            ...group.map((item) => {
              return (
                <DropdownMenuItem
                  key={item.id}
                  onPointerEnter={item.onPrewarm}
                  onFocus={item.onPrewarm}
                  onPointerDown={item.onPrewarm}
                  onClick={item.onSelect}
                >
                  <item.Icon
                    className="shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 truncate">{item.label}</span>
                </DropdownMenuItem>
              );
            }),
          ];
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
