import type { ComponentProps, ReactNode } from "react";
// Slash-workflow domain helpers and the suggestion menu, shared by the chat
// composer. Kept in its own module so the textarea composer and the TipTap
// workflow composer can both reuse them without an import cycle.
import {
  ChevronRight,
  FileText,
  Image,
  Presentation,
  Sparkles,
  Video,
} from "lucide-react";
import { cn, PopoverContent } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { ROUTES } from "../../signals/route-paths.ts";
import { Link } from "../router/link.tsx";
import type {
  ComposerSlashWorkflow,
  ComposerSlashWorkflowMatch,
} from "../../signals/okou-page/workflow-composer-domain.ts";

import {
  composerCreateCommandLabel,
  type ComposerCreateCommand,
} from "../../signals/okou-page/composer-create.ts";

export const COMPOSER_CREATE_ICONS = {
  choose: Sparkles,
  image: Image,
  video: Video,
  presentation: Presentation,
} as const;

export function slashWorkflowOptionId(workflowId: string): string {
  return `slash-workflow-option-${workflowId}`;
}

const COMPOSER_SUGGESTION_COLLISION_GAP = 12;

export function composerSuggestionCollisionPadding():
  | number
  | { top: number; right: number; bottom: number; left: number } {
  // Base UI portals the menu to body. Read the shared root edges and the
  // component-owned bottom inset so it stays inside the visible boundary.
  const root = document.getElementById("root");
  if (!root) {
    return COMPOSER_SUGGESTION_COLLISION_GAP;
  }
  const styles = window.getComputedStyle(root);
  const documentStyles = window.getComputedStyle(document.documentElement);
  const inset = (value: string): number => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    top: COMPOSER_SUGGESTION_COLLISION_GAP + inset(styles.paddingTop),
    right: COMPOSER_SUGGESTION_COLLISION_GAP + inset(styles.paddingRight),
    bottom:
      COMPOSER_SUGGESTION_COLLISION_GAP +
      inset(documentStyles.getPropertyValue("--sab")),
    left: COMPOSER_SUGGESTION_COLLISION_GAP + inset(styles.paddingLeft),
  };
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

function SlashCreateGroup({
  modes,
  selectedIndex,
  onSelect,
}: {
  readonly modes: readonly ComposerCreateCommand[];
  readonly selectedIndex: number;
  readonly onSelect: (mode: ComposerCreateCommand) => void;
}) {
  const { t } = useTranslation();
  if (modes.length === 0) {
    return null;
  }
  return (
    <div className="px-1 py-1">
      {modes.map((mode, index) => {
        const Icon = COMPOSER_CREATE_ICONS[mode];
        return (
          <button
            key={mode}
            id={slashWorkflowOptionId(mode)}
            type="button"
            aria-label={composerCreateCommandLabel(mode)}
            className={cn(
              "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors",
              index === selectedIndex ? "bg-accent" : "hover:bg-state-hover",
            )}
            onPointerDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => {
              onSelect(mode);
            }}
          >
            <Icon size={16} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block">{composerCreateCommandLabel(mode)}</span>
              {mode === "choose" && (
                <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                  {t(($) => {
                    return $.chat.composer.create.description;
                  })}
                </span>
              )}
            </span>
            {mode === "choose" && <ChevronRight size={16} aria-hidden />}
          </button>
        );
      })}
    </div>
  );
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

