import { createHash, randomUUID } from "node:crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";

import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { revokedChatEventIds } from "@okouai/api-contracts/contracts/chat-events";
import {
  integrationsDiscordDownloadFileContract,
  integrationsDiscordUploadCompleteContract,
  integrationsDiscordUploadInitContract,
  MAX_DISCORD_FILE_SIZE_BYTES,
  type DiscordUploadCompleteBody,
  type DiscordUploadInitBody,
} from "@okouai/api-contracts/contracts/integrations-discord-files";
import { HttpResponse, http } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { array, literal, object, string } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { sanitizeArtifactFilename } from "../../../lib/file-url";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { clearAllDetached, settleIncludingAbort } from "../../utils";
import { createBddApi } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
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
  removePublicDiscordBinding,
  mockDiscordMemberships,
  createPublicDiscordBinding,
} from "./helpers/discord";
import { launchPublicDiscordTestRun } from "./helpers/discord-run";
import { createFixtureLifecycle } from "./helpers/fixture-lifecycle";
import { artifactCatalogRoutes } from "../artifact-catalog";
import { integrationsDiscordFileRoutes } from "../integrations-discord-files";

const context = testContext();
const bdd = createBddApi(context);
const storage = createChatCallbacksApi(context);
const runs = createRunsApi(context);
const channelId = "123456789012345678";
const messageId = "223456789012345678";
const attachmentId = "323456789012345678";

function fileClients() {
  const app = setupApp({ context, routes: integrationsDiscordFileRoutes });
  return {
    init: app(integrationsDiscordUploadInitContract).init,
    complete: app(integrationsDiscordUploadCompleteContract).complete,
    fileUrl: app(integrationsDiscordDownloadFileContract).fileUrl,
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
    channelId,
    ...overrides,
  };
}

async function finishPublishedDiscordFixture(disconnect: () => Promise<void>) {
  const waiting = await settleIncludingAbort(flushWaitUntilForTest);
  const detached = await settleIncludingAbort(clearAllDetached);
  const disconnected = await settleIncludingAbort(disconnect);
  const finalWaiting = await settleIncludingAbort(flushWaitUntilForTest);
  const finalDetached = await settleIncludingAbort(clearAllDetached);
  const errors = [
    waiting,
    detached,
    disconnected,
    finalWaiting,
    finalDetached,
  ].flatMap((result) => {
    return result.ok ? [] : [result.error];
  });
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Discord publication cleanup failed");
  }
}

function withPublishedDiscordFixture(
  operation: (
    fixture: BoundFixture,
    lifecycle: ReturnType<typeof createFixtureLifecycle>,
  ) => Promise<void>,
) {
  return async () => {
    const cleanupController = new AbortController();
    const cleanupContext = { ...context, signal: cleanupController.signal };
    let disconnect = () => {
      return Promise.resolve();
    };
    const lifecycle = createFixtureLifecycle({
      teardown: () => {
        return finishPublishedDiscordFixture(disconnect);
      },
      afterTeardown: () => {
        return cleanupController.abort();
      },
    });
    const result = await settleIncludingAbort(() => {
      return lifecycle.run(async () => {
        const fixture = await boundFixture({
          registerCleanup(actor) {
            disconnect = async () => {
              mockDiscordMemberships(cleanupContext, [actor]);
              await removePublicDiscordBinding(cleanupContext, actor);
            };
          },
        });
        await operation(fixture, lifecycle);
      });
    });
    const finished = await settleIncludingAbort(() => {
      return lifecycle.finish();
    });
    const errors = [result, finished].flatMap((outcome) => {
      return outcome.ok ? [] : [outcome.error];
    });
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Discord publication fixture failed");
    }
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
  readonly binding: Awaited<ReturnType<typeof createPublicDiscordBinding>>;
  readonly connectionId: string;
  readonly headers: { readonly authorization: string };
}

