import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { beforeEach, expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { artifactReferencePath } from "@okouai/api-contracts/contracts/artifact-references";
import { artifactSharesContract } from "@okouai/api-contracts/contracts/artifact-shares";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { artifactShareRoutes } from "../artifact-shares";
import { featureSwitchesRoutes } from "../feature-switches";
import { sharedThreadRoutes } from "../shared-threads";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createHostMapsBddApi } from "./helpers/api-bdd-host-maps";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);
const mocks = createRouteMocks(context);

beforeEach(() => {
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  mockEnv("APP_URL", "https://app.okou.ai");
});

function api() {
  return setupApp({
    context,
    routes: [
      ...sharedThreadRoutes,
      ...featureSwitchesRoutes,
      ...artifactShareRoutes,
      ...uploadsPrepareRoutes,
      ...uploadsCompleteRoutes,
    ],
  });
}

function headers(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

async function flag(actor: ApiTestUser, enabled: boolean) {
  await accept(
    api()(featureSwitchesContract).update({
      headers: headers(actor),
      body: { switches: { [FeatureSwitchKey.PrivateArtifacts]: enabled } },
    }),
    [200],
  );
}

async function fixture() {
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
    displayName: "Resource snapshot",
  });
  const originalSend = context.mocks.s3.send.getMockImplementation();
  const objects = new Map<string, Buffer>();
  const failedWrites = new Set<string>();
  const etag = (body: Buffer) => {
    return `"${createHash("md5").update(body).digest("hex")}"`;
  };
  const missing = () => {
    return Object.assign(new Error("Object unavailable"), {
      name: "NoSuchKey",
      $metadata: { httpStatusCode: 404 },
    });
  };
  const copies: { source: string; destination: string }[] = [];

  context.mocks.s3.getSignedUrl.mockImplementation(
    (_client: unknown, command: unknown) => {
      if (
        !(
          command instanceof PutObjectCommand ||
          command instanceof GetObjectCommand
        )
      ) {
        throw new Error("Unexpected presign operation");
      }
      return Promise.resolve(
        `https://test.r2.cloudflarestorage.com/${command.input.Bucket}/${command.input.Key}?X-Amz-Signature=fixture`,
      );
    },
  );
  function putSnapshotObject(command: PutObjectCommand) {
    const key = `${command.input.Bucket}/${command.input.Key}`;
    if (failedWrites.has(key)) {
      return Promise.reject(new Error("Storage write unavailable"));
    }
    const previous = objects.get(key);
    if (
      (command.input.IfNoneMatch === "*" && previous) ||
      (command.input.IfMatch &&
        (!previous || etag(previous) !== command.input.IfMatch))
    ) {
      return Promise.reject(
        Object.assign(new Error("Revision conflict"), {
          name: "PreconditionFailed",
        }),
      );
    }
    if (
      !Buffer.isBuffer(command.input.Body) &&
      typeof command.input.Body !== "string"
    ) {
      throw new Error("Unexpected object body");
    }
    objects.set(key, Buffer.from(command.input.Body));
    return Promise.resolve({});
  }

  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (command instanceof CopyObjectCommand) {
      const source = decodeURIComponent(command.input.CopySource!);
      const destination = `${command.input.Bucket}/${command.input.Key}`;
      const body = objects.get(source);
      if (!body) {
        return Promise.reject(missing());
      }
      copies.push({ source, destination });
      objects.set(destination, Buffer.from(body));
      return Promise.resolve({});
    }
    if (command instanceof DeleteObjectsCommand) {
      for (const object of command.input.Delete?.Objects ?? []) {
        objects.delete(`${command.input.Bucket}/${object.Key}`);
      }
      return Promise.resolve({});
    }
    if (
      command instanceof PutObjectCommand &&
      (command.input.Bucket === "test-hosted-sites" ||
        command.input.Bucket === "test-private-artifacts")
    ) {
      return putSnapshotObject(command);
    }
    if (
      (command instanceof GetObjectCommand ||
        command instanceof HeadObjectCommand) &&
      (command.input.Bucket === "test-hosted-sites" ||
        command.input.Bucket === "test-private-artifacts")
    ) {
      const body = objects.get(`${command.input.Bucket}/${command.input.Key}`);
      if (!body) {
        return Promise.reject(missing());
      }
      return Promise.resolve({
        ...(command instanceof GetObjectCommand
          ? { Body: Readable.from([body]) }
          : {}),
        ETag: etag(body),
        ContentLength: body.length,
        Metadata: {
          "artifact-id": command.input.Key?.split("/")[1],
          sha256: createHash("sha256").update(body).digest("hex"),
        },
      });
    }
    if (
      command instanceof ListObjectsV2Command &&
      command.input.Bucket === "test-hosted-sites"
    ) {
      return Promise.resolve({ Contents: [] });
    }
    if (!originalSend) {
      throw new Error("Unexpected storage request");
    }
    return originalSend(command);
  });
  await flag(actor, true);

  async function upload(owner = actor, content = "Original generated PDF") {
    const prepared = await accept(
      api()(uploadsContract).prepare({
        headers: headers(owner),
        body: {
          filename: "report.pdf",
          contentType: "application/pdf",
          size: Buffer.byteLength(content),
          purpose: "artifact",
        },
      }),
      [200],
    );
    if (!("uploadUrl" in prepared.body)) {
      throw new Error("Expected a single upload");
    }
    const key = decodeURIComponent(
      new URL(prepared.body.uploadUrl).pathname.slice(1),
    );
    objects.set(key, Buffer.from(content));
    await accept(
      api()(uploadsContract).complete({
        headers: headers(owner),
        body: { id: prepared.body.id },
      }),
      [200],
    );
    return { id: prepared.body.id, url: prepared.body.url, key };
  }

  async function selection(
    content: string,
    omitted = "Unselected private information",
  ) {
    const sent = await accept(
      chat.requestSendEvent(
        actor,
        { agentId: agent.agentId, prompt: content },
        [201],
      ),
      [201],
    );
    await flushWaitUntilForTest();
    const { threadId, runId } = sent.body;
    await chat.requestSendEvent(
      actor,
      { agentId: agent.agentId, threadId, prompt: omitted },
      [201],
    );
    await flushWaitUntilForTest();
    const { events } = await chat.listThreadEvents(actor, threadId);
    const event = events.find((entry) => {
      return entry.eventType === "input.prompt" && entry.runId === runId;
    });
    if (!event) {
      throw new Error("Expected selected message");
    }
    return { threadId, eventId: event.id, content };
  }

  async function site(
    files: { path: string; content: string; contentType?: string }[],
    name = `snapshot-${randomUUID().slice(0, 8)}`,
  ) {
    const host = createHostMapsBddApi(context);
    const prepared = await host.prepareHostedSite(actor, {
      site: name,
      artifactKind: "hosted-site",
      spaFallback: true,
      files: files.map((file) => {
        return hostedTextFile(file.path, file.content, file.contentType);
      }),
    });
    for (const upload of prepared.uploads) {
      const source = files.find((file) => {
        return file.path === upload.path;
      });
      if (!source) {
        throw new Error("Unexpected hosted upload");
      }
      objects.set(
        decodeURIComponent(new URL(upload.uploadUrl).pathname.slice(1)),
        Buffer.from(source.content),
      );
    }
    await host.completeHostedSite(actor, prepared.deploymentId);
    return {
      ...prepared,
      name,
      url: artifactReferencePath(prepared.deploymentId, "index.html"),
    };
  }
  return { actor, objects, copies, failedWrites, upload, selection, site };
}

