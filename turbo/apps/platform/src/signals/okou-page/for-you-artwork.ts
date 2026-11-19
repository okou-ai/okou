import { computed } from "ccstate";
import {
  forYouBackgrounds,
  forYouIllustrations,
} from "../../lib/for-you-artwork.ts";
import { forYouDeck$ } from "./for-you.ts";

// A store lives for the page load. Card navigation, feedback and route changes
// do not reselect the background or shuffle the illustration sequence.
const artwork$ = computed(() => {
  const illustrations = [...forYouIllustrations];
  for (let index = illustrations.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [illustrations[index], illustrations[other]] = [
      illustrations[other],
      illustrations[index],
    ];
  }
  return {
    background:
      forYouBackgrounds[Math.floor(Math.random() * forYouBackgrounds.length)],
    illustrations,
  };
});

export const forYouBackground$ = computed((get) => {
  return get(artwork$).background;
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
