import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Plus, type LucideIcon } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@okouai/ui";

interface ComposerAddMenuRow {
  readonly id: string;
  readonly Icon: LucideIcon;
  readonly label: string;
}

/**
 * One row of the composer's add menu: an action, or a choice that opens its
 * options beside the menu.
 */
export type ComposerAddMenuItem = ComposerAddMenuRow &
  (
    | { readonly onSelect: () => void }
    | {
        /** The submenu's own menu items, rendered flat like the rows here. */
        readonly submenu: ReactNode;
      }
  );

function ComposerAddMenuRowLabel({
  item,
}: {
  readonly item: ComposerAddMenuRow;
}) {
  return (
    <>
      <item.Icon
        className="shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <span className="min-w-0 truncate">{item.label}</span>
    </>
  );
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
 * rather than a button per capability. It groups attachments, templates and
 * skill imports in one menu, and on a new chat the Project it starts in.
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
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="quiet"
            size="icon-sm"
            iconSize="md"
            className="shrink-0"
            aria-label={label}
          />
        }
      >
        <Plus size={18} aria-hidden="true" />
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
              if ("submenu" in item) {
                return (
                  <DropdownMenuSub key={item.id}>
                    <DropdownMenuSubTrigger>
                      <ComposerAddMenuRowLabel item={item} />
                      <ChevronRight
                        className="ml-auto text-muted-foreground"
                        aria-hidden="true"
                      />
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent
                      aria-label={item.label}
                      className="w-64"
                    >
                      {item.submenu}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                );
              }
              return (
                <DropdownMenuItem key={item.id} onClick={item.onSelect}>
                  <ComposerAddMenuRowLabel item={item} />
                </DropdownMenuItem>
              );
            }),
          ];
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