function share(
  actor: ApiTestUser,
  selection: { threadId: string; eventId: string },
) {
  return api()(sharedThreadsContract).create({
    headers: headers(actor),
    params: { threadId: selection.threadId },
    body: { eventIds: [selection.eventId] },
  });
}

test("copies only selected artifacts, rewrites the snapshot, and preserves source messages and permissions", async () => {
  const f = await fixture();
  const file = await f.upload();
  const other = await f.upload(f.actor, "Unselected document");
  const selection = await f.selection(
    `[Report](${file.url}) and ${file.url}`,
    `[Unselected](${other.url})`,
  );
  const created = await accept(share(f.actor, selection), [201]);
  const shared = await accept(
    api()(sharedThreadsContract).get({ params: { id: created.body.id } }),
    [200],
  );
  const content = shared.body.messages[0]!.content;
  const urls = content.match(/https:\/\/a\.okou\.io\/[a-f0-9]{24}\.pdf/gu);
  expect(urls).toHaveLength(2);
  expect(new Set(urls).size).toBe(1);
  expect(content).not.toContain("/artifacts/");
  expect(content).not.toContain("Signature");
  expect(
    f.copies.filter((copy) => {
      return copy.source === file.key;
    }),
  ).toHaveLength(1);
  expect(
    f.copies.some((copy) => {
      return copy.source === other.key;
    }),
  ).toBeFalsy();
  const copy = f.copies.find((entry) => {
    return entry.source === file.key;
  })!;
  f.objects.set(file.key, Buffer.from("Changed original"));
  expect(f.objects.get(copy.destination)?.toString()).toBe(
    "Original generated PDF",
  );
  const source = await chat.listThreadEvents(f.actor, selection.threadId);
  expect(JSON.stringify(source.events)).toContain(file.url);
  expect(JSON.stringify(source.events)).not.toContain(urls![0]);
  context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
    id: f.actor.orgId,
    name: "Owner organization",
  });
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    { data: [{ publicUserData: { userId: f.actor.userId } }] },
  );
  const status = await accept(
    api()(artifactSharesContract).status({
      headers: headers(f.actor),
      body: { kind: "file", id: file.id },
    }),
    [200],
  );
  expect(status.body.audience).toBe("private");
  const meta = await accept(
    api()(sharedThreadsContract).meta({ params: { id: created.body.id } }),
    [200],
  );
  expect(meta.headers.get("cache-control")).toBe("no-store");
});

