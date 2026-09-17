import { command, computed, state } from "ccstate";
import {
  introVideoPresenterContract,
  type IntroVideoVoicesQuery,
} from "@okouai/api-contracts/contracts/intro-video-presenter";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { createPagedCatalogSignals } from "./intro-video-catalog-picker.ts";

const INTRO_VIDEO_VOICE_PAGE_SIZE = 24;

interface IntroVideoVoiceFilters {
  readonly language: IntroVideoVoicesQuery["language"];
  readonly gender: IntroVideoVoicesQuery["gender"];
}

function createIntroVideoVoicePickerSignals() {
  const internalFilters$ = state<IntroVideoVoiceFilters>({
    language: undefined,
    gender: undefined,
  });
  const loadPage$ = computed((get) => {
    const client = get(apiClient$)(introVideoPresenterContract, {
      apiBase: "api",
    });
    const filters = get(internalFilters$);
    return async (token: string | undefined) => {
      const result = await accept(
        client.voices({
          query: {
            pageSize: INTRO_VIDEO_VOICE_PAGE_SIZE,
            ...(token ? { token } : {}),
            ...(filters.language ? { language: filters.language } : {}),
            ...(filters.gender ? { gender: filters.gender } : {}),
          },
        }),
        [200],
      );
      return {
        items: result.body.voices,
        hasNext: result.body.hasMore && result.body.nextToken !== null,
        nextToken: result.body.nextToken,
      };
    };
  });
  // HeyGen lists some voices under two ids that play the same sample.
  const catalog = createPagedCatalogSignals(loadPage$, (voice) => {
    return voice.sampleUrl ?? voice.id;
  });
  return {
    ...catalog,
    filters$: computed((get) => {
      return get(internalFilters$);
    }),
    setFilters$: command(({ set }, filters: IntroVideoVoiceFilters) => {
      set(internalFilters$, filters);
      set(catalog.reload$);
    }),
  };
}

export const introVideoVoicePickerSignals =
  createIntroVideoVoicePickerSignals();
