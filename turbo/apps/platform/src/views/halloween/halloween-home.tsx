import { Button, cn, DialogTrigger } from "@okouai/ui";
import type { KeyboardEvent } from "react";
import { Candy } from "lucide-react";
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
  halloweenHomeAnimationVisible$,
  halloweenGhostExpanded$,
  halloweenGhostGreetingIndex$,
  expandHalloweenGhost$,
  collapseHalloweenGhost$,
  halloweenBubbleTransition$,
  enterHalloweenFromBubble$,
  setHalloweenModalAnchor$,
} from "../../signals/halloween/halloween.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { HalloweenGhost } from "./halloween-art.tsx";
import { halloweenTypography as typography } from "./halloween-typography.ts";

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
        <p className={typography.labelClassName}>
          {status === "saved" ? copy.saved : copy.saveError}
        </p>
        <p
          className={cn("mt-1 text-muted-foreground", typography.bodyClassName)}
        >
          {status === "saved" ? copy.savedSub : copy.saveErrorSub}
        </p>
      </div>
      {status === "error" && (
        <Button
          variant="neutral"
          size="sm"
          className={typography.labelClassName}
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
  const setAnchor = useSet(setHalloweenModalAnchor$);
  if (phase !== "open") {
    return null;
  }
  const props = {
    "aria-label": copy.nudgeLabel,
    onMouseEnter: () => {
      if (window.matchMedia("(hover: hover)").matches) {
        expand();
      }
    },
    onMouseLeave: () => {
      collapse();
    },
    onFocus: () => {
      if (window.matchMedia("(hover: hover)").matches) {
        expand();
      }
    },
    onBlur: () => {
      collapse();
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        collapse(true);
      }
    },
    className: cn(
      "pointer-events-auto absolute bottom-[76px] right-0 z-20 block h-[136px] max-w-[calc(100%-16px)] overflow-hidden rounded-none bg-transparent p-0 outline-none transition-[width] duration-500 hover:bg-transparent motion-reduce:transition-none",
      expanded ? "w-[330px]" : "w-12",
    ),
  };
  const content = (
    <>
      <span
        className={cn(
          "pointer-events-none absolute right-[90px] top-[70px] w-[220px] max-w-[calc(100vw-130px)] whitespace-pre-line text-right text-[#716456] transition-all duration-300 motion-reduce:transition-none",
          typography.labelClassName,
          expanded ? "translate-x-0 opacity-100" : "translate-x-3 opacity-0",
        )}
      >
        {copy.nudges[greeting]}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute right-3 top-0 text-[#e9bb65] transition-opacity motion-reduce:transition-none",
          typography.titleClassName,
          expanded ? "opacity-100" : "opacity-0",
        )}
      >
        {copy.boo}
      </span>
      <span
        className={cn(
          "absolute top-12 h-[72px] w-[68px] origin-right drop-shadow-[0_5px_9px_#62401725] transition-all duration-500 motion-reduce:transition-none",
          expanded ? "right-3 scale-100" : "-right-[25px] scale-80",
        )}
      >
        <HalloweenGhost />
      </span>
    </>
  );
  return (
    <DialogTrigger
      {...props}
      onClick={(event) => {
        setAnchor(event.currentTarget.getBoundingClientRect());
      }}
    >
      {content}
    </DialogTrigger>
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
  const className = cn(
    "relative pointer-events-auto flex items-center justify-center rounded-full bg-transparent outline-none transition-transform hover:scale-105 hover:shadow-[inset_0_0_0_2px_#b697ea]",
    bubble.size,
  );
  const play = () => {
    detach(playSound(signal), Reason.DomCallback);
    detach(enter(index, signal), Reason.DomCallback);
  };
  const content = (
    <>
      <img
        src={bubble.image}
        alt=""
        draggable={false}
        className="h-full w-full object-contain"
      />
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
                className="absolute left-4 top-4 h-4 w-4 text-brand-text"
              />
            );
          })}
        </span>
      )}
    </>
  );
  return (
    <div
      ref={ref}
      className={`pointer-events-none absolute bottom-0 ${bubble.left}`}
    >
      <div>
        <button
          type="button"
          aria-label={copy.nudgeLabel}
          tabIndex={-1}
          className={className}
          onClick={play}
        >
          {content}
        </button>
      </div>
    </div>
  );
}

export function HalloweenBubbles() {
  const phase = useGet(halloweenPhase$);
  const animationVisible = useGet(halloweenHomeAnimationVisible$);
  if (phase !== "open" || !animationVisible) {
    return null;
  }
  return (
    <div
      data-testid="halloween-bubbles"
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
