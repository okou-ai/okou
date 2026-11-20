import type { ReactNode } from "react";
import { cn } from "@okouai/ui";

/**
 * The capability cards' art: a cut-paper collage per card. Each is a few
 * large flat shapes in tones of the card's one hue with a brush texture laid
 * into them, composed around an element that stays whole while the rest runs
 * off the card's edge:
 *
 * - Find people: three figures, the one in front stepped forward.
 * - Research: columns of data under a lens that really enlarges them.
 * - Create: a written page with a picture laid over it.
 * - Workflow: three steps strung on arrows.
 *
 * A card's two colours, `paper` and `ink`, are registered per theme in
 * `views/css/index.css`; the art root selects its card's pair into
 * `--capability-paper` and `--capability-ink`, and every tone below is one of
 * those mixed toward the card's ground. The drawing is decoration: it is
 * hidden from assistive technology and lets the pointer through to the card's
 * cover.
 *
 * While its card is active (hovered or holding focus) one thing in a drawing
 * moves: the figure in front steps up, the lens crosses to another column,
 * the page slides out from behind the picture, a signal runs along the
 * arrows. Every motion is behind `motion-safe:`.
 */
type CapabilityCard = "people" | "research" | "create" | "workflow";

/* The tones: two of paper for the sheets, three of ink for brush and line. */
const PAPER =
  "bg-[color-mix(in_oklab,var(--capability-paper)_62.5%,var(--color-muted))]";
const PAPER_DEEP = "bg-(--capability-paper)";
const BRUSH =
  "bg-[color-mix(in_oklab,var(--capability-ink)_57%,var(--color-muted))]";
const BRUSH_DEEP =
  "bg-[color-mix(in_oklab,var(--capability-ink)_80%,var(--color-muted))]";
const INK = "bg-(--capability-ink)";

/** The texture inside a shape drifts a few pixels while the card is active. */
const DRIFT =
  "motion-safe:transition-[translate] motion-safe:duration-1300 motion-safe:ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-safe:capability-active:translate-x-[-5px] motion-safe:capability-active:translate-y-[3px]";

/**
 * One cut-paper shape: a flat tone, and a brush texture laid into it as an
 * alpha mask over a span of the stroke's tone. `brush` carries the mask's
 * image, size and position; a shape without one is plain paper.
 */
function Shape({
  className,
  fill = PAPER,
  stroke = BRUSH,
  brush,
  still = false,
  children,
}: {
  readonly className: string;
  readonly fill?: string;
  readonly stroke?: string;
  readonly brush?: string;
  readonly still?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <span className={cn("absolute block overflow-hidden", fill, className)}>
      {brush !== undefined && (
        <i
          className={cn(
            "absolute -inset-[30%] [mask-repeat:no-repeat]",
            stroke,
            brush,
            !still && DRIFT,
          )}
        />
      )}
      {children}
    </span>
  );
}

/* ───────────────────────────── Find people ───────────────────────────── */

const FIGURE =
  "absolute inset-0 block motion-safe:transition-[translate] motion-safe:duration-900 motion-safe:ease-[cubic-bezier(0.2,0.8,0.2,1)]";
const DASH = "[mask-image:var(--okou-capability-brush-dash)]";

