import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import type { UserMessageInputPart } from "@okouai/api-contracts/contracts/chat-threads";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";
import { createStore } from "ccstate";
import { randomUUID } from "node:crypto";

import { testContext, accept } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { sharedThreadRoutes } from "../shared-threads";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { featureSwitchesRoutes } from "../feature-switches";
import { webFileUrlRoutes } from "../web-file-url";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import { installSharedThreadStorage } from "./helpers/shared-thread-storage";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { copyPublicArtifactObject$ } from "../../external/s3";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { now } from "../../../lib/time";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const api = () => {
  return setupApp({
    context,
    routes: [
      ...sharedThreadRoutes,
      ...uploadsPrepareRoutes,
      ...uploadsCompleteRoutes,
      ...featureSwitchesRoutes,
      ...webFileUrlRoutes,
    ],
  });
};

async function fixture(privateFiles = false) {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Attachment sharing",
  });
  const storage = installSharedThreadStorage(context);
  mocks.clerk.session(actor.userId, actor.orgId);
  await accept(
    api()(featureSwitchesContract).update({
      headers,
      body: { switches: { [FeatureSwitchKey.PrivateArtifacts]: privateFiles } },
    }),
    [200],
  );

  async function upload(filename: string, contentType: string, bytes: string) {
    const prepared = await accept(
      api()(uploadsContract).prepare({
        headers,
        body: {
          filename,
          contentType,
          size: Buffer.byteLength(bytes),
          purpose: "artifact",
        },
      }),
      [200],
    );
    if (!("uploadUrl" in prepared.body)) {
      throw new Error("Expected a single upload");
    }
    expect(
      (await fetch(prepared.body.uploadUrl, { method: "PUT", body: bytes }))
        .status,
    ).toBe(200);
    await accept(
      api()(uploadsContract).complete({
        headers,
        body: { id: prepared.body.id },
      }),
      [200],
    );
    return {
      id: prepared.body.id,
      uploadUrl: prepared.body.uploadUrl,
      part: {
        type: "file" as const,
        fileId: prepared.body.id,
        filenameSnapshot: filename,
        contentType,
      },
    };
  }
  async function send(parts: readonly UserMessageInputPart[]) {
    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "Use these files",
        userMessage: { version: 1, parts: [...parts] },
      },
      [201],
    );
    if (sent.status !== 201) {
      throw new Error("Expected sent prompt");
    }
    if (!sent.body.runId) {
      throw new Error("Expected a new chat run");
    }
    await flushWaitUntilForTest();
    const history = await chat.listThreadEvents(actor, sent.body.threadId);
    const event = history.events.find((row) => {
      return row.eventType === "input.prompt" && row.runId === sent.body.runId;
    });
    if (!event) {
      throw new Error("Expected prompt event");
    }
    return { threadId: sent.body.threadId, eventId: event.id };
  }
  function share(message: {
    readonly threadId: string;
    readonly eventId: string;
  }) {
    mocks.clerk.session(actor.userId, actor.orgId);
    return api()(sharedThreadsContract).create({
      headers,
      params: { threadId: message.threadId },
      body: { eventIds: [message.eventId] },
    });
  }
  async function expectNoShare(threadId: string) {
    expect(
      (
        await chat.listArtifactCatalog(actor, {
          kind: "shared-thread",
          chatThreadId: threadId,
        })
      ).artifacts,
    ).toStrictEqual([]);
  }
  return { actor, storage, upload, send, share, expectNoShare };
}

test("publishes independent attachment bytes", async () => {
  const f = await fixture();
  const image = await f.upload(
    "dashboard.png",
    "image/png",
    "original image bytes",
  );
  const pdf = await f.upload(
    "brief.pdf",
    "application/pdf",
    "original pdf bytes",
  );
  const message = await f.send([
    image.part,
    pdf.part,
    { type: "text", text: "Build this dashboard" },
  ]);
  const created = await accept(f.share(message), [201]);
  const shared = await accept(
    api()(sharedThreadsContract).get({ params: { id: created.body.id } }),
    [200],
  );
  expect(shared.body.messages).toHaveLength(1);
  expect(shared.body.messages[0]?.content).toBe("Build this dashboard");
  const attachments = shared.body.messages[0]?.attachments;
  expect(attachments).toHaveLength(2);
  for (const [index, expected] of [
    "original image bytes",
    "original pdf bytes",
  ].entries()) {
    const attachment = attachments?.[index];
    if (!attachment) {
      throw new Error("Expected shared attachment");
    }
    expect(attachment.url).toContain(`/shared-threads/${created.body.id}/`);
    expect(attachment.size).toBe(Buffer.byteLength(expected));
    const response = await fetch(attachment.url);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(expected);
  }
  f.storage.removeUpload(image.uploadUrl);
  const imageAttachment = attachments?.[0];
  if (!imageAttachment) {
    throw new Error("Expected image attachment");
  }
  await expect((await fetch(imageAttachment.url)).text()).resolves.toBe(
    "original image bytes",
  );
  const publicJson = JSON.stringify(shared.body);
  for (const value of [
    image.id,
    pdf.id,
    f.actor.userId,
    f.actor.orgId,
    message.threadId,
  ]) {
    expect(publicJson).not.toContain(value);
  }
});

