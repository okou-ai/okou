import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { ArrowUpRight, Info, Volume2, VolumeX } from "lucide-react";
import { HALLOWEEN_COPY as copy } from "../../signals/halloween/halloween-content.ts";
import { playHalloweenClick$ } from "../../signals/halloween/halloween-motion.ts";
import {
  halloweenRound$,
  halloweenRulesOpen$,
  halloweenScreen$,
  halloweenSound$,
  leaveHalloween$,
  setHalloweenRulesOpen$,
  toggleHalloweenSound$,
} from "../../signals/halloween/halloween.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { HalloweenMark } from "./halloween-art.tsx";

export const goldButton =
  "relative h-auto min-h-12 rounded-[9px] border border-[#ffe1a6] bg-[linear-gradient(120deg,#e7bb68,#f6ddaa_50%,#d8a954)] px-[26px] py-[14px] text-[15px] font-bold text-[#211a0e] shadow-[0_0_25px_#e9b85d20] transition-all hover:-translate-y-px hover:bg-[linear-gradient(120deg,#f4cd88,#ffebbe,#e7be77)]";

export function HalloweenHeader() {
  const screen = useGet(halloweenScreen$);
  const round = useGet(halloweenRound$);
  const sound = useGet(halloweenSound$);
  const toggle = useSet(toggleHalloweenSound$);
  const setRules = useSet(setHalloweenRulesOpen$);
  const playSound = useSet(playHalloweenClick$);
  const signal = useGet(pageSignal$);
  const [operation, leave] = useLoadableSet(leaveHalloween$);
  const playing = screen === "question";
  return (
    <header className="relative z-20 flex min-h-[72px] shrink-0 items-center gap-3 border-b border-[#9ebbec23] bg-[#050c2280] px-[18px] py-4 text-[#eef4ff] md:h-[72px] md:px-11 md:py-0">
      <Link
        pathname="/"
        className="flex shrink-0 items-center gap-[10px] text-[20px] font-bold tracking-tight transition-opacity hover:opacity-75"
      >
        <span className="h-7 w-7">
          <HalloweenMark />
        </span>
        {copy.brand}
      </Link>
      <div className="ml-auto flex max-w-[72%] flex-wrap items-center justify-end gap-x-[14px] gap-y-2 text-[11px] md:max-w-none md:gap-[22px] md:text-[13px]">
        <span className="font-semibold text-[#d9e5ff]">
          {playing
            ? `${copy.question} ${round?.questionNumber ?? 1} ${copy.of} 5`
            : copy.campaign}
        </span>
        {!playing && (
          <span className="hidden text-[#8b9ec2] md:inline">{copy.dates}</span>
        )}
        {playing ? (
          <Button
            variant="quiet"
            size="sm"
            pending={operation.state === "loading"}
            className="h-auto gap-1 p-0 text-[length:inherit] font-semibold text-[#d9e5ff] hover:bg-transparent hover:text-[#edc987]"
            onClick={() => {
              detach(leave(signal), Reason.DomCallback);
            }}
          >
            {copy.leave}
            <ArrowUpRight className="size-3" />
          </Button>
        ) : (
          <Link
            pathname="/"
            className="flex items-center gap-1 font-semibold text-[#d9e5ff] transition-colors hover:text-[#edc987]"
          >
            {copy.back}
            <ArrowUpRight className="size-3" />
          </Link>
        )}
        {screen !== "result" && (
          <Button
            variant="quiet"
            size="sm"
            className="h-auto gap-1 rounded-full border border-[#93afd166] bg-[#14284a] px-3 py-[7px] text-[11px] font-semibold text-[#e8d2a7] hover:border-[#edc585] hover:bg-[#243c64] hover:text-[#e8d2a7]"
            onClick={() => {
              setRules(true);
            }}
          >
            {copy.rules}
            <Info className="size-3" />
          </Button>
        )}
        <Button
          variant="quiet"
          size="sm"
          className="h-auto gap-1 rounded-full border border-[#a9bbd54d] bg-[#172234e8] px-[13px] py-[9px] text-[11px] font-semibold text-[#e7f1ff] hover:bg-[#2b3c55] hover:text-[#e7f1ff]"
          aria-pressed={sound}
          aria-label={sound ? copy.soundOn : copy.soundOff}
          onClick={() => {
            toggle();
            detach(playSound(signal), Reason.DomCallback);
          }}
        >
          {sound ? (
            <Volume2 className="size-3" />
          ) : (
            <VolumeX className="size-3" />
          )}
          {sound ? copy.soundOn : copy.soundOff}
        </Button>
      </div>
    </header>
  );
}

export function HalloweenFooter() {
  const setRules = useSet(setHalloweenRulesOpen$);
  return (
    <footer className="relative z-10 mt-auto flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-[#b7cdff1a] px-5 py-[13px] text-[10px] text-[#7e91b6] md:px-11 md:pr-[130px]">
      <span>{copy.tagline}</span>
      <span className="flex items-center gap-[10px]">
        {copy.language} ·{" "}
        <Button
          variant="quiet"
          size="sm"
          className="h-auto gap-1 rounded-none p-0 text-[10px] text-[#7e91b6] underline underline-offset-[3px] hover:bg-transparent hover:text-[#edc987]"
          onClick={() => {
            setRules(true);
          }}
        >
          {copy.rules}
          <ArrowUpRight className="size-[11px]" />
        </Button>
      </span>
    </footer>
  );
}

export function HalloweenRules() {
  const open = useGet(halloweenRulesOpen$);
  const setOpen = useSet(setHalloweenRulesOpen$);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        maxWidth={760}
        showCloseButton={false}
        overlayClassName="backdrop-blur-sm"
        contentClassName="gap-0 bg-white p-6 text-[#292929] sm:p-9"
      >
        <div className="mb-8 flex items-center justify-between gap-4 text-[13px]">
          <Button
            variant="quiet"
            size="sm"
            className="h-auto rounded-none p-0 text-[#555] underline underline-offset-4 hover:bg-transparent hover:text-[#17181c]"
            aria-label={copy.backToGame}
            onClick={() => {
              setOpen(false);
            }}
          >
            {copy.backToGame} →
          </Button>
          <span className="text-[#888]">{copy.rulesBrand}</span>
        </div>
        <DialogTitle className="mb-4 text-[28px] font-bold leading-tight tracking-tight">
          {copy.rulesHeading}
        </DialogTitle>
        <DialogDescription className="mb-9 text-[15px] text-[#555]">
          {copy.rulesSub}
        </DialogDescription>
        <div className="space-y-8 text-[15px] leading-[1.9] text-[#555]">
          {copy.ruleSections.map((section, index) => {
            return (
              <section key={section.title}>
                <h2 className="mb-3 text-lg font-bold text-[#292929]">
                  {index + 1}. {section.title}
                </h2>
                <p>{section.text}</p>
              </section>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
