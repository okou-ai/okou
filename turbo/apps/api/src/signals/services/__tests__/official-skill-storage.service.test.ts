import { randomUUID } from "node:crypto";

import { getOfficialSkillAliasUrls } from "@okouai/core/github-url";
import { SYSTEM_ORG_ID, VOLUME_ORG_USER_ID } from "@okouai/core/storage-names";
import { skills } from "@okouai/db/schema/skill";
import { storages } from "@okouai/db/schema/storage";
import { inArray } from "drizzle-orm";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { db } from "../../../lib/db";
import { resolveOfficialSkillStorageBindings } from "../official-skill-storage.service";

const context = testContext();

interface StorageFixture {
  readonly id: string;
  readonly name: string;
  readonly s3Prefix: string;
}

async function createStorageFixture(
  label: string,
  system = true,
): Promise<StorageFixture> {
  const id = randomUUID();
  const suffix = randomUUID();
  const name = `official-skill-test-${label}-${suffix}`;
  const s3Prefix = `official-skill-test/${suffix}`;
  const [storage] = await db()
    .insert(storages)
    .values({
      id,
      orgId: system ? SYSTEM_ORG_ID : `org_${suffix}`,
      userId: system ? VOLUME_ORG_USER_ID : `user_${suffix}`,
      name,
      s3Prefix,
    })
    .returning({
      id: storages.id,
      name: storages.name,
      s3Prefix: storages.s3Prefix,
    });
  if (!storage) {
    throw new Error("Expected official skill Storage fixture");
  }
  return storage;
}

async function insertSkillAlias(
  skillName: string,
  aliasIndex: 0 | 1,
  storageId: string,
): Promise<string> {
  const url = getOfficialSkillAliasUrls(skillName)[aliasIndex];
  if (!url) {
    throw new Error("Expected official skill repository alias");
  }
  await db()
    .insert(skills)
    .values({
      url,
      name: skillName,
      fullPath: url.replace("https://github.com/", ""),
      storageId,
    });
  return url;
}

function cleanUpFixture(
  skillUrls: readonly string[],
  storageIds: readonly string[],
) {
  onTestFinished(async () => {
    if (skillUrls.length > 0) {
      await db()
        .delete(skills)
        .where(inArray(skills.url, [...skillUrls]));
    }
    if (storageIds.length > 0) {
      await db()
        .delete(storages)
        .where(inArray(storages.id, [...storageIds]));
    }
  });
}

describe("official skill Storage binding resolution", () => {
  it("returns no binding for a new official skill", async () => {
    const skillName = `unbound-${randomUUID()}`;

    await expect(
      resolveOfficialSkillStorageBindings(db(), [skillName], context.signal),
    ).resolves.toStrictEqual({});
  });

  it("resolves either repository alias through the persisted Storage binding", async () => {
    const skillName = `shared-${randomUUID()}`;
    const storage = await createStorageFixture("shared");
    const skillUrls = [
      await insertSkillAlias(skillName, 0, storage.id),
      await insertSkillAlias(skillName, 1, storage.id),
    ];
    cleanUpFixture(skillUrls, [storage.id]);

    await expect(
      resolveOfficialSkillStorageBindings(db(), [skillName], context.signal),
    ).resolves.toStrictEqual({
      [skillName]: storage,
    });
  });

  it("fails closed when repository aliases reference different Storages", async () => {
    const skillName = `conflict-${randomUUID()}`;
    const oldStorage = await createStorageFixture("old");
    const newStorage = await createStorageFixture("new");
    const skillUrls = [
      await insertSkillAlias(skillName, 0, oldStorage.id),
      await insertSkillAlias(skillName, 1, newStorage.id),
    ];
    cleanUpFixture(skillUrls, [oldStorage.id, newStorage.id]);

    await expect(
      resolveOfficialSkillStorageBindings(db(), [skillName], context.signal),
    ).rejects.toThrow(
      `Official skill ${skillName} aliases have conflicting Storage bindings`,
    );
  });

  it("rejects an official alias bound outside system Storage", async () => {
    const skillName = `external-${randomUUID()}`;
    const storage = await createStorageFixture("external", false);
    const skillUrl = await insertSkillAlias(skillName, 0, storage.id);
    cleanUpFixture([skillUrl], [storage.id]);

    await expect(
      resolveOfficialSkillStorageBindings(db(), [skillName], context.signal),
    ).rejects.toThrow(
      `Official skill ${skillName} is bound outside system Storage`,
    );
  });
});
