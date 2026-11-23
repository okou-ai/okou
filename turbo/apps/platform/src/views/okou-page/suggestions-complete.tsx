import type { CSSProperties } from "react";
import { useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { cn } from "@okouai/ui";
import { forYouCompleteIllustration } from "../../lib/for-you-artwork.ts";
import { focusSuggestionTitleOnRef$ } from "../../signals/okou-page/agent-suggestion-session.ts";

// Brand colours from the Okou palette: Dark Pink, Pink, Dark Blue, Blue and
// Orange. Each burst has a main colour for its long rays, a light one for its
// short rays and centre ring, and Orange for the spark on every fourth tip.
const FIREWORK_PINK = { main: "#ff96a9", light: "#ffc6e2" } as const;
const FIREWORK_BLUE = { main: "#3363d3", light: "#82cffb" } as const;
const FIREWORK_ORANGE = "#ffa500";

// Four bursts around the illustration, positioned relative to it and staggered
// so they pop one after another: a large pink one top right, a blue one top
// left, and two small ones low on either side. `reach` is the burst's outer
// radius in px; `rays` alternates long and short rays.
const FIREWORKS = [
  {
    left: "84%",
    top: "24%",
    reach: 26,
    rays: 20,
    rotate: 3,
    delay: 0,
    colors: FIREWORK_PINK,
  },
  {
    left: "13%",
    top: "25%",
    reach: 19,
    rays: 16,
    rotate: 11,
    delay: 240,
    colors: FIREWORK_BLUE,
  },
  {
    left: "101%",
    top: "52%",
    reach: 10,
    rays: 12,
    rotate: 6,
    delay: 460,
    colors: FIREWORK_PINK,
  },
  {
    left: "-3%",
    top: "56%",
    reach: 8,
    rays: 10,
    rotate: 17,
    delay: 620,
    colors: FIREWORK_BLUE,
  },
] as const;

// Four-point sparkles that twinkle in the gaps between the bursts.
const FIREWORK_SPARKLES = [
  { left: "69%", top: "7%", size: 9, delay: 300, color: FIREWORK_ORANGE },
  { left: "29%", top: "9%", size: 7, delay: 520, color: FIREWORK_PINK.main },
  { left: "98%", top: "8%", size: 7, delay: 700, color: FIREWORK_BLUE.main },
  { left: "2%", top: "44%", size: 7, delay: 820, color: FIREWORK_ORANGE },
] as const;

type FireworkConfig = (typeof FIREWORKS)[number];

interface FireworkRay {
  readonly key: number;
  readonly angle: number;
  readonly inner: number;
  readonly outer: number;
  readonly width: number;
  readonly color: string;
  readonly tip: string;
  readonly tipSize: number;
}

function fireworkRays(firework: FireworkConfig): FireworkRay[] {
  const { reach, rays, rotate, colors } = firework;
  return Array.from({ length: rays }, (_, index) => {
    const long = index % 2 === 0;
    return {
      key: index,
      angle: rotate + (360 / rays) * index,
      inner: reach * (long ? 0.3 : 0.42),
      outer: reach * (long ? 1 : 0.74),
      width: long ? 1.5 : 1,
      color: long ? colors.main : colors.light,
      tip:
        index % 4 === 0 ? FIREWORK_ORANGE : long ? colors.main : colors.light,
      tipSize: long ? 3 : 2,
    };
  });
}

function fireworkVars(vars: Record<string, string>): CSSProperties {
  return vars as CSSProperties;
}

function Firework({ firework }: { readonly firework: FireworkConfig }) {
  const { reach, colors } = firework;
  const rays = fireworkRays(firework);
  return (
    <span
      className="absolute size-0 motion-safe:animate-firework-fall"
      style={{
        left: firework.left,
        top: firework.top,
        ...fireworkVars({
          "--firework-delay": `${firework.delay}ms`,
          "--firework-climb": `${Math.round(reach * 1.8)}px`,
          "--firework-drop": `${Math.round(reach * 0.35)}px`,
        }),
      }}
    >
      <span
        className="absolute bottom-0 -left-px h-3.5 w-0.5 rounded-full opacity-0 motion-safe:animate-firework-rise"
        style={{
          background: `linear-gradient(to top, transparent, ${colors.main})`,
        }}
      />
      <span
        className="absolute -top-0.75 -left-0.75 size-1.5 rounded-full opacity-0 motion-safe:animate-firework-flash"
        style={{ background: FIREWORK_ORANGE }}
      />
      {rays.map((ray) => {
        const vars = {
          "--firework-angle": `${ray.angle}deg`,
          "--firework-inner": `${ray.inner}px`,
          "--firework-outer": `${ray.outer}px`,
          "--firework-length": `${ray.outer - ray.inner}px`,
        };
        return (
          <span key={ray.key}>
            <span
              className="absolute bottom-0 origin-bottom rounded-full opacity-0 motion-safe:animate-firework-ray"
              style={{
                left: -ray.width / 2,
                width: ray.width,
                height: ray.outer - ray.inner,
                background: `linear-gradient(to top, transparent, ${ray.color} 55%)`,
                ...fireworkVars(vars),
              }}
            />
            <span
              className="absolute rounded-full opacity-0 motion-safe:animate-firework-tip"
              style={{
                left: -ray.tipSize / 2,
                top: -ray.tipSize / 2,
                width: ray.tipSize,
                height: ray.tipSize,
                background: ray.tip,
                ...fireworkVars(vars),
              }}
            />
            {ray.key % 2 === 1 && (
              <span
                className="absolute -top-px -left-px size-0.5 rounded-full opacity-0 motion-safe:animate-firework-ring"
                style={{
                  background: colors.light,
                  ...fireworkVars({
                    ...vars,
                    "--firework-inner": `${reach * 0.2}px`,
                  }),
                }}
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
      className="absolute opacity-0 motion-safe:animate-firework-twinkle"
      style={{
        left: sparkle.left,
        top: sparkle.top,
        width: sparkle.size,
        height: sparkle.size,
        marginLeft: -sparkle.size / 2,
        marginTop: -sparkle.size / 2,
        ...fireworkVars({ "--firework-delay": `${sparkle.delay}ms` }),
      }}
    >
      <span
        className="absolute inset-x-0 top-1/2 -mt-px h-0.5 rounded-full"
        style={{ background: sparkle.color }}
      />
      <span
        className="absolute inset-y-0 left-1/2 -ml-px w-0.5 rounded-full"
        style={{ background: sparkle.color }}
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
              return (
                <Firework
                  key={`${firework.left}-${firework.top}`}
                  firework={firework}
                />
              );
            })}
          {celebrate &&
            FIREWORK_SPARKLES.map((sparkle) => {
              return (
                <FireworkSparkle
                  key={`${sparkle.left}-${sparkle.top}`}
                  sparkle={sparkle}
                />
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
