/**
 * Default skills always included in agent composes.
 * Source: https://github.com/okou-ai/okou-skills
 *
 * These live server-side only so the frontend never sends stale seed skills.
 */
export const SEED_SKILLS: readonly string[] = [
  "computer-use",
  "gen",
  "office-files",
  "ppt-avatar-video",
  "workflow-setup",
] as const;
