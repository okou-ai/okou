import { command, computed, state, type Computed } from "ccstate";
import {
  avatarVideoContract,
  type AvatarVideoAvatar,
  type AvatarVideoAvatarsQuery,
  type AvatarVideoVoice,
  type AvatarVideoVoicesQuery,
} from "@okouai/api-contracts/contracts/avatar-video";

import type { SupportedLocale } from "../../i18n/resources.ts";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { locale$ } from "../locale.ts";
import { onRejection } from "../utils.ts";

const AVATAR_TEMPLATE_PAGE_SIZE = 24;
const AVATAR_TEMPLATE_FILTER_OPTIONS_PAGE_SIZE = 100;
const AVATAR_TEMPLATE_RECOMMENDATION_PAGE_SIZE = 100;

interface AvatarTemplateCatalogPage {
  readonly avatars: readonly AvatarVideoAvatar[];
  readonly hasNext: boolean;
  readonly generation: number;
}

interface AvatarTemplateVoiceCatalogPage {
  readonly voices: readonly AvatarVideoVoice[];
  readonly hasNext: boolean;
  readonly generation: number;
}

interface AvatarTemplateFilters {
  readonly aspectRatio: "portrait" | "landscape";
  readonly style: AvatarVideoAvatarsQuery["style"];
  readonly gender: AvatarVideoAvatarsQuery["gender"];
  readonly age: AvatarVideoAvatarsQuery["age"];
  readonly scene: AvatarVideoAvatarsQuery["scene"];
  readonly ethnicity: AvatarVideoAvatarsQuery["ethnicity"];
}

interface AvatarTemplateVoiceFilters {
  readonly language: AvatarVideoVoicesQuery["language"];
  readonly gender: AvatarVideoVoicesQuery["gender"];
  readonly age: AvatarVideoVoicesQuery["age"];
  readonly useCase: AvatarVideoVoicesQuery["useCase"];
}

interface AvatarTemplateVoiceFilterOptions {
  readonly languages: readonly string[];
  readonly useCases: readonly string[];
}

interface OffsetCatalogPage<T> {
  readonly items: readonly T[];
  readonly hasNext: boolean;
}

type LoadOffsetCatalogPage<T> = (page: number) => Promise<OffsetCatalogPage<T>>;

function emptyAvatarTemplateFilters(): AvatarTemplateFilters {
  return {
    aspectRatio: "portrait",
    style: undefined,
    gender: undefined,
    age: undefined,
    scene: undefined,
    ethnicity: undefined,
  };
}

function emptyAvatarTemplateVoiceFilters(): AvatarTemplateVoiceFilters {
  return {
    language: undefined,
    gender: undefined,
    age: undefined,
    useCase: undefined,
  };
}

const PREFERRED_VOICE_LANGUAGE_BY_LOCALE = {
  "de-DE": "german",
  "en-US": "english",
  "es-ES": "spanish",
  "fr-FR": "french",
  "hi-IN": "hindi",
  "id-ID": "indonesian",
  "it-IT": "italian",
  "ja-JP": "japanese",
  "ko-KR": "korean",
  "pt-BR": "portuguese",
  "zh-Hans": "chinese",
  "zh-Hant": "chinese",
} as const satisfies Record<SupportedLocale, string>;

const PREFERRED_VOICE_USE_CASE_BY_AVATAR_STYLE = {
  professional: "informative_educational",
  social: "social_media",
} as const satisfies Record<
  NonNullable<AvatarVideoAvatarsQuery["style"]>,
  string
>;

const PREFERRED_VOICE_USE_CASE_BY_AVATAR_SCENE = {
  lifestyle: "conversational",
  outdoors: "social_media",
  business: "advertisement",
  studio: "entertainment_tv",
  health_fitness: "informative_educational",
  education: "informative_educational",
  news: "entertainment_tv",
} as const satisfies Record<
  NonNullable<AvatarVideoAvatarsQuery["scene"]>,
  string
>;

const PREFERRED_VOICE_ACCENTS_BY_AVATAR_ETHNICITY = {
  european: [
    "british",
    "irish",
    "scottish",
    "parisian",
    "peninsular",
    "moscow",
    "russian",
    "swedish",
  ],
  african: ["african", "nigerian", "south african", "african american"],
  south_asian: ["indian", "bihari", "marathi"],
  east_asian: [
    "chinese",
    "mandarin",
    "cantonese",
    "japanese",
    "korean",
    "taiwanese",
  ],
  middle_eastern: ["middle eastern", "arabic", "gulf", "istanbul"],
  south_american: ["latin american", "colombian", "peruvian", "brazilian"],
  north_american: ["american", "new york", "southern", "canadian"],
} as const satisfies Record<
  NonNullable<AvatarVideoAvatarsQuery["ethnicity"]>,
  readonly string[]
