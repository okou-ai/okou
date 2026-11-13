import type { ReactNode } from "react";
import { cn } from "@okouai/ui";
import { platformStaticAssetUrl } from "../../lib/static-assets.ts";

/**
 * The capability cards' art: a few photographed objects, shot flat from
 * above, standing on a faint ground of the card's own hue with the brand's
 * Spiral texture pooled behind them. The ground is strongest behind the
 * objects and gone before the copy and the buttons, so nothing sits under a
 * label.
 *
 * Each object is its own layer, so it can move on its own: a layer is an
 * anchor at the object's centre carrying its resting pose, and the card's
 * `capability-active` state (hovered or holding focus) moves it into a
 * lifted pose -- the cards fan out, the magnifier slides onto the page, the
 * papers spread. Swapping a Create or Workflow choice plays the new
 * objects' entrance from a pose of their own; Explore replays the top cards'
 * objects without fading them. Positions are in card pixels, placed by where
 * the objects visibly sit, so every composition has the same room above and
 * below it at rest and lifted.
 */
type CapabilityCard = "people" | "research" | "create" | "workflow";

type CapabilityArt =
  | "people"
  | "research"
  | "presentation"
  | "image"
  | "document"
  | "website"
  | "chart"
  | "scheduled"
  | "triggers"
  | "advanced";

function capabilityAsset(file: string): string {
  return platformStaticAssetUrl(
    `views/zero-page/assets/capability-home/${file}`,
  );
}

const ASSETS = {
  card: capabilityAsset("card-c7bc481949c3.webp"),
  page: capabilityAsset("page-16c6e1eaaecc.webp"),
  magnifier: capabilityAsset("magnifier-0159010e3fad.webp"),
  paper: capabilityAsset("paper-bad924907e08.webp"),
  photo: capabilityAsset("photo-eacc4606de7c.webp"),
  photoSmall: capabilityAsset("photo-small-8ff6d8f696e9.webp"),
  slide: capabilityAsset("slide-f4f5ddac488b.webp"),
  tablet: capabilityAsset("tablet-7bd95f26765a.webp"),
  gearWhite: capabilityAsset("gear-white-df2deef73b56.webp"),
  gearOrange: capabilityAsset("gear-orange-cda701eeb994.webp"),
  clock: capabilityAsset("clock-129897bb96d7.webp"),
  button: capabilityAsset("button-7b2ab1bcc694.webp"),
  spiralWhite: capabilityAsset("spiral-white-470c2e64094e.svg"),
  spiralBlack: capabilityAsset("spiral-black-38d06102f11e.svg"),
  faceBlue: capabilityAsset("face-blue-17a2f83734d0.svg"),
  faceYellow: capabilityAsset("face-yellow-0d44a0c32917.svg"),
  facePink: capabilityAsset("face-pink-971f29c61abf.svg"),
} as const;

/**
 * Where each card's ground pools: its hue, the centre and radii of the pool
 * behind its objects, and the Spiral, 1.5 times the card's height, bleeding
 * past its top and right edges.
 */
const TOP_POOL =
  "[--capability-pool-x:71%] [--capability-pool-y:52%] [--capability-pool-rx:190px] [--capability-pool-ry:150px]";
const TOP_SPIRAL = "-top-[74px] -right-[32px] size-[252px]";
const BOTTOM_SPIRAL = "-top-[82px] -right-[34px] size-[276px]";

const GROUNDS = {
  people: {
    pool: cn("[--capability-hue:var(--color-capability-people)]", TOP_POOL),
    spiral: TOP_SPIRAL,
  },
  research: {
    pool: cn("[--capability-hue:var(--color-capability-research)]", TOP_POOL),
    spiral: TOP_SPIRAL,
  },
  create: {
    pool: "[--capability-hue:var(--color-capability-create)] [--capability-pool-x:74%] [--capability-pool-y:34%] [--capability-pool-rx:180px] [--capability-pool-ry:118px]",
    spiral: BOTTOM_SPIRAL,
  },
  workflow: {
    pool: "[--capability-hue:var(--color-capability-workflow)] [--capability-pool-x:72%] [--capability-pool-y:34%] [--capability-pool-rx:170px] [--capability-pool-ry:118px]",
    spiral: BOTTOM_SPIRAL,
  },
} as const satisfies Record<
  CapabilityCard,
  { readonly pool: string; readonly spiral: string }
>;

const SPIRAL =
  "absolute max-w-none transition-transform duration-1200 ease-[cubic-bezier(0.2,0.8,0.2,1)] capability-active:translate-x-[-7px] capability-active:translate-y-[5px] capability-active:-rotate-2 motion-reduce:transition-none";