async function boundFixture(
  options: {
    readonly registerCleanup?: (actor: BoundFixture["actor"]) => void;
  } = {},
): Promise<BoundFixture> {
  const actor = await actorSession();
  options.registerCleanup?.(actor);
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
  const binding = await createPublicDiscordBinding(context, {
    flow: "install",
    userId: actor.userId,
    orgId: actor.orgId,
    orgRole: "org:admin",
    guildId: identity.guildId,
    guildName: "Discord file tests",
    botUserId: identity.botUserId,
    discordUserId: identity.discordUserId,
  });
  if (!options.registerCleanup) {
    onTestFinished(async () => {
      mockDiscordMemberships(context, [actor]);
      await removePublicDiscordBinding(context, binding);
    });
  }
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
  const completeBody: DiscordUploadCompleteBody = {
    assetId: initialized.body.assetId,
    ...(body.channelId !== undefined ? { channelId: body.channelId } : {}),
    ...(body.userId !== undefined ? { userId: body.userId } : {}),
    ...(body.guildId !== undefined ? { guildId: body.guildId } : {}),
    ...(body.comment !== undefined ? { comment: body.comment } : {}),
  };
  return {
    initialized: initialized.body,
    body,
    bytes,
    completeBody,
  };
}

function catalogClient() {
  return setupApp({ context, routes: artifactCatalogRoutes })(
    artifactCatalogContract,
  );
}

const deliveryPayloadSchema = object({
  allowed_mentions: object({
    parse: array(string()),
    replied_user: literal(false),
  }),
});

