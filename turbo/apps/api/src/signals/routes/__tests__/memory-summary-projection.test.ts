import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import type {
  TestMemorySummaryProjectionStateActionBody,
  TestMemorySummaryProjectionStateActionResponse,
} from "@okouai/api-contracts/contracts/test-memory-summary-projection-state";
import {
  MEMORY_ARTIFACT_NAME,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { beforeEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { readStorageIdentityFixture } from "../../../test-fixtures/storage";
import { testMemorySummaryProjectionStateRoutes } from "../test-memory-summary-projection-state";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import type { BddStorageFileEntry } from "./helpers/api-bdd-storage-files";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";

const context = testContext();
const bdd = createBddApi(context);
const storages = createStoragesBddApi(context);
const BUCKET = "memory-summary-projection-test";
const TAR_BLOCK_SIZE = 512;

interface TarEntry {
  readonly path: string;
  readonly content?: Buffer;
  readonly type?: "file" | "directory" | "symlink";
  readonly linkName?: string;
}

interface PublishedVersion {
  readonly actor: ApiTestUser;
  readonly memoryStorageId: string;
  readonly storageVersionId: string;
  readonly manifestKey: string;
  readonly archiveKey: string;
  readonly files: readonly BddStorageFileEntry[];
}

function requiredOrgId(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Memory summary projection tests require an org actor");
  }
  return actor.orgId;
}

function requiredObjectKey(key: string | undefined): string {
  if (!key) {
    throw new Error("Expected an S3 object key");
  }
  return key;
}

function missingObject(key: string): Error {
  return Object.assign(new Error(`Missing test object ${key}`), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 },
  });
}

function asyncBody(body: Uint8Array): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield body;
    },
  };
}

function installS3Objects(): void {
  context.mocks.s3.getSignedUrl.mockResolvedValue(
    "https://r2.example.com/upload?sig=memory-summary",
  );
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (command instanceof HeadObjectCommand) {
      const key = requiredObjectKey(command.input.Key);
      const body = context.sessionHistoryBlobs.get(key);
      return body
        ? Promise.resolve({ ContentLength: body.length })
        : Promise.reject(missingObject(key));
    }
    if (command instanceof GetObjectCommand) {
      const key = requiredObjectKey(command.input.Key);
      const body = context.sessionHistoryBlobs.get(key);
      return body
        ? Promise.resolve({
            Body: asyncBody(body),
            ContentLength: body.length,
          })
        : Promise.reject(missingObject(key));
    }
    return Promise.resolve({});
  });
}

function failNextObjectRead(key: string): void {
  const fallback = context.mocks.s3.send.getMockImplementation();
  let pending = true;
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (
      pending &&
      command instanceof GetObjectCommand &&
      command.input.Key === key
    ) {
      pending = false;
      const error = new Error("Injected transient object read failure");
      error.name = "TimeoutError";
      return Promise.reject(error);
    }
    return fallback ? fallback(command) : Promise.resolve({});
  });
}

function downloadedObjectKeys(): readonly string[] {
  return context.mocks.s3.send.mock.calls.flatMap(([command]) => {
    return command instanceof GetObjectCommand
      ? [requiredObjectKey(command.input.Key)]
      : [];
  });
}

function writeTarNumber(
  header: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  header.write(
    `${value.toString(8).padStart(length - 1, "0")}\0`,
    offset,
    length,
    "ascii",
  );
}

function tarHeader(entry: TarEntry): Buffer {
  const content = entry.content ?? Buffer.alloc(0);
  const type = entry.type ?? "file";
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  header.write(entry.path, 0, 100, "utf8");
  writeTarNumber(header, 100, 8, type === "directory" ? 0o755 : 0o644);
  writeTarNumber(header, 108, 8, 0);
  writeTarNumber(header, 116, 8, 0);
  writeTarNumber(header, 124, 12, type === "file" ? content.length : 0);
  writeTarNumber(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(
    type === "file" ? "0" : type === "directory" ? "5" : "2",
    156,
    1,
    "ascii",
  );
  if (entry.linkName) {
    header.write(entry.linkName, 157, 100, "utf8");
  }
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("root", 265, 32, "ascii");
  header.write("root", 297, 32, "ascii");
  const checksum = header.reduce((sum, byte) => {
    return sum + byte;
  }, 0);
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function tarGz(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = entry.content ?? Buffer.alloc(0);
    blocks.push(tarHeader(entry));
    if ((entry.type ?? "file") === "file") {
      blocks.push(content);
      const padding =
        (TAR_BLOCK_SIZE - (content.length % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
      if (padding > 0) {
        blocks.push(Buffer.alloc(padding));
      }
    }
  }
  blocks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2));
  return gzipSync(Buffer.concat(blocks));
}

function declaredFile(path: string, content: Buffer): BddStorageFileEntry {
  return {
    path,
    hash: createHash("sha256").update(content).digest("hex"),
    size: content.length,
  };
}

function canonicalManifest(files: readonly BddStorageFileEntry[]): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      files,
      createdAt: new Date(0).toISOString(),
    }),
    "utf8",
  );
}

