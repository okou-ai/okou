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
import {
  CANONICAL_WORKING_DIR,
  PI_AGENT_DIR,
} from "@okouai/api-contracts/contracts/runners";
import { synthesizeWorkflowSkillMd } from "@okouai/core/skill-document";
import { http, HttpResponse } from "msw";
import { Header } from "tar";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import {
  prepareEmptyPiWritebackSnapshotFixture,
  prepareRegisteredPiResourceSnapshotFixture,
  prepareUnpublishedPiVolumeFixture,
  publishEmptyPiVolumeFixture,
} from "../../../test-fixtures/pi-resource-index";
import {
  readPiStableContextStorageDemandFixture,
  seedPiStableContextStorageDemandFixture,
} from "../../../test-fixtures/pi-stable-context";
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
  it("builds stable context when a captured gzip hint differs from the ready index", async () => {
    const published = await publishStorage();
    if (!published.actor.orgId) {
      throw new Error("Expected an organization-scoped actor");
    }
    await expect(run(published.versionId)).resolves.toMatchObject({
      claimed: 1,
      ready: 1,
    });
    const agent = await bdd.createAgent(published.actor, {
      displayName: "Stale gzip hint agent",
    });
    // An earlier API could update a version's archive size after this demand
    // captured it. The index still represents the same logical file content.
    const headId = await seedPiStableContextStorageDemandFixture({
      orgId: published.actor.orgId,
      userId: published.actor.userId,
      agentId: agent.agentId,
      storageName: published.storageName,
      versionId: published.versionId,
      archiveSize: published.archive.length + 1,
    });
    const result = await accept(
      setupApp({ context, routes: testPiResourceIndexWorkRoutes })(
        testPiResourceIndexWorkContract,
      ).run({
        body: {
          versionIds: [published.versionId],
          stableContextOwner: {
            orgId: published.actor.orgId,
            userId: published.actor.userId,
            agentId: agent.agentId,
          },
        },
      }),
      [200],
    );
    expect(result.body.stableContext).toMatchObject({ failed: 0 });
    await expect(
      readPiStableContextStorageDemandFixture(headId),
    ).resolves.toMatchObject({
      status: "ready",
      artifactDigest: expect.any(String),
    });
  });

  it("keeps an archive-less empty writeback empty after its index is ready", async () => {
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped actor");
    }
    const versionId = await publishEmptyPiVolumeFixture(
      {
        orgId: actor.orgId,
        storageName: `empty-resource-index-${randomUUID()}`,
      },
      context.signal,
    );
    await expect(run(versionId)).resolves.toMatchObject({
      claimed: 1,
      ready: 1,
    });

    await expect(
      prepareEmptyPiWritebackSnapshotFixture(
        versionId,
        CANONICAL_WORKING_DIR,
        context.signal,
      ),
    ).resolves.toMatchObject({
      snapshot: { schemaVersion: 1, agentsFiles: [], skills: [] },
    });
  });

  it("does not requeue a ready index when reusing a registered volume", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, { displayName: "Repair owner" });
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped actor");
    }
    const objects = new Map<string, Buffer>();
    context.mocks.s3.send.mockImplementation((request: unknown) => {
      if (request instanceof PutObjectCommand) {
        const { Key: key, Body: body } = request.input;
        if (!key || !(typeof body === "string" || body instanceof Uint8Array)) {
          throw new Error("Expected a storage object");
        }
        objects.set(key, Buffer.from(body));
        return Promise.resolve({});
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
        return Promise.resolve({
          ContentLength: body.length,
          Body: {
            async *[Symbol.asyncIterator]() {
              yield body;
            },
          },
        });
      }
      return Promise.resolve({});
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
    await expect(run(prepared.versionId)).resolves.toMatchObject({
      claimed: 0,
    });
    const putCount = context.mocks.s3.send.mock.calls.filter(([command]) => {
      return command instanceof PutObjectCommand;
    }).length;
    await prepareUnpublishedPiVolumeFixture(
      {
        orgId: actor.orgId,
        storageName,
        piResourceIndex: true,
        files: [{ path: "SKILL.md", content }],
      },
      context.signal,
    );
    expect(
      context.mocks.s3.send.mock.calls.filter(([command]) => {
        return command instanceof PutObjectCommand;
      }),
    ).toHaveLength(putCount);
    await expect(run(prepared.versionId)).resolves.toMatchObject({
      claimed: 0,
    });
  });

  it("prepares a snapshot from a different gzip size and reuses the logical index", async () => {
    const published = await publishStorage();
    if (!published.actor.orgId) {
      throw new Error("Expected an organization-scoped actor");
    }
    const recompressed = gzipSync(gunzipSync(published.archive), { level: 0 });
    expect(recompressed).not.toHaveLength(published.archive.length);
    const archiveUrl = `https://storage.example/${randomUUID()}/alternate-gzip.tar.gz`;
    let archiveGets = 0;
    server.use(
      http.get(archiveUrl, () => {
        archiveGets++;
        return new HttpResponse(new Uint8Array(recompressed), {
          status: 200,
          headers: { "content-length": String(recompressed.length) },
        });
      }),
    );
    const snapshot = {
      orgId: published.actor.orgId,
      userId: published.actor.userId,
      storageName: published.storageName,
      versionId: published.versionId,
      mountPath: `${PI_AGENT_DIR}/skills/index-work`,
      archiveUrl,
    };
    const first = await prepareRegisteredPiResourceSnapshotFixture(
      { ...snapshot, archiveSize: published.archive.length },
      context.signal,
    );
    expect(first.snapshot.skills).toStrictEqual([
      expect.objectContaining({
        name: "index-work",
        description: "Index a committed Storage version",
        filePath: `${PI_AGENT_DIR}/skills/index-work/SKILL.md`,
      }),
    ]);
    const second = await prepareRegisteredPiResourceSnapshotFixture(
      { ...snapshot, archiveSize: 1 },
      context.signal,
    );
    expect(second.snapshot).toStrictEqual(first.snapshot);
    expect(archiveGets).toBe(1);
  });
});
