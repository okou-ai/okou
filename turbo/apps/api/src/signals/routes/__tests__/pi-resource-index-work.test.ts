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
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { prepareUnpublishedPiVolumeFixture } from "../../../test-fixtures/pi-resource-index";
import { testPiResourceIndexWorkRoutes } from "../test-pi-resource-index-work";
import { workflowsRoutes } from "../workflows";
import { createBddApi } from "./helpers/api-bdd";
import { storageTextFile } from "./helpers/api-bdd-storage-files";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const storages = createStoragesBddApi(context);

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
});
