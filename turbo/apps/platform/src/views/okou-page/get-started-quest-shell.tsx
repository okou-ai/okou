/**
 * The two-panel shell the Get started quest dialogs share.
 *
 * It lives apart from the intro dialog because the phone connect dialog uses
 * the same shell from the integration pages, and it should not have to bring
 * the connector catalog and workflow picker along with it.
 */
import type { ReactNode } from "react";
import { Coins } from "lucide-react";
import { Badge } from "@okouai/ui";
import { formatLocalizedNumber } from "../../i18n/format.ts";
import { platformStaticAssetUrl } from "../../lib/static-assets.ts";

/**
 * The quest drawings, from the Brand assets library.
 *
 * These replace five figures that were assembled here out of divs -- a replica
 * of Slack's message list, tile pairs joined by dots, a fake report table. That
 * approach put eight off-scale spacings, two off-ladder radii and four type
 * sizes into this file that exist nowhere else in the product, and it produced
 * art that could not be art-directed. The library is drawn by the people who
 * own the brand; the product's job is to frame it.
 *
 * Exported as the artboard group rather than the frame, so each file is
 * transparent and sits on whatever paper the product gives it. Every name
 * carries its own content hash, and `static.okou.io` hard caches for a year,
 * so a re-export lands on a new path instead of serving stale.
 */
const QUEST_ART = Object.freeze({
  slack: "get-started-slack-12b969d9d2a7.png",
  invite: "get-started-invite-09ddee851551.png",
  checkinWeek: "get-started-checkin-week-b218eb5cd860.png",
});

function questArtUrl(name: keyof typeof QUEST_ART): string {
  return platformStaticAssetUrl(`views/okou-page/assets/${QUEST_ART[name]}`);
}

/**
 * The panel a quest drawing is printed on.
 *
 * One fixed-width column, full bleed to the card's own edge, with the drawing
 * centred in it. The paper is the same value in both themes: it is the sheet
 * the drawing is printed on rather than a UI surface, the argument the style
 * guide already makes for illustration stroke weights -- and it is what lets
 * one asset serve Light and Dark instead of needing a second drawing.
 *
 * The drawing is capped in both directions, not just width. Capping width alone
 * let a portrait drawing set the panel's height from its own aspect ratio: the
 * gears landed at 280x317 and took 57% of the dialog while the landscape art
 * took 43%, so the same shell changed shape depending on which file it got.
 * With both capped the column is a constant and the words decide the height.
 */
const FIGURE_W = 248;
const ART_MAX = 188;

export function QuestFigure({ art }: { art: keyof typeof QUEST_ART }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center bg-illustration-canvas p-5"
      style={{ width: FIGURE_W }}
    >
      <img
        src={questArtUrl(art)}
        alt=""
        aria-hidden
        className="block w-full object-contain"
        style={{ maxHeight: ART_MAX }}
      />
    </div>
  );
}

/**
 * The drawing takes a column and the words take the rest.
 *
 * Spanning the header across both panels is what left the earlier version
 * hollow: the picture had nothing beside it at the top and the prose had
 * nothing to sit under, so three lines floated in the middle of the column
 * with unowned white above and below. With the whole text block inside the
 * column, every edge of both panels is doing something.
 *
 * `-m-6` cancels the dialog body's own padding so the drawing reaches its own
 * edge. An inset tile reads as a thumbnail pasted on; a panel reads as part of
 * the card.
 */
export function QuestSplitLayout({
  figure,
  children,
}: {
  readonly figure: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="-m-6 flex items-stretch">
      {figure}
      <div className="flex min-w-0 flex-1 flex-col gap-3 p-6">{children}</div>
    </div>
  );
}

/**
 * What a step pays, on its own row under the title.
 *
 * In a column this narrow a chip sharing the description's line pushes the
 * sentence into an extra wrap. The width has to be the chip's own, because
 * this row lands in two different formatting contexts: the split layout's flex
 * column, and the dialog's `grid gap-4 p-6` for a step that keeps the plain
 * padded body. A grid item is blockified and stretched by the initial
 * `justify-self`, so an alignment utility alone left the chip spanning the
 * whole column.
 */
export function QuestRewardBadge({ amount }: { readonly amount: number }) {
  return (
    <Badge className="w-fit text-xs font-semibold tabular-nums text-brand-text">
      <Coins />+{formatLocalizedNumber(amount)}
    </Badge>
  );
}
