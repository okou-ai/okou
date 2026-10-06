import { command } from "ccstate";
import {
  testCronSyncSkillsStateContract,
  type TestCronSyncSkillsStateActionBody,
  type TestCronSyncSkillsStateSkillVersionSeed,
} from "@okouai/api-contracts/contracts/test-cron-sync-skills-state";
import { SYSTEM_ORG_ID, VOLUME_ORG_USER_ID } from "@okouai/core/storage-names";
import { skills } from "@okouai/db/schema/skill";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { and, eq, inArray } from "drizzle-orm";

import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { newStorageS3Location } from "../services/storage-s3-prefix.utils";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const actionBody$ = bodyResultOf(testCronSyncSkillsStateContract.action);

type CronSyncSkillsAction<
  TAction extends TestCronSyncSkillsStateActionBody["action"],
> = Extract<TestCronSyncSkillsStateActionBody, { action: TAction }>;

function actionOk(extra: Record<string, unknown> = {}) {
  return { status: 200 as const, body: { ok: true as const, ...extra } };
}

async function cleanupOwnedSkillsForAction(
  db: Db,
  body: CronSyncSkillsAction<"cleanup-owned-skills">,
  signal: AbortSignal,
) {
  if (body.skill_urls.length > 0) {
    await db.delete(skills).where(inArray(skills.url, body.skill_urls));
    signal.throwIfAborted();
  }
  if (body.storage_names.length > 0) {
    await db
      .delete(storages)
      .where(
        and(
          eq(storages.orgId, SYSTEM_ORG_ID),
          eq(storages.userId, VOLUME_ORG_USER_ID),
          inArray(storages.name, body.storage_names),
        ),
      );
    signal.throwIfAborted();
  }
  return actionOk();
}

async function setOwnedSkillsCommitShaForAction(
  db: Db,
  body: CronSyncSkillsAction<"set-owned-skills-commit-sha">,
  signal: AbortSignal,
) {
  await db.insert(skills).values(
    body.skills.map((skill) => {
      return {
        url: skill.url,
        name: skill.name,
        fullPath: skill.full_path,
        frontmatter: skill.frontmatter,
      };
    }),
  );
  signal.throwIfAborted();

  await db
    .update(skills)
    .set({ commitSha: body.commit_sha })
    .where(
      inArray(
        skills.url,
        body.skills.map((skill) => {
          return skill.url;
        }),
      ),
    );
  signal.throwIfAborted();
  return actionOk();
}

async function seedStorageRows(
  db: Db,
  versions: readonly TestCronSyncSkillsStateSkillVersionSeed[],
) {
  const storageSeeds = versions.map((version) => {
    const location = newStorageS3Location(SYSTEM_ORG_ID);
    return {
      id: location.storageId,
      orgId: SYSTEM_ORG_ID,
      userId: VOLUME_ORG_USER_ID,
      name: version.storage_name,
      s3Prefix: location.s3Prefix,
      size: version.size,
      fileCount: version.file_count,
    };
  });
  const storageRows = await db.insert(storages).values(storageSeeds).returning({
    id: storages.id,
    name: storages.name,
    s3Prefix: storages.s3Prefix,
  });

  return new Map(
    storageRows.map((row) => {
      return [row.name, { id: row.id, s3Prefix: row.s3Prefix }];
    }),
  );
}