/**
 * A card's ground, under everything else in it. The hue wash paints over the
 * texture pool, so the white Spiral takes the card's tint instead of cutting
 * through it. The pool reaches a little further while the card is active, and
 * the Spiral drifts a few pixels the other way from the objects.
 */
export function CapabilityGround({ card }: { readonly card: CapabilityCard }) {
  const { pool, spiral } = GROUNDS[card];
  return (
    <span
      aria-hidden
      className={cn("pointer-events-none absolute inset-0", pool)}
    >
      <span className="absolute inset-0 [mask-image:radial-gradient(var(--capability-pool-rx)_var(--capability-pool-ry)_at_var(--capability-pool-x)_var(--capability-pool-y),black_calc(var(--capability-pool)_-_50%),transparent_var(--capability-pool))] transition-[--capability-pool] duration-900 ease-[cubic-bezier(0.2,0.8,0.2,1)] capability-active:[--capability-pool:100%] motion-reduce:transition-none">
        <span className="absolute inset-0 bg-capability-pool opacity-35" />
        <img
          src={ASSETS.spiralWhite}
          alt=""
          className={cn(SPIRAL, spiral, "dark:hidden")}
        />
        <img
          src={ASSETS.spiralBlack}
          alt=""
          className={cn(SPIRAL, spiral, "hidden opacity-55 dark:block")}
        />
      </span>
      <span className="absolute inset-0 bg-capability-wash opacity-(--okou-capability-wash) transition-opacity duration-400 capability-active:opacity-(--okou-capability-wash-active) motion-reduce:transition-none" />
      <span className="absolute inset-0 bg-capability-grain opacity-6 mix-blend-multiply [mask-image:radial-gradient(calc(var(--capability-pool-rx)*1.35)_calc(var(--capability-pool-ry)*1.5)_at_var(--capability-pool-x)_var(--capability-pool-y),black,transparent)] dark:mix-blend-screen dark:invert" />
    </span>
  );
}

/**
 * The box a card's objects are placed in, anchored to the card's right edge.
 * Find people and Research keep their single action in the left column, so
 * their objects take the right column's full height; Create and Workflow run
 * their choices across the card, so their objects stand above that row.
 */
const STAGES = {
  people: "right-3 h-[168px] w-[236px]",
  research: "right-3 h-[168px] w-[236px]",
  create: "right-[14px] h-[134px] w-[226px]",
  workflow: "right-[10px] h-[134px] w-[206px]",
} as const satisfies Record<CapabilityCard, string>;

