/**
 * Default skills always included in agent composes.
 * Source: https://github.com/vm0-ai/vm0-skills
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

/** Mounted only for runs whose organization or user has Intro Video enabled. */
export const INTRO_VIDEO_SKILL_NAME = "intro-video";
