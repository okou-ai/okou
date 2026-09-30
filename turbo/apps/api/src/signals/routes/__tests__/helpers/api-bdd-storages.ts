import type {
  TestStorageStateActionBody,
  TestStorageStateActionResponse,
} from "@okouai/api-contracts/contracts/test-storage-fixture";

import { createAppWithRoutes } from "../../../../app-factory-core";
import type { TestContext } from "../../../../__tests__/test-context";
import { testStorageStateRoutes } from "../../test-storage-fixture";
import type { ApiTestUser } from "./api-bdd";
import type { BddStorageFileEntry } from "./api-bdd-storage-files";

type StorageFixtureOwner = "organization" | "user";

interface BddStoragePrepareBody {
  readonly storageName: string;
  readonly storageOwner: StorageFixtureOwner;
  readonly files: readonly BddStorageFileEntry[];
  readonly force?: boolean;
  readonly baseVersion?: string;
  readonly changes?: {
    readonly added: readonly string[];
    readonly modified: readonly string[];
    readonly deleted: readonly string[];
  };
}

interface BddStorageCommitBody {
  readonly storageName: string;
  readonly storageOwner: StorageFixtureOwner;
  readonly versionId: string;
  readonly files: readonly BddStorageFileEntry[];
  readonly message?: string;
}

interface BddStorageDownloadQuery {
  readonly name: string;
  readonly owner: StorageFixtureOwner;
  readonly version?: string;
}

interface BddStorageWritebackQuery {
  readonly storageId: string;
  readonly versionId: string;
  readonly runId: string;
  readonly parentVersionId: string;
}

function requireOrgId(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Storage fixture requires an org-scoped actor");
  }
  return actor.orgId;
}

function requestStorageState(
  context: TestContext,
  body: TestStorageStateActionBody,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testStorageStateRoutes,
  });
  return Promise.resolve(
    app.request("/api/test/storage-fixture/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function postAction(
  context: TestContext,
  body: TestStorageStateActionBody,
): Promise<TestStorageStateActionResponse> {
  const response = await requestStorageState(context, body);
  if (!response.ok) {
    throw new Error(
      `Storage state action ${body.action} failed with ${response.status}`,
    );
  }
  return (await response.json()) as TestStorageStateActionResponse;
}

function fixtureFiles(files: readonly BddStorageFileEntry[]) {
  return files.map((file) => {
    return { ...file };
  });
}

export function createStoragesBddApi(context: TestContext) {
  return {
    mockStoragePresignedUrls(
      url = "https://r2.example.com/storages/presigned?sig=bdd",
    ): void {
      context.mocks.s3.getSignedUrl.mockResolvedValue(url);
    },

    mockStorageObjectsExist(contentLength = 1024): void {
      context.mocks.s3.send.mockResolvedValue({
        ContentLength: contentLength,
      });
    },

    mockStorageObjectExistsOnce(contentLength = 1024): void {
      context.mocks.s3.send.mockResolvedValueOnce({
        ContentLength: contentLength,
      });
    },

    async prepareStorage(actor: ApiTestUser, body: BddStoragePrepareBody) {
      const response = await postAction(context, {
        action: "prepare",
        orgId: requireOrgId(actor),
        userId: actor.userId,
        storageName: body.storageName,
        storageOwner: body.storageOwner,
        files: fixtureFiles(body.files),
        force: body.force,
        baseVersion: body.baseVersion,
        changes: body.changes
          ? {
              added: [...body.changes.added],
              modified: [...body.changes.modified],
              deleted: [...body.changes.deleted],
            }
          : undefined,
      });
      if (!response.prepared) {
        throw new Error("Storage prepare action returned no result");
      }
      return response.prepared;
    },

    async commitStorage(actor: ApiTestUser, body: BddStorageCommitBody) {
      const response = await postAction(context, {
        action: "commit",
        orgId: requireOrgId(actor),
        userId: actor.userId,
        storageName: body.storageName,
        storageOwner: body.storageOwner,
        versionId: body.versionId,
        files: fixtureFiles(body.files),
        message: body.message,
      });
      if (!response.committed) {
        throw new Error("Storage commit action returned no result");
      }
      return response.committed;
    },

    async listStorages(actor: ApiTestUser, owner: StorageFixtureOwner) {
      const response = await postAction(context, {
        action: "list",
        orgId: requireOrgId(actor),
        userId: actor.userId,
        storageOwner: owner,
      });
      if (!response.storages) {
        throw new Error("Storage list action returned no result");
      }
      return response.storages;
    },

    async downloadStorage(actor: ApiTestUser, query: BddStorageDownloadQuery) {
      const response = await postAction(context, {
        action: "download",
        orgId: requireOrgId(actor),
        userId: actor.userId,
        storageName: query.name,
        storageOwner: query.owner,
        versionId: query.version,
      });
      if (!response.download) {
        throw new Error("Storage download action returned no result");
      }
      return response.download;
    },

    async inspectWriteback(query: BddStorageWritebackQuery) {
      const response = await postAction(context, {
        action: "inspect-writeback",
        storageId: query.storageId,
        versionId: query.versionId,
        runId: query.runId,
        parentVersionId: query.parentVersionId,
      });
      if (!response.writeback) {
        throw new Error("Storage writeback inspection returned no result");
      }
      return response.writeback;
    },
  };
}