test("leaves ordinary relative API paths unchanged", async () => {
  const f = await fixture();
  const content = "The client calls /api/users before rendering.";
  const selection = await f.selection(content);
  const created = await accept(share(f.actor, selection), [201]);
  const shared = await accept(
    api()(sharedThreadsContract).get({ params: { id: created.body.id } }),
    [200],
  );
  expect(shared.body.messages[0]!.content).toBe(content);
  expect(f.copies).toStrictEqual([]);
});

test("copies a complete fixed site and rewrites its managed private dependencies", async () => {
  const f = await fixture();
  const asset = await f.upload();
  const signedAsset = `https://test.r2.cloudflarestorage.com/${asset.key}?X-Amz-Date=20200101T000000Z&X-Amz-Signature=expired`;
  const site = await f.site([
    {
      path: "/index.html",
      content: `<h1>Version one</h1><a href="${asset.url}">Download</a><link href="assets/style.css" rel="stylesheet">`,
    },
    {
      path: "/assets/style.css",
      content: "body{color:red}",
      contentType: "text/css",
    },
    {
      path: "/assets/app.js",
      content: `const asset = "${signedAsset}";`,
      contentType: "application/javascript",
    },
  ]);
  const selection = await f.selection(`[Site](${site.url}#page-2)`);
  const created = await accept(share(f.actor, selection), [201]);
  const shared = await accept(
    api()(sharedThreadsContract).get({ params: { id: created.body.id } }),
    [200],
  );
  expect(shared.body.messages[0]!.content).toMatch(
    /https:\/\/[a-f0-9]{24}\.okou\.app\/#page-2/u,
  );
  const prefix = `test-hosted-sites/shared-artifacts/okou/${created.body.id}/${site.deploymentId}`;
  expect(f.objects.get(`${prefix}/index.html`)?.toString()).toMatch(
    /https:\/\/a\.okou\.io\/[a-f0-9]{24}\.pdf/u,
  );
  expect(f.objects.get(`${prefix}/assets/style.css`)?.toString()).toBe(
    "body{color:red}",
  );
  expect(f.objects.get(`${prefix}/assets/app.js`)?.toString()).toMatch(
    /^const asset = "https:\/\/a\.okou\.io\/[a-f0-9]{24}\.pdf";$/u,
  );
  expect(
    f.copies.filter((copy) => {
      return copy.source === asset.key;
    }),
  ).toHaveLength(1);
  await f.site(
    [{ path: "/index.html", content: "<h1>Version two</h1>" }],
    site.name,
  );
  expect(f.objects.get(`${prefix}/index.html`)?.toString()).toContain(
    "Version one",
  );
  expect(f.objects.get(`${prefix}/index.html`)?.toString()).not.toContain(
    "/artifacts/",
  );
});

