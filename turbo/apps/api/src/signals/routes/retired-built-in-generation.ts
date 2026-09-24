import { computed } from "ccstate";

// Loaded App bundles and installed CLIs can still call these authenticated
// endpoints. Retire admission before storage, billing, or provider submission;
// accepted jobs keep their separate status and webhook completion routes.
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
