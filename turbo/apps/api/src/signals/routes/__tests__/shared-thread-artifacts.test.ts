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
import { beforeEach, expect, onTestFinished, test } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { createDeferredPromise } from "../../utils";
import { completeHostedSiteWithoutDependencyIndex } from "../../../test-fixtures/hosted-site-dependencies-previous-api";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { artifactSharesContract } from "@okouai/api-contracts/contracts/artifact-shares";
import { artifactReferencePath } from "@okouai/api-contracts/contracts/artifact-references";
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

function api(rethrowErrors = false) {
  return setupApp({
    context,
    rethrowErrors,
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

  function readSnapshotObject(command: GetObjectCommand | HeadObjectCommand) {
    const body = objects.get(`${command.input.Bucket}/${command.input.Key}`);
    if (!body) {
      return Promise.reject(missing());
    }
    if (command.input.IfMatch && command.input.IfMatch !== etag(body)) {
      return Promise.reject(
        Object.assign(new Error("Source changed"), {
          name: "PreconditionFailed",
        }),
      );
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

  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (command instanceof CopyObjectCommand) {
      const source = decodeURIComponent(command.input.CopySource!);
      const destination = `${command.input.Bucket}/${command.input.Key}`;
      const body = objects.get(source);
      if (!body) {
        return Promise.reject(missing());
      }
      if (
        command.input.CopySourceIfMatch &&
        command.input.CopySourceIfMatch !== etag(body)
      ) {
        return Promise.reject(
          Object.assign(new Error("Source changed"), {
            name: "PreconditionFailed",
          }),
        );
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
      return readSnapshotObject(command);
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
    legacy = false,
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
    if (legacy) {
      if (!actor.orgId) {
        throw new Error(
          "Expected an organization for the historical deployment",
        );
      }
      await completeHostedSiteWithoutDependencyIndex({
        id: prepared.deploymentId,
        userId: actor.userId,
        orgId: actor.orgId,
      });
    } else {
      await host.completeHostedSite(actor, prepared.deploymentId);
    }
    return {
      ...prepared,
      name,
    };
  }
  return { actor, objects, copies, failedWrites, upload, selection, site };
}

function share(
  actor: ApiTestUser,
  selection: { threadId: string; eventId: string },
  options?: { signal: AbortSignal; rethrowErrors: boolean },
) {
  return api(options?.rethrowErrors)(sharedThreadsContract).create({
    fetchOptions: { signal: options?.signal },
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
  const urls = content.match(/https:\/\/a\.okou\.io\/[a-z0-9]{10}\.pdf/gu);
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
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: [
        {
          publicUserData: { userId: f.actor.userId },
          organization: { id: f.actor.orgId, name: "Owner organization" },
        },
      ],
    },
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
    /https:\/\/[a-z0-9]{10}\.okou\.app\/#page-2/u,
  );
  const prefix = `test-hosted-sites/shared-artifacts/okou/${created.body.id}/${site.deploymentId}`;
  expect(f.objects.get(`${prefix}/index.html`)?.toString()).toMatch(
    /https:\/\/a\.okou\.io\/[a-z0-9]{10}\.pdf/u,
  );
  expect(f.objects.get(`${prefix}/assets/style.css`)?.toString()).toBe(
    "body{color:red}",
  );
  expect(f.objects.get(`${prefix}/assets/app.js`)?.toString()).toMatch(
    /^const asset = "https:\/\/a\.okou\.io\/[a-z0-9]{10}\.pdf";$/u,
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

test.each([false, true])(
  "rechecks ownership before sharing another user's artifact (indexed site: %s)",
  async (nested) => {
    const f = await fixture();
    const other = bdd.user({ orgId: f.actor.orgId });
    await flag(other, true);
    const file = await f.upload(other);
    const source = nested
      ? (
          await f.site([
            {
              path: "/index.html",
              content: `<a href="${file.url}">Other owner</a>`,
            },
          ])
        ).url
      : file.url;
    const selection = await f.selection(`[Other owner](${source})`);
    await accept(share(f.actor, selection), [400]);
    expect(f.copies).toStrictEqual([]);
    const catalog = await chat.listArtifactCatalog(f.actor, {
      kind: "shared-thread",
      chatThreadId: selection.threadId,
    });
    expect(catalog.artifacts).toStrictEqual([]);
  },
);

test.each(["short", "legacy"] as const)(
  "%s organization share references cannot authorize a recipient to publish a thread snapshot",
  async (format) => {
    const f = await fixture();
    const owner = bdd.user({ orgId: f.actor.orgId });
    await flag(owner, true);
    const file = await f.upload(owner);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            publicUserData: { userId: owner.userId },
            organization: { id: f.actor.orgId, name: "Owner organization" },
          },
          {
            publicUserData: { userId: f.actor.userId },
            organization: { id: f.actor.orgId, name: "Owner organization" },
          },
        ],
        totalCount: 2,
      },
    );
    const shared = await accept(
      api()(artifactSharesContract).update({
        headers: headers(owner),
        body: {
          target: { kind: "file", id: file.id },
          audience: "organization",
        },
      }),
      [200],
    );
    const url =
      format === "short"
        ? shared.body.shortUrl
        : `https://app.okou.ai${artifactReferencePath(shared.body.shareId!, "report.pdf")}`;
    const selection = await f.selection(`[Organization report](${url})`);
    await accept(share(f.actor, selection), [400]);
    const catalog = await chat.listArtifactCatalog(f.actor, {
      kind: "shared-thread",
      chatThreadId: selection.threadId,
    });
    expect(catalog.artifacts).toStrictEqual([]);
  },
);

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

test("snapshot short-reference collisions preserve the occupied alias and retry", async () => {
  const f = await fixture();
  const file = await f.upload();
  const selection = await f.selection(file.url);
  const storage = context.mocks.s3.send.getMockImplementation()!;
  let occupiedKey: string | undefined;
  let occupiedBody: Buffer | undefined;
  context.mocks.s3.send.mockImplementation((command) => {
    if (
      !occupiedKey &&
      command instanceof PutObjectCommand &&
      command.input.Key?.startsWith("artifact-delivery/files/")
    ) {
      occupiedKey = `${command.input.Bucket}/${command.input.Key}`;
      const record = JSON.parse(String(command.input.Body)) as Record<
        string,
        unknown
      >;
      occupiedBody = Buffer.from(
        JSON.stringify({
          ...record,
          threadId: randomUUID(),
          targetId: randomUUID(),
        }),
      );
      f.objects.set(occupiedKey, occupiedBody);
    }
    return storage(command);
  });
  const created = await accept(share(f.actor, selection), [201]);
  const shared = await accept(
    api()(sharedThreadsContract).get({ params: { id: created.body.id } }),
    [200],
  );
  const url = shared.body.messages[0]!.content;
  expect(url).toMatch(/^https:\/\/a\.okou\.io\/[a-z0-9]{10}\.pdf$/u);
  expect(occupiedKey).toBeDefined();
  expect(occupiedKey).not.toContain(new URL(url).pathname.slice(1));
  expect(f.objects.get(occupiedKey!)).toStrictEqual(occupiedBody);
});

test("independent thread snapshots use different short references and revoke separately", async () => {
  const f = await fixture();
  const file = await f.upload();
  const selection = await f.selection(file.url);
  const first = await accept(share(f.actor, selection), [201]);
  const second = await accept(share(f.actor, selection), [201]);
  const firstView = await accept(
    api()(sharedThreadsContract).get({ params: { id: first.body.id } }),
    [200],
  );
  const secondView = await accept(
    api()(sharedThreadsContract).get({ params: { id: second.body.id } }),
    [200],
  );
  const firstUrl = firstView.body.messages[0]!.content;
  const secondUrl = secondView.body.messages[0]!.content;
  expect(firstUrl).toMatch(/^https:\/\/a\.okou\.io\/[a-z0-9]{10}\.pdf$/u);
  expect(secondUrl).toMatch(/^https:\/\/a\.okou\.io\/[a-z0-9]{10}\.pdf$/u);
  expect(secondUrl).not.toBe(firstUrl);
  await accept(
    api()(sharedThreadsContract).delete({
      headers: headers(f.actor),
      params: { id: first.body.id },
    }),
    [204],
  );
  await accept(
    api()(sharedThreadsContract).get({ params: { id: first.body.id } }),
    [404],
  );
  const retained = await accept(
    api()(sharedThreadsContract).get({ params: { id: second.body.id } }),
    [200],
  );
  expect(retained.body.messages[0]!.content).toBe(secondUrl);
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

function hostedSourceReads(deploymentId: string): string[] {
  return context.mocks.s3.send.mock.calls.flatMap(([command]) => {
    return command instanceof GetObjectCommand &&
      command.input.Key?.startsWith(`private-sites/okou/${deploymentId}/`)
      ? [command.input.Key]
      : [];
  });
}

test.each([false, true])(
  "reuses dependency indexes and copies unchanged text directly (historical: %s)",
  async (legacy) => {
    const f = await fixture();
    const site = await f.site(
      [
        {
          path: "/index.html",
          content: '<h1>Report</h1><a href="https://example.com">External</a>',
        },
        {
          path: "/style.css",
          content: "body { color: red }",
          contentType: "text/css",
        },
      ],
      undefined,
      legacy,
    );
    if (!legacy) {
      await createHostMapsBddApi(context).completeHostedSite(
        f.actor,
        site.deploymentId,
      );
    }
    const selection = await f.selection(site.url);
    expect(hostedSourceReads(site.deploymentId)).toHaveLength(legacy ? 0 : 2);
    context.mocks.s3.send.mockClear();
    const first = await accept(share(f.actor, selection), [201]);
    expect(hostedSourceReads(site.deploymentId)).toHaveLength(legacy ? 2 : 0);
    expect(
      f.copies.filter((copy) => {
        return copy.destination.includes(first.body.id);
      }),
    ).toHaveLength(2);
    context.mocks.s3.send.mockClear();
    const second = await accept(share(f.actor, selection), [201]);
    expect(hostedSourceReads(site.deploymentId)).toStrictEqual([]);
    expect(
      f.copies.filter((copy) => {
        return copy.destination.includes(second.body.id);
      }),
    ).toHaveLength(2);
    const manifest = f.objects
      .get(
        `test-hosted-sites/shared-artifacts/okou/${second.body.id}/${site.deploymentId}/manifest.json`,
      )
      ?.toString();
    expect(manifest).not.toContain("snapshotDependencies");
  },
);

test.each([false, true])(
  "rejects source changes after dependency collection (rewrite: %s)",
  async (rewrite) => {
    const f = await fixture();
    const asset = await f.upload();
    const site = await f.site([
      {
        path: "/index.html",
        content: rewrite
          ? `<a href="${asset.url}">Report</a>`
          : "<h1>Original</h1>",
      },
    ]);
    const selection = await f.selection(site.url);
    f.objects.set(
      `test-hosted-sites/private-sites/okou/${site.deploymentId}/index.html`,
      Buffer.from(`<a href="${asset.url}">Changed after scan</a>`),
    );
    await accept(share(f.actor, selection), [400]);
    expect(
      [...f.objects.keys()].filter((key) => {
        return key.includes("/shared-artifacts/");
      }),
    ).toStrictEqual([]);
    expect(
      (await chat.listArtifactCatalog(f.actor, { kind: "shared-thread" }))
        .artifacts,
    ).toStrictEqual([]);
  },
);

test.each(["publish", "delete", "cancel"] as const)(
  "copies while the title is pending and respects the final action: %s",
  async (action) => {
    const f = await fixture();
    const file = await f.upload();
    const selection = await f.selection(file.url);
    const titleEntered = createDeferredPromise<void>(context.signal);
    const releaseTitle = createDeferredPromise<void>(context.signal);
    const copied = createDeferredPromise<string>(context.signal);
    const providerReturned = createDeferredPromise<void>(context.signal);
    const controller = new AbortController();
    const originalSend = context.mocks.s3.send.getMockImplementation()!;
    context.mocks.s3.send.mockImplementation(async (command: unknown) => {
      const result = await originalSend(command);
      if (
        command instanceof CopyObjectCommand &&
        command.input.CopySource === file.key
      ) {
        copied.resolve(
          command.input.Key!.split("/thread-shares/")[1]!.split("/")[0]!,
        );
      }
      return result;
    });
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter");
    server.use(
      http.post("https://openrouter.ai/api/v1/chat/completions", async () => {
        titleEntered.resolve(undefined);
        await releaseTitle.promise;
        providerReturned.resolve(undefined);
        return HttpResponse.json({
          choices: [
            { finish_reason: "stop", message: { content: "Shared report" } },
          ],
        });
      }),
    );
    const pending = share(f.actor, selection, {
      signal: controller.signal,
      rethrowErrors: true,
    });
    const outcome = Promise.allSettled([pending]);
    onTestFinished(async () => {
      if (!releaseTitle.settled()) {
        releaseTitle.resolve(undefined);
      }
      await outcome;
    });
    await titleEntered.promise;
    const id = await copied.promise;
    const policyKey = `test-hosted-sites/shared-thread-artifacts/okou/${id}.json`;
    expect(JSON.parse(f.objects.get(policyKey)!.toString())).toMatchObject({
      status: "preparing",
    });
    await accept(api()(sharedThreadsContract).get({ params: { id } }), [404]);
    expect(
      (await chat.listArtifactCatalog(f.actor, { kind: "shared-thread" }))
        .artifacts,
    ).toStrictEqual([]);
    if (action === "cancel") {
      const reason = new DOMException("Caller cancelled", "AbortError");
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
      expect(
        [...f.objects.keys()].filter((key) => {
          return key.includes("/thread-shares/");
        }),
      ).toStrictEqual([]);
      expect(JSON.parse(f.objects.get(policyKey)!.toString())).toMatchObject({
        status: "revoked",
      });
      releaseTitle.resolve(undefined);
      await providerReturned.promise;
      return;
    }
    if (action === "delete") {
      await accept(
        api()(sharedThreadsContract).delete({
          headers: headers(f.actor),
          params: { id },
        }),
        [204],
      );
      expect(JSON.parse(f.objects.get(policyKey)!.toString())).toMatchObject({
        status: "revoked",
      });
      releaseTitle.resolve(undefined);
      await accept(pending, [400]);
      await accept(api()(sharedThreadsContract).get({ params: { id } }), [404]);
      expect(
        [...f.objects.keys()].filter((key) => {
          return key.includes("/thread-shares/");
        }),
      ).toStrictEqual([]);
      return;
    }
    releaseTitle.resolve(undefined);
    const created = await accept(pending, [201]);
    expect(created.body.id).toBe(id);
    const shared = await accept(
      api()(sharedThreadsContract).get({ params: { id } }),
      [200],
    );
    expect(shared.body.title).toBe("Shared report");
    const catalog = await chat.listArtifactCatalog(f.actor, {
      kind: "shared-thread",
    });
    expect(catalog.artifacts).toHaveLength(1);
    const detail = await chat.getArtifactCatalogEntry(
      f.actor,
      catalog.artifacts[0]!.id,
    );
    expect(detail).toMatchObject({
      title: "Shared report",
      sharedThread: { id },
    });
    expect(JSON.parse(f.objects.get(policyKey)!.toString())).toMatchObject({
      status: "active",
    });
  },
);

test("starts queued copies while an earlier copy is still pending", async () => {
  const f = await fixture();
  const site = await f.site([
    { path: "/index.html", content: "<h1>Large bundle</h1>" },
    ...Array.from({ length: 11 }, (_, index) => {
      return {
        path: `/asset-${index}.bin`,
        content: `Asset ${index}`,
        contentType: "application/octet-stream",
      };
    }),
  ]);
  const selection = await f.selection(site.url);
  const releaseFirst = createDeferredPromise<void>(context.signal);
  const eleventhStarted = createDeferredPromise<void>(context.signal);
  const originalSend = context.mocks.s3.send.getMockImplementation()!;
  let started = 0;
  let running = 0;
  let maximumRunning = 0;
  context.mocks.s3.send.mockImplementation(async (command: unknown) => {
    if (
      command instanceof CopyObjectCommand &&
      command.input.CopySource?.includes(site.deploymentId)
    ) {
      started += 1;
      running += 1;
      maximumRunning = Math.max(maximumRunning, running);
      if (started === 1) {
        await releaseFirst.promise;
      } else if (started === 11) {
        eleventhStarted.resolve(undefined);
      }
      const result = await originalSend(command);
      running -= 1;
      return result;
    }
    return originalSend(command);
  });
  const pending = share(f.actor, selection);
  const outcome = Promise.allSettled([pending]);
  onTestFinished(async () => {
    if (!releaseFirst.settled()) {
      releaseFirst.resolve(undefined);
    }
    await outcome;
  });
  await eleventhStarted.promise;
  expect(releaseFirst.settled()).toBeFalsy();
  expect(maximumRunning).toBeGreaterThan(1);
  expect(maximumRunning).toBeLessThanOrEqual(10);
  releaseFirst.resolve(undefined);
  await accept(pending, [201]);
  expect(started).toBe(12);
});

test("drains an in-flight copy before rolling back another copy's failure", async () => {
  const f = await fixture();
  const first = await f.upload();
  const second = await f.upload(f.actor, "Second file");
  const selection = await f.selection(`${first.url} ${second.url}`);
  const release = createDeferredPromise<void>(context.signal);
  const failed = createDeferredPromise<void>(context.signal);
  const originalSend = context.mocks.s3.send.getMockImplementation()!;
  let copiesStarted = 0;
  let deletedWhileCopying = false;
  context.mocks.s3.send.mockImplementation(async (command: unknown) => {
    if (command instanceof CopyObjectCommand) {
      copiesStarted += 1;
      if (copiesStarted === 1) {
        await release.promise;
      } else {
        failed.resolve(undefined);
        throw new Error("Copy failed");
      }
    }
    if (command instanceof DeleteObjectsCommand && !release.settled()) {
      deletedWhileCopying = true;
    }
    return originalSend(command);
  });
  const pending = share(f.actor, selection);
  const outcome = Promise.allSettled([pending]);
  onTestFinished(async () => {
    if (!release.settled()) {
      release.resolve(undefined);
    }
    await outcome;
  });
  await failed.promise;
  expect(deletedWhileCopying).toBeFalsy();
  release.resolve(undefined);
  await expect(pending).rejects.toThrow("Unknown response status 500");
  expect(deletedWhileCopying).toBeFalsy();
  expect(
    [...f.objects.keys()].filter((key) => {
      return key.includes("/thread-shares/");
    }),
  ).toStrictEqual([]);
  expect(
    (await chat.listArtifactCatalog(f.actor, { kind: "shared-thread" }))
      .artifacts,
  ).toStrictEqual([]);
});

test("registers independent dependency aliases concurrently and deduplicates repeated references", async () => {
  const f = await fixture();
  const first = await f.upload();
  const second = await f.upload(f.actor, "Another dependency");
  const selection = await f.selection(
    `${first.url} ${second.url} ${first.url}`,
  );
  const release = createDeferredPromise<void>(context.signal);
  const secondStarted = createDeferredPromise<void>(context.signal);
  const originalSend = context.mocks.s3.send.getMockImplementation()!;
  let registrations = 0;
  context.mocks.s3.send.mockImplementation(async (command: unknown) => {
    if (
      command instanceof PutObjectCommand &&
      typeof command.input.Body === "string" &&
      command.input.Body.includes('"kind":"thread-resource"')
    ) {
      registrations += 1;
      if (registrations === 1) {
        await release.promise;
      } else {
        secondStarted.resolve(undefined);
      }
    }
    return originalSend(command);
  });
  const pending = share(f.actor, selection);
  const outcome = Promise.allSettled([pending]);
  onTestFinished(async () => {
    if (!release.settled()) {
      release.resolve(undefined);
    }
    await outcome;
  });
  await secondStarted.promise;
  expect(release.settled()).toBeFalsy();
  release.resolve(undefined);
  await accept(pending, [201]);
  expect(registrations).toBe(2);
  expect(f.copies).toHaveLength(2);
});

test("snapshots nested and cyclic historical dependencies once per deployment", async () => {
  const f = await fixture();
  const first = await f.site(
    [{ path: "/index.html", content: "Original upload" }],
    undefined,
    true,
  );
  const second = await f.site(
    [{ path: "/index.html", content: `<a href="${first.url}">First</a>` }],
    undefined,
    true,
  );
  // Older completion did not pin upload revisions. Its still-valid upload URL
  // could create self/cyclic references before the first indexed share.
  f.objects.set(
    `test-hosted-sites/private-sites/okou/${first.deploymentId}/index.html`,
    Buffer.from(
      `<a href="${second.url}">Second</a><a href="${first.url}">Self</a>`,
    ),
  );
  const selection = await f.selection(
    `${first.url} ${second.url} ${first.url}`,
  );
  const created = await accept(share(f.actor, selection), [201]);
  const shared = await accept(
    api()(sharedThreadsContract).get({ params: { id: created.body.id } }),
    [200],
  );
  const [firstUrl, secondUrl, repeatedUrl] =
    shared.body.messages[0]!.content.split(" ");
  expect(repeatedUrl).toBe(firstUrl);
  expect(firstUrl).not.toBe(secondUrl);
  const prefix = `test-hosted-sites/shared-artifacts/okou/${created.body.id}`;
  expect(
    f.objects.get(`${prefix}/${first.deploymentId}/index.html`)?.toString(),
  ).toBe(`<a href="${secondUrl}">Second</a><a href="${firstUrl}">Self</a>`);
  expect(
    f.objects.get(`${prefix}/${second.deploymentId}/index.html`)?.toString(),
  ).toBe(`<a href="${firstUrl}">First</a>`);
  expect(hostedSourceReads(first.deploymentId)).toHaveLength(2);
  expect(hostedSourceReads(second.deploymentId)).toHaveLength(2);
});

test("keeps oversized sites hostable while preserving the snapshot text limit", async () => {
  const f = await fixture();
  const site = await f.site([
    { path: "/index.html", content: "x".repeat(4 * 1024 * 1024 + 1) },
  ]);
  expect(hostedSourceReads(site.deploymentId)).toStrictEqual([]);
  const selection = await f.selection(site.url);
  await accept(share(f.actor, selection), [400]);
  expect(f.copies).toStrictEqual([]);
});

test("bounds dependency indexing by actual bytes when historical upload sizes are incorrect", async () => {
  const f = await fixture();
  const site = await f.site(
    [
      { path: "/index.html", content: "Original upload" },
      ...Array.from({ length: 9 }, (_, index) => {
        return {
          path: `/chunk-${index}.js`,
          content: "x",
          contentType: "text/javascript",
        };
      }),
    ],
    undefined,
    true,
  );
  const chunk = Buffer.from("x".repeat(4 * 1024 * 1024));
  for (let index = 0; index < 9; index += 1) {
    f.objects.set(
      `test-hosted-sites/private-sites/okou/${site.deploymentId}/chunk-${index}.js`,
      chunk,
    );
  }
  const selection = await f.selection(site.url);
  await accept(share(f.actor, selection), [400]);
  expect(f.copies).toStrictEqual([]);
  context.mocks.s3.send.mockClear();
  await accept(share(f.actor, selection), [400]);
  expect(hostedSourceReads(site.deploymentId)).toStrictEqual([]);
});