// Provider-boundary coverage: normal chat sending currently resolves public
// inputs only. Exercise the private-to-public adapter using a real private
// upload, without fabricating a chat event the send endpoint cannot create.
test("copies private bytes with separate credentials while retaining source privacy", async () => {
  const f = await fixture(true);
  const file = await f.upload(
    "private.pdf",
    "application/pdf",
    "private bytes",
  );
  const sourcePath = new URL(file.uploadUrl).pathname.slice(1);
  const separator = sourcePath.indexOf("/");
  const key = `artifacts/shared-threads/${randomUUID()}/private.pdf`;
  await createStore().set(
    copyPublicArtifactObject$,
    {
      sourceBucket: sourcePath.slice(0, separator),
      sourceKey: sourcePath.slice(separator + 1),
      key,
      filename: "private.pdf",
      contentType: "application/pdf",
      size: Buffer.byteLength("private bytes"),
      publicBrand: "okou",
    },
    context.signal,
  );
  const response = await fetch(
    `https://a.okou.io/${key.slice("artifacts/".length)}`,
  );
  expect(response.status).toBe(200);
  await expect(response.text()).resolves.toBe("private bytes");
  const source = await accept(
    api()(webFilesContract).fileUrl({ headers, query: { file_id: file.id } }),
    [200],
  );
  expect(source.body.publicUrl).toBeNull();
});

test("shares attachment-only prompts and reuses a copy for repeated references", async () => {
  const f = await fixture();
  const image = await f.upload("reference.png", "image/png", "reference bytes");
  const message = await f.send([image.part, image.part]);
  const created = await accept(f.share(message), [201]);
  const shared = await accept(
    api()(sharedThreadsContract).get({ params: { id: created.body.id } }),
    [200],
  );
  expect(shared.body.messages).toHaveLength(1);
  expect(shared.body.messages[0]?.content).toBe("");
  const attachments = shared.body.messages[0]?.attachments;
  expect(attachments).toHaveLength(2);
  expect(attachments?.[0]?.url).toBe(attachments?.[1]?.url);
});

test("publishes the annotated image without exposing its original", async () => {
  const f = await fixture();
  const original = await f.upload("screen.png", "image/png", "original image");
  const annotated = await f.upload(
    "screen.annotated.png",
    "image/png",
    "annotated image",
  );
  const message = await f.send([
    {
      ...original.part,
      annotatedFileId: annotated.id,
      annotations: {
        marks: [
          {
            id: "redaction",
            shape: "redact",
            rect: { x: 0, y: 0, width: 0.5, height: 0.5 },
          },
        ],
      },
    },
  ]);
  const created = await accept(f.share(message), [201]);
  const shared = await accept(
    api()(sharedThreadsContract).get({ params: { id: created.body.id } }),
    [200],
  );
  const attachments = shared.body.messages[0]?.attachments;
  expect(attachments).toHaveLength(1);
  const attachment = attachments?.[0];
  if (!attachment) {
    throw new Error("Expected annotated attachment");
  }
  expect(attachment.filename).toBe("screen.annotated.png");
  await expect((await fetch(attachment.url)).text()).resolves.toBe(
    "annotated image",
  );
  expect(JSON.stringify(shared.body)).not.toContain(original.id);
});

test("requires file read capability when sharing prompt attachments", async () => {
  const f = await fixture();
  const file = await f.upload(
    "brief.pdf",
    "application/pdf",
    "private prompt bytes",
  );
  const message = await f.send([file.part]);
  if (!f.actor.orgId) {
    throw new Error("Expected a sharing organization");
  }
  const seconds = Math.floor(now() / 1000);
  const token = signSandboxJwtForTests({
    scope: "okou",
    userId: f.actor.userId,
    orgId: f.actor.orgId,
    runId: randomUUID(),
    capabilities: ["chat-event:read"],
    iat: seconds,
    exp: seconds + 60,
  });
  const response = await accept(
    api()(sharedThreadsContract).create({
      headers: { authorization: `Bearer ${token}` },
      params: { threadId: message.threadId },
      body: { eventIds: [message.eventId] },
    }),
    [403],
  );
  expect(response.body.error.message).toContain("file:read");
  await f.expectNoShare(message.threadId);
});

test.each(["missing source", "copy failure"])(
  "rejects sharing on %s without publishing a partial conversation",
  async (failure) => {
    const f = await fixture();
    const file = await f.upload("brief.pdf", "application/pdf", "file bytes");
    const message = await f.send([
      file.part,
      { type: "text", text: "Read the brief" },
    ]);
    if (failure === "missing source") {
      f.storage.removeUpload(file.uploadUrl);
    } else {
      f.storage.rejectCopies();
    }
    await expect(f.share(message)).rejects.toThrow(
      "Unknown response status 500",
    );
    await f.expectNoShare(message.threadId);
  },
);
