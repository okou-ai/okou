import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogClose,
  IconButton,
} from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { ArrowLeft, Info, Volume2, VolumeX, X } from "lucide-react";
import {
  platformOkouWordmarkDarkImg,
  platformOkouWordmarkLightImg,
} from "../../lib/static-assets.ts";
import { useHalloweenCopy } from "../../signals/halloween/halloween-content.ts";
import { playHalloweenClick$ } from "../../signals/halloween/halloween-motion.ts";
import {
  halloweenRulesOpen$,
  halloweenScreen$,
  halloweenSound$,
  setHalloweenRulesOpen$,
  toggleHalloweenSound$,
} from "../../signals/halloween/halloween.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { halloweenTypography as typography } from "./halloween-typography.ts";

export const goldButton = cn(
  "relative h-auto min-h-12 gap-3 rounded-xl border border-[#fbe7c1b3] bg-[linear-gradient(180deg,#f0d6a5,#dfb879)] px-7 py-3.5 text-[#302519] shadow-[inset_0_1px_0_#fff5,0_4px_20px_#0003] transition-all duration-200 hover:border-[#ffebc8] hover:bg-[linear-gradient(180deg,#f7e3bf,#eac88e)] hover:shadow-[inset_0_1px_0_#fff5,0_6px_28px_#e2bc7620] active:translate-y-px motion-safe:hover:-translate-y-0.5",
  typography.labelClassName,
);

function HalloweenBrand() {
  const copy = useHalloweenCopy();
  return (
    <DialogClose
      aria-label={copy.brand}
      className="flex h-8 shrink-0 items-center transition-opacity hover:opacity-75"
    >
      <img
        src={platformOkouWordmarkLightImg}
        alt=""
        aria-hidden
        width={91}
        height={24}
        className="h-6 w-[91px]"
      />
    </DialogClose>
  );
}

export function HalloweenHeader() {
  const copy = useHalloweenCopy();
  const screen = useGet(halloweenScreen$);
  const sound = useGet(halloweenSound$);
  const toggle = useSet(toggleHalloweenSound$);
  const setRules = useSet(setHalloweenRulesOpen$);
  const playSound = useSet(playHalloweenClick$);
  const signal = useGet(pageSignal$);
  return (
    <header
      className={cn(
        "relative z-20 flex min-h-14 shrink-0 items-center gap-3 border-b border-[#c0d1e512] bg-[#07111f40] px-4 py-2 text-[#eef1f5] lg:min-h-16 lg:px-12 lg:py-3",
      )}
    >
      <HalloweenBrand />
      <div
        className={cn(
          "ml-auto flex max-w-none flex-nowrap items-center justify-end gap-x-2 gap-y-2 lg:gap-4",
          typography.labelClassName,
        )}
      >
        {screen !== "question" && (
          <span className="hidden text-[#b8c6d8] lg:inline">
            {copy.campaign}
          </span>
        )}
        {screen !== "result" && (
          <Button
            variant="quiet"
            size="default"
            aria-label={copy.rules}
            className={cn(
              "h-9 gap-2 rounded-lg border border-[#b4c5dc24] bg-[#ffffff04] px-3 text-[#b8c6d8] hover:border-[#e8c68d66] hover:bg-[#ffffff09] hover:text-[#e8c68d]",
              typography.labelClassName,
            )}
            onClick={() => {
              setRules(true);
            }}
          >
            <Info className="size-4" />
            <span className="hidden sm:inline">{copy.rules}</span>
          </Button>
        )}
        <Button
          variant="quiet"
          size="default"
          className={cn(
            "h-9 gap-2 rounded-lg border border-[#b4c5dc24] bg-[#ffffff04] px-3 text-[#b8c6d8] hover:border-[#e8c68d66] hover:bg-[#ffffff09] hover:text-[#e8c68d]",
            typography.labelClassName,
          )}
          aria-pressed={sound}
          aria-label={sound ? copy.soundOn : copy.soundOff}
          onClick={() => {
            toggle();
            detach(playSound(signal), Reason.DomCallback);
          }}
        >
          {sound ? (
            <Volume2 className="size-4" />
          ) : (
            <VolumeX className="size-4" />
          )}
          <span className="hidden lg:inline">
            {sound ? copy.soundOn : copy.soundOff}
          </span>
        </Button>
        <DialogClose
          render={
            <IconButton
              aria-label={copy.back}
              className="text-[#bcc8d9] hover:bg-[#ffffff09] hover:text-[#e8c68d]"
            />
          }
        >
          <X className="size-5" />
        </DialogClose>
      </div>
    </header>
  );
}

export function HalloweenFooter() {
  const copy = useHalloweenCopy();
  return (
    <footer
      className={cn(
        "relative z-10 mt-auto hidden shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-[#c0d1e512] px-5 py-4 text-[#9aabc1] lg:flex lg:px-12",
        typography.captionClassName,
      )}
    >
      <span>{copy.tagline}</span>
      <span>{copy.language}</span>
    </footer>
  );
}

export function HalloweenRules() {
  const copy = useHalloweenCopy();
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
        <div
          className={cn(
            "mb-9 flex items-center justify-between gap-4",
            typography.labelClassName,
          )}
        >
          <Button
            variant="quiet"
            size="sm"
            className={cn(
              "h-auto gap-1.5 rounded-none p-0 text-[#656b73] hover:bg-transparent hover:text-[#262c34]",
              typography.labelClassName,
            )}
            aria-label={copy.backToGame}
            onClick={() => {
              setOpen(false);
            }}
          >
            <ArrowLeft className="size-3.5" />
            {copy.backToGame}
          </Button>
          <img
            src={platformOkouWordmarkDarkImg}
            alt={copy.rulesBrand}
            width={76}
            height={20}
            className="h-5 w-[76px]"
          />
        </div>
        <DialogTitle className={cn("mb-3", typography.titleClassName)}>
          {copy.rulesHeading}
        </DialogTitle>
        <DialogDescription
          className={cn("mb-9 text-[#7c7e83]", typography.bodyClassName)}
        >
          {copy.rulesSub}
        </DialogDescription>
        <div
          className={cn(
            "divide-y divide-[#dcd7cf] text-[#646970]",
            typography.bodyClassName,
          )}
        >
          {copy.ruleSections.map((section, index) => {
            return (
              <section
                key={section.title}
                className="py-7 first:pt-0 last:pb-0"
              >
                <h2
                  className={cn(
                    "mb-3 flex items-center gap-3 text-[#30363e]",
                    typography.labelClassName,
                  )}
                >
                  <span
                    className={cn(
                      "flex size-6 shrink-0 items-center justify-center rounded-md bg-[#ede7db] text-[#8b7652]",
                      typography.labelClassName,
                    )}
                  >
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
