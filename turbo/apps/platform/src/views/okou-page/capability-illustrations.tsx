import type { ReactNode } from "react";
import { cn } from "@okouai/ui";

/**
 * The capability cards' art: a cut-paper collage per card, drawn in
 * `views/css/capability-art.css`. Each is a few large shapes in tones of the
 * card's one hue, every one wearing a brush texture, composed around an
 * element that stays whole while the rest runs off the card's edge:
 *
 * - Find people: three figures, the one in front stepped forward.
 * - Research: columns of data under a lens that really enlarges them.
 * - Create: a written page with a picture laid over it.
 * - Workflow: three steps strung on arrows.
 *
 * The drawing is decoration: it is hidden from assistive technology and lets
 * the pointer through to the card's cover.
 */
type CapabilityCard = "people" | "research" | "create" | "workflow";

/** One cut-paper shape: a flat tone with the card's brush laid into it. */
function Shape({
  className,
  children,
}: {
  readonly className: string;
  readonly children?: ReactNode;
}) {
  return (
    <span className={cn("cap-shape", className)}>
      <i />
      {children}
    </span>
  );
}

const FIGURES = [
  "cap-figure-left",
  "cap-figure-right",
  "cap-figure-front",
] as const;

function PeopleCollage() {
  return (
    <span className="cap-collage cap-collage-people">
      {FIGURES.map((figure) => {
        return (
          <span key={figure} className={cn("cap-figure", figure)}>
            <Shape className="cap-body" />
            <Shape className="cap-head" />
          </span>
        );
      })}
    </span>
  );
}

const BARS = [
  "cap-bar-1",
  "cap-bar-2",
  "cap-bar-3",
  "cap-bar-4",
  "cap-bar-5",
  "cap-bar-6",
] as const;

function Bars() {
  return (
    <>
      {BARS.map((bar) => {
        return <Shape key={bar} className={cn("cap-bar", bar)} />;
      })}
    </>
  );
}

/**
 * The lens holds a second copy of the columns, scaled about its own centre,
 * so what it shows is always what lies under it.
 */
function ResearchCollage() {
  return (
    <span className="cap-collage cap-collage-research">
      <Bars />
      <span className="cap-glass">
        <span className="cap-handle" />
        <span className="cap-lens">
          <span className="cap-zoom">
            <Bars />
          </span>
        </span>
        <span className="cap-rim" />
      </span>
    </span>
  );
}

function CreateCollage() {
  return (
    <span className="cap-collage cap-collage-create">
      <span className="cap-stack">
        <Shape className="cap-sheet cap-page" />
        <Shape className="cap-sheet cap-picture">
          <Shape className="cap-sun" />
          <Shape className="cap-peak cap-peak-far" />
          <Shape className="cap-peak cap-peak-near" />
        </Shape>
      </span>
    </span>
  );
}

/** The two links between the steps; each ends in an arrowhead at the step it feeds. */
const FLOW = [
  "M46 96 C48 126 66 118 82 106",
  "M150 136 C172 148 204 132 210 100",
] as const;

function WorkflowCollage() {
  return (
    <span className="cap-collage cap-collage-workflow">
      <svg className="cap-flow" viewBox="0 0 236 184" width="236" height="184">
        <defs>
          <marker
            id="capability-flow-head"
            viewBox="0 0 10 10"
            refX="4"
            refY="5"
            markerWidth="2.5"
            markerHeight="2.5"
            orient="auto"
          >
            <path className="cap-flow-head" d="M1.5 1.2 L9 5 L1.5 8.8 Z" />
          </marker>
        </defs>
        {FLOW.map((d) => {
          return (
            <path
              key={d}
              className="cap-flow-track"
              d={d}
              markerEnd="url(#capability-flow-head)"
            />
          );
        })}
        <path className="cap-flow-run" d={FLOW.join(" ")} pathLength={1} />
      </svg>
      <Shape className="cap-step cap-step-1" />
      <Shape className="cap-step cap-step-3" />
      <Shape className="cap-step cap-step-2" />
    </span>
  );
}

const COLLAGES = {
  people: PeopleCollage,
  research: ResearchCollage,
  create: CreateCollage,
  workflow: WorkflowCollage,
} as const satisfies Record<CapabilityCard, () => ReactNode>;

/**
 * A card's drawing, under its copy, cover and choices. It fills the card, so
 * its glow and its collage are placed against the card's own edges.
 */
export function CapabilityArt({ card }: { readonly card: CapabilityCard }) {
  const Collage = COLLAGES[card];
  return (
    <span aria-hidden className="capability-art" data-card={card}>
      <Collage />
    </span>
  );
}