>;

function voiceGenderForAvatar(
  avatarGender: string | undefined,
  fallback: AvatarTemplateVoiceFilters["gender"],
): AvatarTemplateVoiceFilters["gender"] {
  const normalized = avatarGender?.toLocaleLowerCase();
  if (normalized === "female" || normalized === "male") {
    return normalized;
  }
  return fallback;
}

function voiceAgeForAvatar(
  avatarAge: string | undefined,
): AvatarTemplateVoiceFilters["age"] {
  switch (avatarAge?.toLocaleLowerCase()) {
    case "young":
    case "young_adult": {
      return "young";
    }
    case "adult":
    case "middle_aged": {
      return "middle_aged";
    }
    case "old":
    case "senior": {
      return "old";
    }
    default: {
      return undefined;
    }
  }
}

function voiceUseCaseForAvatar(
  avatarStyle: string | undefined,
  filters: AvatarTemplateFilters,
): AvatarTemplateVoiceFilters["useCase"] {
  if (filters.scene) {
    return PREFERRED_VOICE_USE_CASE_BY_AVATAR_SCENE[filters.scene];
  }
  const style = avatarStyle ?? filters.style;
  if (style === "professional" || style === "social") {
    return PREFERRED_VOICE_USE_CASE_BY_AVATAR_STYLE[style];
  }
  return undefined;
}

function recommendedVoiceFromCandidates(
  voices: readonly AvatarVideoVoice[],
  ethnicity: AvatarTemplateFilters["ethnicity"],
): AvatarVideoVoice | null {
  if (!ethnicity) {
    return voices[0] ?? null;
  }
  const preferredAccents = new Set<string>(
    PREFERRED_VOICE_ACCENTS_BY_AVATAR_ETHNICITY[ethnicity],
  );
  return (
    voices.find((voice) => {
      return (
        voice.accent !== undefined &&
        preferredAccents.has(voice.accent.toLocaleLowerCase())
      );
    }) ??
    voices[0] ??
    null
  );
}

function voiceFiltersForAvatar(
  avatar: AvatarVideoAvatar,
  filters: AvatarTemplateFilters,
  locale: SupportedLocale,
): AvatarTemplateVoiceFilters {
  return {
    language: PREFERRED_VOICE_LANGUAGE_BY_LOCALE[locale],
    gender: voiceGenderForAvatar(avatar.gender, filters.gender),
    age: voiceAgeForAvatar(avatar.age ?? filters.age),
    useCase: voiceUseCaseForAvatar(avatar.style, filters),
  };
}

function recommendedVoiceQuery(
  avatar: AvatarVideoAvatar,
  avatarFilters: AvatarTemplateFilters,
  voiceFilters: AvatarTemplateVoiceFilters,
  locale: SupportedLocale,
): AvatarVideoVoicesQuery {
  const gender =
    voiceFilters.gender ??
    voiceGenderForAvatar(avatar.gender, avatarFilters.gender);
  const age =
    voiceFilters.age ?? voiceAgeForAvatar(avatar.age ?? avatarFilters.age);
  return {
    page: 1,
    pageSize: AVATAR_TEMPLATE_RECOMMENDATION_PAGE_SIZE,
    language:
      voiceFilters.language ?? PREFERRED_VOICE_LANGUAGE_BY_LOCALE[locale],
    ...(gender ? { gender } : {}),
    ...(age ? { age } : {}),
    ...(voiceFilters.useCase ? { useCase: voiceFilters.useCase } : {}),
  };
}

