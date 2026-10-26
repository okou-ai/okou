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
    <main className="relative z-10 flex flex-1 flex-col items-center justify-center px-[22px] py-7 pb-[55px] text-center md:px-6 md:pt-6">
      <h1 className="mb-[30px] mt-[18px] text-[43px] font-bold leading-[1.22] tracking-[-.045em] text-[#f1f5ff] [text-shadow:0_3px_30px_#0005] md:text-[64px]">
        {open ? (
          <>
            {copy.title}
            <br />
            <span className="text-[#edc987]">{copy.subtitle}</span>
          </>
        ) : (
          title
        )}
      </h1>
      {open ? (
        <p className="mb-[26px] text-sm leading-[1.9] text-[#a9bddd]">
          {copy.rewardPrefix}
          <strong className="text-xl text-[#ebd5a9]">
            {copy.rewardEmphasis}
          </strong>
          <br />
          {copy.review}
        </p>
      ) : (
        <p className="mb-6 max-w-[600px] text-base leading-relaxed text-[#c7d9fa]">
          {subtitle}
        </p>
      )}
      {open ? (
        <Button
          className={goldButton}
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
        <p className="mt-5 max-w-[420px] text-[11px] text-[#7f95ba]">
          {copy.hint}
        </p>
      )}
      {operation.state === "hasError" && (
        <p role="alert" className="mt-4 text-sm text-[#ffccde]">
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
        "relative isolate flex min-h-full w-full flex-col overflow-hidden text-[#eff3ff] [font-family:Inter,'Segoe_UI',Arial,sans-serif]",
        screen === "result"
          ? "bg-[radial-gradient(ellipse_at_50%_35%,#17366b,#040b20_80%)]"
          : "bg-[radial-gradient(ellipse_at_50%_38%,#183b79_0,#0b1d48_38%,#03091d_78%)]",
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
