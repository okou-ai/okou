import { command, computed, state } from "ccstate";
import {
  DEFAULT_FOR_YOU_COVER_ID,
  forYouCovers,
  forYouIllustrations,
} from "../../lib/for-you-artwork.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import { forYouDeck$ } from "./for-you.ts";

const coverStorage = localStorageSignals("for-you:cover");

// The member's pick stays in this browser. Without one, or with an id that is
// no longer in the gallery, the page shows the default cover.
export const forYouCover$ = computed((get) => {
  const stored = get(coverStorage.get$);
  return (
    forYouCovers.find((cover) => {
      return cover.id === stored;
    }) ?? forYouCovers[0]
  );
});

export const selectForYouCover$ = command(({ set }, id: string) => {
  if (id === DEFAULT_FOR_YOU_COVER_ID) {
    set(coverStorage.clear$);
    return;
  }
  set(coverStorage.set$, id);
});

// The header's colors follow the cover that is on screen. The banner keeps
// showing the previous artwork until the new one loads, so the header waits
// for that load instead of switching to the new cover's colors early.
const paintedCoverId$ = state<string | null>(null);

export const forYouPaintedCover$ = computed((get) => {
  const painted = get(paintedCoverId$);
  return (
    forYouCovers.find((cover) => {
      return cover.id === painted;
    }) ?? get(forYouCover$)
  );
});

export const markForYouCoverPainted$ = command(({ set }, id: string) => {
  set(paintedCoverId$, id);
});

// A store lives for the page load. Card navigation, feedback and route changes
// do not reshuffle the illustration sequence.
const artwork$ = computed(() => {
  const illustrations = [...forYouIllustrations];
  for (let index = illustrations.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [illustrations[index], illustrations[other]] = [
      illustrations[other],
      illustrations[index],
    ];
  }
  return { illustrations };
});

export const forYouIllustrations$ = computed(async (get) => {
  const { illustrations } = get(artwork$);
  const { illustrationIds } = await get(forYouDeck$);
  // Include handled cards so feedback and Undo cannot move another card's art.
  return Object.fromEntries(
    illustrationIds.map((id, index) => {
      return [id, illustrations[index % illustrations.length]];
    }),
  );
});