function PeopleCollage() {
  return (
    <span className="absolute right-0 bottom-0 block h-[168px] w-[270px] origin-bottom-right scale-[0.86] @max-[428px]:scale-[0.66]">
      <span
        className={cn(
          FIGURE,
          "motion-safe:capability-active:translate-x-[-4px] motion-safe:capability-active:translate-y-[2px]",
        )}
      >
        <Shape
          className="top-[112px] left-[10px] h-[96px] w-[112px] rounded-t-full"
          brush={cn(DASH, "[mask-size:250px_auto] [mask-position:30%_40%]")}
        />
        <Shape
          className="top-[58px] left-[43px] size-[46px] rounded-full"
          brush={cn(DASH, "[mask-size:150px_auto] [mask-position:70%_30%]")}
        />
      </span>
      <span
        className={cn(
          FIGURE,
          "motion-safe:capability-active:translate-x-[4px] motion-safe:capability-active:translate-y-[2px]",
        )}
      >
        <Shape
          className="top-[106px] left-[170px] h-[96px] w-[112px] rounded-t-full"
          brush={cn(DASH, "[mask-size:250px_auto] [mask-position:80%_60%]")}
        />
        <Shape
          className="top-[52px] left-[203px] size-[46px] rounded-full"
          brush={cn(DASH, "[mask-size:150px_auto] [mask-position:20%_70%]")}
        />
      </span>
      {/* The figure in front is a tone deeper, with a sliver of the ground
          around it, as cut paper overlaps. */}
      <span
        className={cn(
          FIGURE,
          "motion-safe:capability-active:translate-y-[-7px]",
        )}
      >
        <Shape
          className="top-[98px] left-[72px] h-[110px] w-[150px] rounded-t-full [box-shadow:0_-3px_0_0_color-mix(in_oklab,var(--capability-paper)_26%,var(--color-muted)),-3px_0_0_0_color-mix(in_oklab,var(--capability-paper)_26%,var(--color-muted)),3px_0_0_0_color-mix(in_oklab,var(--capability-paper)_26%,var(--color-muted))]"
          fill={PAPER_DEEP}
          stroke={BRUSH_DEEP}
          brush={cn(DASH, "[mask-size:290px_auto] [mask-position:50%_30%]")}
        />
        <Shape
          className="top-[30px] left-[117px] size-[60px] rounded-full [box-shadow:0_0_0_3px_color-mix(in_oklab,var(--capability-paper)_26%,var(--color-muted))]"
          fill={PAPER_DEEP}
          stroke={BRUSH_DEEP}
          brush={cn(DASH, "[mask-size:190px_auto] [mask-position:45%_55%]")}
        />
      </span>
    </span>
  );
}

/* ───────────────────────────── Research ───────────────────────────── */

const DROP =
  "[mask-image:var(--okou-capability-brush-drop)] [mask-size:200px_auto]";
const BARS = [
  {
    box: "top-[124px] left-[34px] h-[60px]",
    brush: "[mask-position:20%_30%]",
  },
  {
    box: "top-[96px] left-[74px] h-[90px]",
    brush: "[mask-position:35%_60%]",
  },
  {
    box: "top-[112px] left-[114px] h-[70px]",
    brush: "[mask-position:50%_20%]",
  },
  {
    box: "top-[68px] left-[154px] h-[120px]",
    brush: "[mask-position:62%_50%]",
  },
  {
    box: "top-[88px] left-[194px] h-[100px]",
    brush: "[mask-position:76%_35%]",
  },
  {
    box: "top-[44px] left-[234px] h-[140px]",
    brush: "[mask-position:90%_60%]",
  },
] as const;

/** The columns; under the lens they are drawn again, deeper. */
function Bars({ magnified = false }: { readonly magnified?: boolean }) {
  return (
    <>
      {BARS.map(({ box, brush }) => {
        return (
          <Shape
            key={box}
            className={cn("w-[28px] rounded-t-[9px]", box)}
            fill={magnified ? BRUSH : PAPER}
            stroke={magnified ? INK : BRUSH}
            brush={cn(DROP, brush)}
          />
        );
      })}
    </>
  );
}

/**
 * The lens holds a second copy of the columns, scaled 1.7 times about the
 * lens's own centre, so what it shows is always what lies under it. The lens
 * and that copy read one registered offset, `--okou-capability-lens-x`/`-y`,
 * which glides to another column while the card is active.
 */
function ResearchCollage() {
  return (
    <span className="absolute right-0 bottom-0 block h-[168px] w-[256px] origin-bottom-right scale-[0.9] motion-safe:transition-[--okou-capability-lens-x,--okou-capability-lens-y] motion-safe:duration-1100 motion-safe:ease-[cubic-bezier(0.45,0,0.2,1)] motion-safe:capability-active:[--okou-capability-lens-x:-80px] motion-safe:capability-active:[--okou-capability-lens-y:24px] @max-[428px]:scale-[0.66]">
      <Bars />
      <span className="absolute inset-0 block [translate:var(--okou-capability-lens-x)_var(--okou-capability-lens-y)]">
        <span className="absolute top-[93px] left-[131px] block h-[42px] w-[10px] origin-top rotate-45 rounded-[5px] bg-(--capability-ink)" />
        <span className="absolute top-[20px] left-[124px] block size-[88px] overflow-hidden rounded-full bg-[color-mix(in_oklab,var(--capability-paper)_36%,var(--color-muted))]">
          <span className="absolute top-0 left-0 block h-[168px] w-[256px] origin-top-left [transform:translate(calc(44px_-_1.7_*_(168px_+_var(--okou-capability-lens-x))),calc(44px_-_1.7_*_(64px_+_var(--okou-capability-lens-y))))_scale(1.7)]">
            <Bars magnified />
          </span>
        </span>
        <span className="absolute top-[20px] left-[124px] block size-[88px] rounded-full [box-shadow:inset_0_0_0_5px_var(--capability-ink)]" />
      </span>
    </span>
  );
}

