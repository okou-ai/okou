/**
 * Default skills always included in agent composes.
 * Source: https://github.com/okou-ai/okou-skills
 *
 * These live server-side only so the frontend never sends stale seed skills.
 */
export const BUILT_IN_SKILLS: readonly string[] = [
  "computer-use",
  "gen",
  "workflow-setup",
] as const;