function createOffsetCatalogPagingSignals<T>(
  loadPage$: Computed<LoadOffsetCatalogPage<T>>,
) {
  const internalPages$ = state<readonly OffsetCatalogPage<T>[]>([]);
  const internalRequestedPages$ = state<ReadonlySet<number>>(new Set());
  const internalLoadingMore$ = state(false);
  const internalGeneration$ = state(0);
  const firstPage$ = computed((get) => {
    return get(loadPage$)(1);
  });
  const catalog$ = computed(async (get): Promise<OffsetCatalogPage<T>> => {
    const firstPage = await get(firstPage$);
    const appendedPages = get(internalPages$);
    const lastPage = appendedPages.at(-1) ?? firstPage;
    return {
      items: [
        ...firstPage.items,
        ...appendedPages.flatMap((page) => {
          return page.items;
        }),
      ],
      hasNext: lastPage.hasNext,
    };
  });
  const reset$ = command(({ set }) => {
    set(internalPages$, []);
    set(internalRequestedPages$, new Set());
    set(internalLoadingMore$, false);
    set(internalGeneration$, (generation) => {
      return generation + 1;
    });
  });
  const loadMore$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const generation = get(internalGeneration$);
      const loaded = await get(catalog$);
      signal.throwIfAborted();
      if (get(internalGeneration$) !== generation || !loaded.hasNext) {
        return;
      }
      const nextPage = get(internalPages$).length + 2;
      if (get(internalRequestedPages$).has(nextPage)) {
        return;
      }
      set(internalRequestedPages$, (pages) => {
        return new Set([...pages, nextPage]);
      });
      set(internalLoadingMore$, true);
      const loadPage = get(loadPage$);
      const next = await onRejection(loadPage(nextPage), () => {
        if (get(internalGeneration$) !== generation) {
          return;
        }
        set(internalLoadingMore$, false);
        set(internalRequestedPages$, (pages) => {
          const retryablePages = new Set(pages);
          retryablePages.delete(nextPage);
          return retryablePages;
        });
      });
      signal.throwIfAborted();
      if (get(internalGeneration$) !== generation) {
        return;
      }
      set(internalPages$, (pages) => {
        return [...pages, next];
      });
      await get(catalog$);
      signal.throwIfAborted();
      if (get(internalGeneration$) !== generation) {
        return;
      }
      set(internalLoadingMore$, false);
    },
  );
  const loadingMore$ = computed((get) => {
    return get(internalLoadingMore$);
  });
  const generation$ = computed((get) => {
    return get(internalGeneration$);
  });
  return { catalog$, reset$, loadMore$, loadingMore$, generation$ };
}

function avatarCatalogQuery(
  filters: AvatarTemplateFilters,
  page: number,
): AvatarVideoAvatarsQuery {
  return {
    page,
    pageSize: AVATAR_TEMPLATE_PAGE_SIZE,
    aspectRatio: filters.aspectRatio,
    ...(filters.style ? { style: filters.style } : {}),
    ...(filters.gender ? { gender: filters.gender } : {}),
    ...(filters.age ? { age: filters.age } : {}),
    ...(filters.scene ? { scene: filters.scene } : {}),
    ...(filters.ethnicity ? { ethnicity: filters.ethnicity } : {}),
  };
}

function voiceCatalogQuery(
  filters: AvatarTemplateVoiceFilters,
  page: number,
): AvatarVideoVoicesQuery {
  return {
    page,
    pageSize: AVATAR_TEMPLATE_PAGE_SIZE,
    ...(filters.language ? { language: filters.language } : {}),
    ...(filters.gender ? { gender: filters.gender } : {}),
    ...(filters.age ? { age: filters.age } : {}),
    ...(filters.useCase ? { useCase: filters.useCase } : {}),
  };
}

function createAvatarTemplateCatalogSignals() {
  const internalFilters$ = state<AvatarTemplateFilters>(
    emptyAvatarTemplateFilters(),
  );
  const loadPage$ = computed(
    (get): LoadOffsetCatalogPage<AvatarVideoAvatar> => {
      const client = get(apiClient$)(avatarVideoContract, {
        apiBase: "api",
      });
      const filters = get(internalFilters$);
      return async (page) => {
        const result = await accept(
          client.avatars({
            query: avatarCatalogQuery(filters, page),
          }),
          [200],
        );
        return {
          items: result.body.avatars,
          hasNext: result.body.avatars.length === AVATAR_TEMPLATE_PAGE_SIZE,
        };
      };
    },
  );
  const paging = createOffsetCatalogPagingSignals<AvatarVideoAvatar>(loadPage$);
  const avatarTemplateFilters$ = computed((get) => {
    return get(internalFilters$);
  });
  const setAvatarTemplateFilters$ = command(
    ({ set }, filters: AvatarTemplateFilters) => {
      set(internalFilters$, filters);
      set(paging.reset$);
    },
  );
  const avatarTemplateCatalogPage$ = computed(
    async (get): Promise<AvatarTemplateCatalogPage> => {
      const catalog = await get(paging.catalog$);
      return {
        avatars: catalog.items,
        hasNext: catalog.hasNext,
        generation: get(paging.generation$),
      };
    },
  );

  return {
    avatarTemplateFilters$,
    setAvatarTemplateFilters$,
    avatarTemplateCatalogPage$,
    avatarTemplateCatalogGeneration$: paging.generation$,
    loadMoreAvatarTemplates$: paging.loadMore$,
    avatarTemplatesLoadingMore$: paging.loadingMore$,
  };
}