/* ────────────────────────────── Create ────────────────────────────── */

const LOOP = "[mask-image:var(--okou-capability-brush-loop)]";
const SHEET =
  "h-[96px] w-[128px] rounded-[12px] [box-shadow:0_0_0_3px_color-mix(in_oklab,var(--capability-paper)_21%,var(--color-muted))]";
const PEAK = "[clip-path:polygon(50%_0,100%_100%,0_100%)]";

/**
 * Two sheets of one size, parallel. Behind, a written page: its brush is the
 * dash turned on its side, whose rows read as lines of writing. In front, a
 * picture: a sun and two peaks, each wearing the loop. Nothing is nested and
 * nothing tilts against anything else, and only the page moves. Where the
 * copy runs the card's full width, the collage moves to the bottom corner and
 * rises from the edge, tops showing, as the top cards' do.
 */
function CreateCollage() {
  return (
    <span className="absolute top-0 right-0 block h-[184px] w-[250px] origin-top-right translate-y-[2px] scale-[0.88] @max-[428px]:scale-[0.66] @max-[398px]:top-auto @max-[398px]:bottom-[-34px] @max-[398px]:origin-bottom-right @max-[398px]:translate-y-0 @max-[398px]:scale-[0.62]">
      <span className="absolute inset-0 block origin-[72%_46%] -rotate-6">
        <Shape
          className={cn(
            SHEET,
            "top-[10px] left-[62px] motion-safe:transition-[translate] motion-safe:duration-700 motion-safe:ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-safe:capability-active:translate-x-[-8px] motion-safe:capability-active:translate-y-[-7px]",
          )}
          brush="rotate-90 [mask-image:var(--okou-capability-brush-dash)] [mask-size:230px_auto] [mask-position:30%_22%]"
          still
        />
        <Shape
          className={cn(SHEET, "top-[38px] left-[98px]")}
          fill={PAPER_DEEP}
        >
          <Shape
            className="top-[12px] left-[94px] size-[22px] rounded-full"
            fill={BRUSH_DEEP}
            stroke={INK}
            brush={cn(LOOP, "[mask-size:80px_auto] [mask-position:50%_50%]")}
            still
          />
          <Shape
            className={cn(PEAK, "top-[30px] left-[20px] h-[66px] w-[88px]")}
            fill={BRUSH}
            stroke={INK}
            brush={cn(LOOP, "[mask-size:160px_auto] [mask-position:45%_55%]")}
            still
          />
          <Shape
            className={cn(PEAK, "top-[60px] left-[-8px] h-[36px] w-[60px]")}
            fill={BRUSH_DEEP}
            stroke={INK}
            brush={cn(LOOP, "[mask-size:160px_auto] [mask-position:70%_30%]")}
            still
          />
        </Shape>
      </span>
    </span>
  );
}

/* ───────────────────────────── Workflow ───────────────────────────── */

const STRIPE = "[mask-image:var(--okou-capability-brush-stripe)]";
const STEP =
  "[box-shadow:0_0_0_3px_color-mix(in_oklab,var(--capability-paper)_26%,var(--color-muted))]";

/** The two links between the steps; each ends in an arrowhead at the step it feeds. */
const FLOW = [
  "M46 96 C48 126 66 118 82 106",
  "M150 136 C172 148 204 132 210 100",
] as const;

/**
 * Circle, square, circle on two arrows, the last step leaving by the card's
 * edge. While the card is active a pale signal runs along both arrows.
 */