export function CapabilityStage({
  card,
  className,
  children,
}: {
  readonly card: CapabilityCard;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute top-0 z-[1]",
        STAGES[card],
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * One object. `pose` places the anchor at the object's centre in its resting
 * and lifted poses, sets its stacking depth, and names the pose it enters
 * from; `width` sizes the photograph, which is centred on the anchor.
 */
interface CapabilityLayer {
  readonly src: string;
  readonly pose: string;
  readonly width: string;
  readonly turn?: string;
  readonly detail?: ReactNode;
}

const LAYER =
  "absolute size-0 transition-[translate,rotate,scale] duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none";
const BODY =
  "absolute block -translate-1/2 [filter:var(--okou-capability-object-shadow)] transition-[filter] duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)] capability-active:[filter:var(--okou-capability-object-shadow-lifted)] motion-reduce:transition-none";
const FACE =
  "absolute top-[24.4%] left-[49.6%] aspect-square w-[39%] -translate-1/2 rounded-full";

/** The trigger's ring: dark at rest, lit while its card is active. */
const TRIGGER_RING = (
  <span className="absolute top-1/2 left-1/2 aspect-square w-[72%] -translate-1/2 rounded-full transition-shadow duration-500 capability-active:shadow-capability-ring motion-safe:animate-capability-ring-flash motion-reduce:transition-none" />
);

/**
 * The clock's hands, drawn over the photographed face so they can move: they
 * sweep round to the time as the clock enters, then the second and minute
 * hands tick while the card is active. Each hand rests on its outer `rotate`
 * and ticks on its inner `transform`, so a tick composes with the rest.
 */
const CLOCK_HANDS = (
  <span className="absolute inset-0">
    <span className="absolute bottom-1/2 left-1/2 -ml-[2%] h-[22%] w-[4%] origin-bottom -rotate-60 motion-safe:animate-capability-hour-sweep">
      <span className="block size-full rounded-full bg-capability-clock-hand" />
    </span>
    <span className="absolute bottom-1/2 left-1/2 -ml-[1.5%] h-[32%] w-[3%] origin-bottom rotate-54 motion-safe:animate-capability-minute-sweep">
      <span className="block size-full origin-bottom rounded-full bg-capability-clock-hand/80 motion-safe:capability-active:animate-capability-minute-tick" />
    </span>
    <span className="absolute bottom-1/2 left-1/2 -ml-[0.7%] h-[36%] w-[1.4%] origin-bottom rotate-150">
      <span className="block size-full origin-bottom rounded-full bg-primary motion-safe:capability-active:animate-capability-second-tick" />
    </span>
  </span>
);

/**
 * A group with several objects gathers them into a small stack at its centre
 * and fans them out; a single object rises into place; the gears roll in; the
 * trigger is pressed. The magnifier enters from its resting spot, so Explore
 * glides it onto the page instead of dropping it in.
 */
const ARTS = {
  people: [
    {
      src: ASSETS.card,
      width: "w-[66px]",
      pose: "top-[86px] left-[78px] z-5 -rotate-11 [--capability-from-scale:0.86] [--capability-from-x:40px] [--capability-from-y:6px] capability-active:translate-x-[-20px] capability-active:translate-y-[2px] capability-active:-rotate-17",
      detail: <img src={ASSETS.faceBlue} alt="" className={FACE} />,
    },
    {
      src: ASSETS.card,
      width: "w-[66px]",
      pose: "top-[86px] left-[158px] z-5 rotate-11 [--capability-delay:70ms] [--capability-from-scale:0.86] [--capability-from-x:-40px] [--capability-from-y:6px] capability-active:translate-x-[20px] capability-active:translate-y-[2px] capability-active:rotate-17",
      detail: <img src={ASSETS.facePink} alt="" className={FACE} />,
    },
    {
      src: ASSETS.card,
      width: "w-[68px]",
      pose: "top-[80px] left-[118px] z-10 [--capability-delay:140ms] [--capability-from-scale:0.86] [--capability-from-y:12px] capability-active:translate-y-[-4px] capability-active:-rotate-2 capability-active:scale-105",
      detail: <img src={ASSETS.faceYellow} alt="" className={FACE} />,
    },
  ],
  research: [
    {
      src: ASSETS.page,
      width: "w-[84px]",
      pose: "top-[84px] left-[102px] z-4 -rotate-6 [--capability-from-rotate:-14deg] [--capability-from-scale:0.88] [--capability-from-y:14px] capability-active:translate-x-[-2px] capability-active:-rotate-4",
    },
    {
      src: ASSETS.magnifier,
      width: "w-[88px]",
      pose: "top-[80px] left-[180px] z-12 rotate-6 [--capability-duration:900ms] [--capability-from-rotate:6deg] capability-active:translate-x-[-58px] capability-active:translate-y-[2px] capability-active:-rotate-4",
    },
  ],
  presentation: [
    {
      src: ASSETS.paper,
      width: "w-[62px]",
      pose: "top-[70px] left-[62px] z-4 -rotate-12 [--capability-from-scale:0.86] [--capability-from-x:46px] [--capability-from-y:8px] capability-active:translate-x-[-18px] capability-active:translate-y-[2px] capability-active:-rotate-18",
    },
    {
      src: ASSETS.photo,
      width: "w-[92px]",
      pose: "top-[60px] left-[112px] z-7 rotate-6 [--capability-delay:70ms] [--capability-from-scale:0.86] [--capability-from-x:-4px] [--capability-from-y:18px] capability-active:translate-x-[4px] capability-active:translate-y-[-6px] capability-active:rotate-9",
    },
    {
      src: ASSETS.slide,
      width: "w-[100px]",
      pose: "top-[80px] left-[150px] z-11 -rotate-3 [--capability-delay:140ms] [--capability-from-scale:0.86] [--capability-from-x:-42px] [--capability-from-y:-2px] capability-active:translate-x-[18px] capability-active:translate-y-[2px] capability-active:rotate-3",
    },
  ],
  image: [
    {
      src: ASSETS.photoSmall,
      width: "w-[70px]",
      pose: "top-[66px] left-[84px] z-5 -rotate-9 [--capability-from-scale:0.86] [--capability-from-x:32px] [--capability-from-y:11px] capability-active:translate-x-[-18px] capability-active:translate-y-[4px] capability-active:-rotate-15",
    },
    {
      src: ASSETS.photo,
      width: "w-[110px]",
      pose: "top-[72px] left-[148px] z-10 rotate-5 [--capability-delay:70ms] [--capability-from-scale:0.86] [--capability-from-x:-32px] [--capability-from-y:5px] capability-active:translate-x-[12px] capability-active:translate-y-[-6px] capability-active:rotate-9",
    },
  ],
  document: [
    {
      src: ASSETS.paper,
      width: "w-[70px]",
      pose: "top-[68px] left-[104px] z-3 -rotate-8 [--capability-from-scale:0.86] [--capability-from-x:8px] [--capability-from-y:6px] capability-active:translate-x-[-26px] capability-active:translate-y-[4px] capability-active:-rotate-15",
    },
    {
      src: ASSETS.paper,
      width: "w-[70px]",
      pose: "top-[66px] left-[112px] z-6 -rotate-2 [--capability-delay:70ms] [--capability-from-scale:0.86] [--capability-from-y:8px] capability-active:translate-x-[2px] capability-active:translate-y-[-4px] capability-active:-rotate-1",
    },
    {
      src: ASSETS.paper,
      width: "w-[70px]",
      pose: "top-[64px] left-[120px] z-9 rotate-5 [--capability-delay:140ms] [--capability-from-scale:0.86] [--capability-from-x:-8px] [--capability-from-y:10px] capability-active:translate-x-[30px] capability-active:translate-y-[6px] capability-active:rotate-12",
    },
  ],
  website: [
    {
      src: ASSETS.tablet,
      width: "w-[124px]",
      pose: "top-[66px] left-[124px] z-8 -rotate-5 [--capability-from-rotate:-13deg] [--capability-from-scale:0.88] [--capability-from-y:14px] capability-active:translate-y-[-2px] capability-active:-rotate-1 capability-active:scale-103",
    },
  ],
  chart: [
    {
      src: ASSETS.slide,
      width: "w-[128px]",
      pose: "top-[66px] left-[126px] z-8 -rotate-4 [--capability-from-rotate:-12deg] [--capability-from-scale:0.88] [--capability-from-y:14px] capability-active:translate-y-[-4px] capability-active:-rotate-1 capability-active:scale-104",
    },
  ],
  scheduled: [
    {
      src: ASSETS.clock,
      width: "w-[98px]",
      pose: "top-[66px] left-[104px] z-8 [--capability-from-rotate:-8deg] [--capability-from-scale:0.88] [--capability-from-y:14px] capability-active:translate-y-[-2px] capability-active:scale-103",
      detail: CLOCK_HANDS,
    },
  ],
  triggers: [
    {
      src: ASSETS.button,
      width: "w-[96px]",
      pose: "top-[66px] left-[104px] z-8 [--capability-from-scale:0.9] capability-active:translate-y-[-3px] capability-active:scale-102",
      detail: TRIGGER_RING,
    },
  ],
  advanced: [
    {
      src: ASSETS.gearWhite,
      width: "w-[86px]",
      pose: "top-[62px] left-[62px] z-5 [--capability-from-rotate:-120deg] [--capability-from-scale:0.6] capability-active:translate-y-[-2px]",
      turn: "motion-safe:animate-capability-gear",
    },
    {
      src: ASSETS.gearWhite,
      width: "w-[66px]",
      pose: "top-[95px] left-[122px] z-8 rotate-14 [--capability-delay:70ms] [--capability-from-rotate:-106deg] [--capability-from-scale:0.6] capability-active:translate-y-[-2px]",
      turn: "motion-safe:animate-capability-gear-reverse",
    },
    {
      src: ASSETS.gearOrange,
      width: "w-[52px]",
      pose: "top-[74px] left-[158px] z-11 rotate-9 [--capability-delay:140ms] [--capability-from-rotate:-111deg] [--capability-from-scale:0.6] capability-active:translate-y-[-2px]",
      turn: "motion-safe:animate-capability-gear-fast",
    },
  ],
} as const satisfies Record<CapabilityArt, readonly CapabilityLayer[]>;

/**
 * Find people and Research show one composition and replay it from Explore;
 * every other drawing is one of a card's choices and enters as it is swapped
 * in.
 */
function entrance(art: CapabilityArt): string {
  return art === "people" || art === "research"
    ? "motion-safe:group-has-[[data-art=explore]:is(:hover,:focus-visible)]/card:animate-capability-layer-replay"
    : "motion-safe:animate-capability-layer-in";
}

export function CapabilityObjects({
  art,
  className,
}: {
  readonly art: CapabilityArt;
  readonly className?: string;
}) {
  const layers: readonly CapabilityLayer[] = ARTS[art];
  return (
    <span className={cn("absolute inset-0", className)}>
      {layers.map(({ src, pose, width, turn, detail }) => {
        const photo = (
          <img src={src} alt="" className="block w-full dark:brightness-93" />
        );
        return (
          // No two objects in a drawing share a place, so the pose is unique.
          <span key={pose} className={cn(LAYER, entrance(art), pose)}>
            <span className={cn(BODY, width)}>
              {turn ? (
                // The gears turn only while the card is active and keep the
                // angle they reached when it lets go.
                <span
                  className={cn(
                    "block capability-active:[animation-play-state:running]",
                    turn,
                  )}
                >
                  {photo}
                </span>
              ) : (
                photo
              )}
              {detail}
            </span>
          </span>
        );
      })}
    </span>
  );
}
