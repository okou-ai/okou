import { getOfficialSkillAliasUrls } from "@okouai/core/github-url";
import { SYSTEM_ORG_ID, VOLUME_ORG_USER_ID } from "@okouai/core/storage-names";
import { skills } from "@okouai/db/schema/skill";
import { storages } from "@okouai/db/schema/storage";
import { eq, inArray } from "drizzle-orm";

import type { Db } from "../external/db";

export interface OfficialSkillStorageBinding {
  readonly id: string;
  readonly name: string;
  readonly s3Prefix: string;
}

/**
 * Resolve exact official repository aliases through their persisted Storage
 * relation. Existing bindings are authoritative; callers derive a fallback
 * identity only when this lookup has no bound row for a skill.
 */
export async function resolveOfficialSkillStorageBindings(
  db: Db,
  skillNames: readonly string[],
  signal: AbortSignal,
): Promise<ReadonlyMap<string, OfficialSkillStorageBinding>> {
  const uniqueSkillNames = [...new Set(skillNames)];
  if (uniqueSkillNames.length === 0) {
    return new Map();
  }

  const skillNameByUrl = new Map<string, string>();
  for (const skillName of uniqueSkillNames) {
    for (const url of getOfficialSkillAliasUrls(skillName)) {
      skillNameByUrl.set(url, skillName);
    }
  }

  const rows = await db
    .select({
      url: skills.url,
      storageId: storages.id,
      storageName: storages.name,
      s3Prefix: storages.s3Prefix,
      orgId: storages.orgId,
      userId: storages.userId,
    })
    .from(skills)
    .innerJoin(storages, eq(skills.storageId, storages.id))
    .where(inArray(skills.url, [...skillNameByUrl.keys()]));
  signal.throwIfAborted();

  const bindings = new Map<string, OfficialSkillStorageBinding>();
  for (const row of rows) {
    const skillName = skillNameByUrl.get(row.url);
    if (skillName === undefined) {
      throw new Error(`Unexpected official skill URL returned: ${row.url}`);
    }
    if (row.orgId !== SYSTEM_ORG_ID || row.userId !== VOLUME_ORG_USER_ID) {
      throw new Error(
        `Official skill ${skillName} is bound outside system Storage`,
      );
    }

    const existing = bindings.get(skillName);
    if (existing !== undefined && existing.id !== row.storageId) {
      throw new Error(
        `Official skill ${skillName} aliases have conflicting Storage bindings`,
      );
    }
    bindings.set(skillName, {
      id: row.storageId,
      name: row.storageName,
      s3Prefix: row.s3Prefix,
    });
  }

  return bindings;
}
