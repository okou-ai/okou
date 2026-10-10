import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { featureSwitchesRoutes } from "../feature-switches";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  createChatEventsFixture,
  okouTokenFromClaim,
} from "./helpers/chat-events-fixture";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const fixture = createChatEventsFixture(context);

async function claimedUpload(options: { readonly stage?: boolean } = {}) {
  const actor = bdd.user();
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
  const features = setupApp({
    context,
    routes: featureSwitchesRoutes,
  })(featureSwitchesContract);
  await accept(
    features.update({
      headers: { authorization: "Bearer clerk-session" },
      body: { switches: { privateArtifacts: false } },
    }),
    [200],
  );
  const owner = await fixture.entitledNativeChatActor(actor);
  const run = await fixture.sendChatRun(actor, {
    agentId: owner.agentId,
    prompt: "Publish an uploaded report",
  });
  const { claim, sandboxHeaders } = await fixture.claimChatRun(
    owner.runnerGroup,
    run.runId,
  );
  const bearer = `Bearer ${okouTokenFromClaim(claim)}`;
  const prepared = await accept(
    setupApp({ context, routes: uploadsPrepareRoutes })(
      uploadsContract,
    ).prepare({
      headers: { authorization: bearer },
      body: {
        filename: "report.txt",
        contentType: "text/plain",
        size: 7,
        purpose: "artifact",
      },
    }),
    [200],
  );
  const storage = fixture.chatCallbacks.acceptChatObjectStorage();
  const object = {
    bucket: "test-user-artifacts",
    key: `artifacts${new URL(prepared.body.url).pathname}`,
    size: 7,
    contentType: "text/plain",
    metadata: {
      "artifact-id": prepared.body.id,
      filename: "report.txt",
      "public-brand": "okou",
      "user-id": encodeURIComponent(actor.userId),
    },
  };
  let staged = false;
  const stage = (size: number) => {
    object.size = size;
    if (!staged) {
      storage.addObject(object);
      staged = true;
    }
  };
  if (options.stage !== false) {
    stage(7);
  }
  return {
    actor,
    owner,
    run,
    bearer,
    sandboxHeaders,
    prepared: prepared.body,
    stage,
  };
}

test("keeps one file identity and captured owner across concurrent replay and metadata updates", async () => {
  const upload = await claimedUpload();
  const complete = (contentType = "text/plain") => {
    return chat.completeUploadWithBearer(
      upload.bearer,
      { id: upload.prepared.id, contentType },
      [200],
    );
  };
  const [first, replay] = await Promise.all([complete(), complete()]);
  expect(replay.body).toStrictEqual(first.body);
  const before = await chat.listThreadArtifacts(
    upload.actor,
    upload.run.threadId,
  );
  const original = before.runs.flatMap((run) => {
    return run.files;
  });
  expect(original).toMatchObject([{ filename: "report.txt", size: 7 }]);
  expect(original).toHaveLength(1);
  const originalCatalog = await chat.listArtifactCatalog(upload.actor, {
    chatThreadId: upload.run.threadId,
  });
  const artifactId = originalCatalog.artifacts[0]?.id;
  if (!artifactId) {
    throw new Error("Expected the completed artifact in the owner's catalog");
  }
  const originalDetail = await chat.getArtifactCatalogEntry(
    upload.actor,
    artifactId,
  );
  if (originalDetail.kind !== "file") {
    throw new Error("Expected an uploaded file artifact");
  }

  upload.stage(19);
  // The public alias fixes the content type. A rejected alias change must not
  // publish the new file metadata; a replay with the original type can update it.
  await chat.completeUploadWithBearer(
    upload.bearer,
    { id: upload.prepared.id, contentType: "text/markdown" },
    [500],
  );
  expect(
    (await chat.listThreadArtifacts(upload.actor, upload.run.threadId)).runs,
  ).toMatchObject([{ files: [{ size: 7, contentType: "text/plain" }] }]);
  const updated = await complete();
  expect(updated.body).toMatchObject({
    size: 19,
    contentType: "text/plain",
  });
  const after = await chat.listThreadArtifacts(
    upload.actor,
    upload.run.threadId,
  );
  expect(
    after.runs.flatMap((run) => {
      return run.files;
    }),
  ).toMatchObject([
    {
      id: original[0]?.id,
      size: 19,
      contentType: "text/plain",
    },
  ]);
  const catalog = await chat.listArtifactCatalog(upload.actor, {
    chatThreadId: upload.run.threadId,
  });
  expect(catalog.artifacts).toMatchObject([
    { id: artifactId, title: "report.txt", kind: "file" },
  ]);
  expect(catalog.artifacts).toHaveLength(1);
  await expect(
    chat.getArtifactCatalogEntry(upload.actor, artifactId),
  ).resolves.toMatchObject({
    file: {
      id: originalDetail.file.id,
      size: 19,
      url: upload.prepared.url,
      previewImageUrl: null,
    },
  });
  for (const outsider of [
    bdd.user(),
    bdd.user({ orgId: upload.actor.orgId }),
  ]) {
    await chat.requestListThreadArtifacts(outsider, upload.run.threadId, [404]);
    await chat.requestArtifactCatalogEntry(outsider, artifactId, [404]);
    expect((await chat.listArtifactCatalog(outsider)).artifacts).toStrictEqual(
      [],
    );
  }
});

test("records a late completion through a surviving issued token after the owner deletes its agent", async () => {
  const upload = await claimedUpload();
  await fixture.completeChatRunOk(upload.run.runId, upload.sandboxHeaders);
  await flushWaitUntilForTest();
  await bdd.deleteAgent(upload.actor, upload.owner.agentId);
  await chat.completeUploadWithBearer(
    upload.bearer,
    { id: upload.prepared.id },
    [200],
  );
  const catalog = await chat.listArtifactCatalog(upload.actor);
  expect(catalog.artifacts).toMatchObject([{ title: "report.txt" }]);
  expect(catalog.artifacts).toHaveLength(1);
});

test("leaves an unavailable upload absent and permits completion after the object arrives", async () => {
  const upload = await claimedUpload({ stage: false });
  await chat.completeUploadWithBearer(
    upload.bearer,
    { id: upload.prepared.id },
    [404],
  );
  expect(
    (await chat.listThreadArtifacts(upload.actor, upload.run.threadId)).runs,
  ).toStrictEqual([]);
  upload.stage(7);
  await chat.completeUploadWithBearer(
    upload.bearer,
    { id: upload.prepared.id },
    [200],
  );
  expect(
    (await chat.listThreadArtifacts(upload.actor, upload.run.threadId)).runs,
  ).toMatchObject([{ files: [{ filename: "report.txt" }] }]);
});
