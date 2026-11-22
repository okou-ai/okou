import { useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { cn } from "@okouai/ui";
import { forYouCompleteIllustration } from "../../lib/for-you-artwork.ts";
import { focusSuggestionTitleOnRef$ } from "../../signals/okou-page/agent-suggestion-session.ts";

// Three bursts around the illustration, positioned relative to it and
// staggered so they pop one after another rather than all at once. Each burst
// rises, then opens into twelve sparks in two alternating colours.
const FIREWORKS = [
  {
    position:
      "top-[22%] left-[-14%] [--firework-delay:0ms] [--firework-reach:44px]",
    colors: ["bg-amber-400", "bg-rose-400"],
  },
  {
    position:
      "top-[8%] left-[112%] [--firework-delay:240ms] [--firework-reach:40px]",
    colors: ["bg-sky-400", "bg-emerald-400"],
  },
  {
    position:
      "top-[-30%] left-[54%] [--firework-delay:480ms] [--firework-reach:52px]",
    colors: ["bg-rose-400", "bg-amber-300"],
  },
] as const;

const FIREWORK_SPARKS = [
  "[--firework-spark-angle:0deg] [--firework-spark-scale:1]",
  "[--firework-spark-angle:30deg] [--firework-spark-scale:0.72]",
  "[--firework-spark-angle:60deg] [--firework-spark-scale:1]",
  "[--firework-spark-angle:90deg] [--firework-spark-scale:0.72]",
  "[--firework-spark-angle:120deg] [--firework-spark-scale:1]",
  "[--firework-spark-angle:150deg] [--firework-spark-scale:0.72]",
  "[--firework-spark-angle:180deg] [--firework-spark-scale:1]",
  "[--firework-spark-angle:210deg] [--firework-spark-scale:0.72]",
  "[--firework-spark-angle:240deg] [--firework-spark-scale:1]",
  "[--firework-spark-angle:270deg] [--firework-spark-scale:0.72]",
  "[--firework-spark-angle:300deg] [--firework-spark-scale:1]",
  "[--firework-spark-angle:330deg] [--firework-spark-scale:0.72]",
] as const;

function Firework({
  firework,
}: {
  readonly firework: (typeof FIREWORKS)[number];
}) {
  return (
    <span
      className={cn(
        "absolute size-0 motion-safe:animate-firework-fall",
        firework.position,
      )}
    >
      <span
        className={cn(
          "absolute top-0 -left-px h-3 w-0.5 rounded-full opacity-0 motion-safe:animate-firework-rise",
          firework.colors[0],
        )}
      />
      {FIREWORK_SPARKS.map((spark, index) => {
        return (
          <span
            key={spark}
            className={cn(
              "absolute -top-1.25 -left-px h-2.5 w-0.5 rounded-full opacity-0 motion-safe:animate-firework-spark",
              firework.colors[index % 2],
              spark,
            )}
          />
        );
      })}
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
