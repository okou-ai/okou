import { command, computed, state } from "ccstate";
import {
  DEFAULT_FOR_YOU_COVER_ID,
  forYouCovers,
} from "../../lib/for-you-artwork.ts";
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