function WorkflowCollage() {
  return (
    <span className="absolute top-0 right-0 block h-[184px] w-[236px] origin-top-right translate-y-[4px] scale-[0.83] @max-[348px]:scale-[0.64]">
      <svg
        className="absolute inset-0 overflow-visible"
        viewBox="0 0 236 184"
        width="236"
        height="184"
      >
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
            <path
              className="fill-(--capability-ink) stroke-(--capability-ink) stroke-[1.4] [stroke-linejoin:round]"
              d="M1.5 1.2 L9 5 L1.5 8.8 Z"
            />
          </marker>
        </defs>
        {FLOW.map((d) => {
          return (
            <path
              key={d}
              className="fill-none stroke-(--capability-ink) stroke-[6] [stroke-linecap:round]"
              d={d}
              markerEnd="url(#capability-flow-head)"
            />
          );
        })}
        <path
          className="fill-none stroke-(--capability-paper) stroke-[6] opacity-0 [stroke-dasharray:0.16_1] [stroke-dashoffset:0.16] [stroke-linecap:round] motion-safe:capability-active:animate-capability-flow-run"
          d={FLOW.join(" ")}
          pathLength={1}
        />
      </svg>
      <Shape
        className={cn(STEP, "top-[24px] left-[10px] size-[68px] rounded-full")}
        brush={cn(STRIPE, "[mask-size:150px_auto] [mask-position:30%_40%]")}
      />
      <Shape
        className={cn(STEP, "top-[18px] left-[180px] size-[68px] rounded-full")}
        brush={cn(STRIPE, "[mask-size:150px_auto] [mask-position:75%_60%]")}
      />
      <Shape
        className={cn(
          STEP,
          "top-[59px] left-[91px] size-[74px] rotate-[7deg] rounded-[16px]",
        )}
        fill={PAPER_DEEP}
        stroke={BRUSH_DEEP}
        brush={cn(STRIPE, "[mask-size:170px_auto] [mask-position:55%_50%]")}
      />
    </span>
  );
}

/* ───────────────────────────── the art ───────────────────────────── */

/**
 * Each card's pair of colours, and its one patch of colour: a glow behind the
 * drawing that is gone before the copy.
 */
const ART = {
  people: {
    Collage: PeopleCollage,
    ground:
      "[--capability-paper:var(--okou-capability-people-paper)] [--capability-ink:var(--okou-capability-people-ink)] bg-[radial-gradient(62%_120%_at_78%_86%,color-mix(in_oklab,var(--capability-paper)_48%,var(--color-muted)),transparent_72%)]",
  },
  research: {
    Collage: ResearchCollage,
    ground:
      "[--capability-paper:var(--okou-capability-research-paper)] [--capability-ink:var(--okou-capability-research-ink)] bg-[radial-gradient(62%_120%_at_80%_70%,color-mix(in_oklab,var(--capability-paper)_48%,var(--color-muted)),transparent_72%)]",
  },
  create: {
    Collage: CreateCollage,
    ground:
      "[--capability-paper:var(--okou-capability-create-paper)] [--capability-ink:var(--okou-capability-create-ink)] bg-[radial-gradient(56%_120%_at_82%_44%,color-mix(in_oklab,var(--capability-paper)_38%,var(--color-muted)),transparent_72%)]",
  },
  workflow: {
    Collage: WorkflowCollage,
    ground:
      "[--capability-paper:var(--okou-capability-workflow-paper)] [--capability-ink:var(--okou-capability-workflow-ink)] bg-[radial-gradient(58%_120%_at_80%_40%,color-mix(in_oklab,var(--capability-paper)_48%,var(--color-muted)),transparent_72%)]",
  },
} as const satisfies Record<
  CapabilityCard,
  { readonly Collage: () => ReactNode; readonly ground: string }
>;

/**
 * A card's drawing, under its copy, cover and choices. It fills the card and
 * is the container its collage sizes against, so a narrow card gets a
 * smaller collage that never meets the copy.
 */
export function CapabilityArt({ card }: { readonly card: CapabilityCard }) {
  const { Collage, ground } = ART[card];
  return (
    <span
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 @container", ground)}
    >
      <Collage />
    </span>
  );
}
