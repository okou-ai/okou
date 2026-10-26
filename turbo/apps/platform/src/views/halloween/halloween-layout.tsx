import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { ArrowLeft, ArrowUpRight, Info, Volume2, VolumeX } from "lucide-react";
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
  "relative h-auto min-h-12 gap-3 rounded-xl border border-[#fbe7c1b3] bg-[linear-gradient(180deg,#f0d6a5,#dfb879)] px-7 py-3.5 text-sm font-semibold text-[#302519] shadow-[inset_0_1px_0_#fff5,0_4px_20px_#0003] transition-all duration-200 hover:border-[#ffebc8] hover:bg-[linear-gradient(180deg,#f7e3bf,#eac88e)] hover:shadow-[inset_0_1px_0_#fff5,0_6px_28px_#e2bc7620] active:translate-y-px motion-safe:hover:-translate-y-0.5";

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
    <header className="relative z-20 flex min-h-[76px] shrink-0 items-center gap-3 border-b border-[#c0d1e512] bg-[#07111f40] px-5 py-4 text-[#eef1f5] md:px-12">
      <Link
        pathname="/"
        className="flex shrink-0 items-center gap-2.5 text-xl font-semibold tracking-[-.045em] transition-opacity hover:opacity-75"
      >
        <span className="size-6">
          <HalloweenMark />
        </span>
        {copy.brand}
      </Link>
      <div className="ml-auto flex max-w-[74%] flex-wrap items-center justify-end gap-x-3 gap-y-2 text-xs md:max-w-none md:gap-5">
        <span className="hidden font-medium text-[#c5cfdd] md:inline">
          {playing
            ? `${copy.question} ${round?.questionNumber ?? 1} ${copy.of} 5`
            : copy.campaign}
        </span>
        {!playing && (
          <span className="hidden text-[#7f90a8] lg:inline">{copy.dates}</span>
        )}
        {playing ? (
          <Button
            variant="quiet"
            size="sm"
            pending={operation.state === "loading"}
            className="h-8 gap-1 p-0 text-xs font-medium text-[#aebcd0] hover:bg-transparent hover:text-[#e8c68d]"
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
            className="flex h-8 items-center gap-1 font-medium text-[#aebcd0] transition-colors hover:text-[#e8c68d]"
          >
            {copy.back}
            <ArrowUpRight className="size-3" />
          </Link>
        )}
        {screen !== "result" && (
          <Button
            variant="quiet"
            size="sm"
            aria-label={copy.rules}
            className="h-8 gap-2 rounded-full border border-[#b4c5dc24] bg-[#ffffff04] px-2.5 text-[11px] font-medium text-[#bcc8d9] hover:border-[#e8c68d66] hover:bg-[#ffffff09] hover:text-[#e8c68d] sm:px-3"
            onClick={() => {
              setRules(true);
            }}
          >
            <span className="hidden sm:inline">{copy.rules}</span>
            <Info className="size-3" />
          </Button>
        )}
        <Button
          variant="quiet"
          size="sm"
          className="h-8 gap-2 rounded-full border border-[#b4c5dc24] bg-[#ffffff04] px-2.5 text-[11px] font-medium text-[#bcc8d9] hover:border-[#e8c68d66] hover:bg-[#ffffff09] hover:text-[#e8c68d] md:px-3"
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
          <span className="hidden md:inline">
            {sound ? copy.soundOn : copy.soundOff}
          </span>
        </Button>
      </div>
    </header>
  );
}

export function HalloweenFooter() {
  const setRules = useSet(setHalloweenRulesOpen$);
  return (
    <footer className="relative z-10 mt-auto flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-[#c0d1e512] px-5 py-4 text-[10px] text-[#7c8ba1] md:px-12 md:text-[11px]">
      <span>{copy.tagline}</span>
      <span className="flex items-center gap-[10px]">
        {copy.language} ·{" "}
        <Button
          variant="quiet"
          size="sm"
          className="h-auto gap-1 rounded-none p-0 text-[length:inherit] text-[#7c8ba1] underline decoration-[#7c8ba160] underline-offset-4 hover:bg-transparent hover:text-[#e8c68d]"
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
        contentClassName="gap-0 rounded-3xl border-[#e5dfd4] bg-[#fbfaf7] p-6 text-[#292e34] sm:p-10"
      >
        <div className="mb-9 flex items-center justify-between gap-4 text-xs">
          <Button
            variant="quiet"
            size="sm"
            className="h-auto gap-1.5 rounded-none p-0 text-[#656b73] hover:bg-transparent hover:text-[#262c34]"
            aria-label={copy.backToGame}
            onClick={() => {
              setOpen(false);
            }}
          >
            <ArrowLeft className="size-3.5" />
            {copy.backToGame}
          </Button>
          <span className="text-[#8a8b8e]">{copy.rulesBrand}</span>
        </div>
        <DialogTitle className="mb-3 text-[28px] font-semibold leading-tight tracking-[-.035em] sm:text-[32px]">
          {copy.rulesHeading}
        </DialogTitle>
        <DialogDescription className="mb-9 text-sm text-[#7c7e83]">
          {copy.rulesSub}
        </DialogDescription>
        <div className="divide-y divide-[#dcd7cf] text-sm leading-[1.9] text-[#646970]">
          {copy.ruleSections.map((section, index) => {
            return (
              <section
                key={section.title}
                className="py-7 first:pt-0 last:pb-0"
              >
                <h2 className="mb-3 flex items-center gap-3 text-base font-semibold text-[#30363e]">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-[#ede7db] text-[11px] font-medium text-[#8b7652]">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  {section.title}
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
