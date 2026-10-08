import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { testPiResourceIndexWorkContract } from "@okouai/api-contracts/contracts/test-pi-resource-index-work";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
} from "@okouai/api-contracts/contracts/workflows";
import { getCustomSkillStorageName } from "@okouai/core/storage-names";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { alterRegisteredVolumeIndexFixture } from "../../../test-fixtures/registered-volume-index";
import { testPiResourceIndexWorkRoutes } from "../test-pi-resource-index-work";
import { workflowsRoutes } from "../workflows";
import { createBddApi } from "./helpers/api-bdd";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const storages = createStoragesBddApi(context);

function installObjectStore() {
  const objects = new Map<string, Buffer>();
  context.mocks.s3.send.mockImplementation((request: unknown) => {
    if (request instanceof PutObjectCommand) {
      const { Key: key, Body: body } = request.input;
      if (!key || !(typeof body === "string" || body instanceof Uint8Array)) {
        throw new Error("Expected a Storage object");
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
        return Promise.reject(
          Object.assign(new Error("Missing object"), {
            name: "NotFound",
            $metadata: { httpStatusCode: 404 },
          }),
        );
      }
      return Promise.resolve({
        ContentLength: body.length,
        Body: Readable.from([body]),
      });
    }
    return Promise.resolve({});
  });
}

function detailClient(rethrowErrors = false) {
  return setupApp({ context, routes: workflowsRoutes, rethrowErrors })(
    workflowsDetailContract,
  );
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

async function createVolume() {
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped actor");
  }
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(actor, {
    displayName: "Ready index owner",
  });
  installObjectStore();
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  const headers = { authorization: "Bearer clerk-session" };
  const definition = {
    name: `index-reuse-${randomUUID().slice(0, 8)}`,
    description: "Canonical indexed workflow resources",
    instruction: "Keep the first exact revision.",
  };
  const files = [
    { path: "./AGENTS.md", content: "Normalized instructions" },
    { path: "AGENTS.md", content: "Canonical instructions: 世界" },
    { path: "notes.txt", content: "First duplicate" },
    { path: "notes.txt", content: "Last duplicate" },
    { path: "assets/icon.txt", content: "Non-discovery asset" },
  ];
  const created = await accept(
    setupApp({ context, routes: workflowsRoutes })(
      workflowsCollectionContract,
    ).create({
      headers,
      body: { agentId: agent.agentId, ...definition, files },
    }),
    [201],
  );
  const workflowId = created.body.id;
  const storageName = getCustomSkillStorageName(workflowId);
  const download = () => {
    return storages.downloadStorage(actor, {
      name: storageName,
      owner: "organization",
    });
  };
  const read = () => {
    return accept(
      detailClient().get({ headers, params: { workflowId } }),
      [200],
    );
  };
  const update = (
    instruction = definition.instruction,
    attachedFiles = files,
  ) => {
    return detailClient().update({
      headers,
      params: { workflowId },
      body: { instruction, files: attachedFiles },
    });
  };
  // Corrupt ready rows are infrastructure-only states; surface the real route's
  // invariant error rather than assert the app's generic, untyped HTTP 500.
  const rejectedUpdate = () => {
    return detailClient(true).update({
      headers,
      params: { workflowId },
      body: { instruction: definition.instruction, files },
    });
  };
  const firstVersion = await download();
  const original = await read();
  const fixture = {
    orgId: actor.orgId,
    storageName,
    versionId: firstVersion.versionId,
  };
  return {
    actor,
    definition,
    files,
    download,
    read,
    update,
    rejectedUpdate,
    original,
    firstVersion,
    fixture,
  };
}

describe("Registered workflow volume index reuse", () => {
  it("publishes A-B-A with exact canonical content and no ready-index requeue", async () => {
    const volume = await createVolume();
    const secondInstruction = "Publish the second exact revision.";
    await accept(volume.update(secondInstruction), [200]);
    const second = await volume.download();
    expect(second.versionId).not.toBe(volume.firstVersion.versionId);

    context.mocks.s3.send.mockClear();
    await accept(
      volume.update(volume.definition.instruction, [...volume.files].reverse()),
      [200],
    );
    await expect(volume.download()).resolves.toStrictEqual(volume.firstVersion);
    expect((await volume.read()).body).toMatchObject({
      instruction: volume.definition.instruction,
      fileContents: volume.original.body.fileContents,
    });
    await expect(run(volume.firstVersion.versionId)).resolves.toMatchObject({
      claimed: 0,
    });
    await expect(run(second.versionId)).resolves.toMatchObject({ claimed: 0 });
    expect(
      context.mocks.s3.send.mock.calls.some(([request]) => {
        return (
          request instanceof PutObjectCommand ||
          request instanceof HeadObjectCommand
        );
      }),
    ).toBeFalsy();
    // Public APIs cannot corrupt a ready projection. Change only this owned
    // historical index after reuse; the real next publication must reject it.
    await alterRegisteredVolumeIndexFixture(
      { ...volume.fixture, state: "corrupt-hash" },
      context.signal,
    );
    await expect(volume.rejectedUpdate()).rejects.toThrow(
      "Pi resource version index failed integrity validation",
    );
  });

  it.each(["missing", "other-extractor"] as const)(
    "canonically prepares a registered %s index without changing the version",
    async (state) => {
      const volume = await createVolume();
      await alterRegisteredVolumeIndexFixture(
        { ...volume.fixture, state },
        context.signal,
      );
      await accept(
        volume.update(
          volume.definition.instruction,
          [...volume.files].reverse(),
        ),
        [200],
      );
      await expect(volume.download()).resolves.toStrictEqual(
        volume.firstVersion,
      );
      expect((await volume.read()).body.fileContents).toStrictEqual(
        volume.original.body.fileContents,
      );
      await expect(run(volume.firstVersion.versionId)).resolves.toMatchObject({
        claimed: 0,
      });
      // Only a newly completed current-extractor ready index permits this
      // infrastructure mutation; the next real publication must reject it.
      await alterRegisteredVolumeIndexFixture(
        { ...volume.fixture, state: "corrupt-hash" },
        context.signal,
      );
      await expect(volume.rejectedUpdate()).rejects.toThrow(
        "Pi resource version index failed integrity validation",
      );
    },
  );

  it.each(["corrupt-hash", "corrupt-shape", "conflicting-key"] as const)(
    "rejects %s instead of silently rebuilding a registered ready version",
    async (state) => {
      const volume = await createVolume();
      await accept(volume.update("Keep the newer HEAD."), [200]);
      const second = await volume.download();
      await alterRegisteredVolumeIndexFixture(
        { ...volume.fixture, state },
        context.signal,
      );
      await expect(volume.rejectedUpdate()).rejects.toThrow(
        state === "corrupt-hash"
          ? "Pi resource version index failed integrity validation"
          : state === "corrupt-shape"
            ? "Invalid input: expected 1"
            : "conflicts with prepared metadata",
      );
      await expect(volume.download()).resolves.toStrictEqual(second);
      await expect(run(second.versionId)).resolves.toMatchObject({
        claimed: 0,
      });
    },
  );
});
