import { command } from "ccstate";
import { onRef, settle, detach, Reason } from "../utils.ts";
import { halloweenSound$ } from "./halloween.ts";
import { platformStaticAssetUrl } from "../../lib/static-assets.ts";

export const focusHalloweenHeading$ = onRef<HTMLElement>(
  command((_store, element: HTMLElement) => {
    element.focus({ preventScroll: true });
  }),
);

function ownAnimations(animations: readonly Animation[], signal: AbortSignal) {
  for (const animation of animations) {
    detach(animation.finished, Reason.DomCallback);
  }
  const cancel = () => {
    for (const animation of animations) {
      animation.cancel();
    }
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) {
    cancel();
  }
}

export const halloweenStageMotion$ = onRef(
  command((_store, element: HTMLElement, signal: AbortSignal) => {
    if (
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      !element.animate
    ) {
      return;
    }
    const beams = Array.from(
      element.querySelectorAll<HTMLElement>("[data-beam]"),
    ).map((beam, index) => {
      return beam.animate(
        [{ transform: "rotate(-18deg)" }, { transform: "rotate(18deg)" }],
        {
          duration: index === 2 ? 12_500 : 9000,
          delay: -index * 5000,
          direction: index === 1 ? "alternate-reverse" : "alternate",
          iterations: Infinity,
          easing: "ease-in-out",
        },
      );
    });
    const silhouettes = Array.from(
      element.querySelectorAll<HTMLElement>("[data-haunt]"),
    ).map((art, index) => {
      return art.animate(
        [
          { transform: "translate(-8px, 12px) rotate(-9deg)" },
          { transform: "translate(14px, -20px) rotate(10deg)" },
        ],
        {
          duration: 9000 + (index % 3) * 1500,
          delay: -index * 1800,
          direction: "alternate",
          iterations: Infinity,
          easing: "ease-in-out",
        },
      );
    });
    ownAnimations([...beams, ...silhouettes], signal);
  }),
);

export const halloweenConfetti$ = onRef(
  command((_store, element: HTMLElement, signal: AbortSignal) => {
    if (
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      !element.animate
    ) {
      return;
    }
    const animations = Array.from(element.children).map((piece, index) => {
      return piece.animate(
        [
          { transform: "translateY(-20px) rotate(0deg)", opacity: 1 },
          {
            transform: `translate(${((index % 7) - 3) * 35}px, ${element.clientHeight + 40}px) rotate(${index * 73}deg)`,
            opacity: 0,
          },
        ],
        {
          duration: 2200 + (index % 4) * 350,
          delay: (index % 5) * 90,
          easing: "ease-in",
          fill: "both",
        },
      );
    });
    ownAnimations(animations, signal);
  }),
);

export const halloweenCandyBurst$ = onRef(
  command((_store, element: HTMLElement, signal: AbortSignal) => {
    const animations = Array.from(element.children).map((child, index) => {
      const angle = (index * Math.PI) / 4;
      return child.animate(
        [
          { transform: "translate(0, 0) scale(.4)", opacity: 1 },
          {
            transform: `translate(${Math.cos(angle) * 65}px, ${Math.sin(angle) * 65}px) rotate(${index * 65}deg) scale(1)`,
            opacity: 0,
          },
        ],
        {
          duration: 700,
          easing: "cubic-bezier(.2,.65,.4,1)",
          fill: "forwards",
        },
      );
    });
    ownAnimations(animations, signal);
  }),
);

const bubbleArtwork = Object.freeze([
  "B01-round-bd983d0e16.png",
  "B02-round-ae72e312bc.png",
  "B03-round-eeec0f4878.png",
  "B04-round-55d5d4f89f.png",
  "B05-round-bb2e5d493c.png",
  "B06-round-c642d056d2.png",
  "B07-round-e0bba08bba.png",
  "B10-round-3980ce12a3.png",
  "B01-round-bd983d0e16.png",
  "B06-round-c642d056d2.png",
]);
const bubbleSizes = Object.freeze([
  "h-[62px] w-[62px]",
  "h-[54px] w-[54px]",
  "h-12 w-12",
  "h-14 w-14",
  "h-[50px] w-[50px]",
  "h-[58px] w-[58px]",
  "h-[46px] w-[46px]",
  "h-[52px] w-[52px]",
  "h-[60px] w-[60px]",
  "h-12 w-12",
]);

// Each bubble gets a single ascent and a smooth, bounded horizontal swing.
// The element's left/right inset leaves room for its complete sway on phones.
export const HALLOWEEN_BUBBLES = Object.freeze(
  [
    { left: "left-[10%]", rise: 6788, sway: 36, drift: 5000 },
    { left: "left-[75%]", rise: 8242, sway: 32, drift: 5350 },
    { left: "left-[20%]", rise: 6303, sway: 48, drift: 5700 },
    { left: "left-[65%]", rise: 8727, sway: 44, drift: 6050 },
    { left: "left-[34%]", rise: 7758, sway: 34, drift: 6400 },
    { left: "left-[80%]", rise: 9212, sway: 36, drift: 6750 },
    { left: "left-[49%]", rise: 7273, sway: 42, drift: 7100 },
    { left: "left-[23%]", rise: 8242, sway: 30, drift: 7450 },
    { left: "left-[60%]", rise: 8727, sway: 36, drift: 7800 },
    { left: "left-[70%]", rise: 11_636, sway: 40, drift: 8150 },
  ].map((bubble, index) => {
    return {
      ...bubble,
      size: bubbleSizes[index],
      image: platformStaticAssetUrl(
        `views/halloween/assets/${bubbleArtwork[index]}`,
      ),
      ref$: onRef(
        command((_store, element: HTMLElement, signal: AbortSignal) => {
          if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            return;
          }
          const height =
            element.parentElement?.clientHeight ?? window.innerHeight;
          const rise = element.animate(
            [
              { transform: "translateY(72px)", opacity: 0 },
              { transform: "translateY(0)", opacity: 1, offset: 0.08 },
              { transform: `translateY(-${height + 72}px)`, opacity: 1 },
            ],
            {
              duration: bubble.rise,
              delay: index * 500,
              fill: "both",
              easing: "linear",
            },
          );
          const content = element.firstElementChild;
          const sway = content?.animate(
            [
              { transform: `translateX(-${bubble.sway}px)` },
              { transform: `translateX(${bubble.sway}px)` },
            ],
            {
              duration: bubble.drift,
              delay: index * 500,
              direction: "alternate",
              iterations: 3,
              easing: "ease-in-out",
            },
          );
          ownAnimations(sway ? [rise, sway] : [rise], signal);
        }),
      ),
    };
  }),
);

export const playHalloweenClick$ = command(
  async ({ get }, signal: AbortSignal) => {
    if (!get(halloweenSound$) || !globalThis.AudioContext) {
      return;
    }
    signal.throwIfAborted();
    const audio = new AudioContext();
    const close = () => {
      signal.removeEventListener("abort", close);
      if (audio.state !== "closed") {
        detach(audio.close(), Reason.DomCallback);
      }
    };
    signal.addEventListener("abort", close, { once: true });
    const resumed = await settle(audio.resume(), signal);
    if (!resumed.ok || audio.state !== "running") {
      close();
      return;
    }
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(660, audio.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(
      990,
      audio.currentTime + 0.1,
    );
    gain.gain.setValueAtTime(0.025, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.18);
    oscillator.addEventListener("ended", close, { once: true });
    oscillator.start();
    oscillator.stop(audio.currentTime + 0.2);
  },
);
