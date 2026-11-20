import { command, computed } from "ccstate";
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