async function publishVersion(args: {
  readonly actor?: ApiTestUser;
  readonly storageName?: string;
  readonly storageOwner?: "organization" | "user";
  readonly files: readonly BddStorageFileEntry[];
  readonly archive: Buffer;
  readonly manifest?: Buffer;
}): Promise<PublishedVersion> {
  const actor = args.actor ?? bdd.user();
  const storageName = args.storageName ?? MEMORY_ARTIFACT_NAME;
  const storageOwner = args.storageOwner ?? "user";
  const prepared = await storages.prepareStorage(actor, {
    storageName,
    storageOwner,
    files: args.files,
  });
  if (!prepared.uploads) {
    throw new Error("Expected a new Storage version with upload targets");
  }
  const archiveKey = prepared.uploads.archive.key;
  const manifestKey = prepared.uploads.manifest.key;
  context.sessionHistoryBlobs.set(archiveKey, args.archive);
  context.sessionHistoryBlobs.set(
    manifestKey,
    args.manifest ?? canonicalManifest(args.files),
  );
  await storages.commitStorage(actor, {
    storageName,
    storageOwner,
    versionId: prepared.versionId,
    files: args.files,
  });

  const identity = await readStorageIdentityFixture({
    orgId: requiredOrgId(actor),
    userId: storageOwner === "organization" ? VOLUME_ORG_USER_ID : actor.userId,
    name: storageName,
  });
  return {
    actor,
    memoryStorageId: identity.id,
    storageVersionId: prepared.versionId,
    manifestKey,
    archiveKey,
    files: args.files,
  };
}

function projectionScope(
  version: PublishedVersion,
): Omit<TestMemorySummaryProjectionStateActionBody, "action" | "content"> {
  return {
    org_id: requiredOrgId(version.actor),
    user_id: version.actor.userId,
    memory_storage_id: version.memoryStorageId,
    storage_version_id: version.storageVersionId,
  };
}

async function stateAction(
  body: TestMemorySummaryProjectionStateActionBody,
): Promise<TestMemorySummaryProjectionStateActionResponse> {
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
      `Projection state action ${body.action} failed with ${response.status}`,
    );
  }
  return (await response.json()) as TestMemorySummaryProjectionStateActionResponse;
}

async function inspect(version: PublishedVersion) {
  return (await stateAction({ action: "inspect", ...projectionScope(version) }))
    .state;
}

async function run(version: PublishedVersion, currentTime?: Date) {
  const result = await stateAction({
    action: "run",
    ...projectionScope(version),
    ...(currentTime ? { current_time: currentTime.toISOString() } : {}),
  });
  if (!result.worker) {
    throw new Error("Projection worker returned no result");
  }
  return result.worker;
}

async function read(version: PublishedVersion) {
  return (await stateAction({ action: "read", ...projectionScope(version) }))
    .projection;
}

beforeEach(() => {
  context.sessionHistoryBlobs.clear();
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
  installS3Objects();
});