async function seedCurrentSkillVersionsForAction(
  db: Db,
  body: CronSyncSkillsAction<"seed-current-skill-versions">,
  signal: AbortSignal,
) {
  if (body.versions.length === 0) {
    return actionOk();
  }

  const storageByName = await seedStorageRows(db, body.versions);
  signal.throwIfAborted();

  await db.insert(storageVersions).values(
    body.versions.map((version) => {
      const storage = storageByName.get(version.storage_name);
      if (!storage) {
        throw new Error(`Missing storage for ${version.name}`);
      }
      return {
        id: version.version_hash,
        storageId: storage.id,
        s3Key: `${storage.s3Prefix}/${version.version_hash}`,
        size: version.size,
        archiveSize: version.archive_size,
        fileCount: version.file_count,
        message: "Preseeded by cron sync skills route test",
        createdBy: "system",
      };
    }),
  );
  signal.throwIfAborted();

  await Promise.all(
    body.versions.map((version) => {
      const storage = storageByName.get(version.storage_name);
      if (!storage) {
        throw new Error(`Missing storage for ${version.name}`);
      }
      return db
        .update(storages)
        .set({ headVersionId: version.version_hash })
        .where(eq(storages.id, storage.id));
    }),
  );
  signal.throwIfAborted();

  await db.insert(skills).values(
    body.versions.map((version) => {
      const storage = storageByName.get(version.storage_name);
      if (!storage) {
        throw new Error(`Missing storage for ${version.name}`);
      }
      return {
        url: version.url,
        name: version.name,
        fullPath: version.full_path,
        storageId: storage.id,
        versionHash: version.version_hash,
        commitSha: body.stale_commit_sha,
        frontmatter: version.frontmatter,
        s3Key: `${storage.s3Prefix}/${version.version_hash}`,
        size: version.size,
        fileCount: version.file_count,
      };
    }),
  );
  signal.throwIfAborted();
  return actionOk();
}

async function readSkillByUrlForAction(
  db: Db,
  body: CronSyncSkillsAction<"read-skill-by-url">,
  signal: AbortSignal,
) {
  const [row] = await db
    .select({
      name: skills.name,
      fullPath: skills.fullPath,
      commitSha: skills.commitSha,
      versionHash: skills.versionHash,
      fileCount: skills.fileCount,
      frontmatter: skills.frontmatter,
    })
    .from(skills)
    .where(eq(skills.url, body.url))
    .limit(1);
  signal.throwIfAborted();
  return actionOk({
    skill: row
      ? {
          name: row.name,
          full_path: row.fullPath,
          commit_sha: row.commitSha,
          version_hash: row.versionHash,
          file_count: row.fileCount,
          frontmatter: row.frontmatter,
        }
      : null,
  });
}

async function readStorageByNameForAction(
  db: Db,
  body: CronSyncSkillsAction<"read-storage-by-name">,
  signal: AbortSignal,
) {
  const [row] = await db
    .select({
      headVersionId: storages.headVersionId,
      s3Prefix: storages.s3Prefix,
      size: storages.size,
      versionSize: storageVersions.size,
      archiveSize: storageVersions.archiveSize,
    })
    .from(storages)
    .leftJoin(storageVersions, eq(storages.headVersionId, storageVersions.id))
    .where(
      and(
        eq(storages.orgId, SYSTEM_ORG_ID),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        eq(storages.name, body.name),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return actionOk({
    storage: row
      ? {
          head_version_id: row.headVersionId,
          s3_prefix: row.s3Prefix,
          size: row.size,
          version_size: row.versionSize,
          archive_size: row.archiveSize,
        }
      : null,
  });
}

const mutateCronSyncSkillsState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const db = set(writeDb$);
    const body = bodyResult.data;
    switch (body.action) {
      case "cleanup-owned-skills": {
        return await cleanupOwnedSkillsForAction(db, body, signal);
      }
      case "set-owned-skills-commit-sha": {
        return await setOwnedSkillsCommitShaForAction(db, body, signal);
      }
      case "seed-current-skill-versions": {
        return await seedCurrentSkillVersionsForAction(db, body, signal);
      }
      case "read-skill-by-url": {
        return await readSkillByUrlForAction(db, body, signal);
      }
      case "read-storage-by-name": {
        return await readStorageByNameForAction(db, body, signal);
      }
    }
  },
);

export const testCronSyncSkillsStateRoutes: readonly RouteEntry[] = [
  {
    route: testCronSyncSkillsStateContract.action,
    handler: mutateCronSyncSkillsState$,
  },
];
