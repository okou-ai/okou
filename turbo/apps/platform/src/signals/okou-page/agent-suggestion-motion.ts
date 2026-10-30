import { command, state } from "ccstate";
import type { Suggestion } from "@okouai/api-contracts/contracts/suggestions";
import { onRef } from "../utils.ts";

type DeckDirection = "next" | "previous" | "consume";

interface DepartingCard {
  readonly item: Suggestion;
  readonly direction: DeckDirection;
  readonly height: number;
}

function animateDeckArrival(
  deck: HTMLElement,
  element: HTMLElement,
  departing: DepartingCard,
): Animation[] {
  const incoming = element.querySelector("article");
  const outgoing = deck.querySelector("[data-departing-card]");
  const options = {
    duration: 280,
    easing: "cubic-bezier(0.32, 0.72, 0, 1)",
  };
  const animations: Animation[] = [];
  if (outgoing) {
    const destination =
      departing.direction === "previous"
        ? "translateY(10px) scale(0.98)"
        : departing.direction === "consume"
          ? "translate(104%, -16px) scale(0.96)"
          : "translateX(-104%) scale(0.98)";
    animations.push(
      outgoing.animate(
        [
          { transform: "none", opacity: 1 },
          { opacity: 1, offset: 0.95 },
          { transform: destination, opacity: 0 },
        ],
        { ...options, fill: "forwards" },
      ),
    );
  }
  if (incoming) {
    animations.push(
      incoming.animate(
        [
          {
            transform:
              departing.direction === "previous"
                ? "translateX(-104%) scale(0.98)"
                : "translateY(10px) scale(0.98)",
          },
          { transform: "none" },
        ],
        options,
      ),
    );
  }
  const height = element.offsetHeight;
  if (height !== departing.height) {
    animations.push(
      deck.animate(
        [{ height: `${departing.height}px` }, { height: `${height}px` }],
        {
          duration: 180,
          delay: incoming ? 160 : 200,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          fill: "backwards",
        },
      ),
    );
  }
  return animations;
}

/** Presentation belongs to this visit; persistence never waits for motion. */
export function createSuggestionDeckMotion() {
  const element$ = state<HTMLElement | null>(null);
  const departing$ = state<DepartingCard | null>(null);
  const clear$ = command(({ set }) => {
    set(departing$, null);
  });
  return {
    departing$,
    clear$,
    begin$: command(
      ({ get, set }, item: Suggestion, direction: DeckDirection) => {
        const element = get(element$);
        if (
          !element?.animate ||
          window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ) {
          set(clear$);
          return;
        }
        set(departing$, {
          item,
          direction,
          height: element.getBoundingClientRect().height,
        });
      },
    ),
    deckRef$: onRef(
      command(({ get, set }, element: HTMLElement, signal: AbortSignal) => {
        set(element$, element);
        signal.addEventListener(
          "abort",
          () => {
            if (get(element$) === element) {
              set(element$, null);
              set(clear$);
            }
          },
          { once: true },
        );
      }),
    ),
    arrivalRef$: onRef(
      command(
        async ({ get, set }, element: HTMLElement, signal: AbortSignal) => {
          const departing = get(departing$);
          const deck = get(element$);
          if (!departing || !deck) {
            return;
          }
          const reducedMotion = window.matchMedia(
            "(prefers-reduced-motion: reduce)",
          );
          if (reducedMotion.matches) {
            set(clear$);
            return;
          }
          const animations = animateDeckArrival(deck, element, departing);
          const cancel = () => {
            for (const animation of animations) {
              animation.cancel();
            }
          };
          const finish = () => {
            if (reducedMotion.matches) {
              for (const animation of animations) {
                animation.finish();
              }
            }
          };
          signal.addEventListener("abort", cancel, { once: true });
          reducedMotion.addEventListener("change", finish, { signal });
          await Promise.all(
            animations.map((animation) => {
              return animation.finished;
            }),
          ).finally(() => {
            signal.removeEventListener("abort", cancel);
            reducedMotion.removeEventListener("change", finish);
            cancel();
            // A cancelled arrival must not remove a newer departure.
            if (get(departing$) === departing) {
              set(clear$);
            }
          });
        },
      ),
    ),
  };
}
