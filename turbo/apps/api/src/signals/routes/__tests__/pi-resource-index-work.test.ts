import { randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { testPiResourceIndexWorkContract } from "@okouai/api-contracts/contracts/test-pi-resource-index-work";
import { workflowsCollectionContract } from "@okouai/api-contracts/contracts/workflows";
import { getCustomSkillStorageName } from "@okouai/core/storage-names";
import { synthesizeWorkflowSkillMd } from "@okouai/core/skill-document";
import { Header } from "tar";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { prepareUnpublishedPiVolumeFixture } from "../../../test-fixtures/pi-resource-index";
import { createDeferredPromise } from "../../utils";
import { testPiResourceIndexWorkRoutes } from "../test-pi-resource-index-work";
import { workflowsRoutes } from "../workflows";
import { createBddApi } from "./helpers/api-bdd";
import { storageTextFile } from "./helpers/api-bdd-storage-files";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const storages = createStoragesBddApi(context);

function skillArchive(content: string): Buffer {
  const bytes = Buffer.from(content);
  const header = Buffer.alloc(512);
  new Header({
    path: "SKILL.md",
    size: bytes.length,
    type: "File",
    mode: 0o644,
  }).encode(header);
  return gzipSync(
    Buffer.concat([
      header,
      bytes,
      Buffer.alloc((512 - (bytes.length % 512)) % 512),
      Buffer.alloc(1024),
    ]),
  );
}

async function publishStorage() {
  const actor = bdd.user();
  const storageName = `resource-index-${randomUUID()}`;
  const content =
    "---\nname: index-work\ndescription: Index a committed Storage version\n---\n";
  const archive = skillArchive(content);
  context.mocks.s3.getSignedUrl.mockResolvedValue(
    "https://r2.example.com/resource-index-upload",
  );
  context.mocks.s3.send.mockImplementation((request: unknown) => {
    if (request instanceof GetObjectCommand) {
      return Promise.resolve({
        Body: {
          async *[Symbol.asyncIterator]() {
            yield archive;
          },
        },
        ContentLength: archive.length,
      });
    }
    return Promise.resolve({ ContentLength: archive.length });
  });
  const files = [storageTextFile("SKILL.md", content)];
  const prepared = await storages.prepareStorage(actor, {
    storageName,
    storageOwner: "user",
    files,
  });
  await storages.commitStorage(actor, {
    storageName,
    storageOwner: "user",
    files,
    versionId: prepared.versionId,
  });
  return { versionId: prepared.versionId, archive, actor, storageName, files };
}

async function run(versionId: string) {
  const result = await accept(
    setupApp({ context, routes: testPiResourceIndexWorkRoutes })(
      testPiResourceIndexWorkContract,
    ).run({ body: { versionIds: [versionId] } }),
    [200],
  );
  return result.body;
}

describe("Pi resource indexing of generic Storage commits", () => {
  it("invalidates a worker lease when server-side encoding repair finishes without HEAD publication", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, { displayName: "Repair owner" });
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped actor");
    }
    const objects = new Map<string, Buffer>();
    const entered = createDeferredPromise<void>(context.signal);
    const released = createDeferredPromise<void>(context.signal);
    let holdRead = false;
    context.mocks.s3.send.mockImplementation(async (request: unknown) => {
      if (request instanceof PutObjectCommand) {
        const { Key: key, Body: body } = request.input;
        if (!key || !(typeof body === "string" || body instanceof Uint8Array)) {
          throw new Error("Expected a storage object");
        }
        objects.set(key, Buffer.from(body));
        return {};
      }
      if (
        request instanceof GetObjectCommand ||
        request instanceof HeadObjectCommand
      ) {
        const body = request.input.Key
          ? objects.get(request.input.Key)
          : undefined;
        if (!body) {
          throw Object.assign(new Error("Missing object"), {
            name: "NotFound",
            $metadata: { httpStatusCode: 404 },
          });
        }
        if (holdRead && request instanceof GetObjectCommand) {
          holdRead = false;
          entered.resolve(undefined);
          await released.promise;
        }
        return {
          ContentLength: body.length,
          Body: {
            async *[Symbol.asyncIterator]() {
              yield body;
            },
          },
        };
      }
      return {};
    });
    const definition = {
      name: `repair-${randomUUID().slice(0, 8)}`,
      description: "Repair a workflow resource",
      instruction: "Produce a report.",
    };
    createRouteMocks(context).clerk.session(
      actor.userId,
      actor.orgId,
      actor.orgRole,
    );
    const created = await accept(
      setupApp({ context, routes: workflowsRoutes })(
        workflowsCollectionContract,
      ).create({
        headers: { authorization: "Bearer clerk-session" },
        body: { agentId: agent.agentId, ...definition },
      }),
      [201],
    );
    const storageName = getCustomSkillStorageName(created.body.id);
    const content = synthesizeWorkflowSkillMd(definition);
    const files = [storageTextFile("SKILL.md", content)];
    const prepared = await storages.prepareStorage(actor, {
      storageName,
      storageOwner: "organization",
      files,
    });
    const archiveEntry = [...objects].find(([key]) => {
      return key.endsWith(`/${prepared.versionId}/archive.tar.gz`);
    });
    if (!archiveEntry) {
      throw new Error("Expected the published workflow archive");
    }
    const [archiveKey, canonicalArchive] = archiveEntry;
    const previousEncoding = gzipSync(gunzipSync(canonicalArchive), {
      level: 0,
    });
    expect(previousEncoding).not.toHaveLength(canonicalArchive.length);
    objects.set(archiveKey, previousEncoding);
    await storages.commitStorage(actor, {
      storageName,
      storageOwner: "organization",
      files,
      versionId: prepared.versionId,
    });
    holdRead = true;
    const previousWorker = run(prepared.versionId);
    onTestFinished(async () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
      await previousWorker;
    });
    await entered.promise;
    objects.delete(archiveKey);
    // The API cannot pause after preparation but before commit. Model that
    // interruption without publishing HEAD; all other steps use real routes.
    await prepareUnpublishedPiVolumeFixture(
      {
        orgId: actor.orgId,
        storageName,
        piResourceIndex: true,
        files: [{ path: "SKILL.md", content }],
      },
      context.signal,
    );
    released.resolve(undefined);
    await expect(previousWorker).resolves.toMatchObject({ ready: 0, stale: 1 });
    await expect(run(prepared.versionId)).resolves.toMatchObject({
      claimed: 1,
      ready: 1,
    });
  });

  it("materializes committed work once and reuses the completed index", async () => {
    const { versionId } = await publishStorage();
    await expect(run(versionId)).resolves.toMatchObject({
      claimed: 1,
      ready: 1,
      retried: 0,
    });
    await expect(run(versionId)).resolves.toMatchObject({
      claimed: 0,
      ready: 0,
    });
  });

  it("rebuilds an index when Storage repairs the archive encoding for the same version", async () => {
    const published = await publishStorage();
    await expect(run(published.versionId)).resolves.toMatchObject({ ready: 1 });
    const repaired = gzipSync(gunzipSync(published.archive), { level: 0 });
    context.mocks.s3.send.mockImplementation((request: unknown) => {
      if (request instanceof GetObjectCommand) {
        return Promise.resolve({
          ContentLength: repaired.length,
          Body: {
            async *[Symbol.asyncIterator]() {
              yield repaired;
            },
          },
        });
      }
      return Promise.resolve({ ContentLength: repaired.length });
    });
    await storages.commitStorage(published.actor, {
      storageName: published.storageName,
      storageOwner: "user",
      files: published.files,
      versionId: published.versionId,
    });
    await expect(run(published.versionId)).resolves.toMatchObject({
      claimed: 1,
      ready: 1,
    });
    await expect(run(published.versionId)).resolves.toMatchObject({
      claimed: 0,
    });
  });

  it("keeps an invalid archive out of the ready index set without rejecting its Storage commit", async () => {
    const { versionId, archive } = await publishStorage();
    context.mocks.s3.send.mockImplementation((request: unknown) => {
      if (request instanceof GetObjectCommand) {
        return Promise.resolve({
          ContentLength: archive.length,
          Body: {
            async *[Symbol.asyncIterator]() {
              yield Buffer.alloc(archive.length);
            },
          },
        });
      }
      return Promise.resolve({});
    });
    await expect(run(versionId)).resolves.toMatchObject({
      claimed: 1,
      ready: 0,
      unindexable: 1,
    });
    await expect(run(versionId)).resolves.toMatchObject({ claimed: 0 });
  });

  it("retries a failed object read after its bounded backoff", async () => {
    const { versionId } = await publishStorage();
    const original = context.mocks.s3.send.getMockImplementation();
    let fail = true;
    context.mocks.s3.send.mockImplementation((request: unknown) => {
      if (fail && request instanceof GetObjectCommand) {
        fail = false;
        return Promise.reject(new Error("Temporary object store failure"));
      }
      if (!original) {
        throw new Error("Expected the test object store");
      }
      return original(request);
    });
    await expect(run(versionId)).resolves.toMatchObject({
      claimed: 1,
      retried: 1,
    });
    await expect(run(versionId)).resolves.toMatchObject({ claimed: 0 });
    mockNow(now() + 11_000);
    onTestFinished(clearMockNow);
    await expect(run(versionId)).resolves.toMatchObject({
      claimed: 1,
      ready: 1,
    });
  });

  it("reclaims expired work and prevents its old owner from publishing", async () => {
    const { versionId } = await publishStorage();
    const original = context.mocks.s3.send.getMockImplementation();
    const entered = createDeferredPromise<void>(context.signal);
    const released = createDeferredPromise<void>(context.signal);
    let hold = true;
    context.mocks.s3.send.mockImplementation(async (request: unknown) => {
      if (hold && request instanceof GetObjectCommand) {
        hold = false;
        entered.resolve(undefined);
        await released.promise;
      }
      if (!original) {
        throw new Error("Expected the test object store");
      }
      return await original(request);
    });
    const first = run(versionId);
    await entered.promise;
    await expect(run(versionId)).resolves.toMatchObject({ claimed: 0 });
    mockNow(now() + 5 * 60_000 + 1);
    onTestFinished(clearMockNow);
    await expect(run(versionId)).resolves.toMatchObject({
      claimed: 1,
      ready: 1,
    });
    released.resolve(undefined);
    await expect(first).resolves.toMatchObject({
      claimed: 1,
      ready: 0,
      stale: 1,
    });
  });
});
