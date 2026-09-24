import { computed } from "ccstate";

// These endpoints reject new built-in media requests after authentication and
// before input parsing, storage, billing, or provider submission. This is the
// current admission contract; accepted jobs finish through separate endpoints.
export const retiredBuiltInGeneration$ = computed(() => {
  return {
    status: 410 as const,
    body: {
      error: {
        code: "GENERATION_RETIRED",
        message:
          "Built-in video, voice, and avatar generation is no longer available.",
      },
    },
  };
});
