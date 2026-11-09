import { command, computed, state } from "ccstate";

export interface CarouselSwipePoint {
  readonly identifier: number;
  readonly x: number;
  readonly y: number;
}

export function createCarouselSelection() {
  const index$ = state(0);
  const swipeStart$ = state<CarouselSwipePoint | null>(null);
  const select$ = command(({ set }, index: number) => {
    set(index$, index);
    set(swipeStart$, null);
  });
  return {
    index$: computed((get) => {
      return get(index$);
    }),
    select$,
    beginSwipe$: command(({ set }, point: CarouselSwipePoint | null) => {
      set(swipeStart$, point);
    }),
    endSwipe$: command(
      ({ get, set }, point: CarouselSwipePoint | null, itemCount: number) => {
        const start = get(swipeStart$);
        set(swipeStart$, null);
        if (
          itemCount < 2 ||
          !start ||
          !point ||
          start.identifier !== point.identifier
        ) {
          return null;
        }
        const deltaX = point.x - start.x;
        const deltaY = point.y - start.y;
        if (
          Math.abs(deltaX) < 48 ||
          Math.abs(deltaX) <= Math.abs(deltaY) * 1.5
        ) {
          return null;
        }
        const next =
          (get(index$) + (deltaX < 0 ? 1 : itemCount - 1)) % itemCount;
        set(select$, next);
        return next;
      },
    ),
  };
}