describe("memory summary projection", () => {
  it("accepts a different gzip size for the same logical Storage version", async () => {
    const summary = Buffer.from("summary with stable logical contents", "utf8");
    const original = tarGz([{ path: "memory_summary.md", content: summary }]);
    const version = await publishVersion({
      files: [declaredFile("memory_summary.md", summary)],
      archive: original,
    });
    const differentlyCompressed = gzipSync(gunzipSync(original), { level: 0 });
    expect(differentlyCompressed).not.toHaveLength(original.length);
    context.sessionHistoryBlobs.set(version.archiveKey, differentlyCompressed);
    context.mocks.s3.send.mockClear();

    await expect(run(version)).resolves.toMatchObject({ claimed: 1, ready: 1 });
    expect(
      context.mocks.s3.send.mock.calls.filter(([command]) => {
        return command instanceof HeadObjectCommand;
      }),
    ).toHaveLength(0);
    await expect(read(version)).resolves.toMatchObject({
      content: summary.toString("utf8"),
      source_size: summary.length,
    });
  });

  const invalidCases: readonly {
    readonly name: string;
    readonly files: () => readonly BddStorageFileEntry[];
    readonly archive: () => Buffer;
    readonly manifest?: (files: readonly BddStorageFileEntry[]) => Buffer;
    readonly status: "invalid" | "missing" | "over_limit";
  }[] = [
    {
      name: "missing root summary",
      files: () => {
        return [declaredFile("other.md", Buffer.from("other", "utf8"))];
      },
      archive: () => {
        return tarGz([
          { path: "other.md", content: Buffer.from("other", "utf8") },
        ]);
      },
      status: "missing",
    },
    {
      name: "empty root summary",
      files: () => {
        return [declaredFile("memory_summary.md", Buffer.alloc(0))];
      },
      archive: () => {
        return tarGz([{ path: "memory_summary.md", content: Buffer.alloc(0) }]);
      },
      status: "missing",
    },
    {
      name: "invalid UTF-8",
      files: () => {
        return [declaredFile("memory_summary.md", Buffer.from([0xff]))];
      },
      archive: () => {
        return tarGz([
          { path: "memory_summary.md", content: Buffer.from([0xff]) },
        ]);
      },
      status: "invalid",
    },
    {
      name: "duplicate archive path",
      files: () => {
        return [declaredFile("memory_summary.md", Buffer.from("one", "utf8"))];
      },
      archive: () => {
        return tarGz([
          { path: "memory_summary.md", content: Buffer.from("one", "utf8") },
          { path: "memory_summary.md", content: Buffer.from("one", "utf8") },
        ]);
      },
      status: "invalid",
    },
    {
      name: "symlink summary",
      files: () => {
        return [declaredFile("memory_summary.md", Buffer.from("link", "utf8"))];
      },
      archive: () => {
        return tarGz([
          {
            path: "memory_summary.md",
            type: "symlink",
            linkName: "other.md",
          },
        ]);
      },
      status: "invalid",
    },
    {
      name: "archive traversal",
      files: () => {
        return [declaredFile("memory_summary.md", Buffer.from("safe", "utf8"))];
      },
      archive: () => {
        return tarGz([
          {
            path: "memory_summary.md",
            content: Buffer.from("safe", "utf8"),
          },
          { path: "../escape", content: Buffer.from("escape", "utf8") },
        ]);
      },
      status: "invalid",
    },
    {
      name: "summary hash mismatch",
      files: () => {
        return [
          declaredFile("memory_summary.md", Buffer.from("expected", "utf8")),
        ];
      },
      archive: () => {
        return tarGz([
          {
            path: "memory_summary.md",
            content: Buffer.from("tampered", "utf8"),
          },
        ]);
      },
      status: "invalid",
    },
    {
      name: "duplicate manifest path",
      files: () => {
        const file = declaredFile(
          "memory_summary.md",
          Buffer.from("duplicate", "utf8"),
        );
        return [file, file];
      },
      archive: () => {
        return tarGz([
          {
            path: "memory_summary.md",
            content: Buffer.from("duplicate", "utf8"),
          },
        ]);
      },
      status: "invalid",
    },
    {
      name: "nested alternate summary",
      files: () => {
        return [
          declaredFile(
            "nested/memory_summary.md",
            Buffer.from("nested", "utf8"),
          ),
        ];
      },
      archive: () => {
        return tarGz([
          {
            path: "nested/memory_summary.md",
            content: Buffer.from("nested", "utf8"),
          },
        ]);
      },
      status: "invalid",
    },
    {
      name: "oversized summary bytes",
      files: () => {
        return [declaredFile("memory_summary.md", Buffer.alloc(64 * 1024 + 1))];
      },
      archive: () => {
        return tarGz([
          { path: "memory_summary.md", content: Buffer.alloc(64 * 1024 + 1) },
        ]);
      },
      status: "over_limit",
    },
    {
      name: "malformed manifest",
      files: () => {
        return [
          declaredFile("memory_summary.md", Buffer.from("summary", "utf8")),
        ];
      },
      archive: () => {
        return tarGz([
          {
            path: "memory_summary.md",
            content: Buffer.from("summary", "utf8"),
          },
        ]);
      },
      manifest: () => {
        return Buffer.from("{malformed", "utf8");
      },
      status: "invalid",
    },
  ];

  it.each(invalidCases)(
    "fails closed for $name",
    async ({ files: filesFactory, archive, manifest, status }) => {
      const files = filesFactory();
      const version = await publishVersion({
        files,
        archive: archive(),
        manifest: manifest?.(files),
      });
      await expect(run(version)).resolves.toMatchObject({
        claimed: 1,
        ready: 0,
        no_content: 1,
        retried: 0,
      });
      await expect(inspect(version)).resolves.toMatchObject({
        status,
        has_content: false,
      });
      await expect(read(version)).resolves.toBeNull();
    },
  );

  it.each(["manifest", "archive"] as const)(
    "retries transient %s reads with backoff and then materializes",
    async (objectKind) => {
      const content = Buffer.from("retryable summary", "utf8");
      const version = await publishVersion({
        files: [declaredFile("memory_summary.md", content)],
        archive: tarGz([{ path: "memory_summary.md", content }]),
      });
      failNextObjectRead(
        objectKind === "manifest" ? version.manifestKey : version.archiveKey,
      );

      await expect(run(version)).resolves.toMatchObject({
        claimed: 1,
        retried: 1,
        ready: 0,
      });
      const pending = await inspect(version);
      expect(pending).toMatchObject({
        status: "pending",
        attempt_count: 1,
        last_error_class: "TimeoutError",
        has_content: false,
      });
      expect(new Date(pending?.available_at ?? 0).getTime()).toBeGreaterThan(
        now() - 100,
      );

      await stateAction({ action: "make-due", ...projectionScope(version) });
      await expect(run(version)).resolves.toMatchObject({
        claimed: 1,
        ready: 1,
      });
      await expect(inspect(version)).resolves.toMatchObject({
        status: "ready",
        attempt_count: 2,
        last_error_class: null,
      });
    },
  );

  it("leaves missing projections unchanged until the background worker backfills them", async () => {
    const content = Buffer.from("lazy projection", "utf8");
    const version = await publishVersion({
      files: [declaredFile("memory_summary.md", content)],
      archive: tarGz([{ path: "memory_summary.md", content }]),
    });
    await stateAction({ action: "delete", ...projectionScope(version) });
    await expect(
      run(version, new Date("2000-01-01T00:00:00.000Z")),
    ).resolves.toMatchObject({
      backfilled: 1,
      claimed: 1,
      ready: 1,
    });

    await stateAction({ action: "delete", ...projectionScope(version) });
    context.mocks.s3.send.mockClear();
    await expect(read(version)).resolves.toBeNull();
    expect(downloadedObjectKeys()).toStrictEqual([]);
    await expect(inspect(version)).resolves.toBeNull();
    await expect(run(version)).resolves.toMatchObject({
      backfilled: 1,
      claimed: 1,
      ready: 1,
    });
    await expect(read(version)).resolves.toMatchObject({
      content: content.toString("utf8"),
    });
  });

  it("materializes a full source above the prompt injection budget", async () => {
    const summary = Buffer.from(
      `v1\n## User Profile\n${" token".repeat(2936)}`,
      "utf8",
    );
    const tokenCount = encode(summary.toString("utf8")).length;
    expect(tokenCount).toBe(2943);
    expect(summary.length).toBeLessThanOrEqual(64 * 1024);
    const declared = declaredFile("memory_summary.md", summary);
    const version = await publishVersion({
      files: [declared],
      archive: tarGz([{ path: "memory_summary.md", content: summary }]),
    });

    await expect(run(version)).resolves.toMatchObject({ ready: 1 });

    // The stored projection describes the complete source; the runtime renderer
    // is the only place that applies the 2500-token injection budget.
    await expect(inspect(version)).resolves.toMatchObject({
      status: "ready",
      last_error_class: null,
      source_hash: declared.hash,
      source_size: summary.length,
      token_count: tokenCount,
    });
    await expect(read(version)).resolves.toMatchObject({
      content: summary.toString("utf8"),
      source_hash: declared.hash,
      source_size: summary.length,
      token_count: tokenCount,
    });
  });
});
