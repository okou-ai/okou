import { ScrollArea } from "@base-ui/react/scroll-area";
import { useLastResolved } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { cn, ScrollBar, surfaceVariants } from "@okouai/ui";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import {
  WORKFLOW_RECOMMENDATIONS,
  type WorkflowRecommendation,
} from "../../signals/okou-page/composer-workflow-recommendations.ts";
import { connectorCatalogStatus$ } from "../../signals/external/connectors.ts";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import { SCROLL_FADE_Y_START_WHEN_OVERFLOWING } from "./scroll-fade.ts";

/**
 * How tall the list is allowed to be, in whole rows.
 *
 * A card holds a 24px mark row, an 8px gap, its `text-sm` title's 20px line box,
 * the title's own 2px offset and two `text-xs` description lines: 86px of
 * content, so at `p-3.5` the card is 114. Deriving it from the content is what
 * keeps the second description line off the card's own edge; a round number
 * picked for the box was shorter than the text it had to hold.
 *
 * The viewport's own `pb-2` is added on top, so the window stops one grid gap
 * below the last row it can show and the fade only ever covers whitespace or a
 * row that starts exactly at the edge.
 */
const CARD_H = 24 + 8 + 20 + 2 + 2 * 16 + 2 * 14;
const GRID_GAP = 8;
const VISIBLE_ROWS = 3;
const LIST_MAX_H =
  VISIBLE_ROWS * CARD_H + (VISIBLE_ROWS - 1) * GRID_GAP + GRID_GAP;

/** How many marks a card shows before the rest are left to the workflow itself. */
const MAX_MARKS = 3;

/**
 * The apps a workflow runs on, as marks alone.
 *
 * The slot is a fixed three marks wide even when the workflow uses one, because
 * the titles below them line up across the grid only if the row above them is
 * the same width on every card — the connector picker gets that for free by
 * giving every tile exactly one mark.
 */
const MARK_SLOT_W = MAX_MARKS * 24 + (MAX_MARKS - 1) * 4;

function WorkflowMarks({
  connectors,
}: {
  readonly connectors: readonly ConnectorSlug[];
}) {
  const catalog = useLastResolved(connectorCatalogStatus$)?.connectors;
  return (
    <span
      className="flex shrink-0 items-center gap-1"
      style={{ width: MARK_SLOT_W }}
    >
      {connectors.slice(0, MAX_MARKS).map((slug) => {
        const connector = catalog?.find((candidate) => {
          return candidate.slug === slug;
        });
        return (
          <span
            key={slug}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background"
          >
            <ConnectorIcon icon={connector?.icon} size={14} />
          </span>
        );
      })}
    </span>
  );
}

function WorkflowCard({
  item,
  onSelect,
}: {
  readonly item: WorkflowRecommendation;
  readonly onSelect: (item: WorkflowRecommendation) => void;
}) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.workflows.items;
    },
    { returnObjects: true },
  )[item.id];
  return (
    <button
      type="button"
      data-testid={`quest-workflow-${item.id}`}
      onClick={() => {
        onSelect(item);
      }}
      className={cn(
        // The quest connector tile's own treatment, at the same compact radius:
        // one dialog, one card, rather than a second one invented per step.
        surfaceVariants({ radius: "compact", interactive: true }),
        "flex min-w-0 flex-col items-start gap-2 p-3.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
      style={{ height: CARD_H }}
    >
      <WorkflowMarks connectors={item.connectors} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-foreground">
          {copy.title}
        </span>
        <span className="mt-0.5 line-clamp-2 text-xs leading-4 text-muted-foreground">
          {copy.description}
        </span>
      </span>
    </button>
  );
}

/**
 * The workflows the step can start from, inside the dialog that says what the
 * step pays.
 *
 * Pressing one hands its sentence to the composer rather than installing
 * anything: the reader reads it, edits it if they want, and sends it, and the
 * workflow the assistant then writes is their own — which is the version of
 * this step the reward can actually be earned on.
 *
 * The same nine the composer's own shelf offers, so the step introduces the
 * product's recommendations rather than a second list that has to be kept in
 * step with them.
 */
export function QuestWorkflowPicker({
  onSelect,
}: {
  readonly onSelect: (item: WorkflowRecommendation) => void;
}) {
  return (
    /*
     * The window the connector step cuts, at its own measurements: the list
     * bleeds to both card edges and its own `px-6` puts the cards back on the
     * column the title and the buttons use, the top fades only while a row is
     * cut off above, and nothing is drawn at the bottom because the viewport's
     * `pb-2` and the shell's `gap-4` already close the list.
     */
    <div className="-mx-6" data-testid="quest-workflow-picker">
      <ScrollArea.Root
        // `group` so the viewport's fade can read the root's own
        // `data-overflow-y-start`.
        className="group relative"
        data-testid="quest-workflow-list"
      >
        <ScrollArea.Viewport
          data-slot="scroll-area-viewport"
          className={cn(
            "px-6 pb-2 focus:outline-none",
            SCROLL_FADE_Y_START_WHEN_OVERFLOWING,
          )}
          style={{ maxHeight: LIST_MAX_H }}
        >
          <ScrollArea.Content className="grid grid-cols-2 gap-2">
            {WORKFLOW_RECOMMENDATIONS.map((item) => {
              return (
                <WorkflowCard key={item.id} item={item} onSelect={onSelect} />
              );
            })}
          </ScrollArea.Content>
        </ScrollArea.Viewport>
        {/* The track lands on the root's own edge, which is the card's, so the
            dialog's `p-6` is what keeps it off the cards: no offset of its own,
            the same as the connector list's. */}
        <ScrollBar data-testid="quest-workflow-scrollbar" />
      </ScrollArea.Root>
    </div>
  );
}
