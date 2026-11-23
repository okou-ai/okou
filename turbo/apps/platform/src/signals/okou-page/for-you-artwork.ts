import { command, computed, state } from "ccstate";
import {
  DEFAULT_FOR_YOU_COVER_ID,
  forYouCovers,
  forYouIllustrations,
} from "../../lib/for-you-artwork.ts";
import { forYouDeck$ } from "./for-you.ts";
import {
  updateUserPreference$,
  userPreferences$,
} from "./settings/user-preferences.ts";

// The member's workspace preference follows them across browsers and devices.
// An unset or retired cover uses the gallery's default.
export const forYouCover$ = computed(async (get) => {
  const { forYouCoverId } = await get(userPreferences$);
  return (
    forYouCovers.find((cover) => {
      return cover.id === forYouCoverId;
    }) ?? forYouCovers[0]
  );
});

export const selectForYouCover$ = command(
  async ({ set }, id: string, signal: AbortSignal) => {
    await set(
      updateUserPreference$,
      { forYouCoverId: id === DEFAULT_FOR_YOU_COVER_ID ? null : id },
      signal,
    );
  },
);

// The header's colors follow the cover that is on screen. The banner keeps
// showing the previous artwork until the new one loads, so the header waits
// for that load instead of switching to the new cover's colors early.
const paintedCoverId$ = state<string | null>(null);

export const forYouPaintedCover$ = computed(async (get) => {
  const painted = get(paintedCoverId$);
  return (
    forYouCovers.find((cover) => {
      return cover.id === painted;
    }) ?? (await get(forYouCover$))
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
