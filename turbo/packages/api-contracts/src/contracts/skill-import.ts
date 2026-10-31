import {
  array,
  iso,
  literal,
  number,
  object,
  string,
  url,
  uuid,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  RESERVED_SKILL_FILE,
  workflowNameSchema,
  workflowSummarySchema,
} from "./workflows";

import { workflowImportSourceSchema } from "./workflow-import-source";

export { SKILL_IMPORT_SESSION_TTL_SECONDS } from "./skill-import-session";

const c = initContract();

/**
 * Skill import (text-only v1).
 *
 * The browser cannot read a local skill directory, so the onboarding step hands
 * the user a prompt for their own Codex or Claude Code session. That agent
 * collects the local skills and writes them back through these two routes:
 * the Platform mints a short-lived session, and the user's agent uploads one
 * skill per request with the session token.
 *
 * The routes serve the onboarding skills step and the workflows page's import
 * dialog.
 *
 * Binary content is deliberately out of scope for this version. A later version
 * can add an explicit encoding to the upload body without touching the shared
 * workflow contract.
 */

/**
 * Upload limits for one session. They are returned with the session so the
 * generated prompt states the same numbers the server enforces.
 */
export const SKILL_IMPORT_LIMITS = {
  /** Skills one session may create, attributed by its upload credential. */
  maxSkillsPerSession: 50,
  maxInstructionBytes: 256 * 1024,
  maxFilesPerSkill: 50,
  maxFileBytes: 64 * 1024,
  maxTotalFileBytes: 1024 * 1024,
  maxRequestBytes: 2 * 1024 * 1024,
} as const;

export const skillImportLimitsSchema = object({
  maxSkillsPerSession: number().int().positive(),
  maxInstructionBytes: number().int().positive(),
  maxFilesPerSkill: number().int().positive(),
  maxFileBytes: number().int().positive(),
  maxTotalFileBytes: number().int().positive(),
  maxRequestBytes: number().int().positive(),
});
export type SkillImportLimits = zInfer<typeof skillImportLimitsSchema>;

/**
 * The tool the prompt is written for. The session records it so every skill
 * the session imports is tagged with where it came from.
 */
export const skillImportSessionRequestSchema = object({
  provider: workflowImportSourceSchema,
});
export type SkillImportSessionRequest = zInfer<
  typeof skillImportSessionRequestSchema
>;

export const skillImportSessionResponseSchema = object({
  sessionId: uuid(),
  /** Absolute URL of the upload route the prompt posts each skill to. */
  uploadUrl: url(),
  token: string().min(1),
  expiresAt: iso.datetime(),
  limits: skillImportLimitsSchema,
});
export type SkillImportSessionResponse = zInfer<
  typeof skillImportSessionResponseSchema
>;

/**
 * Raw skill name as found in the local SKILL.md frontmatter or directory name.
 * The server normalizes it to `workflowNameSchema`; a value that cannot be
 * normalized into a slug is rejected as invalid.
 */
export const skillImportNameSchema = string().min(1).max(128);

/**
 * One supplementary file. `SKILL.md` is reserved: it is synthesized server-side
 * from (name, description, instruction) and is never uploaded.
 */
export const skillImportFileSchema = object({
  path: string()
    .min(1)
    .max(256)
    .refine(
      (path) => {
        return !path.startsWith("/");
      },
      { message: "Path must be relative" },
    )
    .refine(
      (path) => {
        return !path.includes("..");
      },
      { message: "Path must not contain .." },
    )
    .refine(
      (path) => {
        return path !== RESERVED_SKILL_FILE;
      },
      { message: `${RESERVED_SKILL_FILE} is reserved and is generated` },
    ),
  content: string(),
});

/**
 * One skill per request. Sizes are validated by the route rather than by this
 * schema so an oversize payload answers `413` instead of `400`.
 */
export const skillImportRequestSchema = object({
  name: skillImportNameSchema,
  displayName: string().max(256).optional(),
  description: string().max(1024).optional(),
  instruction: string().min(1),
  files: array(skillImportFileSchema).optional(),
}).strict();
export type SkillImportRequest = zInfer<typeof skillImportRequestSchema>;

export const skillImportCreatedResponseSchema = object({
  outcome: literal("created"),
  workflowId: uuid(),
  /** Normalized slug the skill was stored under. */
  name: workflowNameSchema,
});

export const skillImportSkippedResponseSchema = object({
  outcome: literal("skipped"),
  reason: literal("name_exists"),
  workflowId: uuid(),
  name: workflowNameSchema,
});

/** Payload exceeds a documented limit. */
export const SKILL_IMPORT_TOO_LARGE_CODE = "SKILL_TOO_LARGE";
/** Text-only v1 rejected content that is not valid UTF-8 text. */
export const SKILL_IMPORT_BINARY_CODE = "BINARY_FILE_UNSUPPORTED";
/** The slug is taken by something the caller cannot own. */
export const SKILL_IMPORT_NAME_TAKEN_CODE = "SKILL_NAME_TAKEN";
/** The session token is missing, invalid, expired, or no longer resolvable. */
export const SKILL_IMPORT_SESSION_INVALID_CODE = "SKILL_IMPORT_SESSION_INVALID";
/** The session already created `maxSkillsPerSession` skills. */
export const SKILL_IMPORT_SESSION_LIMIT_CODE = "SKILL_IMPORT_LIMIT_REACHED";

export const skillImportSessionsContract = c.router({
  create: {
    method: "POST",
    path: "/api/skill-import/sessions",
    headers: authHeadersSchema,
    body: skillImportSessionRequestSchema,
    responses: {
      200: skillImportSessionResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Open a skill import session for the org's default agent",
  },
  listSkills: {
    method: "GET",
    path: "/api/skill-import/sessions/:sessionId/skills",
    headers: authHeadersSchema,
    pathParams: object({ sessionId: uuid() }),
    responses: {
      200: array(workflowSummarySchema),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Read the current member's workflows imported by one session",
  },
});

export const skillImportSkillsContract = c.router({
  upload: {
    method: "POST",
    path: "/api/skill-import/skills",
    headers: authHeadersSchema,
    body: skillImportRequestSchema,
    responses: {
      200: skillImportSkippedResponseSchema,
      201: skillImportCreatedResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
      413: apiErrorSchema,
      429: apiErrorSchema,
    },
    summary: "Import one local skill as a private workflow",
  },
});

export type SkillImportSessionsContract = typeof skillImportSessionsContract;
export type SkillImportSkillsContract = typeof skillImportSkillsContract;

/**
 * Normalize a locally authored skill name into a workflow slug.
 *
 * Local skills are named by their directory or frontmatter, so they arrive with
 * capitals, spaces, underscores, or dots. Returns null when nothing usable
 * remains, which the upload route reports as an invalid request.
 */
export function normalizeSkillImportName(name: string): string | null {
  // One pass collapses every run of non-slug characters into a single hyphen,
  // so the truncated result can only ever carry one leading and one trailing
  // hyphen. Those are removed by index rather than by a `-+` pattern, which
  // backtracks on a long run of hyphens.
  const collapsed = name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .slice(0, 64);
  const start = collapsed.startsWith("-") ? 1 : 0;
  const end = collapsed.endsWith("-") ? collapsed.length - 1 : collapsed.length;
  const slug = collapsed.slice(start, Math.max(start, end));

  return workflowNameSchema.safeParse(slug).success ? slug : null;
}
