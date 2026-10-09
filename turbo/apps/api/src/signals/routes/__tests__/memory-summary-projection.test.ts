import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { MEMORY_ARTIFACT_NAME } from "@okouai/core/storage-names";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { env, mockEnv } from "../../../lib/env";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import type { BddStorageFileEntry } from "./helpers/api-bdd-storage-files";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import {
  createRunsApi,
  expectCanonicalStorageManifest,
} from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { flushWaitUntilForTest } from "../../context/wait-until";

const context = testContext();
const BUCKET = "memory-summary-projection-test";
const TAR_BLOCK_SIZE = 512;

interface TarEntry {
  readonly path: string;
  readonly content: Buffer;
}

interface PublishedVersion {
  readonly runId: string;
  readonly sandboxHeaders: { readonly authorization: string };
  readonly memoryStorageId: string;
  readonly storageVersionId: string;
  readonly files: readonly BddStorageFileEntry[];
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
  const content = entry.content;
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  header.write(entry.path, 0, 100, "utf8");
  writeTarNumber(header, 100, 8, 0o644);
  writeTarNumber(header, 108, 8, 0);
  writeTarNumber(header, 116, 8, 0);
  writeTarNumber(header, 124, 12, content.length);
  writeTarNumber(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
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
    const content = entry.content;
    blocks.push(tarHeader(entry));
    blocks.push(content);
    const padding =
      (TAR_BLOCK_SIZE - (content.length % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
    if (padding > 0) {
      blocks.push(Buffer.alloc(padding));
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

// Memory ownership and writes come from a real claimed native Run.
async function publishVersion(args: {
  readonly files: readonly BddStorageFileEntry[];
  readonly archive: Buffer;
}): Promise<PublishedVersion> {
  const fixture = createChatEventsFixture(context);
  const { actor, agentId, runnerGroup } = await fixture.entitledChatActor();
  const storage = context.mocks.s3.send.getMockImplementation();
  const signedUrl = context.mocks.s3.getSignedUrl.getMockImplementation();
  const kmsKeyId = env("SECRETS_KMS_KEY_ID");

  const carrier: {
    actor: ApiTestUser;
    agentId: string;
    runId?: string;
    sandboxToken?: string;
    restoreStorage: () => void;
  } = {
    actor,
    agentId,
    restoreStorage() {
      mockEnv("SECRETS_KMS_KEY_ID", kmsKeyId);
      mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
      if (storage) {
        context.mocks.s3.send.mockImplementation(storage);
      }
      if (signedUrl) {
        context.mocks.s3.getSignedUrl.mockImplementation(signedUrl);
      }
    },
  };
  onTestFinished(async () => {
    carrier.restoreStorage();
    context.mocks.ably.publish.mockResolvedValue(undefined);
    const runs = createRunsApi(context);
    runs.acceptTelemetryIngest();
    if (carrier.runId) {
      const run = await runs.readRun(carrier.actor, carrier.runId);
      if (run.status === "pending" || run.status === "running") {
        await runs.requestCancelRun(carrier.actor, carrier.runId, [200]);
      }
      if (
        carrier.sandboxToken &&
        ["pending", "running", "cancelled"].includes(run.status)
      ) {
        await createWebhookCallbackApi(context).requestAgentComplete(
          {
            runId: carrier.runId,
            exitCode: 1,
            error: "Memory projection carrier cancelled",
          },
          { authorization: `Bearer ${carrier.sandboxToken}` },
          [200],
        );
      }
    }
    await flushWaitUntilForTest();
    await createBddApi(context).deleteAgent(carrier.actor, carrier.agentId);
    await flushWaitUntilForTest();
  });
  await fixture.api.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
  const run = await fixture.sendChatRun(actor, {
    agentId,
    prompt: "Write the owned memory projection source",
    model: "claude-fable-5-1",
  });
  carrier.runId = run.runId;
  const claimed = await fixture.claimChatRun(runnerGroup, run.runId);
  carrier.sandboxToken = claimed.claim.sandboxToken;
  const manifest = expectCanonicalStorageManifest(
    claimed.claim.storageManifest,
  );
  const memory = manifest?.storageMounts.find((mount) => {
    return mount.name === MEMORY_ARTIFACT_NAME && mount.storageId;
  });
  if (!memory) {
    throw new Error("Expected an actual writable memory mount");
  }
  installS3Objects();
  const preparedResponse = await fixture.webhooks.requestAgentStoragePrepare(
    {
      runId: run.runId,
      storageId: memory.storageId,
      files: [...args.files],
    },
    claimed.sandboxHeaders,
    [200],
  );
  if (preparedResponse.status !== 200) {
    throw new Error("Expected Storage prepare success");
  }
  const prepared = preparedResponse.body;
  if (!prepared.uploads) {
    throw new Error("Expected a new Storage version with upload targets");
  }
  const archiveKey = prepared.uploads.archive.key;
  const manifestKey = prepared.uploads.manifest.key;
  context.sessionHistoryBlobs.set(archiveKey, args.archive);
  context.sessionHistoryBlobs.set(manifestKey, canonicalManifest(args.files));
  const committed = await fixture.webhooks.requestAgentStorageCommit(
    {
      runId: run.runId,
      storageId: memory.storageId,
      versionId: prepared.versionId,
      files: [...args.files],
    },
    claimed.sandboxHeaders,
    [200],
  );
  if (committed.status !== 200) {
    throw new Error("Expected Storage commit success");
  }
  expect(committed.body.versionId).toBe(prepared.versionId);
  return {
    runId: run.runId,
    sandboxHeaders: claimed.sandboxHeaders,
    memoryStorageId: memory.storageId,
    storageVersionId: committed.body.versionId,
    files: [...args.files],
  };
}

beforeEach(() => {
  context.sessionHistoryBlobs.clear();
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
  installS3Objects();
});

describe("Runner memory publication", () => {
  it("deduplicates memory publication through the claimed Run's upload authorization", async () => {
    const summary = Buffer.from("summary with stable logical contents", "utf8");
    const version = await publishVersion({
      files: [declaredFile("memory_summary.md", summary)],
      archive: tarGz([{ path: "memory_summary.md", content: summary }]),
    });
    const repeated = await createWebhookCallbackApi(
      context,
    ).requestAgentStoragePrepare(
      {
        runId: version.runId,
        storageId: version.memoryStorageId,
        files: [...version.files],
      },
      version.sandboxHeaders,
      [200],
    );
    expect(repeated.body).toStrictEqual({
      versionId: version.storageVersionId,
      existing: true,
    });
  });
});