test("rejects hosted text that exceeds the per-file limit after rewriting", async () => {
  const f = await fixture();
  const file = await f.upload();
  const reference = file.url.replace(/\.pdf$/u, "");
  const unit = `${reference} `;
  const maxTextBytes = 4 * 1024 * 1024;
  const source = unit.repeat(
    Math.floor(maxTextBytes / Buffer.byteLength(unit)),
  );
  expect(Buffer.byteLength(source)).toBeLessThanOrEqual(maxTextBytes);
  const site = await f.site([{ path: "/index.html", content: source }]);
  const selection = await f.selection(site.url);
  await accept(share(f.actor, selection), [400]);
  expect(f.copies).toStrictEqual([]);
  const catalog = await chat.listArtifactCatalog(f.actor, {
    kind: "shared-thread",
    chatThreadId: selection.threadId,
  });
  expect(catalog.artifacts).toStrictEqual([]);
});

test("an unavailable authenticated site dependency fails before publishing any resources", async () => {
  const f = await fixture();
  const site = await f.site([
    {
      path: "/index.html",
      content: '<img src="https://api.okou.ai/api/private-resource/missing">',
    },
  ]);
  const selection = await f.selection(site.url);
  await accept(share(f.actor, selection), [400]);
  expect(f.copies).toStrictEqual([]);
  const catalog = await chat.listArtifactCatalog(f.actor, {
    kind: "shared-thread",
    chatThreadId: selection.threadId,
  });
  expect(catalog.artifacts).toStrictEqual([]);
});

test("another user's artifact and unavailable managed dependencies cannot be published", async () => {
  const f = await fixture();
  const other = bdd.user({ orgId: f.actor.orgId });
  await flag(other, true);
  const file = await f.upload(other);
  const selection = await f.selection(`[Other owner](${file.url})`);
  await accept(share(f.actor, selection), [400]);
  expect(f.copies).toStrictEqual([]);
  const catalog = await chat.listArtifactCatalog(f.actor, {
    kind: "shared-thread",
    chatThreadId: selection.threadId,
  });
  expect(catalog.artifacts).toStrictEqual([]);
});

test("a partial copy failure leaves no usable share and cleans copied private bytes", async () => {
  const f = await fixture();
  const file = await f.upload();
  const missing = await f.upload();
  const selection = await f.selection(
    `[One](${file.url}) [Two](${missing.url})`,
  );
  f.objects.delete(missing.key);
  await accept(share(f.actor, selection), [400]);
  expect(
    [...f.objects.keys()].filter((key) => {
      return key.includes("/thread-shares/");
    }),
  ).toStrictEqual([]);
  const catalog = await chat.listArtifactCatalog(f.actor, {
    kind: "shared-thread",
    chatThreadId: selection.threadId,
  });
  expect(catalog.artifacts).toStrictEqual([]);
  expect(f.objects.has(file.key)).toBeTruthy();
});

