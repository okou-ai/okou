import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const testCronSyncSkillsStateErrorSchema = z.object({
  error: z.string(),
});

const skillVersionSeedSchema = z.object({
  name: z.string(),
  url: z.string(),
  full_path: z.string(),
  storage_name: z.string(),
  version_hash: z.string(),
  size: z.number(),
  archive_size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  file_count: z.number(),
  frontmatter: z.unknown(),
});

const ownedSkillSchema = z.object({
  name: z.string(),
  url: z.string(),
  full_path: z.string(),
  frontmatter: z.unknown(),
});

const skillRowSchema = z.object({
  name: z.string(),
  full_path: z.string(),
  commit_sha: z.string().nullable(),
  version_hash: z.string().nullable(),
  file_count: z.number(),
  frontmatter: z.unknown(),
});

const storageRowSchema = z.object({
  head_version_id: z.string().nullable(),
  s3_prefix: z.string(),
  size: z.number(),
  version_size: z.number().nullable(),
  archive_size: z.number().nullable(),
});

export const testCronSyncSkillsStateActionBodySchema = z.discriminatedUnion(
  "action",
  [
    z.object({
      action: z.literal("cleanup-owned-skills"),
      skill_urls: z.array(z.string()),
      storage_names: z.array(z.string()),
    }),
    z.object({
      action: z.literal("set-owned-skills-commit-sha"),
      skills: z.array(ownedSkillSchema).min(1),
      commit_sha: z.string(),
    }),
    z.object({
      action: z.literal("seed-current-skill-versions"),
      stale_commit_sha: z.string(),
      versions: z.array(skillVersionSeedSchema),
    }),
    z.object({
      action: z.literal("read-skill-by-url"),
      url: z.string(),
    }),
    z.object({
      action: z.literal("read-storage-by-name"),
      name: z.string(),
    }),
  ],
);

export const testCronSyncSkillsStateActionResponseSchema = z.object({
  ok: z.literal(true),
  skill: skillRowSchema.nullable().optional(),
  storage: storageRowSchema.nullable().optional(),
});

export const testCronSyncSkillsStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/cron-sync-skills-state/action",
    body: testCronSyncSkillsStateActionBodySchema,
    responses: {
      200: testCronSyncSkillsStateActionResponseSchema,
      400: testCronSyncSkillsStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate and read cron sync skills API test support state",
  },
});

export type TestCronSyncSkillsStateContract =
  typeof testCronSyncSkillsStateContract;
export type TestCronSyncSkillsStateActionBody = z.infer<
  typeof testCronSyncSkillsStateActionBodySchema
>;
export type TestCronSyncSkillsStateActionResponse = z.infer<
  typeof testCronSyncSkillsStateActionResponseSchema
>;
export type TestCronSyncSkillsStateSkillVersionSeed = z.infer<
  typeof skillVersionSeedSchema
>;
