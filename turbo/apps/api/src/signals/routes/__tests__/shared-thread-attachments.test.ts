import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import type { UserMessageInputPart } from "@okouai/api-contracts/contracts/chat-threads";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";
import { createStore } from "ccstate";
import { randomUUID } from "node:crypto";

import { testContext, accept } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { sharedThreadRoutes } from "../shared-threads";
import { artifactReferenceRoutes } from "../artifact-references";
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
import { CopyObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { now } from "../../../lib/time";
import { mockEnv } from "../../../lib/env";
import {
  createPreviousSharedThread$,
  previousSharedThreadReadRoutes,
} from "../../../test-fixtures/shared-thread-previous-api";

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
      ...artifactReferenceRoutes,
      ...uploadsPrepareRoutes,
      ...uploadsCompleteRoutes,
      ...featureSwitchesRoutes,
      ...webFileUrlRoutes,
    ],
  });
};

async function fixture(privateFiles = false) {
  mockEnv("APP_URL", "https://app.okou.ai");
  const actor = bdd.user();
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: [{ publicUserData: { userId: actor.userId } }],
      totalCount: 1,
    },
  );
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

async function attachmentBytes(url: string): Promise<string> {
  const parsed = new URL(url);
  if (parsed.origin === "https://app.okou.ai") {
    const resolved = await accept(
      api()(artifactReferencesContract).resolve({
        params: { reference: parsed.pathname.slice("/artifacts/".length) },
      }),
      [200],
    );
    return (await fetch(resolved.body.url)).text();
  }
  return (await fetch(url)).text();
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

test("previous API readers can serve newly shared attachment messages", async () => {
  const f = await fixture();
  const file = await f.upload("brief.pdf", "application/pdf", "file bytes");
  const message = await f.send([
    file.part,
    { type: "text", text: "Read the brief" },
  ]);
  const created = await accept(f.share(message), [201]);
  const previousApi = setupApp({
    context,
    routes: previousSharedThreadReadRoutes,
  })(sharedThreadsContract);
  const shared = await accept(
    previousApi.get({ params: { id: created.body.id } }),
    [200],
  );
  expect(shared.body.messages).toHaveLength(1);
  expect(shared.body.messages[0]?.content).toBe("Read the brief");
});

test("serves shares written by the previous API after the migration", async () => {
  const f = await fixture();
  const content = "Text shared by the previous API";
  const message = await f.send([{ type: "text", text: content }]);
  const id = await createStore().set(
    createPreviousSharedThread$,
    { userId: f.actor.userId, threadId: message.threadId, content },
    new AbortController().signal,
  );
  const shared = await accept(
    api()(sharedThreadsContract).get({ params: { id } }),
    [200],
  );
  expect(shared.body.messages).toStrictEqual([
    { messageIndex: 0, role: "user", content },
  ]);
});

test("sends private attachments and shares independent private snapshots after rollout is disabled", async () => {
  const f = await fixture(true);
  const file = await f.upload(
    "private.pdf",
    "application/pdf",
    "private bytes",
  );
  await accept(
    api()(featureSwitchesContract).update({
      headers,
      body: { switches: { [FeatureSwitchKey.PrivateArtifacts]: false } },
    }),
    [200],
  );
  const message = await f.send([file.part, file.part]);
  const created = await accept(f.share(message), [201]);
  const shared = await accept(
    api()(sharedThreadsContract).get({ params: { id: created.body.id } }),
    [200],
  );
  const attachments = shared.body.messages[0]?.attachments;
  expect(attachments).toHaveLength(2);
  const url = attachments?.[0]?.url;
  if (!url) {
    throw new Error("Expected shared private attachment");
  }
  expect(attachments?.[1]?.url).toBe(url);
  expect(url).toMatch(
    /^https:\/\/app\.okou\.ai\/artifacts\/[a-z0-9]{10}\.pdf$/u,
  );
  await expect(attachmentBytes(url)).resolves.toBe("private bytes");
  const copies = context.mocks.s3.send.mock.calls
    .map(([command]) => {
      return command;
    })
    .filter((command) => {
      return command instanceof CopyObjectCommand;
    });
  expect(copies).toHaveLength(1);
  expect(copies[0]?.input).toMatchObject({ Bucket: "test-private-artifacts" });
  expect(
    context.mocks.s3.send.mock.calls.some(([command]) => {
      return (
        command instanceof PutObjectCommand &&
        command.input.Bucket === "test-user-artifacts"
      );
    }),
  ).toBeFalsy();
  const source = await accept(
    api()(webFilesContract).fileUrl({ headers, query: { file_id: file.id } }),
    [200],
  );
  expect(source.body.publicUrl).toBeNull();
  f.storage.removeUpload(file.uploadUrl);
  await expect(attachmentBytes(url)).resolves.toBe("private bytes");
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

test.each([false, true])(
  "publishes the annotated image without exposing its original (private=%s)",
  async (privateFiles) => {
    const f = await fixture(privateFiles);
    const original = await f.upload(
      "screen.png",
      "image/png",
      "original image",
    );
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
    await expect(attachmentBytes(attachment.url)).resolves.toBe(
      "annotated image",
    );
    expect(JSON.stringify(shared.body)).not.toContain(original.id);
  },
);

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