/** The flat menu's workflow rows, split out to keep the menu within its size. */
function SlashWorkflowRows({
  workflows,
  loading,
  selectedIndex,
  indexOffset,
  onSelect,
}: {
  readonly workflows: readonly ComposerSlashWorkflowMatch[];
  readonly loading: boolean;
  readonly selectedIndex: number;
  /** How many rows precede these, so the shared index still lines up. */
  readonly indexOffset: number;
  readonly onSelect: (workflow: ComposerSlashWorkflow) => void;
}) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <div className="px-2.5 py-2 text-sm text-muted-foreground">
        {t(($) => {
          return $.chat.composer.workflows.loading;
        })}
      </div>
    );
  }
  if (workflows.length === 0) {
    return (
      <div className="px-2.5 pt-1 pb-2.5 text-sm text-muted-foreground">
        {t(($) => {
          return $.chat.composer.workflows.empty;
        })}
      </div>
    );
  }
  return (
    <div className="px-1 pb-1">
      {workflows.map((workflow, index) => {
        const selected = index + indexOffset === selectedIndex;
        return (
          <button
            id={slashWorkflowOptionId(workflow.id)}
            key={workflow.id}
            type="button"
            className={cn(
              "flex w-full flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors",
              selected ? "bg-accent" : "hover:bg-state-hover",
            )}
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(workflow);
            }}
          >
            <SlashWorkflowName workflow={workflow} className="w-full text-sm" />
            {workflow.description && (
              <span className="w-full truncate text-xs text-muted-foreground/70">
                {workflow.description}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function SlashWorkflowMenu({
  anchor,
  workflows,
  createModes,
  onSelectCreate,
  loading,
  selectedIndex,
  showWorkflowsPageLink,
  onSelect,
  panel,
}: {
  readonly anchor?: ComponentProps<typeof PopoverContent>["anchor"];
  readonly workflows: readonly ComposerSlashWorkflowMatch[];
  readonly createModes: readonly ComposerCreateCommand[];
  readonly onSelectCreate: (mode: ComposerCreateCommand) => void;
  readonly loading: boolean;
  readonly selectedIndex: number;
  readonly showWorkflowsPageLink: boolean;
  readonly onSelect: (workflow: ComposerSlashWorkflow) => void;
  /**
   * The two-pane template panel. When present it replaces the flat list and
   * owns its own scrolling, workflow rows and footer.
   */
  readonly panel?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <PopoverContent
      anchor={anchor}
      side="top"
      align="start"
      sideOffset={8}
      collisionPadding={composerSuggestionCollisionPadding()}
      updatePositionStrategy="always"
      // Keep focus in the TipTap editor: the menu's keyboard navigation is
      // handled there, so the popover must never steal focus when it opens.
      initialFocus={false}
      // The selected command owns focus, including the Create type chooser.
      finalFocus={false}
      className={cn(
        "flex max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden p-0",
        panel
          ? "h-[min(380px,var(--available-height))] w-auto"
          : "h-[min(16rem,var(--available-height))] w-[300px] md:h-[min(20rem,var(--available-height))]",
      )}
      data-testid="slash-workflow-menu"
    >
      {panel ?? (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SlashCreateGroup
              modes={createModes}
              selectedIndex={selectedIndex}
              onSelect={onSelectCreate}
            />
            <div className="px-2.5 pt-2 pb-2 text-xs font-medium text-muted-foreground">
              {t(($) => {
                return $.chat.composer.workflows.title;
              })}
            </div>
            <SlashWorkflowRows
              workflows={workflows}
              loading={loading}
              selectedIndex={selectedIndex}
              indexOffset={createModes.length}
              onSelect={onSelect}
            />
          </div>
          {showWorkflowsPageLink && (
            <div className="shrink-0 border-t border-border/60 bg-popover/95 p-1">
              <Link
                pathname={ROUTES.workflows}
                onMouseDown={(event) => {
                  // Keep the composer focused until Link handles the click.
                  event.preventDefault();
                }}
                className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-sm font-medium text-popover-foreground transition-colors hover:bg-state-hover"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <FileText
                    size={16}
                    className="shrink-0 text-muted-foreground"
                  />
                  <span className="truncate">
                    {t(($) => {
                      return $.chat.composer.workflows.viewAll;
                    })}
                  </span>
                </span>
                <ChevronRight
                  size={16}
                  className="shrink-0 text-muted-foreground"
                />
              </Link>
            </div>
          )}
        </>
      )}
    </PopoverContent>
  );
}
