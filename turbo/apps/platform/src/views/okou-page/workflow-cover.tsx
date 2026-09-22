import type { ReactNode } from "react";
import { useLastResolved } from "ccstate-react";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { cn } from "@okouai/ui/lib/utils";
import { connectorCatalogStatus$ } from "../../signals/external/connectors.ts";
import type {
  WorkflowCoverKind,
  WorkflowCoverTone,
  WorkflowRecommendation,
} from "../../signals/okou-page/composer-workflow-recommendations.ts";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";

/**
 * The shelf cover of a recommended workflow: the connector marks it reads and
 * writes, drawn the way the onboarding diagram draws them, over a very faint
 * sketch of the result. Nothing in the cover is text; the caption under it
 * carries the title.
 *
 * The ground is the tile's own token mixed into `card` at 12%, the same
 * `color-mix` shape the hover tokens use, so it lands at a whisper of the hue
 * in Light and tints the dark card just as gently. Spelled per tone so
 * Tailwind's scanner sees every class.
 */
const COVER_GROUND = {
  "artifact-presentation":
    "bg-[color-mix(in_oklab,var(--color-artifact-presentation)_12%,var(--color-card))]",
  "chart-green":
    "bg-[color-mix(in_oklab,var(--color-chart-green)_12%,var(--color-card))]",
  "chart-orange":
    "bg-[color-mix(in_oklab,var(--color-chart-orange)_12%,var(--color-card))]",
  "chart-blue-300":
    "bg-[color-mix(in_oklab,var(--color-chart-blue-300)_12%,var(--color-card))]",
  "artifact-image":
    "bg-[color-mix(in_oklab,var(--color-artifact-image)_12%,var(--color-card))]",
  "chart-gold":
    "bg-[color-mix(in_oklab,var(--color-chart-gold)_12%,var(--color-card))]",
  "usage-kind-image":
    "bg-[color-mix(in_oklab,var(--color-usage-kind-image)_12%,var(--color-card))]",
  "usage-kind-connector":
    "bg-[color-mix(in_oklab,var(--color-usage-kind-connector)_12%,var(--color-card))]",
  "artifact-video":
    "bg-[color-mix(in_oklab,var(--color-artifact-video)_12%,var(--color-card))]",
} as const satisfies Record<WorkflowCoverTone, string>;

/* The onboarding diagram's tile: the illustration stroke, the card fill and
   border, and the artwork's own lift. */
const COVER_TILE =
  "border-(length:--border-width-illustration) border-solid border-border bg-card shadow-[0_12px_30px_-18px_rgba(0,0,0,0.5)]";
/* The waypoint dot and the line between two marks, from the same diagram. The
   ring is the literal white because it is artwork that stays white in Dark. */
const COVER_DOT =
  "box-border size-[7px] shrink-0 rounded-full border-(length:--border-width-illustration-marker) border-solid border-[#ffffff] bg-[#29292e]";
const COVER_LINK = "block h-[2px] w-4 shrink-0 rounded-full bg-[#ed7a44]";
/* Two marks sit on a diagonal; the onboarding stack's triangle is for three. */
const STACK_POSITIONS = ["top-0 left-0", "bottom-0 right-0"] as const;

/* A row of the result sketch: foreground at 6%, a heading row a step darker. */
const SKETCH_ROW = "block h-1 rounded-full bg-foreground/[0.06]";
const SKETCH_HEADING = "block h-[5px] rounded-full bg-foreground/[0.08]";
const SKETCH_MARK = "block shrink-0 bg-foreground/[0.07]";

function SketchRow({
  width,
  heading = false,
}: {
  readonly width: string;
  readonly heading?: boolean;
}) {
  return (
    <span className={heading ? SKETCH_HEADING : SKETCH_ROW} style={{ width }} />
  );
}

function SketchList({
  widths,
  markClassName,
}: {
  readonly widths: readonly string[];
  readonly markClassName: string;
}) {
  return (
    <span className="flex flex-col gap-[7px]">
      {widths.map((width) => {
        return (
          <span key={width} className="flex items-center gap-1.5">
            <span className={cn(SKETCH_MARK, "size-1.5", markClassName)} />
            <SketchRow width={width} />
          </span>
        );
      })}
    </span>
  );
}

/* What the workflow leaves behind, as the shape of that thing and nothing
   more: a page, a contact card, a list, a checklist, a table, a chart. */
const TABLE_ROWS = [
  { key: "head", heading: true },
  { key: "first", heading: false },
  { key: "second", heading: false },
] as const;
const CHART_BARS = [14, 24, 18, 32, 26, 38] as const;