function createAvatarTemplateVoiceCatalogSignals() {
  const internalVoiceFilters$ = state<AvatarTemplateVoiceFilters>(
    emptyAvatarTemplateVoiceFilters(),
  );
  const loadPage$ = computed((get): LoadOffsetCatalogPage<AvatarVideoVoice> => {
    const client = get(apiClient$)(avatarVideoContract, {
      apiBase: "api",
    });
    const filters = get(internalVoiceFilters$);
    return async (page) => {
      const result = await accept(
        client.voices({
          query: voiceCatalogQuery(filters, page),
        }),
        [200],
      );
      return {
        items: result.body.voices,
        hasNext: result.body.hasMore,
      };
    };
  });
  const paging = createOffsetCatalogPagingSignals<AvatarVideoVoice>(loadPage$);
  const avatarTemplateVoiceFilters$ = computed((get) => {
    return get(internalVoiceFilters$);
  });
  const setAvatarTemplateVoiceFilters$ = command(
    ({ set }, filters: AvatarTemplateVoiceFilters) => {
      set(internalVoiceFilters$, filters);
      set(paging.reset$);
    },
  );
  const avatarTemplateVoiceFilterOptions$ = computed(
    async (get): Promise<AvatarTemplateVoiceFilterOptions> => {
      const client = get(apiClient$)(avatarVideoContract, {
        apiBase: "api",
      });
      const result = await accept(
        client.voices({
          query: {
            page: 1,
            pageSize: AVATAR_TEMPLATE_FILTER_OPTIONS_PAGE_SIZE,
          },
        }),
        [200],
      );
      return {
        languages: result.body.filterOptions?.languages ?? [],
        useCases: result.body.filterOptions?.useCases ?? [],
      };
    },
  );
  const avatarTemplateVoiceCatalogPage$ = computed(
    async (get): Promise<AvatarTemplateVoiceCatalogPage> => {
      const catalog = await get(paging.catalog$);
      return {
        voices: catalog.items,
        hasNext: catalog.hasNext,
        generation: get(paging.generation$),
      };
    },
  );

  return {
    avatarTemplateVoiceFilters$,
    setAvatarTemplateVoiceFilters$,
    avatarTemplateVoiceFilterOptions$,
    avatarTemplateVoiceCatalogPage$,
    avatarTemplateVoiceCatalogGeneration$: paging.generation$,
    loadMoreAvatarTemplateVoices$: paging.loadMore$,
    avatarTemplateVoicesLoadingMore$: paging.loadingMore$,
    resetAvatarTemplateVoiceCatalog$: paging.reset$,
  };
}

export function createAvatarTemplatePickerSignals() {
  const avatarCatalog = createAvatarTemplateCatalogSignals();
  const voiceCatalog = createAvatarTemplateVoiceCatalogSignals();
  const internalSelectedAvatar$ = state<AvatarVideoAvatar | null>(null);
  const selectedAvatarTemplateForVoice$ = computed((get) => {
    return get(internalSelectedAvatar$);
  });
  const avatarTemplateRecommendedVoice$ = computed(
    async (get): Promise<AvatarVideoVoice | null> => {
      const avatar = get(internalSelectedAvatar$);
      if (!avatar) {
        return null;
      }
      const avatarFilters = get(avatarCatalog.avatarTemplateFilters$);
      const voiceFilters = get(voiceCatalog.avatarTemplateVoiceFilters$);
      const locale = get(locale$);
      const client = get(apiClient$)(avatarVideoContract, {
        apiBase: "api",
      });
      const result = await accept(
        client.voices({
          query: recommendedVoiceQuery(
            avatar,
            avatarFilters,
            voiceFilters,
            locale,
          ),
        }),
        [200],
      );
      return recommendedVoiceFromCandidates(
        result.body.voices,
        avatarFilters.ethnicity,
      );
    },
  );
  const selectAvatarTemplateForVoice$ = command(
    ({ get, set }, avatar: AvatarVideoAvatar) => {
      const avatarFilters = get(avatarCatalog.avatarTemplateFilters$);
      const locale = get(locale$);
      set(
        voiceCatalog.setAvatarTemplateVoiceFilters$,
        voiceFiltersForAvatar(avatar, avatarFilters, locale),
      );
      set(internalSelectedAvatar$, avatar);
    },
  );
  const clearAvatarTemplateVoiceSelection$ = command(({ set }) => {
    set(voiceCatalog.resetAvatarTemplateVoiceCatalog$);
    set(internalSelectedAvatar$, null);
  });

  return {
    ...avatarCatalog,
    ...voiceCatalog,
    selectedAvatarTemplateForVoice$,
    avatarTemplateRecommendedVoice$,
    selectAvatarTemplateForVoice$,
    clearAvatarTemplateVoiceSelection$,
  };
}
