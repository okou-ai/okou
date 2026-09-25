import { createHash, randomUUID } from "node:crypto";

import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { revokedChatEventIds } from "@okouai/api-contracts/contracts/chat-events";
import {
  integrationsDiscordDownloadFileContract,
  integrationsDiscordUploadCompleteContract,
  integrationsDiscordUploadInitContract,
  integrationsDiscordUploadMaterializeContract,
  MAX_DISCORD_FILE_SIZE_BYTES,
  type DiscordUploadInitBody,
} from "@okouai/api-contracts/contracts/integrations-discord-files";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, now, withMockNowForTest } from "../../../lib/time";
import { sanitizeArtifactFilename } from "../../../lib/file-url";
import { server } from "../../../mocks/server";
import {
  closeErasureSubjectFixture,
  removeErasureSubjectsFixture,
} from "../../../test-fixtures/account-erasure-subject";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise, settle } from "../../utils";
import { createBddApi } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { readProjectedChatEvents } from "./helpers/chat-event-test-reader";
import {
  discordChatThreads,
  discordMessageForTest,
  mockDiscordProvider,
  postDiscordMessage,
  setupConnectedDiscordActor,
} from "./helpers/discord-fixture";
import {
  discordApiOrigin,
  discordFileMessage,
  discordSnowflake,
  mockDiscordFileProvider,
  type DiscordFileProviderIdentity,
} from "./helpers/discord-file-provider";
import {
  configureDiscordApp,
  deleteDiscordFixture,
  mockDiscordMemberships,
  seedDiscordFixture,
} from "./helpers/discord";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { artifactCatalogRoutes } from "../artifact-catalog";
import { integrationsDiscordFileRoutes } from "../integrations-discord-files";

const context = testContext({ connectorCatalog: true });
const bdd = createBddApi(context);
const storage = createChatCallbacksApi(context);
const chatFiles = createChatFilesBddApi(context);
const runs = createRunsApi(context);
const channelId = "123456789012345678";
const messageId = "223456789012345678";
const attachmentId = "323456789012345678";

function fileClients() {
  const app = setupApp({ context, routes: integrationsDiscordFileRoutes });
  return {
    init: app(integrationsDiscordUploadInitContract).init,
    materialize: app(integrationsDiscordUploadMaterializeContract).materialize,
    complete: app(integrationsDiscordUploadCompleteContract).complete,
    download: app(integrationsDiscordDownloadFileContract).download,
  };
}

function uploadBody(
  overrides: Partial<DiscordUploadInitBody> = {},
): DiscordUploadInitBody {
  return {
    filename: "report.csv",
    length: 8,
    contentType: "text/csv",
    checksumSha256: "a".repeat(64),
    operationId: randomUUID(),
    channelId,
    ...overrides,
  };
}

async function actorSession(options: Parameters<typeof bdd.user>[0] = {}) {
  const actor = bdd.user(options);
  if (!actor.orgId) {
    throw new Error("Discord file test actor must have an organization");
  }
  await bdd.readMe(actor);
  return { ...actor, orgId: actor.orgId };
}

interface BoundFixture extends DiscordFileProviderIdentity {
  readonly actor: Awaited<ReturnType<typeof actorSession>>;
  readonly binding: Awaited<ReturnType<typeof seedDiscordFixture>>;
  readonly connectionId: string;
  readonly headers: { readonly authorization: string };
}

async function boundFixture(): Promise<BoundFixture> {
  const actor = await actorSession();
  const identity = {
    guildId: discordSnowflake(),
    discordUserId: discordSnowflake(),
    botUserId: discordSnowflake(),
    channelId: discordSnowflake(),
  };
  configureDiscordApp();
  mockEnv("DISCORD_APPLICATION_ID", identity.botUserId);
  mockDiscordMemberships(context, [actor]);
  mockDiscordFileProvider(identity);
  const binding = await seedDiscordFixture(context, {
    userId: actor.userId,
    orgId: actor.orgId,
    orgRole: "org:admin",
    guildId: identity.guildId,
    guildName: "Discord file tests",
    botUserId: identity.botUserId,
    discordUserId: identity.discordUserId,
  });
  onTestFinished(async () => {
    mockDiscordMemberships(context, [actor]);
    await deleteDiscordFixture(context, binding);
  });
  await updateFeatureSwitchesForUser(context, actor, {
    [FeatureSwitchKey.DiscordIntegration]: true,
  });
  return {
    ...identity,
    actor,
    binding,
    connectionId: binding.connectionId,
    headers: { authorization: "Bearer clerk-session" },
  };
}

async function canonicalUpload(
  fixture: BoundFixture,
  overrides: Partial<DiscordUploadInitBody> = {},
) {
  await updateFeatureSwitchesForUser(context, fixture.actor, {
    [FeatureSwitchKey.DiscordIntegration]: true,
    [FeatureSwitchKey.PrivateArtifacts]: true,
  });
  const objectStore = storage.acceptChatObjectStorage();
  const bytes = Buffer.from("a,b\n1,2\n");
  const body = uploadBody({
    channelId: fixture.channelId,
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
    ...overrides,
  });
  const initialized = await accept(
    fileClients().init({ headers: fixture.headers, body }),
    [200],
  );
  objectStore.addObject({
    bucket: "test-private-artifacts",
    key: `private-artifacts/${initialized.body.assetId}/${sanitizeArtifactFilename(body.filename)}`,
    size: bytes.byteLength,
    body: bytes,
    contentType: body.contentType,
    metadata: { "artifact-id": initialized.body.assetId },
  });
  return {
    initialized: initialized.body,
    body,
    bytes,
    operation: {
      assetId: initialized.body.assetId,
      operationId: body.operationId,
    },
  };
}

function catalogClient() {
  return setupApp({ context, routes: artifactCatalogRoutes })(
    artifactCatalogContract,
  );
}

const deliveryPayloadSchema = z.object({
  nonce: z.string().min(1),
  enforce_nonce: z.literal(true),
  allowed_mentions: z.object({
    parse: z.array(z.string()),
    replied_user: z.literal(false),
  }),
});

async function uploadedDiscordNonce(request: Request, expectedBytes: Buffer) {
  const form = await request.formData();
  const payloadJson = form.get("payload_json");
  if (typeof payloadJson !== "string") {
    throw new Error("Expected Discord multipart message payload");
  }
  const payload = deliveryPayloadSchema.parse(JSON.parse(payloadJson));
  expect(payload.allowed_mentions.parse).toStrictEqual([]);
  const attachment = form.get("files[0]");
  if (!(attachment instanceof File)) {
    throw new Error("Expected the canonical file in Discord multipart bytes");
  }
  expect(Buffer.from(await attachment.arrayBuffer())).toStrictEqual(
    expectedBytes,
  );
  return payload.nonce;
}

function incomingAttachment(fixture: DiscordFileProviderIdentity) {
  const fileId = discordSnowflake();
  const sourceMessageId = discordSnowflake();
  const bytes = "a,b\n1,2\n";
  const filename = "quarterly report.csv";
  const url =
    `https://cdn.discordapp.com/attachments/${fixture.channelId}/${fileId}/` +
    `${encodeURIComponent(filename)}?ex=expires&hm=signed`;
  const attachment = {
    id: fileId,
    filename,
    size: Buffer.byteLength(bytes),
    content_type: "text/csv",
    url,
  };
  const message = discordFileMessage({
    channelId: fixture.channelId,
    messageId: sourceMessageId,
    authorId: fixture.discordUserId,
    attachment,
  });
  const messageUrl =
    `${discordApiOrigin}/channels/${fixture.channelId}/messages/` +
    sourceMessageId;
  server.use(
    http.get(messageUrl, () => {
      return HttpResponse.json(message);
    }),
    http.get(url, ({ request }) => {
      expect(request.headers.get("authorization")).toBeNull();
      expect(request.headers.get("cookie")).toBeNull();
      return new HttpResponse(bytes, {
        headers: {
          "content-type": attachment.content_type,
          "content-length": String(attachment.size),
        },
      });
    }),
  );
  return {
    bytes,
    attachment,
    message,
    messageUrl,
    query: {
      channelId: fixture.channelId,
      messageId: sourceMessageId,
      attachmentId: fileId,
    },
  };
}

