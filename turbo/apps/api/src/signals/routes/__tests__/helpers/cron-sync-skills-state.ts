import type {
  TestCronSyncSkillsStateActionBody,
  TestCronSyncSkillsStateActionResponse,
  TestCronSyncSkillsStateSkillVersionSeed,
} from "@okouai/api-contracts/contracts/test-cron-sync-skills-state";

import { createAppWithRoutes } from "../../../../app-factory-core";
import type { TestContext } from "../../../../__tests__/test-context";
import { testCronSyncSkillsStateRoutes } from "../../test-cron-sync-skills-state";

const CRON_SYNC_SKILLS_STATE_ROUTE = "/api/test/cron-sync-skills-state";

interface CronSyncSkillRow {
  readonly name: string;
  readonly fullPath: string;
  readonly commitSha: string | null;
  readonly versionHash: string | null;
  readonly fileCount: number;
  readonly frontmatter: unknown;
}

interface CronSyncStorageRow {
  readonly headVersionId: string | null;
  readonly s3Prefix: string;
  readonly size: number;
  readonly versionSize: number | null;
  readonly archiveSize: number | null;
}

function requestCronSyncSkillsState(
  context: TestContext,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testCronSyncSkillsStateRoutes,
  });
  return Promise.resolve(app.request(path, init));
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function expectOk(response: Response, operation: string): void {
  if (response.ok) {
    return;
  }
  throw new Error(`${operation} failed with ${response.status}`);
}

async function postAction(
  context: TestContext,
  body: TestCronSyncSkillsStateActionBody,
): Promise<TestCronSyncSkillsStateActionResponse> {
  const response = await requestCronSyncSkillsState(
    context,
    `${CRON_SYNC_SKILLS_STATE_ROUTE}/action`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  await expectOk(response, `cron sync skills state action ${body.action}`);
  return await readJson<TestCronSyncSkillsStateActionResponse>(response);
}

export async function cleanupOwnedSkillsState(
  context: TestContext,
  input: {
    readonly skillUrls: readonly string[];
    readonly storageNames: readonly string[];
  },
): Promise<void> {
  await postAction(context, {
    action: "cleanup-owned-skills",
    skill_urls: [...input.skillUrls],
    storage_names: [...input.storageNames],
  });
}

export async function setOwnedSkillsCommitShaState(
  context: TestContext,
  input: {
    readonly skills: readonly {
      readonly name: string;
      readonly url: string;
      readonly fullPath: string;
      readonly frontmatter: unknown;
    }[];
    readonly commitSha: string;
  },
): Promise<void> {
  await postAction(context, {
    action: "set-owned-skills-commit-sha",
    skills: input.skills.map((skill) => {
      return {
        name: skill.name,
        url: skill.url,
        full_path: skill.fullPath,
        frontmatter: skill.frontmatter,
      };
    }),
    commit_sha: input.commitSha,
  });
}

export async function seedCurrentSkillVersionsState(
  context: TestContext,
  input: {
    readonly staleCommitSha: string;
    readonly versions: readonly TestCronSyncSkillsStateSkillVersionSeed[];
  },
): Promise<void> {
  await postAction(context, {
    action: "seed-current-skill-versions",
    stale_commit_sha: input.staleCommitSha,
    versions: [...input.versions],
  });
}

export async function findSkillByUrlState(
  context: TestContext,
  url: string,
): Promise<CronSyncSkillRow | null> {
  const response = await postAction(context, {
    action: "read-skill-by-url",
    url,
  });
  return response.skill
    ? {
        name: response.skill.name,
        fullPath: response.skill.full_path,
        commitSha: response.skill.commit_sha,
        versionHash: response.skill.version_hash,
        fileCount: response.skill.file_count,
        frontmatter: response.skill.frontmatter,
      }
    : null;
}

export async function findSystemStorageByNameState(
  context: TestContext,
  name: string,
): Promise<CronSyncStorageRow | null> {
  const response = await postAction(context, {
    action: "read-storage-by-name",
    name,
  });
  return response.storage
    ? {
        headVersionId: response.storage.head_version_id,
        s3Prefix: response.storage.s3_prefix,
        size: response.storage.size,
        versionSize: response.storage.version_size,
        archiveSize: response.storage.archive_size,
      }
    : null;
}
