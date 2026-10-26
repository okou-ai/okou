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
import { HalloweenHeroArt, HalloweenStage } from "./halloween-art.tsx";
import { HalloweenQuestionScreen } from "./halloween-game.tsx";
import {
  campaignButton,
  HalloweenFooter,
  HalloweenHeader,
  HalloweenRules,
} from "./halloween-layout.tsx";
import { HalloweenResultScreen } from "./halloween-result.tsx";

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
    <main className="relative z-10 mx-auto grid w-full max-w-[1280px] flex-1 content-center items-center gap-8 px-6 py-8 text-center md:grid-cols-[minmax(0,1fr)_minmax(280px,380px)] md:gap-12 md:px-12 md:py-16 md:text-left lg:gap-16">
      <div>
        <p className="mb-5 text-sm font-medium text-[#B4DEF5]">
          {copy.campaign}
        </p>
        <h1 className="mb-7 text-balance text-[36px] font-medium leading-[1.1] tracking-[-.045em] text-[#FAF5F3] md:text-[52px] lg:text-[60px]">
          {open ? (
            <>
              {copy.title}
              <span className="mt-2 block text-[#FFA500]">{copy.subtitle}</span>
            </>
          ) : (
            title
          )}
        </h1>
        {open ? (
          <p className="mb-8 text-sm leading-[1.9] text-[#96a5b9]">
            {copy.rewardPrefix}
            <strong className="text-[17px] font-medium text-[#FAF5F3]">
              {copy.rewardEmphasis}
            </strong>
            <br />
            {copy.review}
          </p>
        ) : (
          <p className="mb-8 max-w-[560px] text-base leading-relaxed text-[#a9b8ca]">
            {subtitle}
          </p>
        )}
        {open ? (
          <Button
            className={cn(campaignButton, "min-w-[184px]")}
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
            className={campaignButton}
          >
            {copy.back}
            <ArrowRight className="size-4" />
          </Button>
        )}
        {open && (
          <p className="mt-5 text-xs leading-relaxed text-[#9caabd]">
            {copy.hint}
          </p>
        )}
        {operation.state === "hasError" && (
          <p role="alert" className="mt-4 text-sm text-[#ffccde]">
            {copy.error}
          </p>
        )}
      </div>
      <HalloweenHeroArt />
    </main>
  );
}

export function HalloweenPage() {
  const screen = useGet(halloweenScreen$);
  return (
    <div className="relative isolate flex min-h-full w-full flex-col overflow-hidden bg-[#102137] text-[#FAF5F3] antialiased [font-family:Geist,system-ui,sans-serif]">
      <HalloweenStage />
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