describe("Discord file authorization and input validation", () => {
  it("requires authentication for every file endpoint", async () => {
    const client = fileClients();
    const operation = { assetId: randomUUID(), operationId: randomUUID() };
    const responses = [
      await accept(client.init({ headers: {}, body: uploadBody() }), [401]),
      await accept(client.materialize({ headers: {}, body: operation }), [401]),
      await accept(client.complete({ headers: {}, body: operation }), [401]),
      await accept(
        client.download({
          headers: {},
          query: { channelId, messageId, attachmentId },
        }),
        [401],
      ),
    ];

    for (const response of responses) {
      expect(response.body.error.code).toBe("UNAUTHORIZED");
    }
  });

  it("requires native read or write capability for sandbox requests", async () => {
    const actor = await actorSession();
    const seconds = Math.floor(now() / 1000);
    const token = signSandboxJwtForTests({
      scope: "sandbox",
      userId: actor.userId,
      orgId: actor.orgId,
      runId: randomUUID(),
      iat: seconds,
      exp: seconds + 60,
    });
    const headers = { authorization: `Bearer ${token}` };
    const client = fileClients();
    const upload = await accept(
      client.init({ headers, body: uploadBody() }),
      [403],
    );
    const download = await accept(
      client.download({
        headers,
        query: { channelId, messageId, attachmentId },
      }),
      [403],
    );

    expect(upload.body.error.message).toContain("discord:write");
    expect(download.body.error.message).toContain("discord:read");
  });

  it("keeps file reads and writes unavailable while Discord is disabled", async () => {
    const actor = await actorSession();
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.DiscordIntegration]: false,
    });
    const client = fileClients();
    const headers = { authorization: "Bearer clerk-session" };
    const upload = await accept(
      client.init({ headers, body: uploadBody() }),
      [403],
    );
    const download = await accept(
      client.download({
        headers,
        query: { channelId, messageId, attachmentId },
      }),
      [403],
    );

    expect(upload.body.error.code).toBe("FORBIDDEN");
    expect(download.body.error.code).toBe("FORBIDDEN");
  });

  it("rejects an enabled but unbound caller", async () => {
    const actor = await actorSession();
    configureDiscordApp();
    mockDiscordMemberships(context, [actor]);
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.DiscordIntegration]: true,
    });
    const response = await accept(
      fileClients().download({
        headers: { authorization: "Bearer clerk-session" },
        query: { channelId, messageId, attachmentId },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it.each([
    { filename: "../report.csv" },
    { filename: "report\r\n.csv" },
    { filename: "report\\private.csv" },
    { filename: "." },
    { length: MAX_DISCORD_FILE_SIZE_BYTES + 1 },
    { length: 0 },
    { checksumSha256: "not-a-checksum" },
    { channelId: "1e18" },
  ])("rejects malformed upload metadata: %j", async (invalid) => {
    await actorSession();
    const response = await accept(
      fileClients().init({
        headers: { authorization: "Bearer clerk-session" },
        body: uploadBody(invalid),
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("rejects download identifiers that cannot identify a Discord attachment", async () => {
    await actorSession();
    const response = await accept(
      fileClients().download({
        headers: { authorization: "Bearer clerk-session" },
        query: {
          channelId,
          messageId,
          attachmentId: "../../credentials",
        },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
  });
});

describe("Discord attachment downloads", () => {
  it.each(["member", "bot"])(
    "requires the %s to have ATTACH_FILES in addition to readable channel access",
    async (deniedParty) => {
      const fixture = await boundFixture();
      const source = incomingAttachment(fixture);
      server.use(
        http.get(`${discordApiOrigin}/channels/${fixture.channelId}`, () => {
          return HttpResponse.json({
            id: fixture.channelId,
            type: 0,
            guild_id: fixture.guildId,
            permission_overwrites: [
              {
                id:
                  deniedParty === "member"
                    ? fixture.discordUserId
                    : fixture.botUserId,
                type: 1,
                allow: "0",
                deny: (1n << 15n).toString(),
              },
            ],
          });
        }),
      );
      const client = fileClients();
      const readable = await accept(
        client.download({ headers: fixture.headers, query: source.query }),
        [200],
      );
      const upload = await accept(
        client.init({
          headers: fixture.headers,
          body: uploadBody({ channelId: fixture.channelId }),
        }),
        [404],
      );

      expect(readable.body).toBe(source.bytes);
      expect(upload.body.error.code).toBe("NOT_FOUND");
    },
  );

  it("denies bot DM attachment downloads while keeping uploads to the sender's own DM", async () => {
    const fixture = await boundFixture();
    const source = incomingAttachment(fixture);
    // Discord keeps one bot DM per user, shared by every connected org.
    server.use(
      http.get(`${discordApiOrigin}/channels/${fixture.channelId}`, () => {
        return HttpResponse.json({
          id: fixture.channelId,
          type: 1,
          recipients: [{ id: fixture.discordUserId, username: "file-owner" }],
        });
      }),
    );
    const denied = await accept(
      fileClients().download({ headers: fixture.headers, query: source.query }),
      [403],
    );
    expect(denied.body.error.code).toBe("DISCORD_DM_READ_DENIED");
    const upload = await canonicalUpload(fixture);
    expect(upload.initialized.assetId).toStrictEqual(expect.any(String));
  });

  it("returns fresh, authorized attachment bytes with private download headers", async () => {
    const fixture = await boundFixture();
    const source = incomingAttachment(fixture);
    const response = await accept(
      fileClients().download({ headers: fixture.headers, query: source.query }),
      [200],
    );

    expect(response.body).toBe(source.bytes);
    expect(response.headers.get("content-type")).toBe("text/csv");
    expect(response.headers.get("content-length")).toBe(
      String(source.attachment.size),
    );
    expect(response.headers.get("x-file-name")).toBe(
      encodeURIComponent(source.attachment.filename),
    );
    expect(response.headers.get("x-file-mimetype")).toBe("text/csv");
    expect(response.headers.get("content-disposition")).toContain(
      "attachment;",
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("does not download a forged attachment ID from an otherwise readable message", async () => {
    const fixture = await boundFixture();
    const source = incomingAttachment(fixture);
    const response = await accept(
      fileClients().download({
        headers: fixture.headers,
        query: { ...source.query, attachmentId: discordSnowflake() },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("refreshes an expired CDN URL once from the same message identity", async () => {
    const fixture = await boundFixture();
    const source = incomingAttachment(fixture);
    const requests: string[] = [];
    let messageReads = 0;
    server.use(
      http.get(source.messageUrl, () => {
        messageReads += 1;
        return HttpResponse.json({
          ...source.message,
          attachments: [
            {
              ...source.attachment,
              url: `${source.attachment.url}&version=${messageReads}`,
            },
          ],
        });
      }),
      http.get(source.attachment.url, ({ request }) => {
        requests.push(request.url);
        expect(request.headers.get("authorization")).toBeNull();
        if (new URL(request.url).searchParams.get("version") === "1") {
          return new HttpResponse(null, { status: 403 });
        }
        return new HttpResponse(source.bytes, {
          headers: { "content-type": "text/csv" },
        });
      }),
    );

    const response = await accept(
      fileClients().download({ headers: fixture.headers, query: source.query }),
      [200],
    );

    expect(response.body).toBe(source.bytes);
    expect(messageReads).toBe(2);
    expect(requests).toStrictEqual([
      `${source.attachment.url}&version=1`,
      `${source.attachment.url}&version=2`,
    ]);
  });

  it("stops after the refreshed attachment URL is still unavailable", async () => {
    const fixture = await boundFixture();
    const source = incomingAttachment(fixture);
    let messageReads = 0;
    let downloads = 0;
    server.use(
      http.get(source.messageUrl, () => {
        messageReads += 1;
        return HttpResponse.json(source.message);
      }),
      http.get(source.attachment.url, () => {
        downloads += 1;
        return new HttpResponse(null, { status: 404 });
      }),
    );

    const response = await accept(
      fileClients().download({ headers: fixture.headers, query: source.query }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(messageReads).toBe(2);
    expect(downloads).toBe(2);
  });

  it("rechecks the live feature gate before refreshing an expired attachment", async () => {
    const fixture = await boundFixture();
    const source = incomingAttachment(fixture);
    let downloads = 0;
    server.use(
      http.get(source.attachment.url, async () => {
        downloads += 1;
        await updateFeatureSwitchesForUser(context, fixture.actor, {
          [FeatureSwitchKey.DiscordIntegration]: false,
        });
        return new HttpResponse(null, { status: 403 });
      }),
    );

    const response = await accept(
      fileClients().download({ headers: fixture.headers, query: source.query }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(downloads).toBe(1);
  });

  it.each(["host", "attachment-path", "redirect"])(
    "rejects an unsafe CDN %s without requesting another origin",
    async (unsafeKind) => {
      const fixture = await boundFixture();
      const source = incomingAttachment(fixture);
      const attackerUrl = "https://download.example.test/private-report";
      const attackerRequests: string[] = [];
      const url =
        unsafeKind === "host"
          ? attackerUrl
          : unsafeKind === "attachment-path"
            ? source.attachment.url.replace(
                source.query.attachmentId,
                discordSnowflake(),
              )
            : source.attachment.url;
      server.use(
        http.get(attackerUrl, ({ request }) => {
          attackerRequests.push(request.url);
          return new HttpResponse(source.bytes);
        }),
        http.get(source.messageUrl, () => {
          return HttpResponse.json({
            ...source.message,
            attachments: [{ ...source.attachment, url }],
          });
        }),
        http.get(source.attachment.url, ({ request }) => {
          expect(request.headers.get("authorization")).toBeNull();
          return new HttpResponse(null, {
            status: 302,
            headers: { location: attackerUrl },
          });
        }),
      );
      if (unsafeKind === "attachment-path") {
        server.use(
          http.get(url, ({ request }) => {
            attackerRequests.push(request.url);
            return new HttpResponse(source.bytes, {
              headers: { "content-type": "text/csv" },
            });
          }),
        );
      }

      const response = await accept(
        fileClients().download({
          headers: fixture.headers,
          query: source.query,
        }),
        [502],
      );

      expect(response.body.error.code).toBe("DISCORD_FILE_ERROR");
      expect(attackerRequests).toStrictEqual([]);
    },
  );

  it("rejects streamed bytes beyond the Discord file limit without a length header", async () => {
    const fixture = await boundFixture();
    const source = incomingAttachment(fixture);
    server.use(
      http.get(source.messageUrl, () => {
        return HttpResponse.json({
          ...source.message,
          attachments: [
            { ...source.attachment, size: MAX_DISCORD_FILE_SIZE_BYTES },
          ],
        });
      }),
      http.get(source.attachment.url, () => {
        return new HttpResponse(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(MAX_DISCORD_FILE_SIZE_BYTES));
              controller.enqueue(new Uint8Array([1]));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/csv" } },
        );
      }),
    );

    const response = await accept(
      fileClients().download({ headers: fixture.headers, query: source.query }),
      [413],
    );

    expect(response.body.error.message).toMatch(/size|large|exceed/iu);
  });

  it.each(["application/x-msdownload", "image/png"])(
    "rejects an unsupported or mismatched CDN MIME type %s",
    async (contentType) => {
      const fixture = await boundFixture();
      const source = incomingAttachment(fixture);
      server.use(
        http.get(source.attachment.url, () => {
          return new HttpResponse(source.bytes, {
            headers: { "content-type": contentType },
          });
        }),
      );

      const response = await accept(
        fileClients().download({
          headers: fixture.headers,
          query: source.query,
        }),
        [502],
      );

      expect(response.body.error.message).toMatch(/mime|type/iu);
    },
  );
});

describe("Canonical Discord file publication and delivery", () => {
  it.each(["user", "organization"] as const)(
    "does not publish after its %s closes during the provider access check",
    async (subjectKind) => {
      const fixture = await boundFixture();
      await updateFeatureSwitchesForUser(context, fixture.actor, {
        [FeatureSwitchKey.DiscordIntegration]: true,
        [FeatureSwitchKey.PrivateArtifacts]: true,
      });
      storage.acceptChatObjectStorage();
      const jobs: string[] = [];
      onTestFinished(async () => {
        await removeErasureSubjectsFixture(jobs);
      });
      server.use(
        http.get(
          `${discordApiOrigin}/channels/${fixture.channelId}`,
          async () => {
            // Infrastructure exception: B1 has no production closure ingress.
            // This existing fixture records a test-owned dormant decision only.
            // The provider response places closure after binding authorization
            // and before the canonical publication writer's transaction.
            const closed = await closeErasureSubjectFixture({
              subjectKind,
              subjectId:
                subjectKind === "user"
                  ? fixture.actor.userId
                  : fixture.actor.orgId,
            });
            jobs.push(closed.jobId);
            return HttpResponse.json({
              id: fixture.channelId,
              type: 0,
              guild_id: fixture.guildId,
              permission_overwrites: [],
            });
          },
        ),
      );
      context.mocks.s3.getSignedUrl.mockClear();
      const response = await settle(
        fileClients().init({
          headers: fixture.headers,
          body: uploadBody({ channelId: fixture.channelId }),
        }),
        context.signal,
      );
      await removeErasureSubjectsFixture(jobs);
      if (!response.ok) {
        throw response.error;
      }
      const rejected = await accept(Promise.resolve(response.value), [404]);

      expect(rejected.body.error.code).toBe("NOT_FOUND");
      expect(context.mocks.s3.getSignedUrl).not.toHaveBeenCalled();
      const catalog = await accept(
        catalogClient().list({ headers: fixture.headers }),
        [200],
      );
      expect(catalog.body.artifacts).toStrictEqual([]);
    },
  );

  it.each(["user", "organization"])(
    "does not expose another %s's asset through materialize or complete",
    async (foreignOwner) => {
      const fixture = await boundFixture();
      const upload = await canonicalUpload(fixture);
      const actor = await actorSession(
        foreignOwner === "user"
          ? { orgId: fixture.actor.orgId }
          : { userId: fixture.actor.userId },
      );
      mockDiscordMemberships(context, [fixture.actor, actor]);
      const client = fileClients();
      const materialize = await accept(
        client.materialize({
          headers: { authorization: "Bearer clerk-session" },
          body: upload.operation,
        }),
        [404],
      );
      const complete = await accept(
        client.complete({
          headers: { authorization: "Bearer clerk-session" },
          body: upload.operation,
        }),
        [404],
      );

      expect(materialize.body.error.code).toBe("NOT_FOUND");
      expect(complete.body.error.code).toBe("NOT_FOUND");
    },
  );

  it("rechecks the live feature gate before delivering a published file", async () => {
    const fixture = await boundFixture();
    const upload = await canonicalUpload(fixture);
    const client = fileClients();
    await accept(
      client.materialize({ headers: fixture.headers, body: upload.operation }),
      [200],
    );
    await updateFeatureSwitchesForUser(context, fixture.actor, {
      [FeatureSwitchKey.DiscordIntegration]: false,
    });
    const deliveredMessages: string[] = [];
    server.use(
      http.post(
        `${discordApiOrigin}/channels/${fixture.channelId}/messages`,
        ({ request }) => {
          deliveredMessages.push(request.url);
          return new HttpResponse(null, { status: 500 });
        },
      ),
    );

    const response = await accept(
      client.complete({ headers: fixture.headers, body: upload.operation }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(deliveredMessages).toStrictEqual([]);
    const catalog = await accept(
      catalogClient().list({ headers: fixture.headers }),
      [200],
    );
    expect(catalog.body.artifacts).toHaveLength(1);
  });

  it("publishes one canonical artifact before delivery and reuses its receipt", async () => {
    const fixture = await boundFixture();
    const upload = await canonicalUpload(fixture);
    expect(context.mocks.s3.getSignedUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        input: expect.objectContaining({
          Key: `private-artifacts/${upload.operation.assetId}/${upload.body.filename}`,
          ChecksumSHA256: Buffer.from(
            upload.body.checksumSha256,
            "hex",
          ).toString("base64"),
        }),
      }),
      expect.anything(),
    );
    const client = fileClients();
    const materialized = await accept(
      client.materialize({ headers: fixture.headers, body: upload.operation }),
      [200],
    );

    expect(materialized.body).toStrictEqual({
      ...upload.operation,
      url: upload.initialized.url,
      delivery: { status: "pending" },
    });
    const catalog = await accept(
      catalogClient().list({ headers: fixture.headers }),
      [200],
    );
    expect(catalog.body.artifacts).toHaveLength(1);
    const artifact = catalog.body.artifacts[0];
    if (!artifact) {
      throw new Error(
        "Expected the materialized canonical output in the catalog",
      );
    }
    const detail = await accept(
      catalogClient().get({
        headers: fixture.headers,
        params: { artifactId: artifact.id },
      }),
      [200],
    );
    expect(detail.body).toMatchObject({
      kind: "file",
      file: {
        id: upload.operation.assetId,
        filename: upload.body.filename,
        contentType: "text/csv",
        size: upload.bytes.byteLength,
        url: upload.initialized.url,
      },
    });

    const duplicateInit = await accept(
      client.init({ headers: fixture.headers, body: upload.body }),
      [200],
    );
    expect(duplicateInit.body).toStrictEqual({
      ...upload.operation,
      url: upload.initialized.url,
    });
    const deliveredMessageId = discordSnowflake();
    const deliveredAttachmentId = discordSnowflake();
    let sends = 0;
    server.use(
      http.post(
        `${discordApiOrigin}/channels/${fixture.channelId}/messages`,
        async ({ request }) => {
          sends += 1;
          const nonce = await uploadedDiscordNonce(request, upload.bytes);
          return HttpResponse.json(
            discordFileMessage({
              channelId: fixture.channelId,
              messageId: deliveredMessageId,
              authorId: fixture.botUserId,
              bot: true,
              nonce,
              attachment: {
                id: deliveredAttachmentId,
                filename: upload.body.filename,
                size: upload.bytes.byteLength,
                url: `https://cdn.discordapp.com/attachments/${fixture.channelId}/${deliveredAttachmentId}/report.csv`,
                content_type: "text/csv",
              },
            }),
          );
        },
      ),
    );
    const completed = await accept(
      client.complete({ headers: fixture.headers, body: upload.operation }),
      [200],
    );
    const repeated = await accept(
      client.complete({ headers: fixture.headers, body: upload.operation }),
      [200],
    );

    expect(completed.body).toStrictEqual({
      ...upload.operation,
      url: upload.initialized.url,
      delivery: {
        status: "delivered",
        channelId: fixture.channelId,
        messageId: deliveredMessageId,
        attachmentId: deliveredAttachmentId,
        permalink: `https://discord.com/channels/${fixture.guildId}/${fixture.channelId}/${deliveredMessageId}`,
      },
    });
    expect(repeated.body).toStrictEqual(completed.body);
    expect(sends).toBe(1);
    const repeatedCatalog = await accept(
      catalogClient().list({ headers: fixture.headers }),
      [200],
    );
    expect(repeatedCatalog.body.artifacts).toStrictEqual(
      catalog.body.artifacts,
    );
  });

  it("rejects reuse of an operation for a different destination or file", async () => {
    const fixture = await boundFixture();
    const upload = await canonicalUpload(fixture);
    const otherChannelId = discordSnowflake();
    server.use(
      http.get(`${discordApiOrigin}/channels/${otherChannelId}`, () => {
        return HttpResponse.json({
          id: otherChannelId,
          type: 0,
          guild_id: fixture.guildId,
          permission_overwrites: [],
        });
      }),
    );
    const client = fileClients();
    const differentDestination = await accept(
      client.init({
        headers: fixture.headers,
        body: { ...upload.body, channelId: otherChannelId },
      }),
      [409],
    );
    const differentFile = await accept(
      client.init({
        headers: fixture.headers,
        body: { ...upload.body, filename: "different.csv" },
      }),
      [409],
    );
    const original = await accept(
      client.init({ headers: fixture.headers, body: upload.body }),
      [200],
    );

    expect(differentDestination.body.error.code).toBe("CONFLICT");
    expect(differentFile.body.error.code).toBe("CONFLICT");
    expect(original.body.assetId).toBe(upload.operation.assetId);
    expect(original.body.url).toBe(upload.initialized.url);
  });

  it("refuses publication when the stored bytes have a different checksum", async () => {
    const fixture = await boundFixture();
    const upload = await canonicalUpload(fixture);
    const objectStore = storage.acceptChatObjectStorage();
    objectStore.addObject({
      bucket: "test-private-artifacts",
      key: `private-artifacts/${upload.operation.assetId}/${upload.body.filename}`,
      size: upload.bytes.byteLength,
      body: Buffer.from("a,b\n9,9\n"),
      contentType: "text/csv",
      metadata: { "artifact-id": upload.operation.assetId },
    });
    const rejected = await accept(
      fileClients().materialize({
        headers: fixture.headers,
        body: upload.operation,
      }),
      [400],
    );

    expect(rejected.body.error).toMatchObject({
      code: "INVALID_FILE",
      message: expect.stringMatching(/checksum/iu),
    });
    const catalog = await accept(
      catalogClient().list({ headers: fixture.headers }),
      [200],
    );
    expect(catalog.body.artifacts).toStrictEqual([]);
  });

  it("reconciles a lost Discord send response by replaying its enforced nonce", async () => {
    const fixture = await boundFixture();
    const upload = await canonicalUpload(fixture);
    const client = fileClients();
    await accept(
      client.materialize({ headers: fixture.headers, body: upload.operation }),
      [200],
    );
    // Discord returns the original message for a repeated enforced nonce.
    const created = new Map<string, ReturnType<typeof discordFileMessage>>();
    const nonces: string[] = [];
    server.use(
      http.post(
        `${discordApiOrigin}/channels/${fixture.channelId}/messages`,
        async ({ request }) => {
          const nonce = await uploadedDiscordNonce(request, upload.bytes);
          nonces.push(nonce);
          const existing = created.get(nonce);
          if (existing) {
            return HttpResponse.json(existing);
          }
          const deliveredAttachmentId = discordSnowflake();
          created.set(
            nonce,
            discordFileMessage({
              channelId: fixture.channelId,
              messageId: discordSnowflake(),
              authorId: fixture.botUserId,
              bot: true,
              nonce,
              attachment: {
                id: deliveredAttachmentId,
                filename: upload.body.filename,
                size: upload.bytes.byteLength,
                url: `https://cdn.discordapp.com/attachments/${fixture.channelId}/${deliveredAttachmentId}/report.csv`,
                content_type: "text/csv",
              },
            }),
          );
          return HttpResponse.error();
        },
      ),
    );
    const unconfirmed = await accept(
      client.complete({ headers: fixture.headers, body: upload.operation }),
      [200],
    );

    expect(unconfirmed.body).toMatchObject({
      ...upload.operation,
      url: upload.initialized.url,
      delivery: { status: "failed", retryable: true },
    });
    const catalog = await accept(
      catalogClient().list({ headers: fixture.headers }),
      [200],
    );
    expect(catalog.body.artifacts).toHaveLength(1);
    const recovered = await accept(
      client.complete({ headers: fixture.headers, body: upload.operation }),
      [200],
    );
    const [sentMessage] = [...created.values()];
    if (!sentMessage) {
      throw new Error("Expected the external Discord send to have occurred");
    }
    expect(recovered.body).toMatchObject({
      ...upload.operation,
      url: upload.initialized.url,
      delivery: {
        status: "delivered",
        channelId: fixture.channelId,
        messageId: sentMessage.id,
        attachmentId: sentMessage.attachments[0]?.id,
      },
    });
    expect(created.size).toBe(1);
    expect(nonces).toHaveLength(2);
    expect(nonces[1]).toBe(nonces[0]);
  });

  it("records the receipt when Discord normalizes the attachment filename", async () => {
    const fixture = await boundFixture();
    const upload = await canonicalUpload(fixture, {
      filename: "quarterly report.csv",
    });
    const client = fileClients();
    await accept(
      client.materialize({ headers: fixture.headers, body: upload.operation }),
      [200],
    );
    const deliveredMessageId = discordSnowflake();
    const deliveredAttachmentId = discordSnowflake();
    server.use(
      http.post(
        `${discordApiOrigin}/channels/${fixture.channelId}/messages`,
        async ({ request }) => {
          const nonce = await uploadedDiscordNonce(request, upload.bytes);
          return HttpResponse.json(
            discordFileMessage({
              channelId: fixture.channelId,
              messageId: deliveredMessageId,
              authorId: fixture.botUserId,
              bot: true,
              nonce,
              attachment: {
                id: deliveredAttachmentId,
                filename: "quarterly_report.csv",
                size: upload.bytes.byteLength,
                url: `https://cdn.discordapp.com/attachments/${fixture.channelId}/${deliveredAttachmentId}/quarterly_report.csv`,
                content_type: "text/csv",
              },
            }),
          );
        },
      ),
    );
    const completed = await accept(
      client.complete({ headers: fixture.headers, body: upload.operation }),
      [200],
    );

    expect(completed.body.delivery).toStrictEqual({
      status: "delivered",
      channelId: fixture.channelId,
      messageId: deliveredMessageId,
      attachmentId: deliveredAttachmentId,
      permalink: `https://discord.com/channels/${fixture.guildId}/${fixture.channelId}/${deliveredMessageId}`,
    });
  });

  it("retries an explicit rate limit only on a new authorized completion request", async () => {
    const fixture = await boundFixture();
    const upload = await canonicalUpload(fixture);
    const client = fileClients();
    await accept(
      client.materialize({ headers: fixture.headers, body: upload.operation }),
      [200],
    );
    const nonces: string[] = [];
    const deliveredMessageId = discordSnowflake();
    const deliveredAttachmentId = discordSnowflake();
    server.use(
      http.post(
        `${discordApiOrigin}/channels/${fixture.channelId}/messages`,
        async ({ request }) => {
          const nonce = await uploadedDiscordNonce(request, upload.bytes);
          nonces.push(nonce);
          if (nonces.length === 1) {
            return HttpResponse.json(
              { retry_after: 0, global: false },
              { status: 429 },
            );
          }
          return HttpResponse.json(
            discordFileMessage({
              channelId: fixture.channelId,
              messageId: deliveredMessageId,
              authorId: fixture.botUserId,
              bot: true,
              nonce,
              attachment: {
                id: deliveredAttachmentId,
                filename: upload.body.filename,
                size: upload.bytes.byteLength,
                url: `https://cdn.discordapp.com/attachments/${fixture.channelId}/${deliveredAttachmentId}/report.csv`,
                content_type: "text/csv",
              },
            }),
          );
        },
      ),
    );
    const limited = await accept(
      client.complete({ headers: fixture.headers, body: upload.operation }),
      [200],
    );

    expect(limited.body).toMatchObject({
      ...upload.operation,
      url: upload.initialized.url,
      delivery: { status: "failed", retryable: true },
    });
    expect(nonces).toHaveLength(1);
    await updateFeatureSwitchesForUser(context, fixture.actor, {
      [FeatureSwitchKey.DiscordIntegration]: false,
    });
    const revoked = await accept(
      client.complete({ headers: fixture.headers, body: upload.operation }),
      [403],
    );
    expect(revoked.body.error.code).toBe("FORBIDDEN");
    expect(nonces).toHaveLength(1);

    await updateFeatureSwitchesForUser(context, fixture.actor, {
      [FeatureSwitchKey.DiscordIntegration]: true,
    });
    const delivered = await accept(
      client.complete({ headers: fixture.headers, body: upload.operation }),
      [200],
    );

    expect(delivered.body).toMatchObject({
      ...upload.operation,
      url: upload.initialized.url,
      delivery: {
        status: "delivered",
        messageId: deliveredMessageId,
        attachmentId: deliveredAttachmentId,
      },
    });
    expect(nonces).toHaveLength(2);
    expect(nonces[1]).toBe(nonces[0]);
    const catalog = await accept(
      catalogClient().list({ headers: fixture.headers }),
      [200],
    );
    expect(catalog.body.artifacts).toHaveLength(1);
  });

  it("honors Discord's retry deadline before sending the same artifact again", async () => {
    const fixture = await boundFixture();
    const upload = await canonicalUpload(fixture);
    const client = fileClients();
    await accept(
      client.materialize({ headers: fixture.headers, body: upload.operation }),
      [200],
    );
    const publishedCatalog = await accept(
      catalogClient().list({ headers: fixture.headers }),
      [200],
    );
    const nonces: string[] = [];
    const deliveredMessageId = discordSnowflake();
    const deliveredAttachmentId = discordSnowflake();
    server.use(
      http.post(
        `${discordApiOrigin}/channels/${fixture.channelId}/messages`,
        async ({ request }) => {
          const nonce = await uploadedDiscordNonce(request, upload.bytes);
          nonces.push(nonce);
          if (nonces.length === 1) {
            return HttpResponse.json(
              { retry_after: 60, global: false },
              { status: 429, headers: { "retry-after": "60" } },
            );
          }
          return HttpResponse.json(
            discordFileMessage({
              channelId: fixture.channelId,
              messageId: deliveredMessageId,
              authorId: fixture.botUserId,
              bot: true,
              nonce,
              attachment: {
                id: deliveredAttachmentId,
                filename: upload.body.filename,
                size: upload.bytes.byteLength,
                url: `https://cdn.discordapp.com/attachments/${fixture.channelId}/${deliveredAttachmentId}/report.csv`,
                content_type: "text/csv",
              },
            }),
          );
        },
      ),
    );
    const requestedAt = now();
    await withMockNowForTest(requestedAt, async () => {
      const limited = await accept(
        client.complete({ headers: fixture.headers, body: upload.operation }),
        [200],
      );
      expect(limited.body).toMatchObject({
        ...upload.operation,
        url: upload.initialized.url,
        delivery: {
          status: "failed",
          retryable: true,
          retryAfterSeconds: 60,
        },
      });
      expect(nonces).toHaveLength(1);

      for (const { elapsedMs, retryAfterSeconds } of [
        { elapsedMs: 30_000, retryAfterSeconds: 30 },
        { elapsedMs: 59_999, retryAfterSeconds: 1 },
      ]) {
        mockNow(requestedAt + elapsedMs);
        const waiting = await accept(
          client.complete({ headers: fixture.headers, body: upload.operation }),
          [200],
        );
        expect(waiting.body).toMatchObject({
          ...upload.operation,
          url: upload.initialized.url,
          delivery: {
            status: "failed",
            retryable: true,
            retryAfterSeconds,
          },
        });
        expect(nonces).toHaveLength(1);
      }

      mockNow(requestedAt + 60_001);
      const delivered = await accept(
        client.complete({ headers: fixture.headers, body: upload.operation }),
        [200],
      );
      expect(delivered.body).toMatchObject({
        ...upload.operation,
        url: upload.initialized.url,
        delivery: {
          status: "delivered",
          channelId: fixture.channelId,
          messageId: deliveredMessageId,
          attachmentId: deliveredAttachmentId,
        },
      });
      expect(nonces).toHaveLength(2);
      expect(nonces[1]).toBe(nonces[0]);
      const catalog = await accept(
        catalogClient().list({ headers: fixture.headers }),
        [200],
      );
      expect(catalog.body.artifacts).toHaveLength(1);
      expect(catalog.body.artifacts).toStrictEqual(
        publishedCatalog.body.artifacts,
      );
    });
  });

  it("does not replay a lost send after Discord's nonce window", async () => {
    const fixture = await boundFixture();
    const upload = await canonicalUpload(fixture);
    const client = fileClients();
    await accept(
      client.materialize({ headers: fixture.headers, body: upload.operation }),
      [200],
    );
    let sends = 0;
    server.use(
      http.post(
        `${discordApiOrigin}/channels/${fixture.channelId}/messages`,
        async ({ request }) => {
          sends += 1;
          await uploadedDiscordNonce(request, upload.bytes);
          return new HttpResponse(null, { status: 502 });
        },
      ),
    );
    const requestedAt = now();
    await withMockNowForTest(requestedAt, async () => {
      const unconfirmed = await accept(
        client.complete({ headers: fixture.headers, body: upload.operation }),
        [200],
      );
      expect(unconfirmed.body.delivery).toMatchObject({
        status: "failed",
        retryable: true,
      });

      mockNow(requestedAt + 60_000);
      const expired = await accept(
        client.complete({ headers: fixture.headers, body: upload.operation }),
        [200],
      );
      const repeated = await accept(
        client.complete({ headers: fixture.headers, body: upload.operation }),
        [200],
      );

      expect(expired.body.delivery).toMatchObject({
        status: "failed",
        retryable: false,
      });
      expect(repeated.body.delivery).toStrictEqual(expired.body.delivery);
    });
    expect(sends).toBe(1);
  });

  it("ends a nonce replay that Discord rejects without sending again", async () => {
    const fixture = await boundFixture();
    const upload = await canonicalUpload(fixture);
    const client = fileClients();
    await accept(
      client.materialize({ headers: fixture.headers, body: upload.operation }),
      [200],
    );
    const nonces: string[] = [];
    server.use(
      http.post(
        `${discordApiOrigin}/channels/${fixture.channelId}/messages`,
        async ({ request }) => {
          nonces.push(await uploadedDiscordNonce(request, upload.bytes));
          return nonces.length === 1
            ? new HttpResponse(null, { status: 502 })
            : HttpResponse.json(
                { code: 50_013, message: "Missing Permissions" },
                { status: 403 },
              );
        },
      ),
    );
    await accept(
      client.complete({ headers: fixture.headers, body: upload.operation }),
      [200],
    );
    const rejected = await accept(
      client.complete({ headers: fixture.headers, body: upload.operation }),
      [200],
    );
    const repeated = await accept(
      client.complete({ headers: fixture.headers, body: upload.operation }),
      [200],
    );

    expect(rejected.body.delivery).toMatchObject({
      status: "failed",
      retryable: false,
    });
    expect(repeated.body.delivery).toStrictEqual(rejected.body.delivery);
    expect(nonces).toHaveLength(2);
    expect(nonces[1]).toBe(nonces[0]);
  });

  it.each([
    {
      name: "an invalid rate-limit body",
      body: "<html>rate limited</html>",
      retryAfterSeconds: 5,
    },
    {
      name: "an extreme retry_after",
      body: JSON.stringify({ retry_after: 9_000_000_000_000, global: false }),
      retryAfterSeconds: 900,
    },
  ])(
    "bounds the retry deadline when Discord's 429 has $name",
    async ({ body, retryAfterSeconds }) => {
      const fixture = await boundFixture();
      const upload = await canonicalUpload(fixture);
      const client = fileClients();
      await accept(
        client.materialize({
          headers: fixture.headers,
          body: upload.operation,
        }),
        [200],
      );
      const nonces: string[] = [];
      const deliveredMessageId = discordSnowflake();
      const deliveredAttachmentId = discordSnowflake();
      server.use(
        http.post(
          `${discordApiOrigin}/channels/${fixture.channelId}/messages`,
          async ({ request }) => {
            const nonce = await uploadedDiscordNonce(request, upload.bytes);
            nonces.push(nonce);
            if (nonces.length === 1) {
              return new HttpResponse(body, {
                status: 429,
                headers: { "content-type": "application/json" },
              });
            }
            return HttpResponse.json(
              discordFileMessage({
                channelId: fixture.channelId,
                messageId: deliveredMessageId,
                authorId: fixture.botUserId,
                bot: true,
                nonce,
                attachment: {
                  id: deliveredAttachmentId,
                  filename: upload.body.filename,
                  size: upload.bytes.byteLength,
                  url: `https://cdn.discordapp.com/attachments/${fixture.channelId}/${deliveredAttachmentId}/report.csv`,
                  content_type: "text/csv",
                },
              }),
            );
          },
        ),
      );
      const requestedAt = now();
      await withMockNowForTest(requestedAt, async () => {
        const limited = await accept(
          client.complete({
            headers: fixture.headers,
            body: upload.operation,
          }),
          [200],
        );
        expect(limited.body.delivery).toMatchObject({
          status: "failed",
          retryable: true,
          retryAfterSeconds,
        });

        mockNow(requestedAt + retryAfterSeconds * 1000 - 1);
        const waiting = await accept(
          client.complete({
            headers: fixture.headers,
            body: upload.operation,
          }),
          [200],
        );
        expect(waiting.body.delivery).toMatchObject({
          status: "failed",
          retryable: true,
        });
        expect(nonces).toHaveLength(1);

        mockNow(requestedAt + retryAfterSeconds * 1000);
        const delivered = await accept(
          client.complete({
            headers: fixture.headers,
            body: upload.operation,
          }),
          [200],
        );
        expect(delivered.body.delivery).toMatchObject({
          status: "delivered",
          messageId: deliveredMessageId,
        });
      });
      expect(nonces).toHaveLength(2);
      expect(nonces[1]).toBe(nonces[0]);
    },
  );

  it("keeps a bounded deadline inside the window when a replay's 429 has no usable delay", async () => {
    const fixture = await boundFixture();
    const upload = await canonicalUpload(fixture);
    const client = fileClients();
    await accept(
      client.materialize({ headers: fixture.headers, body: upload.operation }),
      [200],
    );
    const nonces: string[] = [];
    const deliveredMessageId = discordSnowflake();
    const deliveredAttachmentId = discordSnowflake();
    server.use(
      http.post(
        `${discordApiOrigin}/channels/${fixture.channelId}/messages`,
        async ({ request }) => {
          const nonce = await uploadedDiscordNonce(request, upload.bytes);
          nonces.push(nonce);
          if (nonces.length === 1) {
            return new HttpResponse(null, { status: 502 });
          }
          if (nonces.length === 2) {
            return new HttpResponse("not json", { status: 429 });
          }
          return HttpResponse.json(
            discordFileMessage({
              channelId: fixture.channelId,
              messageId: deliveredMessageId,
              authorId: fixture.botUserId,
              bot: true,
              nonce,
              attachment: {
                id: deliveredAttachmentId,
                filename: upload.body.filename,
                size: upload.bytes.byteLength,
                url: `https://cdn.discordapp.com/attachments/${fixture.channelId}/${deliveredAttachmentId}/report.csv`,
                content_type: "text/csv",
              },
            }),
          );
        },
      ),
    );
    const requestedAt = now();
    await withMockNowForTest(requestedAt, async () => {
      await accept(
        client.complete({ headers: fixture.headers, body: upload.operation }),
        [200],
      );
      mockNow(requestedAt + 1000);
      const limited = await accept(
        client.complete({ headers: fixture.headers, body: upload.operation }),
        [200],
      );
      expect(limited.body.delivery).toMatchObject({
        status: "failed",
        retryable: true,
        retryAfterSeconds: 5,
      });

      mockNow(requestedAt + 3000);
      await accept(
        client.complete({ headers: fixture.headers, body: upload.operation }),
        [200],
      );
      expect(nonces).toHaveLength(2);

      mockNow(requestedAt + 6000);
      const delivered = await accept(
        client.complete({ headers: fixture.headers, body: upload.operation }),
        [200],
      );
      expect(delivered.body.delivery).toMatchObject({
        status: "delivered",
        messageId: deliveredMessageId,
      });
    });
    expect(nonces).toHaveLength(3);
    expect(new Set(nonces).size).toBe(1);
  });

  it("keeps Discord's deadline and the original window for a rate-limited replay", async () => {
    const fixture = await boundFixture();
    const upload = await canonicalUpload(fixture);
    const client = fileClients();
    await accept(
      client.materialize({ headers: fixture.headers, body: upload.operation }),
      [200],
    );
    const nonces: string[] = [];
    const deliveredMessageId = discordSnowflake();
    const deliveredAttachmentId = discordSnowflake();
    server.use(
      http.post(
        `${discordApiOrigin}/channels/${fixture.channelId}/messages`,
        async ({ request }) => {
          const nonce = await uploadedDiscordNonce(request, upload.bytes);
          nonces.push(nonce);
          if (nonces.length === 1) {
            return new HttpResponse(null, { status: 502 });
          }
          if (nonces.length === 2) {
            return HttpResponse.json(
              { retry_after: 5, global: false },
              { status: 429, headers: { "retry-after": "5" } },
            );
          }
          return HttpResponse.json(
            discordFileMessage({
              channelId: fixture.channelId,
              messageId: deliveredMessageId,
              authorId: fixture.botUserId,
              bot: true,
              nonce,
              attachment: {
                id: deliveredAttachmentId,
                filename: upload.body.filename,
                size: upload.bytes.byteLength,
                url: `https://cdn.discordapp.com/attachments/${fixture.channelId}/${deliveredAttachmentId}/report.csv`,
                content_type: "text/csv",
              },
            }),
          );
        },
      ),
    );
    const requestedAt = now();
    await withMockNowForTest(requestedAt, async () => {
      await accept(
        client.complete({ headers: fixture.headers, body: upload.operation }),
        [200],
      );
      mockNow(requestedAt + 1000);
      const limited = await accept(
        client.complete({ headers: fixture.headers, body: upload.operation }),
        [200],
      );
      expect(limited.body.delivery).toMatchObject({
        status: "failed",
        retryable: true,
        retryAfterSeconds: 5,
      });

      mockNow(requestedAt + 3000);
      const waiting = await accept(
        client.complete({ headers: fixture.headers, body: upload.operation }),
        [200],
      );
      expect(waiting.body.delivery).toMatchObject({
        status: "failed",
        retryable: true,
        retryAfterSeconds: 3,
      });
      expect(nonces).toHaveLength(2);

      mockNow(requestedAt + 7000);
      const delivered = await accept(
        client.complete({ headers: fixture.headers, body: upload.operation }),
        [200],
      );
      expect(delivered.body.delivery).toMatchObject({
        status: "delivered",
        messageId: deliveredMessageId,
        attachmentId: deliveredAttachmentId,
      });
    });
    expect(nonces).toHaveLength(3);
    expect(new Set(nonces).size).toBe(1);
  });

  it("keeps a replay's attempt when access is lost immediately before sending", async () => {
    const fixture = await boundFixture();
    const upload = await canonicalUpload(fixture);
    const client = fileClients();
    await accept(
      client.materialize({ headers: fixture.headers, body: upload.operation }),
      [200],
    );
    const created = new Map<string, ReturnType<typeof discordFileMessage>>();
    const nonces: string[] = [];
    server.use(
      http.post(
        `${discordApiOrigin}/channels/${fixture.channelId}/messages`,
        async ({ request }) => {
          const nonce = await uploadedDiscordNonce(request, upload.bytes);
          nonces.push(nonce);
          const existing = created.get(nonce);
          if (existing) {
            return HttpResponse.json(existing);
          }
          const deliveredAttachmentId = discordSnowflake();
          created.set(
            nonce,
            discordFileMessage({
              channelId: fixture.channelId,
              messageId: discordSnowflake(),
              authorId: fixture.botUserId,
              bot: true,
              nonce,
              attachment: {
                id: deliveredAttachmentId,
                filename: upload.body.filename,
                size: upload.bytes.byteLength,
                url: `https://cdn.discordapp.com/attachments/${fixture.channelId}/${deliveredAttachmentId}/report.csv`,
                content_type: "text/csv",
              },
            }),
          );
          return HttpResponse.error();
        },
      ),
    );
    await accept(
      client.complete({ headers: fixture.headers, body: upload.operation }),
      [200],
    );
    // The member leaves between the request's access check and the send.
    let memberReads = 0;
    server.use(
      http.get(
        `${discordApiOrigin}/guilds/${fixture.guildId}/members/${fixture.discordUserId}`,
        () => {
          memberReads += 1;
          return memberReads === 1
            ? HttpResponse.json({
                user: { id: fixture.discordUserId, username: "member" },
                roles: [],
                communication_disabled_until: null,
              })
            : HttpResponse.json(
                { code: 10_007, message: "Unknown Member" },
                { status: 404 },
              );
        },
      ),
    );
    const denied = await client.complete({
      headers: fixture.headers,
      body: upload.operation,
    });
    expect(denied.status).not.toBe(200);
    expect(memberReads).toBe(2);
    expect(nonces).toHaveLength(1);

    server.use(
      http.get(
        `${discordApiOrigin}/guilds/${fixture.guildId}/members/${fixture.discordUserId}`,
        () => {
          return HttpResponse.json({
            user: { id: fixture.discordUserId, username: "member" },
            roles: [],
            communication_disabled_until: null,
          });
        },
      ),
    );
    const recovered = await accept(
      client.complete({ headers: fixture.headers, body: upload.operation }),
      [200],
    );
    const [sentMessage] = [...created.values()];

    expect(recovered.body.delivery).toMatchObject({
      status: "delivered",
      messageId: sentMessage?.id,
    });
    expect(created.size).toBe(1);
    expect(nonces).toHaveLength(2);
    expect(nonces[1]).toBe(nonces[0]);
  });

  it("ends a rate-limited replay whose deadline falls outside the nonce window", async () => {
    const fixture = await boundFixture();
    const upload = await canonicalUpload(fixture);
    const client = fileClients();
    await accept(
      client.materialize({ headers: fixture.headers, body: upload.operation }),
      [200],
    );
    let sends = 0;
    server.use(
      http.post(
        `${discordApiOrigin}/channels/${fixture.channelId}/messages`,
        async ({ request }) => {
          sends += 1;
          await uploadedDiscordNonce(request, upload.bytes);
          return sends === 1
            ? new HttpResponse(null, { status: 502 })
            : HttpResponse.json(
                { retry_after: 30, global: false },
                { status: 429, headers: { "retry-after": "30" } },
              );
        },
      ),
    );
    const requestedAt = now();
    await withMockNowForTest(requestedAt, async () => {
      await accept(
        client.complete({ headers: fixture.headers, body: upload.operation }),
        [200],
      );
      mockNow(requestedAt + 40_000);
      const limited = await accept(
        client.complete({ headers: fixture.headers, body: upload.operation }),
        [200],
      );
      expect(limited.body.delivery).toStrictEqual({
        status: "failed",
        message: expect.any(String),
        retryable: false,
      });

      mockNow(requestedAt + 45_000);
      const repeated = await accept(
        client.complete({ headers: fixture.headers, body: upload.operation }),
        [200],
      );
      expect(repeated.body.delivery).toStrictEqual(limited.body.delivery);
    });
    expect(sends).toBe(2);
  });

  it("allows only one nonce replay when retries overlap", async () => {
    const fixture = await boundFixture();
    const upload = await canonicalUpload(fixture);
    const client = fileClients();
    await accept(
      client.materialize({ headers: fixture.headers, body: upload.operation }),
      [200],
    );
    const replaying = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    const deliveredMessageId = discordSnowflake();
    const deliveredAttachmentId = discordSnowflake();
    let sends = 0;
    server.use(
      http.post(
        `${discordApiOrigin}/channels/${fixture.channelId}/messages`,
        async ({ request }) => {
          sends += 1;
          const nonce = await uploadedDiscordNonce(request, upload.bytes);
          if (sends === 1) {
            return new HttpResponse(null, { status: 502 });
          }
          replaying.resolve(undefined);
          await release.promise;
          return HttpResponse.json(
            discordFileMessage({
              channelId: fixture.channelId,
              messageId: deliveredMessageId,
              authorId: fixture.botUserId,
              bot: true,
              nonce,
              attachment: {
                id: deliveredAttachmentId,
                filename: upload.body.filename,
                size: upload.bytes.byteLength,
                url: `https://cdn.discordapp.com/attachments/${fixture.channelId}/${deliveredAttachmentId}/report.csv`,
                content_type: "text/csv",
              },
            }),
          );
        },
      ),
    );
    await accept(
      client.complete({ headers: fixture.headers, body: upload.operation }),
      [200],
    );

    const replay = client.complete({
      headers: fixture.headers,
      body: upload.operation,
    });
    const overlapping = await settle(
      (async () => {
        await Promise.race([
          replaying.promise,
          replay.then((response) => {
            throw new Error(
              `Replay returned ${response.status} before reaching Discord`,
            );
          }),
        ]);
        return await accept(
          client.complete({ headers: fixture.headers, body: upload.operation }),
          [200],
        );
      })(),
      context.signal,
    );
    release.resolve(undefined);
    const replayed = await accept(replay, [200]);
    if (!overlapping.ok) {
      throw overlapping.error;
    }

    expect(overlapping.value.body.delivery).toStrictEqual({
      status: "pending",
    });
    expect(replayed.body.delivery).toMatchObject({
      status: "delivered",
      messageId: deliveredMessageId,
    });
    expect(sends).toBe(2);
  });

  it("allows only one external message when completion requests overlap", async () => {
    const fixture = await boundFixture();
    const upload = await canonicalUpload(fixture);
    const client = fileClients();
    await accept(
      client.materialize({ headers: fixture.headers, body: upload.operation }),
      [200],
    );
    const sending = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    const deliveredMessageId = discordSnowflake();
    const deliveredAttachmentId = discordSnowflake();
    let sends = 0;
    server.use(
      http.post(
        `${discordApiOrigin}/channels/${fixture.channelId}/messages`,
        async ({ request }) => {
          sends += 1;
          const nonce = await uploadedDiscordNonce(request, upload.bytes);
          sending.resolve(undefined);
          await release.promise;
          return HttpResponse.json(
            discordFileMessage({
              channelId: fixture.channelId,
              messageId: deliveredMessageId,
              authorId: fixture.botUserId,
              bot: true,
              nonce,
              attachment: {
                id: deliveredAttachmentId,
                filename: upload.body.filename,
                size: upload.bytes.byteLength,
                url: `https://cdn.discordapp.com/attachments/${fixture.channelId}/${deliveredAttachmentId}/report.csv`,
                content_type: "text/csv",
              },
            }),
          );
        },
      ),
    );

    const first = client.complete({
      headers: fixture.headers,
      body: upload.operation,
    });
    const overlapping = await settle(
      (async () => {
        await Promise.race([
          sending.promise,
          first.then((response) => {
            throw new Error(
              `Completion returned ${response.status} before reaching Discord`,
            );
          }),
        ]);
        return await accept(
          client.complete({ headers: fixture.headers, body: upload.operation }),
          [200],
        );
      })(),
      context.signal,
    );
    release.resolve(undefined);
    const completed = await accept(first, [200]);
    if (!overlapping.ok) {
      throw overlapping.error;
    }

    expect(overlapping.value.body.delivery).toStrictEqual({
      status: "pending",
    });
    expect(completed.body.delivery).toMatchObject({
      status: "delivered",
      messageId: deliveredMessageId,
    });
    expect(sends).toBe(1);
  });

  it("does not replay a receipt after its verified connection is removed or replaced", async () => {
    const fixture = await boundFixture();
    const upload = await canonicalUpload(fixture);
    const client = fileClients();
    await accept(
      client.materialize({ headers: fixture.headers, body: upload.operation }),
      [200],
    );
    const deliveredAttachmentId = discordSnowflake();
    let sends = 0;
    server.use(
      http.post(
        `${discordApiOrigin}/channels/${fixture.channelId}/messages`,
        async ({ request }) => {
          sends += 1;
          const nonce = await uploadedDiscordNonce(request, upload.bytes);
          return HttpResponse.json(
            discordFileMessage({
              channelId: fixture.channelId,
              messageId: discordSnowflake(),
              authorId: fixture.botUserId,
              bot: true,
              nonce,
              attachment: {
                id: deliveredAttachmentId,
                filename: upload.body.filename,
                size: upload.bytes.byteLength,
                url: `https://cdn.discordapp.com/attachments/${fixture.channelId}/${deliveredAttachmentId}/report.csv`,
                content_type: "text/csv",
              },
            }),
          );
        },
      ),
    );
    const initial = await accept(
      client.complete({ headers: fixture.headers, body: upload.operation }),
      [200],
    );
    expect(initial.body.delivery.status).toBe("delivered");

    await deleteDiscordFixture(context, fixture.binding);
    const revoked = await accept(
      client.complete({ headers: fixture.headers, body: upload.operation }),
      [404],
    );
    expect(revoked.body.error.code).toBe("NOT_FOUND");
    const replacement = await seedDiscordFixture(context, {
      userId: fixture.actor.userId,
      orgId: fixture.actor.orgId,
      orgRole: "org:admin",
      guildId: fixture.guildId,
      guildName: "Discord file tests",
      botUserId: fixture.botUserId,
      discordUserId: fixture.discordUserId,
    });
    expect(replacement.connectionId).not.toBe(fixture.connectionId);
    const rebound = await accept(
      client.complete({ headers: fixture.headers, body: upload.operation }),
      [404],
    );

    expect(rebound.body.error.code).toBe("NOT_FOUND");
    expect(sends).toBe(1);
  });

  it("keeps a Run-owned Discord upload visible in its originating chat thread", async () => {
    const fixture = await boundFixture();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    await runs.grantProEntitlement(fixture.actor);
    await runs.ensureOrgModelProvider(fixture.actor);
    const runnerGroup = runs.configureRunnerGroup();
    await runs.heartbeatRunner(runnerGroup);
    const agent = await bdd.createAgent(fixture.actor, {
      displayName: "Discord file source test",
    });
    const sent = await chatFiles.requestSendEvent(
      fixture.actor,
      {
        agentId: agent.agentId,
        prompt: "Create a report for Discord",
      },
      [201],
    );
    if (sent.status !== 201 || !sent.body.runId) {
      throw new Error("Expected the chat request to create an owned Run");
    }
    const seconds = Math.floor(now() / 1000);
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId: fixture.actor.userId,
      orgId: fixture.actor.orgId,
      runId: sent.body.runId,
      capabilities: ["discord:write"],
      iat: seconds,
      exp: seconds + 60,
    });
    const headers = { authorization: `Bearer ${token}` };
    const upload = await canonicalUpload({ ...fixture, headers });
    await accept(
      fileClients().materialize({ headers, body: upload.operation }),
      [200],
    );
    const artifacts = await chatFiles.listThreadArtifacts(
      fixture.actor,
      sent.body.threadId,
    );

    expect(artifacts.runs).toContainEqual({
      runId: sent.body.runId,
      files: [
        expect.objectContaining({
          id: upload.operation.assetId,
          filename: upload.body.filename,
          url: upload.initialized.url,
          assetRef: expect.objectContaining({
            id: upload.operation.assetId,
            classification: "published-output",
            materialization: { status: "ready" },
          }),
        }),
      ],
    });
  });

  it("publishes a Discord-origin Run's output to its native thread and canonical artifact list", async () => {
    const connected = await setupConnectedDiscordActor(context);
    onTestFinished(async () => {
      await flushWaitUntilForTest();
      mockDiscordMemberships(context, [connected]);
      await deleteDiscordFixture(context, connected.fixture);
    });
    runs.acceptTelemetryIngest();
    const provider = mockDiscordProvider(connected);
    const source = discordMessageForTest(connected, {
      channelId: provider.guildChannelId,
      content: `<@${connected.botUserId}> Publish this report to our thread`,
    });
    provider.messages.set(source.id, source);
    const accepted = await postDiscordMessage(context, source);
    expect(accepted.body.outcome).toBe("accepted");
    await flushWaitUntilForTest();
    const [thread] = await discordChatThreads(context, connected);
    if (!thread) {
      throw new Error("Expected Discord ingress to create a canonical chat");
    }
    const events = await readProjectedChatEvents(context, {
      threadId: thread.id,
      headers: { authorization: "Bearer clerk-session" },
    });
    const revokedIds = revokedChatEventIds(events);
    const input = events.find((event) => {
      return event.eventType === "input.prompt" && !revokedIds.has(event.id);
    });
    expect(input).toMatchObject({
      eventType: "input.prompt",
      runId: expect.any(String),
    });
    if (input?.eventType !== "input.prompt" || !input.runId) {
      throw new Error("Expected a Run admitted from the Discord input");
    }
    expect(input.userMessage.parts).toContainEqual({
      type: "source",
      kind: "discord",
      href: `https://discord.com/channels/${connected.guildId}/${provider.guildChannelId}/${source.id}`,
    });
    await runs.heartbeatRunner(connected.runnerGroup);
    const claim = await runs.claimRunnerJob(input.runId);
    const token = claim.platformEnvironment.OKOU_TOKEN;
    if (!token) {
      throw new Error("Expected the Runner claim to issue an Okou run token");
    }
    const headers = { authorization: `Bearer ${token}` };
    const fixture: BoundFixture = {
      ...connected,
      actor: { ...connected.actor, orgId: connected.orgId },
      binding: connected.fixture,
      channelId: source.id,
      headers,
    };
    const upload = await canonicalUpload(fixture);
    const client = fileClients();
    const materialized = await accept(
      client.materialize({ headers, body: upload.operation }),
      [200],
    );
    expect(materialized.body).toStrictEqual({
      ...upload.operation,
      url: upload.initialized.url,
      delivery: { status: "pending" },
    });
    const deliveredMessageId = discordSnowflake();
    const deliveredAttachmentId = discordSnowflake();
    server.use(
      http.post(
        `${discordApiOrigin}/channels/${source.id}/messages`,
        async ({ request }) => {
          const nonce = await uploadedDiscordNonce(request, upload.bytes);
          return HttpResponse.json(
            discordFileMessage({
              channelId: source.id,
              messageId: deliveredMessageId,
              authorId: connected.botUserId,
              bot: true,
              nonce,
              attachment: {
                id: deliveredAttachmentId,
                filename: upload.body.filename,
                size: upload.bytes.byteLength,
                url: `https://cdn.discordapp.com/attachments/${source.id}/${deliveredAttachmentId}/report.csv`,
                content_type: "text/csv",
              },
            }),
          );
        },
      ),
    );
    const completed = await accept(
      client.complete({ headers, body: upload.operation }),
      [200],
    );
    expect(completed.body).toStrictEqual({
      ...upload.operation,
      url: upload.initialized.url,
      delivery: {
        status: "delivered",
        channelId: source.id,
        messageId: deliveredMessageId,
        attachmentId: deliveredAttachmentId,
        permalink: `https://discord.com/channels/${connected.guildId}/${source.id}/${deliveredMessageId}`,
      },
    });
    const artifacts = await chatFiles.listThreadArtifacts(
      connected.actor,
      thread.id,
    );
    expect(artifacts.runs).toContainEqual({
      runId: input.runId,
      files: [
        expect.objectContaining({
          id: upload.operation.assetId,
          filename: upload.body.filename,
          url: upload.initialized.url,
          assetRef: expect.objectContaining({
            id: upload.operation.assetId,
            classification: "published-output",
            materialization: { status: "ready" },
          }),
        }),
      ],
    });
  });
});
