/**
 * Default skills always included in agent composes.
 * Source: https://github.com/okou-ai/vm0-skills
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

/**
 * The guide a custom template import sends the run to, mounted only for runs
 * whose organization or user has Custom Templates enabled.
 *
 * One skill for every source rather than one per kind: it reads the file,
 * decides whether it is a deck, a Word document, a PDF or an illustration, and
 * follows the branch that matches. Naming the branches here would put a second
 * copy of that decision somewhere that has never seen the file.
 *
 * Shared with the import message so the guide a run is told to follow and the
 * guide it is given cannot drift apart. They already did once, when this
 * dispatcher was still called `reverse-template`.
 */
export const EXTRACT_TEMPLATE_SKILL_NAME = "extract-template";
