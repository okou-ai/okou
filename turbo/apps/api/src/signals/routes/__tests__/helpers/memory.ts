import { createHash } from "node:crypto";

import type {
  TestMemorySummaryProjectionStateActionBody,
  TestMemorySummaryProjectionStateActionResponse,
} from "@okouai/api-contracts/contracts/test-memory-summary-projection-state";
import { MEMORY_ARTIFACT_NAME } from "@okouai/core/storage-names";

import { createAppWithRoutes } from "../../../../app-factory-core";
import type { TestContext } from "../../../../__tests__/test-context";
import {
  readStorageIdentityFixture,
  readStorageS3PrefixFixture,
} from "../../../../test-fixtures/storage";
import { testMemorySummaryProjectionStateRoutes } from "../../test-memory-summary-projection-state";
import type { ApiTestUser } from "./api-bdd";
import { createStoragesBddApi } from "./api-bdd-storages";

interface MemoryFile {
  readonly path: string;
  readonly content: string | Buffer;
}

interface CommittedMemoryVersion {
  readonly storageId: string;
  readonly versionId: string;
  readonly s3Key: string;
}

/**
 * Create (or dedupe onto) a memory artifact version through the in-process
 * Storage fixture. Returns the content-addressed version id and the S3 key
 * assigned to it.
 */
export async function commitMemoryVersion(
  context: TestContext,
  actor: ApiTestUser,
  files: readonly MemoryFile[],
  archiveSize = 1024,
): Promise<CommittedMemoryVersion> {
  if (!actor.orgId) {
    throw new Error("commitMemoryVersion requires an actor with an org");
  }
  const storagesApi = createStoragesBddApi(context);
  const entries = files.map((file) => {
    const content =
      typeof file.content === "string"
        ? Buffer.from(file.content, "utf8")
        : file.content;
    return {
      path: file.path,
      hash: createHash("sha256").update(content).digest("hex"),
      size: content.length,
    };
  });

  const prepared = await storagesApi.prepareStorage(actor, {
    storageName: MEMORY_ARTIFACT_NAME,
    storageOwner: "user",
    files: entries,
  });
  storagesApi.mockStorageObjectExistsOnce();
  storagesApi.mockStorageObjectExistsOnce(archiveSize);
  await storagesApi.commitStorage(actor, {
    storageName: MEMORY_ARTIFACT_NAME,
    storageOwner: "user",
    versionId: prepared.versionId,
    files: entries,
  });

  const s3Prefix = await readStorageS3PrefixFixture({
    orgId: actor.orgId,
    userId: actor.userId,
    name: MEMORY_ARTIFACT_NAME,
  });
  const identity = await readStorageIdentityFixture({
    orgId: actor.orgId,
    userId: actor.userId,
    name: MEMORY_ARTIFACT_NAME,
  });
  return {
    storageId: identity.id,
    versionId: prepared.versionId,
    s3Key: `${s3Prefix}/${prepared.versionId}`,
  };
}

export async function seedReadyMemorySummaryProjection(
  context: TestContext,
  actor: ApiTestUser,
  version: CommittedMemoryVersion,
  content: string,
): Promise<void> {
  if (!actor.orgId) {
    throw new Error("seedReadyMemorySummaryProjection requires an org actor");
  }
  const body: TestMemorySummaryProjectionStateActionBody = {
    action: "seed-ready",
    org_id: actor.orgId,
    user_id: actor.userId,
    memory_storage_id: version.storageId,
    storage_version_id: version.versionId,
    content,
  };
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testMemorySummaryProjectionStateRoutes,
  });
  const response = await app.request(
    "/api/test/memory-summary-projection-state/action",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Projection seed-ready action failed with ${response.status.toString()}`,
    );
  }
  const result =
    (await response.json()) as TestMemorySummaryProjectionStateActionResponse;
  if (!result.ok) {
    throw new Error("Projection seed-ready action did not succeed");
  }
}
