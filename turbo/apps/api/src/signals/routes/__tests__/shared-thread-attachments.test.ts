import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import type { UserMessageInputPart } from "@okouai/api-contracts/contracts/chat-threads";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { artifactReferenceRoutes } from "../artifact-references";
import { sharedThreadRoutes } from "../shared-threads";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { webFileUrlRoutes } from "../web-file-url";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import { installSharedThreadStorage } from "./helpers/shared-thread-storage";

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
      ...webFileUrlRoutes,
    ],
  });
};

async function fixture() {
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
  await runs.ensurePersonalSubscriptionModel(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Attachment sharing",
  });
  const storage = installSharedThreadStorage(context);
  mocks.clerk.session(actor.userId, actor.orgId);

  async function upload(
    filename: string,
    contentType: string,
    bytes: string,
    scope: "public" | "private" = "private",
  ) {
    mocks.clerk.session(actor.userId, scope === "public" ? null : actor.orgId);
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
    mocks.clerk.session(actor.userId, actor.orgId);
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
    const sent = await chat.sendAndLaunch(actor, {
      agentId: agent.agentId,
      prompt: "Use these files",
      userMessage: { version: 1, parts: [...parts] },
    });
    const history = await chat.listThreadEvents(actor, sent.threadId);
    const event = history.events.find((row) => {
      return row.eventType === "input.prompt" && row.runId === sent.runId;
    });
    if (!event) {
      throw new Error("Expected prompt event");
    }
    return { threadId: sent.threadId, eventId: event.id };
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

test("publishes independent public attachment bytes", async () => {
  const f = await fixture();
  const image = await f.upload(
    "dashboard.png",
    "image/png",
    "original image bytes",
    "public",
  );
  const pdf = await f.upload(
    "brief.pdf",
    "application/pdf",
    "original pdf bytes",
    "public",
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
    const filename = index === 0 ? "dashboard.png" : "brief.pdf";
    expect(attachment).toStrictEqual({
      filename,
      contentType: index === 0 ? "image/png" : "application/pdf",
      size: Buffer.byteLength(expected),
      url: expect.stringMatching(
        new RegExp(
          String.raw`^https://a\.okou\.io/shared-threads/${created.body.id}/[a-f0-9-]{36}-${filename.replace(".", String.raw`\.`)}$`,
          "u",
        ),
      ),
    });
    await expect(attachmentBytes(attachment.url)).resolves.toBe(expected);
  }
  f.storage.removeUpload(image.uploadUrl);
  const imageAttachment = attachments?.[0];
  if (!imageAttachment) {
    throw new Error("Expected image attachment");
  }
  await expect(attachmentBytes(imageAttachment.url)).resolves.toBe(
    "original image bytes",
  );
});

test("sends private attachments and shares independent private snapshots", async () => {
  const f = await fixture();
  const file = await f.upload(
    "private.pdf",
    "application/pdf",
    "private bytes",
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
  expect(attachment).toStrictEqual({
    filename: "screen.annotated.png",
    contentType: "image/png",
    size: Buffer.byteLength("annotated image"),
    url: expect.stringMatching(
      /^https:\/\/app\.okou\.ai\/artifacts\/[a-z0-9]{10}\.png$/u,
    ),
  });
  await expect(attachmentBytes(attachment.url)).resolves.toBe(
    "annotated image",
  );
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
