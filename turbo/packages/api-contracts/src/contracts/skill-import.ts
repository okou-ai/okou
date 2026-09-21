import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { RESERVED_SKILL_FILE, workflowNameSchema } from "./workflows";

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
 * Binary content is deliberately out of scope for this version. A later version
 * can add an explicit encoding to the upload body without touching the shared
 * workflow contract.
 */

/** Session token lifetime, mirrored in the session response's `expiresAt`. */
export const SKILL_IMPORT_SESSION_TTL_SECONDS = 60 * 60;

/**
 * Upload limits for one session. They are returned with the session so the
 * generated prompt states the same numbers the server enforces.
 */
export const SKILL_IMPORT_LIMITS = {
  /** Skills one session may create, counted from the token's issue time. */
  maxSkillsPerSession: 50,
  maxInstructionBytes: 256 * 1024,
  maxFilesPerSkill: 50,
  maxFileBytes: 64 * 1024,
  maxTotalFileBytes: 1024 * 1024,
  maxRequestBytes: 2 * 1024 * 1024,
} as const;

export const skillImportLimitsSchema = z.object({
  maxSkillsPerSession: z.number().int().positive(),
  maxInstructionBytes: z.number().int().positive(),
  maxFilesPerSkill: z.number().int().positive(),
  maxFileBytes: z.number().int().positive(),
  maxTotalFileBytes: z.number().int().positive(),
  maxRequestBytes: z.number().int().positive(),
});
export type SkillImportLimits = z.infer<typeof skillImportLimitsSchema>;

export const skillImportSessionResponseSchema = z.object({
  /** Absolute URL of the upload route the prompt posts each skill to. */
  uploadUrl: z.url(),
  token: z.string().min(1),
  expiresAt: z.string().datetime(),
  limits: skillImportLimitsSchema,
});
export type SkillImportSessionResponse = z.infer<
  typeof skillImportSessionResponseSchema
>;

/**
 * Raw skill name as found in the local SKILL.md frontmatter or directory name.
 * The server normalizes it to `workflowNameSchema`; a value that cannot be
 * normalized into a slug is rejected as invalid.
 */
export const skillImportNameSchema = z.string().min(1).max(128);

/**
 * One supplementary file. `SKILL.md` is reserved: it is synthesized server-side
 * from (name, description, instruction) and is never uploaded.
 */
export const skillImportFileSchema = z.object({
  path: z
    .string()
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
  content: z.string(),
});

/**
 * One skill per request. Sizes are validated by the route rather than by this
 * schema so an oversize payload answers `413` instead of `400`.
 */
export const skillImportRequestSchema = z
  .object({
    name: skillImportNameSchema,
    displayName: z.string().max(256).optional(),
    description: z.string().max(1024).optional(),
    instruction: z.string().min(1),
    files: z.array(skillImportFileSchema).optional(),
  })
  .strict();
export type SkillImportRequest = z.infer<typeof skillImportRequestSchema>;

export const skillImportCreatedResponseSchema = z.object({
  outcome: z.literal("created"),
  workflowId: z.string().uuid(),
  /** Normalized slug the skill was stored under. */
  name: workflowNameSchema,
});

export const skillImportSkippedResponseSchema = z.object({
  outcome: z.literal("skipped"),
  reason: z.literal("name_exists"),
  workflowId: z.string().uuid(),
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
    body: c.noBody(),
    responses: {
      200: skillImportSessionResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Open a skill import session for the org's default agent",
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
  const slug = name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64)
    .replace(/-+$/, "");

  return workflowNameSchema.safeParse(slug).success ? slug : null;
}