test("owner deletion revokes a snapshot after switch rollback and preserves the private original", async () => {
  const f = await fixture();
  const file = await f.upload();
  const selection = await f.selection(file.url);
  const created = await accept(share(f.actor, selection), [201]);
  await accept(
    api()(sharedThreadsContract).delete({
      headers: headers(bdd.user({ orgId: f.actor.orgId })),
      params: { id: created.body.id },
    }),
    [404],
  );
  await flag(f.actor, false);
  await accept(
    api()(sharedThreadsContract).delete({
      headers: headers(f.actor),
      params: { id: created.body.id },
    }),
    [204],
  );
  await accept(
    api()(sharedThreadsContract).get({ params: { id: created.body.id } }),
    [404],
  );
  await accept(
    api()(sharedThreadsContract).meta({ params: { id: created.body.id } }),
    [404],
  );
  expect(
    [...f.objects.keys()].filter((key) => {
      return key.includes("/thread-shares/");
    }),
  ).toStrictEqual([]);
  expect(f.objects.has(file.key)).toBeTruthy();
});

test("switch-off shares retain the established message-only projection", async () => {
  const f = await fixture();
  const file = await f.upload();
  const selection = await f.selection(file.url);
  await flag(f.actor, false);
  const created = await accept(share(f.actor, selection), [201]);
  const shared = await accept(
    api()(sharedThreadsContract).get({ params: { id: created.body.id } }),
    [200],
  );
  expect(shared.body.messages[0]!.content).toBe(file.url);
  expect(f.copies).toStrictEqual([]);
});

test.each(["organization", "user"] as const)(
  "%s deletion revokes resource access before acknowledging the webhook",
  async (kind) => {
    const f = await fixture();
    const file = await f.upload();
    const selection = await f.selection(file.url);
    const created = await accept(share(f.actor, selection), [201]);
    await flag(f.actor, false);
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    const webhooks = createWebhookCallbackApi(context);
    webhooks.configureClerkWebhookSecret();
    webhooks.verifyNextClerkWebhook({
      type: kind === "organization" ? "organization.deleted" : "user.deleted",
      data: { id: kind === "organization" ? f.actor.orgId : f.actor.userId },
    });
    await webhooks.requestClerkWebhook("{}", {}, [200]);
    // The foreground revocation is sufficient even before background deletion.
    await accept(
      api()(sharedThreadsContract).get({ params: { id: created.body.id } }),
      [404],
    );
    await flushWaitUntilForTest();
    expect(
      [...f.objects.keys()].filter((key) => {
        return key.includes("/thread-shares/");
      }),
    ).toStrictEqual([]);
  },
);

test("a failed deletion revocation is retryable and is never acknowledged as success", async () => {
  const f = await fixture();
  const file = await f.upload();
  const selection = await f.selection(file.url);
  const created = await accept(share(f.actor, selection), [201]);
  const key = `test-hosted-sites/shared-thread-artifacts/okou/${created.body.id}.json`;
  f.failedWrites.add(key);
  const webhooks = createWebhookCallbackApi(context);
  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "organization.deleted",
    data: { id: f.actor.orgId },
  });
  await webhooks.requestClerkWebhook("{}", {}, [503]);
  f.failedWrites.delete(key);
  context.mocks.stripe.subscriptions.list.mockResolvedValue({
    data: [],
    has_more: false,
  });
  webhooks.verifyNextClerkWebhook({
    type: "organization.deleted",
    data: { id: f.actor.orgId },
  });
  await webhooks.requestClerkWebhook("{}", {}, [200]);
  await accept(
    api()(sharedThreadsContract).get({ params: { id: created.body.id } }),
    [404],
  );
  await flushWaitUntilForTest();
  expect(f.objects.get(key)?.toString()).toContain('"status":"revoked"');
});

test("publication rechecks current ownership after allocating its durable snapshot", async () => {
  const f = await fixture();
  const file = await f.upload();
  const selection = await f.selection(file.url);
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    { data: [], totalCount: 0 },
  );
  await accept(share(f.actor, selection), [400]);
  expect(f.copies).toStrictEqual([]);
  const catalog = await chat.listArtifactCatalog(f.actor, {
    kind: "shared-thread",
    chatThreadId: selection.threadId,
  });
  expect(catalog.artifacts).toStrictEqual([]);
});