async function expectUploadedDiscordFile(
  request: Request,
  expectedBytes: Buffer,
) {
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
  );
  return {
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
    const responses = [
      await accept(client.init({ headers: {}, body: uploadBody() }), [401]),
      await accept(
        client.complete({
          headers: {},
          body: { assetId: randomUUID(), channelId },
        }),
        [401],
      ),
      await accept(
        client.fileUrl({
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
    const { execution: receivedExecution } = await launchPublicDiscordTestRun(
      context,
      actor,
    );
    const headers = {
      authorization: `Bearer ${receivedExecution.sandboxToken}`,
    };
    const client = fileClients();
    const upload = await accept(
      client.init({ headers, body: uploadBody() }),
      [403],
    );
    const download = await accept(
      client.fileUrl({
        headers,
        query: { channelId, messageId, attachmentId },
      }),
      [403],
    );

    expect(upload.body.error.message).toContain("discord:write");
    expect(download.body.error.message).toContain("discord:read");
  });

  it("rejects an unbound caller", async () => {
    const actor = await actorSession();
    configureDiscordApp();
    mockDiscordMemberships(context, [actor]);
    const response = await accept(
      fileClients().fileUrl({
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
      fileClients().fileUrl({
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
  it.each([
    { contentType: "text/csv", expectedType: "text/csv" },
    { contentType: undefined, expectedType: "application/octet-stream" },
  ])(
    "resolves fresh attachment metadata with MIME type $expectedType",
    async ({ contentType, expectedType }) => {
      const fixture = await boundFixture();
      const source = incomingAttachment(fixture);
      const freshUrl = `${source.attachment.url}&version=fresh`;
      server.use(
        http.get(source.messageUrl, () => {
          return HttpResponse.json({
            ...source.message,
            attachments: [
              {
                ...source.attachment,
                url: freshUrl,
                content_type: contentType,
              },
            ],
          });
        }),
      );

      const response = await accept(
        fileClients().fileUrl({
          headers: fixture.headers,
          query: source.query,
        }),
        [200],
      );

      expect(response.body).toStrictEqual({
        downloadUrl: freshUrl,
        filename: source.attachment.filename,
        contentType: expectedType,
        size: source.attachment.size,
      });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    },
  );

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
        client.fileUrl({ headers: fixture.headers, query: source.query }),
        [200],
      );
      const upload = await accept(
        client.init({
          headers: fixture.headers,
          body: uploadBody({ channelId: fixture.channelId }),
        }),
        [404],
      );

      expect(readable.body).toMatchObject({
        downloadUrl: source.attachment.url,
        filename: source.attachment.filename,
      });
      expect(upload.body.error.code).toBe("NOT_FOUND");
    },
  );

  it.each(["own", "other"] as const)(
    "denies %s bot DM downloads while allowing outbound file delivery",
    async (recipient) => {
      const fixture = await boundFixture();
      const source = incomingAttachment(fixture);
      const recipientId =
        recipient === "own" ? fixture.discordUserId : discordSnowflake();
      server.use(
        http.get(`${discordApiOrigin}/channels/${fixture.channelId}`, () => {
          return HttpResponse.json({
            id: fixture.channelId,
            type: 1,
            recipients: [{ id: recipientId, username: "file-owner" }],
          });
        }),
        http.post(
          `${discordApiOrigin}/users/@me/channels`,
          async ({ request }) => {
            await expect(request.json()).resolves.toStrictEqual({
              recipient_id: recipientId,
            });
            return HttpResponse.json({
              id: fixture.channelId,
              type: 1,
              recipients: [{ id: recipientId, username: "file-owner" }],
            });
          },
        ),
      );
      const denied = await accept(
        fileClients().fileUrl({
          headers: fixture.headers,
          query: source.query,
        }),
        [recipient === "own" ? 403 : 404],
      );
      expect(denied.body.error.code).toBe(
        recipient === "own" ? "DISCORD_DM_READ_DENIED" : "NOT_FOUND",
      );
      const upload = await canonicalUpload(fixture, {
        channelId: undefined,
        userId: recipientId,
      });
      expect(upload.initialized.assetId).toStrictEqual(expect.any(String));
      server.use(
        http.post(
          `${discordApiOrigin}/channels/${fixture.channelId}/messages`,
          async ({ request }) => {
            await expectUploadedDiscordFile(request, upload.bytes);
            return HttpResponse.json(
              discordFileMessage({
                channelId: fixture.channelId,
                messageId: discordSnowflake(),
                authorId: fixture.botUserId,
                bot: true,
                attachment: source.attachment,
              }),
            );
          },
        ),
      );
      const delivered = await accept(
        fileClients().complete({
          headers: fixture.headers,
          body: upload.completeBody,
        }),
        [200],
      );
      expect(delivered.body.delivery.status).toBe("delivered");
    },
  );
});

describe("Fire-and-forget Discord file publication and delivery", () => {
  it.each(["user", "organization"])(
    "does not expose another %s's asset through complete",
    async (foreignOwner) => {
      const fixture = await boundFixture();
      const upload = await canonicalUpload(fixture);
      const actor = await actorSession(
        foreignOwner === "user"
          ? { orgId: fixture.actor.orgId }
          : { userId: fixture.actor.userId },
      );
      mockDiscordMemberships(context, [fixture.actor, actor]);
      const complete = await accept(
        fileClients().complete({
          headers: { authorization: "Bearer clerk-session" },
          body: upload.completeBody,
        }),
        [404],
      );
      expect(complete.body.error.code).toBe("NOT_FOUND");
    },
  );

  it(
    "publishes one file artifact in catalog and delivers fire-and-forget to Discord",
    withPublishedDiscordFixture(async (fixture, lifecycle) => {
      const headers = fixture.headers;
      const upload = await canonicalUpload(fixture);
      expect(context.mocks.s3.getSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          input: expect.objectContaining({
            Key: `private-artifacts/${upload.initialized.assetId}/${upload.body.filename}`,
          }),
        }),
        expect.anything(),
      );
      const signedCalls = context.mocks.s3.getSignedUrl.mock.calls;
      const signedPut = signedCalls.find((call) => {
        return (
          call[1] instanceof PutObjectCommand &&
          call[1].input.Key?.endsWith(`/${upload.body.filename}`)
        );
      });
      if (!signedPut || !(signedPut[1] instanceof PutObjectCommand)) {
        throw new Error("Expected a signed Discord PUT");
      }
      expect(signedPut[1].input.ChecksumSHA256).toBeUndefined();

      const deliveredMessageId = discordSnowflake();
      const deliveredAttachmentId = discordSnowflake();
      server.use(
        http.post(
          `${discordApiOrigin}/channels/${fixture.channelId}/messages`,
          ({ request }) => {
            return lifecycle.run(async () => {
              await expectUploadedDiscordFile(request, upload.bytes);
              return HttpResponse.json(
                discordFileMessage({
                  channelId: fixture.channelId,
                  messageId: deliveredMessageId,
                  authorId: fixture.botUserId,
                  bot: true,
                  attachment: {
                    id: deliveredAttachmentId,
                    filename: upload.body.filename,
                    size: upload.bytes.byteLength,
                    url: `https://cdn.discordapp.com/attachments/${fixture.channelId}/${deliveredAttachmentId}/report.csv`,
                    content_type: "text/csv",
                  },
                }),
              );
            });
          },
        ),
      );
      const completed = await accept(
        fileClients().complete({ headers, body: upload.completeBody }),
        [200],
      );

      expect(completed.body).toStrictEqual({
        assetId: upload.initialized.assetId,
        url: upload.initialized.url,
        delivery: {
          status: "delivered",
          channelId: fixture.channelId,
          messageId: deliveredMessageId,
          attachmentId: deliveredAttachmentId,
          permalink: `https://discord.com/channels/${fixture.guildId}/${fixture.channelId}/${deliveredMessageId}`,
        },
      });

      const catalog = await accept(catalogClient().list({ headers }), [200]);
      expect(catalog.body.artifacts).toHaveLength(1);
      const artifact = catalog.body.artifacts[0];
      if (!artifact) {
        throw new Error("Expected the published Discord file in the catalog");
      }
      const detail = await accept(
        catalogClient().get({
          headers,
          params: { artifactId: artifact.id },
        }),
        [200],
      );
      expect(detail.body).toMatchObject({
        kind: "file",
        file: {
          id: upload.initialized.assetId,
          filename: upload.body.filename,
          contentType: "text/csv",
          size: upload.bytes.byteLength,
          url: upload.initialized.url,
        },
      });
    }),
  );

  it("refuses publication when the stored bytes have a different checksum", async () => {
    const fixture = await boundFixture();
    const upload = await canonicalUpload(fixture);
    const objectStore = storage.acceptChatObjectStorage();
    objectStore.addObject({
      bucket: "test-private-artifacts",
      key: `private-artifacts/${upload.initialized.assetId}/${upload.body.filename}`,
      size: upload.bytes.byteLength,
      body: Buffer.from("a,b\n9,9\n"),
      contentType: "text/csv",
      metadata: { "artifact-id": upload.initialized.assetId },
    });
    const rejected = await accept(
      fileClients().complete({
        headers: fixture.headers,
        body: upload.completeBody,
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

  it(
    "reports delivery failure while keeping the published artifact in catalog when Discord errors",
    withPublishedDiscordFixture(async (fixture) => {
      const upload = await canonicalUpload(fixture);
      server.use(
        http.post(
          `${discordApiOrigin}/channels/${fixture.channelId}/messages`,
          async ({ request }) => {
            await expectUploadedDiscordFile(request, upload.bytes);
            return HttpResponse.error();
          },
        ),
      );
      const unconfirmed = await accept(
        fileClients().complete({
          headers: fixture.headers,
          body: upload.completeBody,
        }),
        [200],
      );

      expect(unconfirmed.body).toMatchObject({
        assetId: upload.initialized.assetId,
        url: upload.initialized.url,
        delivery: { status: "failed" },
      });
      const catalog = await accept(
        catalogClient().list({ headers: fixture.headers }),
        [200],
      );
      expect(catalog.body.artifacts).toHaveLength(1);
    }),
  );

  it("records the receipt when Discord normalizes the attachment filename", async () => {
    const fixture = await boundFixture();
    const upload = await canonicalUpload(fixture, {
      filename: "quarterly report.csv",
    });
    const deliveredMessageId = discordSnowflake();
    const deliveredAttachmentId = discordSnowflake();
    server.use(
      http.post(
        `${discordApiOrigin}/channels/${fixture.channelId}/messages`,
        async ({ request }) => {
          await expectUploadedDiscordFile(request, upload.bytes);
          return HttpResponse.json(
            discordFileMessage({
              channelId: fixture.channelId,
              messageId: deliveredMessageId,
              authorId: fixture.botUserId,
              bot: true,
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
      fileClients().complete({
        headers: fixture.headers,
        body: upload.completeBody,
      }),
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

  it("denies delivery after the verified Discord connection is removed", async () => {
    const fixture = await boundFixture();
    const upload = await canonicalUpload(fixture);
    await removePublicDiscordBinding(context, fixture.binding);
    const revoked = await accept(
      fileClients().complete({
        headers: fixture.headers,
        body: upload.completeBody,
      }),
      [404],
    );
    expect(revoked.body.error.code).toBe("NOT_FOUND");
  });

  it("creates the Discord output thread only when the prepared file is sent", async () => {
    const connected = await setupConnectedDiscordActor(context);
    onTestFinished(async () => {
      await flushWaitUntilForTest();
      mockDiscordMemberships(context, [connected]);
      await removePublicDiscordBinding(context, connected.fixture);
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
    const execution = await runs.executionInput(input.runId);
    const token = execution.platformEnvironment.OKOU_TOKEN;
    if (!token) {
      throw new Error(
        "Expected the Runner execution to issue an Okou run token",
      );
    }
    const headers = { authorization: `Bearer ${token}` };
    const fixture: BoundFixture = {
      ...connected,
      actor: { ...connected.actor, orgId: connected.orgId },
      binding: connected.fixture,
      channelId: source.id,
      headers,
    };
    expect(provider.channels.has(source.id)).toBeFalsy();
    const upload = await canonicalUpload(fixture);
    expect(provider.channels.has(source.id)).toBeFalsy();
    const client = fileClients();
    const deliveredMessageId = discordSnowflake();
    const deliveredAttachmentId = discordSnowflake();
    server.use(
      http.post(
        `${discordApiOrigin}/channels/${source.id}/messages`,
        async ({ request }) => {
          expect(provider.channels.get(source.id)?.parent_id).toBe(
            provider.guildChannelId,
          );
          await expectUploadedDiscordFile(request, upload.bytes);
          return HttpResponse.json(
            discordFileMessage({
              channelId: source.id,
              messageId: deliveredMessageId,
              authorId: connected.botUserId,
              bot: true,
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
    server.use(
      http.post(
        `${discordApiOrigin}/channels/${provider.guildChannelId}/messages/${source.id}/threads`,
        () => {
          return HttpResponse.json(
            { message: "Rate limited", retry_after: 60, global: false },
            { status: 429 },
          );
        },
        { once: true },
      ),
    );
    await accept(
      client.complete({ headers, body: upload.completeBody }),
      [429],
    );
    expect(provider.channels.has(source.id)).toBeFalsy();
    const completed = await accept(
      client.complete({ headers, body: upload.completeBody }),
      [200],
    );
    expect(completed.body).toStrictEqual({
      assetId: upload.initialized.assetId,
      url: upload.initialized.url,
      delivery: {
        status: "delivered",
        channelId: source.id,
        messageId: deliveredMessageId,
        attachmentId: deliveredAttachmentId,
        permalink: `https://discord.com/channels/${connected.guildId}/${source.id}/${deliveredMessageId}`,
      },
    });
  });
});