const SKETCHES = {
  doc: () => {
    return (
      <span className="flex flex-col gap-1.5">
        <SketchRow width="62%" heading />
        <SketchRow width="88%" />
        <SketchRow width="74%" />
        <SketchRow width="52%" />
      </span>
    );
  },
  card: () => {
    return (
      <>
        <span className="flex items-center gap-2">
          <span className={cn(SKETCH_MARK, "size-4 rounded-full")} />
          <span className="flex flex-1 flex-col gap-1.5">
            <SketchRow width="70%" heading />
            <SketchRow width="52%" />
          </span>
        </span>
        <span className="mt-2 flex flex-col gap-1.5">
          <SketchRow width="90%" />
          <SketchRow width="64%" />
        </span>
      </>
    );
  },
  list: () => {
    return (
      <SketchList widths={["70%", "84%", "58%"]} markClassName="rounded-full" />
    );
  },
  check: () => {
    return (
      <SketchList
        widths={["66%", "80%", "54%"]}
        markClassName="rounded-[2px]"
      />
    );
  },
  table: () => {
    return (
      <span className="flex flex-col gap-[7px]">
        {TABLE_ROWS.map(({ key, heading }) => {
          return (
            <span key={key} className="flex gap-2">
              <SketchRow width="46%" heading={heading} />
              <SketchRow width="22%" heading={heading} />
              <SketchRow width="18%" heading={heading} />
            </span>
          );
        })}
      </span>
    );
  },
  chart: () => {
    return (
      <span className="flex h-[38px] items-end gap-1.5">
        {CHART_BARS.map((height) => {
          return (
            <span
              key={height}
              className={cn(SKETCH_MARK, "w-[9px] rounded-[2px]")}
              style={{ height }}
            />
          );
        })}
      </span>
    );
  },
} as const satisfies Record<WorkflowCoverKind, () => ReactNode>;

function WorkflowSketch({ kind }: { readonly kind: WorkflowCoverKind }) {
  const Sketch = SKETCHES[kind];
  return <Sketch />;
}

function CoverMark({
  slug,
  size,
}: {
  readonly slug: ConnectorSlug;
  readonly size: number;
}) {
  const connectors = useLastResolved(connectorCatalogStatus$)?.connectors;
  const icon = connectors?.find((candidate) => {
    return candidate.slug === slug;
  })?.icon;
  return <ConnectorIcon icon={icon} size={size} />;
}

/* One end of the flow: a single mark, or the marks a workflow reads stacked
   two-up. `size` is the tile; the mark inside is 58% of it. */
function CoverNode({
  slugs,
  size,
}: {
  readonly slugs: readonly ConnectorSlug[];
  readonly size: number;
}) {
  const stack = Math.round(size * 0.75);
  const item = Math.round(size * 0.5);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[11px]",
        COVER_TILE,
      )}
      style={{ width: size, height: size }}
    >
      {slugs.length > 1 ? (
        <span
          className="relative block"
          style={{ width: stack, height: stack }}
        >
          {slugs.slice(0, STACK_POSITIONS.length).map((slug, index) => {
            return (
              <span
                key={slug}
                className={cn(
                  "absolute inline-flex items-center justify-center rounded-md",
                  COVER_TILE,
                  STACK_POSITIONS[index],
                )}
                style={{ width: item, height: item }}
              >
                <CoverMark slug={slug} size={item - 6} />
              </span>
            );
          })}
        </span>
      ) : (
        <CoverMark slug={slugs[0]!} size={Math.round(size * 0.58)} />
      )}
    </span>
  );
}

/**
 * The marks sit lower-left like an app badge, over the sketch that bleeds off
 * the tile's bottom-right; a single mark is 40px, the two ends of a flow 34px.
 * Every measure is a share of the tile so the cover keeps its composition at
 * whatever width a shelf gives it.
 */
export function WorkflowCover({
  item,
}: {
  readonly item: WorkflowRecommendation;
}) {
  const { cover } = item;
  const flow = cover.destination !== null;
  const size = flow ? 34 : 40;
  return (
    <span
      data-slot="workflow-cover"
      aria-hidden
      className={cn(
        "relative block h-full w-full overflow-hidden",
        COVER_GROUND[cover.tone],
      )}
    >
      <span className="absolute top-[16%] left-[29%] h-[88%] w-[67%] rounded-[10px] border border-border/50 bg-card/55 p-[7.5%]">
        <WorkflowSketch kind={cover.kind} />
      </span>
      <span className="absolute top-[48%] left-[11%] z-[5] flex items-center">
        <CoverNode slugs={cover.sources} size={size} />
        {cover.destination !== null && (
          <>
            <span className={COVER_DOT} />
            <span className={COVER_LINK} />
            <span className={COVER_DOT} />
            <CoverNode slugs={[cover.destination]} size={size} />
          </>
        )}
      </span>
    </span>
  );
}
