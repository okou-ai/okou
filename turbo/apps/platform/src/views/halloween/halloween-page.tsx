import { Button, cn } from "@okouai/ui";
import { useGet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { ArrowRight } from "lucide-react";
import { HALLOWEEN_COPY as copy } from "../../signals/halloween/halloween-content.ts";
import {
  halloweenPhase$,
  halloweenScreen$,
  startHalloween$,
} from "../../signals/halloween/halloween.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { HalloweenStage } from "./halloween-art.tsx";
import { HalloweenQuestionScreen } from "./halloween-game.tsx";
import {
  goldButton,
  HalloweenFooter,
  HalloweenHeader,
  HalloweenRules,
} from "./halloween-layout.tsx";
import { HalloweenResultScreen } from "./halloween-result.tsx";
import { halloweenTypography as typography } from "./halloween-typography.ts";

function StartScreen() {
  const phase = useGet(halloweenPhase$);
  const signal = useGet(pageSignal$);
  const [operation, start] = useLoadableSet(startHalloween$);
  const open = phase === "open";
  const title =
    phase === "ended"
      ? copy.ended
      : phase === "upcoming"
        ? copy.upcoming
        : copy.unavailable;
  const subtitle =
    phase === "ended"
      ? copy.endedSub
      : phase === "upcoming"
        ? copy.upcomingSub
        : copy.unavailableSub;
  return (
    <main className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 py-14 pb-20 text-center md:py-20 md:pb-24">
      <h1
        className={cn(
          "mb-9 max-w-[900px] text-balance text-[#f6f3ed]",
          typography.title,
        )}
      >
        {open ? (
          <>
            {copy.title}
            <span className="mt-2 block text-[#e8c68d]">{copy.subtitle}</span>
          </>
        ) : (
          title
        )}
      </h1>
      {open ? (
        <p className={cn("mb-8 text-[#96a5b9]", typography.body)}>
          {copy.rewardPrefix}
          <strong className={cn("text-[#e8cfaa]", typography.body)}>
            {copy.rewardEmphasis}
          </strong>
          <br />
          {copy.review}
        </p>
      ) : (
        <p className={cn("mb-8 max-w-[560px] text-[#a9b8ca]", typography.body)}>
          {subtitle}
        </p>
      )}
      {open ? (
        <Button
          className={cn(goldButton, "min-w-[184px]")}
          pending={operation.state === "loading"}
          onClick={() => {
            detach(start(signal), Reason.DomCallback);
          }}
        >
          {copy.start}
          <ArrowRight className="size-4" />
        </Button>
      ) : (
        <Button
          nativeButton={false}
          render={<Link pathname="/" />}
          className={goldButton}
        >
          {copy.back}
          <ArrowRight className="size-4" />
        </Button>
      )}
      {open && (
        <p
          className={cn("mt-6 max-w-[420px] text-[#8292a9]", typography.label)}
        >
          {copy.hint}
        </p>
      )}
      {operation.state === "hasError" && (
        <p role="alert" className={cn("mt-4 text-[#ffccde]", typography.body)}>
          {copy.error}
        </p>
      )}
    </main>
  );
}

export function HalloweenPage() {
  const screen = useGet(halloweenScreen$);
  return (
    <div
      className={cn(
        "relative isolate flex min-h-full w-full flex-col overflow-hidden text-[#f6f3ed] antialiased",
        typography.body,
        screen === "result"
          ? "bg-[radial-gradient(ellipse_at_50%_25%,#172c48,#091426_58%,#060d19)]"
          : "bg-[radial-gradient(ellipse_at_50%_42%,#183452_0,#0c1d34_42%,#060d19_85%)]",
      )}
    >
      {screen !== "result" && <HalloweenStage />}
      <HalloweenHeader />
      {screen === "question" ? (
        <HalloweenQuestionScreen />
      ) : screen === "result" ? (
        <HalloweenResultScreen />
      ) : (
        <StartScreen />
      )}
      <HalloweenFooter />
      <HalloweenRules />
    </div>
  );
}
