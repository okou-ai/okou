import type { CSSProperties } from "react";
import { useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { cn } from "@okouai/ui";
import { forYouCompleteIllustration } from "../../lib/for-you-artwork.ts";
import { focusSuggestionTitleOnRef$ } from "../../signals/okou-page/agent-suggestion-session.ts";

// Brand colours from the Okou palette: Dark Pink #ff96a9, Pink #ffc6e2, Dark
// Blue #3363d3, Blue #82cffb and Orange #ffa500. Each burst draws its long rays
// in the darker colour and its short rays and centre ring in the lighter one;
// every fourth tip sparks Orange. Tailwind's scanner is text-based, so every
// colour is spelled out as a literal class.
const FIREWORK_PINK = {
  trail: "bg-[linear-gradient(to_top,transparent,#ff96a9)]",
  longRay: "bg-[linear-gradient(to_top,transparent,#ff96a9_55%)]",
  shortRay: "bg-[linear-gradient(to_top,transparent,#ffc6e2_55%)]",
  longTip: "bg-[#ff96a9]",
  shortTip: "bg-[#ffc6e2]",
} as const;

const FIREWORK_BLUE = {
  trail: "bg-[linear-gradient(to_top,transparent,#3363d3)]",
  longRay: "bg-[linear-gradient(to_top,transparent,#3363d3_55%)]",
  shortRay: "bg-[linear-gradient(to_top,transparent,#82cffb_55%)]",
  longTip: "bg-[#3363d3]",
  shortTip: "bg-[#82cffb]",
} as const;

const FIREWORK_SPARK = "bg-[#ffa500]";

// Four bursts around the illustration, positioned relative to it and staggered
// so they pop one after another: a large pink one top right, a blue one top
// left, and two small ones low on either side. `reach` is the burst's outer
// radius in px; `rays` alternates long and short rays. Each burst climbs 1.8
// and drops 0.35 times its reach.
const FIREWORKS = [
  {
    position:
      "top-[24%] left-[84%] [--firework-delay:0ms] [--firework-climb:47px] [--firework-drop:9px]",
    reach: 26,
    rays: 20,
    rotate: 3,
    colors: FIREWORK_PINK,
  },
  {
    position:
      "top-[25%] left-[13%] [--firework-delay:240ms] [--firework-climb:34px] [--firework-drop:7px]",
    reach: 19,
    rays: 16,
    rotate: 11,
    colors: FIREWORK_BLUE,
  },
  {
    position:
      "top-[52%] left-[101%] [--firework-delay:460ms] [--firework-climb:18px] [--firework-drop:4px]",
    reach: 10,
    rays: 12,
    rotate: 6,
    colors: FIREWORK_PINK,
  },
  {
    position:
      "top-[56%] left-[-3%] [--firework-delay:620ms] [--firework-climb:14px] [--firework-drop:3px]",
    reach: 8,
    rays: 10,
    rotate: 17,
    colors: FIREWORK_BLUE,
  },
] as const;

// Four-point sparkles that twinkle in the gaps between the bursts.
const FIREWORK_SPARKLES = [
  {
    position:
      "top-[7%] left-[69%] -mt-[4.5px] -ml-[4.5px] size-[9px] [--firework-delay:300ms]",
    color: FIREWORK_SPARK,
  },
  {
    position:
      "top-[9%] left-[29%] -mt-[3.5px] -ml-[3.5px] size-[7px] [--firework-delay:520ms]",
    color: FIREWORK_PINK.longTip,
  },
  {
    position:
      "top-[8%] left-[98%] -mt-[3.5px] -ml-[3.5px] size-[7px] [--firework-delay:700ms]",
    color: FIREWORK_BLUE.longTip,
  },
  {
    position:
      "top-[44%] left-[2%] -mt-[3.5px] -ml-[3.5px] size-[7px] [--firework-delay:820ms]",
    color: FIREWORK_SPARK,
  },
] as const;

type FireworkConfig = (typeof FIREWORKS)[number];

// A ray's angle and radii are computed per ray, so they reach the keyframes as
// custom properties; everything visual stays in the class lists.
function fireworkRayVars({
  angle,
  inner,
  outer,
}: {
  readonly angle: number;
  readonly inner: number;
  readonly outer: number;
}): CSSProperties {
  const vars: Record<string, string> = {
    "--firework-angle": `${angle}deg`,
    "--firework-inner": `${inner}px`,
    "--firework-outer": `${outer}px`,
    "--firework-length": `${outer - inner}px`,
  };
  return vars as CSSProperties;
}

function Firework({ firework }: { readonly firework: FireworkConfig }) {
  const { reach, rays, rotate, colors } = firework;
  return (
    <span
      className={cn(
        "absolute size-0 motion-safe:animate-firework-fall",
        firework.position,
      )}
    >
      <span
        className={cn(
          "absolute bottom-0 -left-px h-3.5 w-0.5 rounded-full opacity-0 motion-safe:animate-firework-rise",
          colors.trail,
        )}
      />
      <span
        className={cn(
          "absolute -top-0.75 -left-0.75 size-1.5 rounded-full opacity-0 motion-safe:animate-firework-flash",
          FIREWORK_SPARK,
        )}
      />
      {Array.from({ length: rays }, (_, index) => {
        const long = index % 2 === 0;
        const angle = rotate + (360 / rays) * index;
        const tip =
          index % 4 === 0
            ? FIREWORK_SPARK
            : long
              ? colors.longTip
              : colors.shortTip;
        const vars = fireworkRayVars({
          angle,
          inner: reach * (long ? 0.3 : 0.42),
          outer: reach * (long ? 1 : 0.74),
        });
        return (
          <span key={angle}>
            <span
              className={cn(
                "absolute bottom-0 h-(--firework-length) origin-bottom rounded-full opacity-0 motion-safe:animate-firework-ray",
                long ? "-left-[0.75px] w-[1.5px]" : "-left-[0.5px] w-px",
                long ? colors.longRay : colors.shortRay,
              )}
              style={vars}
            />
            <span
              className={cn(
                "absolute rounded-full opacity-0 motion-safe:animate-firework-tip",
                long
                  ? "-top-[1.5px] -left-[1.5px] size-[3px]"
                  : "-top-px -left-px size-0.5",
                tip,
              )}
              style={vars}
            />
            {!long && (
              <span
                className={cn(
                  "absolute -top-px -left-px size-0.5 rounded-full opacity-0 motion-safe:animate-firework-ring",
                  colors.shortTip,
                )}
                style={fireworkRayVars({
                  angle,
                  inner: reach * 0.2,
                  outer: reach * 0.2,
                })}
              />
            )}
          </span>
        );
      })}
    </span>
  );
}

function FireworkSparkle({
  sparkle,
}: {
  readonly sparkle: (typeof FIREWORK_SPARKLES)[number];
}) {
  return (
    <span
      className={cn(
        "absolute opacity-0 motion-safe:animate-firework-twinkle",
        sparkle.position,
      )}
    >
      <span
        className={cn(
          "absolute inset-x-0 top-1/2 -mt-px h-0.5 rounded-full",
          sparkle.color,
        )}
      />
      <span
        className={cn(
          "absolute inset-y-0 left-1/2 -ml-px w-0.5 rounded-full",
          sparkle.color,
        )}
      />
    </span>
  );
}

export function SuggestionsComplete({
  className,
  celebrate = true,
}: {
  readonly className?: string;
  readonly celebrate?: boolean;
}) {
  const { t } = useTranslation();
  const focusTitle = useSet(focusSuggestionTitleOnRef$);
  return (
    <div className={cn("flex flex-col items-center text-center", className)}>
      <div
        className={cn(
          "flex flex-col items-center",
          celebrate && "motion-safe:animate-completion-in",
        )}
      >
        <span aria-hidden className="pointer-events-none relative">
          <img
            src={forYouCompleteIllustration}
            alt=""
            width={480}
            height={293}
            draggable={false}
            className="h-auto w-40 select-none sm:w-48"
          />
          {celebrate &&
            FIREWORKS.map((firework) => {
              return <Firework key={firework.position} firework={firework} />;
            })}
          {celebrate &&
            FIREWORK_SPARKLES.map((sparkle) => {
              return (
                <FireworkSparkle key={sparkle.position} sparkle={sparkle} />
              );
            })}
        </span>
        <h3
          ref={focusTitle}
          tabIndex={-1}
          className="mt-5 text-xl font-semibold focus:outline-none"
        >
          {t(($) => {
            return $.chat.agentSuggestions.homeCard.completeTitle;
          })}
        </h3>
        <p className="mt-2 max-w-90 text-sm text-muted-foreground">
          {t(($) => {
            return $.chat.agentSuggestions.homeCard.completeDescription;
          })}
        </p>
      </div>
    </div>
  );
}
