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

/**
 * Mounted only for runs whose organization or user has Custom Templates
 * enabled.
 *
 * One skill for every source, not one per file type: it reads the pages,
 * decides whether the upload is a deck, a Word document or a PDF document, and
 * follows the branch that matches. Naming the branches here would put a second
 * copy of that decision in a place that has never seen the file.
 */
export const REVERSE_TEMPLATE_SKILL_NAME = "reverse-template";
