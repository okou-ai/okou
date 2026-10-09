import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import type { StorageManifest } from "@okouai/api-contracts/contracts/runners";
import { MEMORY_ARTIFACT_NAME } from "@okouai/core/storage-names";
import { Header } from "tar";

import type { TestContext } from "../../../../__tests__/test-context";
import { expectCanonicalStorageManifest } from "./api-bdd-runs";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";

interface MemoryFile {
  readonly path: string;
  readonly content: string | Buffer;
}

/** Publish only to the writable memory mount issued by an actual Runner claim. */
export async function commitMemoryVersion(
  context: TestContext,
  run: {
    readonly runId: string;
    readonly sandboxHeaders: { readonly authorization: string };
    readonly storageManifest: StorageManifest | null | undefined;
  },
  files: readonly MemoryFile[],
): Promise<{ readonly storageId: string; readonly versionId: string }> {
  const memory = expectCanonicalStorageManifest(
    run.storageManifest,
  )?.storageMounts.find((mount) => {
    return mount.name === MEMORY_ARTIFACT_NAME && mount.writeback;
  });
  if (!memory) {
    throw new Error("Expected the claimed Run's writable memory mount");
  }
  const blocks: Buffer[] = [];
  const entries = files.map((file) => {
    const content = Buffer.from(file.content);
    const header = Buffer.alloc(512);
    new Header({
      path: file.path,
      size: content.length,
      type: "File",
      mode: 0o644,
    }).encode(header);
    blocks.push(
      header,
      content,
      Buffer.alloc((512 - (content.length % 512)) % 512),
    );
    return {
      path: file.path,
      hash: createHash("sha256").update(content).digest("hex"),
      size: content.length,
    };
  });
  blocks.push(Buffer.alloc(1024));
  const archive = gzipSync(Buffer.concat(blocks));
  const manifest = Buffer.from(
    JSON.stringify({
      version: 1,
      files: entries,
      createdAt: new Date(0).toISOString(),
    }),
  );
  const webhooks = createWebhookCallbackApi(context);
  const prepared = await webhooks.requestAgentStoragePrepare(
    {
      runId: run.runId,
      storageId: memory.storageId,
      parentVersionId: memory.versionId,
      files: entries,
    },
    run.sandboxHeaders,
    [200],
  );
  if (prepared.status !== 200 || !prepared.body.uploads) {
    throw new Error("Expected actual memory upload authorization");
  }
  // Model the external object store at the exact keys authorized by prepare.
  // These are SHA-matching manifest/archive bytes, not arbitrary row identities.
  const objects = new Map([
    [prepared.body.uploads.archive.key, archive],
    [prepared.body.uploads.manifest.key, manifest],
  ]);
  const fallback = context.mocks.s3.send.getMockImplementation();
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (
      command instanceof HeadObjectCommand ||
      command instanceof GetObjectCommand
    ) {
      const bytes = objects.get(command.input.Key ?? "");
      if (bytes) {
        if (command instanceof HeadObjectCommand) {
          return Promise.resolve({ ContentLength: bytes.length });
        }
        return Promise.resolve({
          ContentLength: bytes.length,
          Body: {
            async *[Symbol.asyncIterator]() {
              yield bytes;
            },
            transformToByteArray: () => {
              return Promise.resolve(bytes);
            },
          },
        });
      }
    }
    if (!fallback) {
      throw new Error("Expected the existing object store boundary mock");
    }
    return fallback(command);
  });
  const committed = await webhooks.requestAgentStorageCommit(
    {
      runId: run.runId,
      storageId: memory.storageId,
      parentVersionId: memory.versionId,
      versionId: prepared.body.versionId,
      files: entries,
    },
    run.sandboxHeaders,
    [200],
  );
  if (committed.status !== 200) {
    throw new Error("Expected Run-authorized memory publication");
  }
  return { storageId: memory.storageId, versionId: committed.body.versionId };
}
