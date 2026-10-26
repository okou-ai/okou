import { Button } from "@okouai/ui";
import { Candy, Ghost, Sparkles, Volume2, VolumeX } from "lucide-react";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { HALLOWEEN_COPY as copy } from "../../signals/halloween/halloween-content.ts";
import {
  HALLOWEEN_BUBBLES,
  playHalloweenClick$,
  halloweenCandyBurst$,
} from "../../signals/halloween/halloween-motion.ts";
import {
  halloweenPhase$,
  halloweenLinkState$,
  linkHalloweenResults$,
  halloweenFirstExposure$,
  halloweenGhostExpanded$,
  halloweenGhostGreetingIndex$,
  expandHalloweenGhost$,
  collapseHalloweenGhost$,
  halloweenBubbleTransition$,
  enterHalloweenFromBubble$,
  halloweenSound$,
  toggleHalloweenSound$,
} from "../../signals/halloween/halloween.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { shouldHandleLinkClick } from "../router/link-click.ts";
import { HalloweenGhost } from "./halloween-page.tsx";

export function HalloweenHomeSound({
  mobileOnly = false,
}: {
  mobileOnly?: boolean;
}) {
  const phase = useGet(halloweenPhase$);
  const sound = useGet(halloweenSound$);
  const toggle = useSet(toggleHalloweenSound$);
  const play = useSet(playHalloweenClick$);
  const signal = useGet(pageSignal$);
  if (phase !== "open") {
    return null;
  }
  const control = (
    <Button
      variant="quiet"
      size="sm"
      aria-label={sound ? copy.soundOn : copy.soundOff}
      aria-pressed={sound}
      onClick={() => {
        toggle();
        detach(play(signal), Reason.DomCallback);
      }}
    >
      {sound ? <Volume2 /> : <VolumeX />}
    </Button>
  );
  return mobileOnly ? (
    <div className="flex justify-end px-4 py-2 md:hidden">{control}</div>
  ) : (
    control
  );
}

export function HalloweenResultNotice() {
  const status = useGet(halloweenLinkState$);
  const signal = useGet(pageSignal$);
  const [operation, retry] = useLoadableSet(linkHalloweenResults$);
  if (status === "idle") {
    return null;
  }
  return (
    <div
      role={status === "error" ? "alert" : "status"}
      className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card p-4"
    >
      <div className="min-w-0">
        <p className="text-sm font-medium">
          {status === "saved" ? copy.saved : copy.saveError}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {status === "saved" ? copy.savedSub : copy.saveErrorSub}
        </p>
      </div>
      {status === "error" && (
        <Button
          variant="neutral"
          size="sm"
          pending={operation.state === "loading"}
          onClick={() => {
            detach(retry(signal), Reason.DomCallback);
          }}
        >
          {copy.retry}
        </Button>
      )}
    </div>
  );
}

export function HalloweenEntry() {
  const phase = useGet(halloweenPhase$);
  const expanded = useGet(halloweenGhostExpanded$);
  const greeting = useGet(halloweenGhostGreetingIndex$);
  const expand = useSet(expandHalloweenGhost$);
  const collapse = useSet(collapseHalloweenGhost$);
  if (phase !== "open") {
    return null;
  }
  return (
    <Link
      pathname="/halloween"
      aria-label={copy.nudgeLabel}
      onMouseEnter={() => {
        expand();
      }}
      onMouseLeave={() => {
        collapse();
      }}
      onFocus={() => {
        if (window.matchMedia("(hover: hover)").matches) {
          expand();
        }
      }}
      onBlur={() => {
        collapse();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          collapse(true);
        }
      }}
      onClick={(event) => {
        if (!shouldHandleLinkClick(event)) {
          return;
        }
        if (window.matchMedia("(hover: none)").matches && !expanded) {
          event.preventDefault();
          expand();
        }
      }}
      className="relative my-2 mr-4 z-20 flex shrink-0 self-end items-center gap-2 rounded-2xl bg-background/95 px-3 py-2 transition-colors hover:bg-state-hover sm:absolute sm:bottom-10 sm:right-8 sm:my-0 sm:mr-0"
    >
      {expanded && (
        <span className="whitespace-pre-line text-right text-xs font-medium">
          {copy.nudges[greeting]}
        </span>
      )}
      <span className="h-14 w-14">
        <HalloweenGhost />
      </span>
    </Link>
  );
}

function HalloweenBubble({ index }: { index: number }) {
  const bubble = HALLOWEEN_BUBBLES[index]!;
  const ref = useSet(bubble.ref$);
  const transition = useGet(halloweenBubbleTransition$);
  const signal = useGet(pageSignal$);
  const [, enter] = useLoadableSet(enterHalloweenFromBubble$);
  const playSound = useSet(playHalloweenClick$);
  const burst = useSet(halloweenCandyBurst$);
  const Icon = index % 3 === 0 ? Ghost : index % 3 === 1 ? Candy : Sparkles;
  return (
    <div
      ref={ref}
      className={`pointer-events-none absolute bottom-0 ${bubble.left}`}
    >
      <div>
        <Link
          pathname="/halloween"
          aria-label={copy.nudgeLabel}
          tabIndex={-1}
          className="relative pointer-events-auto flex h-12 w-12 items-center justify-center rounded-full border border-brand/20 bg-background/90 text-brand shadow-sm hover:bg-brand/10"
          onClick={(event) => {
            if (!shouldHandleLinkClick(event)) {
              return;
            }
            event.preventDefault();
            detach(playSound(signal), Reason.DomCallback);
            detach(enter(index, signal), Reason.DomCallback);
          }}
        >
          <Icon className="h-6 w-6" aria-hidden="true" />
          {transition === index && (
            <span
              ref={burst}
              className="pointer-events-none absolute inset-0"
              aria-hidden="true"
            >
              {Array.from({ length: 8 }, (_, particle) => {
                return (
                  <Candy
                    key={particle}
                    className="absolute left-4 top-4 h-4 w-4 text-brand"
                  />
                );
              })}
            </span>
          )}
        </Link>
      </div>
    </div>
  );
}

export function HalloweenBubbles() {
  const phase = useGet(halloweenPhase$);
  const first = useGet(halloweenFirstExposure$);
  if (phase !== "open" || !first) {
    return null;
  }
  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 overflow-hidden motion-reduce:hidden"
      aria-hidden="true"
    >
      <div className="absolute inset-y-0 inset-x-14">
        {HALLOWEEN_BUBBLES.map((bubble, index) => {
          return <HalloweenBubble key={bubble.left} index={index} />;
        })}
      </div>
    </div>
  );
}
