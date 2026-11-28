import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  integrationsDiscordDownloadFileContract,
  integrationsDiscordUploadCompleteContract,
  integrationsDiscordUploadInitContract,
} from "@okouai/api-contracts/contracts/integrations-discord-files";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { array, boolean, object, string } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { artifactCatalogRoutes } from "../artifact-catalog";
import { integrationsDiscordFileRoutes } from "../integrations-discord-files";
import {
  configureDiscordApp,
  createPublicDiscordBinding,
  removePublicDiscordBinding,
  uniqueDiscordSnowflake,
  type DiscordFixture,
} from "./helpers/discord";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const memberships = createStore();

const SESSION = Object.freeze({ authorization: "Bearer clerk-session" });
const DISCORD_API = "https://discord.com/api/v10";
const TIMESTAMP = "2026-01-01T00:00:00.000Z";

const PERMISSION = Object.freeze({
  viewChannel: 1n << 10n,
  sendMessages: 1n << 11n,
  attachFiles: 1n << 15n,
  readMessageHistory: 1n << 16n,
});

const DEFAULT_ROLE_PERMISSIONS = String(
  PERMISSION.viewChannel |
    PERMISSION.sendMessages |
    PERMISSION.attachFiles |
    PERMISSION.readMessageHistory,
);

const app = setupApp({
  context,
  routes: [...integrationsDiscordFileRoutes, ...artifactCatalogRoutes],
});

const openDmBodySchema = object({ recipient_id: string() }).strict();
const payloadJsonSchema = object({
  content: string(),
  allowed_mentions: object({
    parse: array(string()),
    replied_user: boolean(),
  }),
});

interface Actor {
  readonly userId: string;
  readonly orgId: string;
  readonly role: "org:admin" | "org:member";
}

interface StoredObject {
  readonly key: string;
  readonly bytes: Buffer;
  readonly contentType: string;
}

interface SignedPutRecord {
  readonly key: string;
  readonly checksumSha256: string | undefined;
  readonly uploadUrl: string;
}

interface DeliveredDiscordUpload {
  readonly channelId: string;
  readonly allowedMentions: {
    readonly parse: readonly string[];
    readonly replied_user: boolean;
  };
  readonly filename: string;
  readonly bytes: Buffer;
}

interface DiscordChannelSpec {
  readonly id: string;
  readonly type: number;
  readonly guild_id?: string;
  readonly name?: string;
  readonly permission_overwrites?: readonly {
    readonly id: string;
    readonly type: 0 | 1;
    readonly allow: string;
    readonly deny: string;
  }[];
  readonly recipients?: readonly {
    readonly id: string;
    readonly username: string;
  }[];
}

interface DiscordAttachmentSpec {
  readonly id: string;
  readonly filename: string;
  readonly size: number;
  readonly url: string;
  readonly content_type?: string;
}

interface DiscordMessageSpec {
  readonly id: string;
  readonly channel_id: string;
  readonly author: {
    readonly id: string;
    readonly username: string;
    readonly bot?: boolean;
  };
  readonly content: string;
  readonly timestamp: string;
  readonly attachments: readonly DiscordAttachmentSpec[];
}

function signIn(actor: Actor) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.role,
  );
  return SESSION;
}

async function seedActor(
  role: "org:admin" | "org:member",
  overrides: Partial<Actor> = {},
): Promise<Actor> {
  const actor: Actor = {
    userId: overrides.userId ?? `user_df_${randomUUID()}`,
    orgId: overrides.orgId ?? `org_df_${randomUUID()}`,
    role,
  };
  await memberships.set(
    seedOrgMembership$,
    {
      userId: actor.userId,
      orgId: actor.orgId,
      role: role === "org:admin" ? "admin" : "member",
      name: "Discord files workspace",
    },
    context.signal,
  );
  return actor;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function createStorageMock() {
  const objectsByUrl = new Map<string, { key: string; contentType: string }>();
  const objectsByKey = new Map<string, StoredObject>();
  const signedPuts: SignedPutRecord[] = [];

  context.mocks.s3.getSignedUrl.mockImplementation((_client, command) => {
    const cmd = command as {
      readonly constructor: { readonly name: string };
      readonly input?: {
        readonly Key?: string;
        readonly ContentType?: string;
        readonly ChecksumSHA256?: string;
      };
    };
    const key = cmd.input?.Key ?? `unknown/${randomUUID()}`;
    if (cmd.constructor.name === "PutObjectCommand") {
      const uploadUrl = `https://r2.okou.test/put/${randomUUID()}`;
      objectsByUrl.set(uploadUrl, {
        key,
        contentType: cmd.input?.ContentType ?? "application/octet-stream",
      });
      signedPuts.push({
        key,
        checksumSha256: cmd.input?.ChecksumSHA256,
        uploadUrl,
      });
      return Promise.resolve(uploadUrl);
    }
    return Promise.resolve(`https://r2.okou.test/get/${randomUUID()}`);
  });

  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const cmd = command as {
      readonly constructor: { readonly name: string };
      readonly input?: { readonly Key?: string };
    };
    const key = cmd.input?.Key ?? "";
    const stored = objectsByKey.get(key);
    if (cmd.constructor.name === "HeadObjectCommand") {
      if (!stored) {
        const error = Object.assign(new Error("NotFound"), {
          name: "NotFound",
          $metadata: { httpStatusCode: 404 },
        });
        return Promise.reject(error);
      }
      return Promise.resolve({
        ContentLength: stored.bytes.byteLength,
        ContentType: stored.contentType,
      });
    }
    if (cmd.constructor.name === "GetObjectCommand") {
      if (!stored) {
        const error = Object.assign(new Error("NoSuchKey"), {
          name: "NoSuchKey",
          $metadata: { httpStatusCode: 404 },
        });
        return Promise.reject(error);
      }
      return Promise.resolve({
        Body: Readable.from([stored.bytes]),
        ContentLength: stored.bytes.byteLength,
        ContentType: stored.contentType,
      });
    }
    return Promise.resolve({});
  });

  server.use(
    http.put("https://r2.okou.test/put/:id", async ({ request }) => {
      const target = objectsByUrl.get(request.url);
      if (!target) {
        return new HttpResponse(null, { status: 404 });
      }
      const bytes = Buffer.from(await request.arrayBuffer());
      objectsByKey.set(target.key, {
        key: target.key,
        bytes,
        contentType: target.contentType,
      });
      return new HttpResponse(null, { status: 200 });
    }),
  );

  return { signedPuts, objectsByKey };
}

interface DiscordWorldOptions {
  readonly guildOwnerId?: string;
  readonly channels?: readonly DiscordChannelSpec[];
  readonly messages?: readonly DiscordMessageSpec[];
  readonly dmChannelsByRecipient?: ReadonlyMap<string, string>;
  readonly normalizeAttachmentFilename?: (filename: string) => string;
  readonly rateLimitUploads?: boolean;
}

function serveDiscordWorld(
  fixture: DiscordFixture,
  options: DiscordWorldOptions = {},
) {
  const channels = new Map<string, DiscordChannelSpec>();
  for (const channel of options.channels ?? []) {
    channels.set(
      channel.id,
      channel.type === 1 ? channel : { permission_overwrites: [], ...channel },
    );
  }
  const messages = new Map<string, DiscordMessageSpec>();
  for (const message of options.messages ?? []) {
    messages.set(`${message.channel_id}:${message.id}`, message);
  }
  const dmChannels = new Map<string, string>(options.dmChannelsByRecipient);
  const dmOpens: string[] = [];
  const uploads: DeliveredDiscordUpload[] = [];
  const createdMessages: {
    readonly channelId: string;
    readonly messageId: string;
    readonly attachmentId: string;
  }[] = [];

  server.use(
    http.get(`${DISCORD_API}/users/@me`, () => {
      return HttpResponse.json({
        id: fixture.botUserId,
        username: "Okou",
        bot: true,
      });
    }),
    http.get(`${DISCORD_API}/guilds/${fixture.guildId}`, () => {
      return HttpResponse.json({
        id: fixture.guildId,
        name: fixture.guildName,
        owner_id: options.guildOwnerId ?? fixture.discordUserId,
      });
    }),
    http.get(`${DISCORD_API}/guilds/${fixture.guildId}/roles`, () => {
      return HttpResponse.json([
        {
          id: fixture.guildId,
          name: "@everyone",
          permissions: DEFAULT_ROLE_PERMISSIONS,
        },
      ]);
    }),
    http.get(
      `${DISCORD_API}/guilds/${fixture.guildId}/members/:userId`,
      ({ params }) => {
        const id = String(params.userId);
        return HttpResponse.json({
          user: { id, username: "member", bot: id === fixture.botUserId },
          roles: [],
        });
      },
    ),
    http.get(`${DISCORD_API}/channels/:channelId`, ({ params }) => {
      const channel = channels.get(String(params.channelId));
      if (!channel) {
        return HttpResponse.json(
          { message: "Unknown Channel" },
          { status: 404 },
        );
      }
      return HttpResponse.json(channel);
    }),
    http.get(
      `${DISCORD_API}/channels/:channelId/messages/:messageId`,
      ({ params }) => {
        const message = messages.get(
          `${String(params.channelId)}:${String(params.messageId)}`,
        );
        if (!message) {
          return HttpResponse.json(
            { message: "Unknown Message" },
            { status: 404 },
          );
        }
        return HttpResponse.json(message);
      },
    ),
    http.post(`${DISCORD_API}/users/@me/channels`, async ({ request }) => {
      const parsed = openDmBodySchema.parse(await request.json());
      dmOpens.push(parsed.recipient_id);
      const dmChannelId =
        dmChannels.get(parsed.recipient_id) ?? uniqueDiscordSnowflake();
      dmChannels.set(parsed.recipient_id, dmChannelId);
      if (!channels.has(dmChannelId)) {
        channels.set(dmChannelId, {
          id: dmChannelId,
          type: 1,
          recipients: [{ id: parsed.recipient_id, username: "recipient" }],
        });
      }
      return HttpResponse.json(channels.get(dmChannelId));
    }),
    http.post(
      `${DISCORD_API}/channels/:channelId/messages`,
      async ({ request, params }) => {
        const channelId = String(params.channelId);
        const form = await request.formData();
        const payloadRaw = form.get("payload_json");
        const parsedPayload = payloadJsonSchema.parse(
          JSON.parse(typeof payloadRaw === "string" ? payloadRaw : "{}"),
        );
        const fileEntry = form.get("files[0]");
        if (!(fileEntry instanceof File)) {
          return HttpResponse.json(
            { message: "Missing attachment" },
            { status: 400 },
          );
        }
        const bytes = Buffer.from(await fileEntry.arrayBuffer());
        uploads.push({
          channelId,
          allowedMentions: parsedPayload.allowed_mentions,
          filename: fileEntry.name,
          bytes,
        });
        if (options.rateLimitUploads) {
          return HttpResponse.json(
            {
              message: "You are being rate limited.",
              retry_after: 1,
              global: false,
            },
            { status: 429 },
          );
        }
        const messageId = uniqueDiscordSnowflake();
        const attachmentId = uniqueDiscordSnowflake();
        const storedFilename = options.normalizeAttachmentFilename
          ? options.normalizeAttachmentFilename(fileEntry.name)
          : fileEntry.name;
        createdMessages.push({ channelId, messageId, attachmentId });
        return HttpResponse.json({
          id: messageId,
          channel_id: channelId,
          author: { id: fixture.botUserId, username: "Okou", bot: true },
          content: parsedPayload.content,
          timestamp: TIMESTAMP,
          attachments: [
            {
              id: attachmentId,
              filename: storedFilename,
              size: bytes.byteLength,
              url: `https://cdn.discordapp.com/attachments/${channelId}/${attachmentId}/${encodeURIComponent(storedFilename)}`,
              content_type: fileEntry.type || "application/octet-stream",
            },
          ],
        });
      },
    ),
  );

  return { dmOpens, uploads, createdMessages };
}

async function bindAdminDiscord(
  overrides: { readonly discordUserId?: string } = {},
) {
  configureDiscordApp();
  const admin = await seedActor("org:admin");
  const fixture = await createPublicDiscordBinding(context, {
    userId: admin.userId,
    orgId: admin.orgId,
    orgRole: "org:admin",
    flow: "install",
    ...(overrides.discordUserId
      ? { discordUserId: overrides.discordUserId }
      : {}),
  });
  return { admin, fixture };
}

async function putUploadedBytes(
  uploadUrl: string,
  bytes: Buffer,
  contentType: string,
  headers?: Readonly<Record<string, string>>,
): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "content-type": contentType,
      ...headers,
    },
    body: new Uint8Array(bytes),
  });
  expect(response.status).toBe(200);
}

describe("Discord file authorization and input validation", () => {
  it("integrations-discord-files-003 rejects an unbound caller", async () => {
    configureDiscordApp();
    const member = await seedActor("org:member");

    const response = await accept(
      app(integrationsDiscordDownloadFileContract).fileUrl({
        headers: signIn(member),
        query: {
          channelId: uniqueDiscordSnowflake(),
          messageId: uniqueDiscordSnowflake(),
          attachmentId: uniqueDiscordSnowflake(),
        },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("integrations-discord-files-008 rejects malformed upload metadata: length over 10 MiB", async () => {
    configureDiscordApp();
    const member = await seedActor("org:member");
    signIn(member);
    const request = setupRawAppRequest({
      context,
      routes: integrationsDiscordFileRoutes,
    });

    const response = await request(
      "/api/integrations/discord/upload-file/init",
      {
        method: "POST",
        headers: {
          ...SESSION,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          filename: "oversized.csv",
          length: 10_485_761,
          contentType: "text/csv",
          checksumSha256: "a".repeat(64),
          channelId: uniqueDiscordSnowflake(),
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });
});

describe("Discord attachment downloads", () => {
  it("integrations-discord-files-010 resolves fresh attachment metadata with MIME type text/csv", async () => {
    const { admin, fixture } = await bindAdminDiscord();
    const channelId = uniqueDiscordSnowflake();
    const messageId = uniqueDiscordSnowflake();
    const attachmentId = uniqueDiscordSnowflake();
    const freshUrl = `https://cdn.discordapp.com/attachments/${channelId}/${attachmentId}/quarterly%20report.csv?ex=1&is=1&hm=abc`;
    serveDiscordWorld(fixture, {
      channels: [
        { id: channelId, type: 0, guild_id: fixture.guildId, name: "reports" },
      ],
      messages: [
        {
          id: messageId,
          channel_id: channelId,
          author: { id: fixture.discordUserId, username: "admin" },
          content: "latest report",
          timestamp: TIMESTAMP,
          attachments: [
            {
              id: attachmentId,
              filename: "quarterly report.csv",
              size: 42,
              url: freshUrl,
              content_type: "text/csv",
            },
          ],
        },
      ],
    });

    const response = await accept(
      app(integrationsDiscordDownloadFileContract).fileUrl({
        headers: signIn(admin),
        query: { channelId, messageId, attachmentId },
      }),
      [200],
    );

    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.body).toStrictEqual({
      downloadUrl: freshUrl,
      filename: "quarterly report.csv",
      contentType: "text/csv",
      size: 42,
    });
  });

  it("integrations-discord-files-012 requires the member to have ATTACH_FILES in addition to readable channel access", async () => {
    const { admin, fixture } = await bindAdminDiscord();
    const channelId = uniqueDiscordSnowflake();
    const messageId = uniqueDiscordSnowflake();
    const attachmentId = uniqueDiscordSnowflake();
    const freshUrl = `https://cdn.discordapp.com/attachments/${channelId}/${attachmentId}/report.csv`;
    const bytes = Buffer.from("col\n1\n", "utf8");
    serveDiscordWorld(fixture, {
      guildOwnerId: uniqueDiscordSnowflake(),
      channels: [
        {
          id: channelId,
          type: 0,
          guild_id: fixture.guildId,
          name: "read-only-files",
          permission_overwrites: [
            {
              id: fixture.discordUserId,
              type: 1,
              allow: "0",
              deny: String(PERMISSION.attachFiles),
            },
          ],
        },
      ],
      messages: [
        {
          id: messageId,
          channel_id: channelId,
          author: { id: fixture.discordUserId, username: "admin" },
          content: "readable attachment",
          timestamp: TIMESTAMP,
          attachments: [
            {
              id: attachmentId,
              filename: "report.csv",
              size: bytes.byteLength,
              url: freshUrl,
              content_type: "text/csv",
            },
          ],
        },
      ],
    });

    const downloaded = await accept(
      app(integrationsDiscordDownloadFileContract).fileUrl({
        headers: signIn(admin),
        query: { channelId, messageId, attachmentId },
      }),
      [200],
    );
    expect(downloaded.body.downloadUrl).toBe(freshUrl);
    expect(downloaded.body.filename).toBe("report.csv");

    const initDenied = await accept(
      app(integrationsDiscordUploadInitContract).init({
        headers: signIn(admin),
        body: {
          filename: "report.csv",
          length: bytes.byteLength,
          contentType: "text/csv",
          checksumSha256: sha256Hex(bytes),
          channelId,
        },
      }),
      [404],
    );
    expect(initDenied.body.error.code).toBe("NOT_FOUND");
  });

  it("integrations-discord-files-014 (1/2) denies own bot DM attachment downloads", async () => {
    const { admin, fixture } = await bindAdminDiscord();
    const dmChannelId = uniqueDiscordSnowflake();
    const messageId = uniqueDiscordSnowflake();
    const attachmentId = uniqueDiscordSnowflake();
    const bytes = Buffer.from("metric,value\nlatency,12\n", "utf8");
    serveDiscordWorld(fixture, {
      channels: [
        {
          id: dmChannelId,
          type: 1,
          recipients: [{ id: fixture.discordUserId, username: "admin" }],
        },
      ],
      dmChannelsByRecipient: new Map([[fixture.discordUserId, dmChannelId]]),
      messages: [
        {
          id: messageId,
          channel_id: dmChannelId,
          author: { id: fixture.discordUserId, username: "admin" },
          content: "dm attachment",
          timestamp: TIMESTAMP,
          attachments: [
            {
              id: attachmentId,
              filename: "dm.csv",
              size: bytes.byteLength,
              url: `https://cdn.discordapp.com/attachments/${dmChannelId}/${attachmentId}/dm.csv`,
              content_type: "text/csv",
            },
          ],
        },
      ],
    });

    const downloadDenied = await accept(
      app(integrationsDiscordDownloadFileContract).fileUrl({
        headers: signIn(admin),
        query: { channelId: dmChannelId, messageId, attachmentId },
      }),
      [403],
    );
    expect(downloadDenied.body.error.code).toBe("DISCORD_DM_READ_DENIED");
  });

  it("integrations-discord-files-014 (2/2) allows outbound file delivery to own bot DM", async () => {
    const { admin, fixture } = await bindAdminDiscord();
    createStorageMock();
    const dmChannelId = uniqueDiscordSnowflake();
    const bytes = Buffer.from("metric,value\nlatency,12\n", "utf8");
    const world = serveDiscordWorld(fixture, {
      channels: [
        {
          id: dmChannelId,
          type: 1,
          recipients: [{ id: fixture.discordUserId, username: "admin" }],
        },
      ],
      dmChannelsByRecipient: new Map([[fixture.discordUserId, dmChannelId]]),
    });

    const initialized = await accept(
      app(integrationsDiscordUploadInitContract).init({
        headers: signIn(admin),
        body: {
          filename: "dm-report.csv",
          length: bytes.byteLength,
          contentType: "text/csv",
          checksumSha256: sha256Hex(bytes),
          userId: fixture.discordUserId,
        },
      }),
      [200],
    );
    expect(initialized.body.assetId).toBeTruthy();
    await putUploadedBytes(
      initialized.body.uploadUrl,
      bytes,
      "text/csv",
      initialized.body.uploadHeaders,
    );

    const completed = await accept(
      app(integrationsDiscordUploadCompleteContract).complete({
        headers: signIn(admin),
        body: {
          assetId: initialized.body.assetId,
          userId: fixture.discordUserId,
        },
      }),
      [200],
    );

    expect(completed.body.delivery.status).toBe("delivered");
    expect(world.dmOpens.length).toBeGreaterThan(0);
    for (const recipientId of world.dmOpens) {
      expect(recipientId).toBe(fixture.discordUserId);
    }
    expect(world.uploads).toHaveLength(1);
    expect(world.uploads[0]?.bytes.equals(bytes)).toBeTruthy();
    expect(world.uploads[0]?.allowedMentions).toStrictEqual({
      parse: [],
      replied_user: false,
    });
  });

  it("integrations-discord-files-015 (1/2) denies other bot DM attachment downloads", async () => {
    const { admin, fixture } = await bindAdminDiscord();
    const otherDiscordUserId = uniqueDiscordSnowflake();
    const dmChannelId = uniqueDiscordSnowflake();
    const messageId = uniqueDiscordSnowflake();
    const attachmentId = uniqueDiscordSnowflake();
    const bytes = Buffer.from("metric,value\nusers,99\n", "utf8");
    serveDiscordWorld(fixture, {
      channels: [
        {
          id: dmChannelId,
          type: 1,
          recipients: [{ id: otherDiscordUserId, username: "other" }],
        },
      ],
      dmChannelsByRecipient: new Map([[otherDiscordUserId, dmChannelId]]),
      messages: [
        {
          id: messageId,
          channel_id: dmChannelId,
          author: { id: otherDiscordUserId, username: "other" },
          content: "other dm attachment",
          timestamp: TIMESTAMP,
          attachments: [
            {
              id: attachmentId,
              filename: "other.csv",
              size: bytes.byteLength,
              url: `https://cdn.discordapp.com/attachments/${dmChannelId}/${attachmentId}/other.csv`,
              content_type: "text/csv",
            },
          ],
        },
      ],
    });

    const downloadDenied = await accept(
      app(integrationsDiscordDownloadFileContract).fileUrl({
        headers: signIn(admin),
        query: { channelId: dmChannelId, messageId, attachmentId },
      }),
      [404],
    );
    expect(downloadDenied.body.error.code).toBe("NOT_FOUND");
  });

  it("integrations-discord-files-015 (2/2) allows outbound file delivery to another user's bot DM", async () => {
    const { admin, fixture } = await bindAdminDiscord();
    createStorageMock();
    const otherDiscordUserId = uniqueDiscordSnowflake();
    const dmChannelId = uniqueDiscordSnowflake();
    const bytes = Buffer.from("metric,value\nusers,99\n", "utf8");
    const world = serveDiscordWorld(fixture, {
      channels: [
        {
          id: dmChannelId,
          type: 1,
          recipients: [{ id: otherDiscordUserId, username: "other" }],
        },
      ],
      dmChannelsByRecipient: new Map([[otherDiscordUserId, dmChannelId]]),
    });

    const initialized = await accept(
      app(integrationsDiscordUploadInitContract).init({
        headers: signIn(admin),
        body: {
          filename: "other-report.csv",
          length: bytes.byteLength,
          contentType: "text/csv",
          checksumSha256: sha256Hex(bytes),
          userId: otherDiscordUserId,
        },
      }),
      [200],
    );
    expect(initialized.body.assetId).toBeTruthy();
    await putUploadedBytes(
      initialized.body.uploadUrl,
      bytes,
      "text/csv",
      initialized.body.uploadHeaders,
    );

    const completed = await accept(
      app(integrationsDiscordUploadCompleteContract).complete({
        headers: signIn(admin),
        body: {
          assetId: initialized.body.assetId,
          userId: otherDiscordUserId,
        },
      }),
      [200],
    );

    expect(completed.body.delivery.status).toBe("delivered");
    expect(world.dmOpens.length).toBeGreaterThan(0);
    for (const recipientId of world.dmOpens) {
      expect(recipientId).toBe(otherDiscordUserId);
    }
    expect(world.uploads).toHaveLength(1);
    expect(world.uploads[0]?.bytes.equals(bytes)).toBeTruthy();
    expect(world.uploads[0]?.allowedMentions).toStrictEqual({
      parse: [],
      replied_user: false,
    });
  });
});

describe("Canonical Discord file publication and delivery", () => {
  it("integrations-discord-files-016 does not expose another user's asset through complete", async () => {
    const { admin, fixture } = await bindAdminDiscord();
    const otherMember = await seedActor("org:member", { orgId: admin.orgId });
    createStorageMock();
    const channelId = uniqueDiscordSnowflake();
    const bytes = Buffer.from("a,b\n1,2\n", "utf8");
    serveDiscordWorld(fixture, {
      channels: [
        { id: channelId, type: 0, guild_id: fixture.guildId, name: "general" },
      ],
    });

    const initialized = await accept(
      app(integrationsDiscordUploadInitContract).init({
        headers: signIn(admin),
        body: {
          filename: "report.csv",
          length: bytes.byteLength,
          contentType: "text/csv",
          checksumSha256: sha256Hex(bytes),
          channelId,
        },
      }),
      [200],
    );
    await putUploadedBytes(
      initialized.body.uploadUrl,
      bytes,
      "text/csv",
      initialized.body.uploadHeaders,
    );

    const completed = await accept(
      app(integrationsDiscordUploadCompleteContract).complete({
        headers: signIn(otherMember),
        body: { assetId: initialized.body.assetId, channelId },
      }),
      [404],
    );

    expect(completed.body.error.code).toBe("NOT_FOUND");
  });

  it("integrations-discord-files-017 does not expose another organization's asset through complete", async () => {
    const { admin, fixture } = await bindAdminDiscord();
    const sameUserOtherOrg = await seedActor("org:admin", {
      userId: admin.userId,
    });
    createStorageMock();
    const channelId = uniqueDiscordSnowflake();
    const bytes = Buffer.from("a,b\n3,4\n", "utf8");
    serveDiscordWorld(fixture, {
      channels: [
        { id: channelId, type: 0, guild_id: fixture.guildId, name: "general" },
      ],
    });

    const initialized = await accept(
      app(integrationsDiscordUploadInitContract).init({
        headers: signIn(admin),
        body: {
          filename: "report.csv",
          length: bytes.byteLength,
          contentType: "text/csv",
          checksumSha256: sha256Hex(bytes),
          channelId,
        },
      }),
      [200],
    );
    await putUploadedBytes(
      initialized.body.uploadUrl,
      bytes,
      "text/csv",
      initialized.body.uploadHeaders,
    );

    const completed = await accept(
      app(integrationsDiscordUploadCompleteContract).complete({
        headers: signIn(sameUserOtherOrg),
        body: { assetId: initialized.body.assetId, channelId },
      }),
      [404],
    );

    expect(completed.body.error.code).toBe("NOT_FOUND");
  });

  it("integrations-discord-files-024 refuses publication when the stored bytes have a different checksum", async () => {
    const { admin, fixture } = await bindAdminDiscord();
    createStorageMock();
    const channelId = uniqueDiscordSnowflake();
    const declaredBytes = Buffer.from("declared,content\n1,2\n", "utf8");
    const tamperedBytes = Buffer.from("tampered,content\n9,9\n", "utf8");
    serveDiscordWorld(fixture, {
      channels: [
        { id: channelId, type: 0, guild_id: fixture.guildId, name: "general" },
      ],
    });

    const initialized = await accept(
      app(integrationsDiscordUploadInitContract).init({
        headers: signIn(admin),
        body: {
          filename: "report.csv",
          length: declaredBytes.byteLength,
          contentType: "text/csv",
          checksumSha256: sha256Hex(declaredBytes),
          channelId,
        },
      }),
      [200],
    );
    await putUploadedBytes(
      initialized.body.uploadUrl,
      tamperedBytes,
      "text/csv",
      initialized.body.uploadHeaders,
    );

    const completed = await accept(
      app(integrationsDiscordUploadCompleteContract).complete({
        headers: signIn(admin),
        body: { assetId: initialized.body.assetId, channelId },
      }),
      [400],
    );
    expect(completed.body.error.code).toBe("INVALID_FILE");
    expect(completed.body.error.message.toLowerCase()).toContain("checksum");

    const catalog = await accept(
      app(artifactCatalogContract).list({
        headers: signIn(admin),
        query: {},
      }),
      [200],
    );
    expect(catalog.body.artifacts).toStrictEqual([]);
  });

  it("integrations-discord-files-018 publishes one canonical artifact and delivers it to Discord", async () => {
    const { admin, fixture } = await bindAdminDiscord();
    const storage = createStorageMock();
    const channelId = uniqueDiscordSnowflake();
    const bytes = Buffer.from("region,revenue\nus,1200\n", "utf8");
    const world = serveDiscordWorld(fixture, {
      channels: [
        { id: channelId, type: 0, guild_id: fixture.guildId, name: "general" },
      ],
    });

    const initialized = await accept(
      app(integrationsDiscordUploadInitContract).init({
        headers: signIn(admin),
        body: {
          filename: "report.csv",
          length: bytes.byteLength,
          contentType: "text/csv",
          checksumSha256: sha256Hex(bytes),
          channelId,
        },
      }),
      [200],
    );
    const { assetId, url } = initialized.body;
    expect(storage.signedPuts).toHaveLength(1);
    expect(storage.signedPuts[0]?.key).toBe(
      `private-artifacts/${assetId}/report.csv`,
    );
    expect(storage.signedPuts[0]?.checksumSha256).toBeUndefined();
    await putUploadedBytes(
      initialized.body.uploadUrl,
      bytes,
      "text/csv",
      initialized.body.uploadHeaders,
    );

    const completed = await accept(
      app(integrationsDiscordUploadCompleteContract).complete({
        headers: signIn(admin),
        body: { assetId, channelId },
      }),
      [200],
    );

    expect(world.uploads).toHaveLength(1);
    expect(world.uploads[0]?.bytes.equals(bytes)).toBeTruthy();
    const [created] = world.createdMessages;
    if (!created) {
      throw new Error("Expected one delivered Discord message");
    }
    expect(completed.body).toStrictEqual({
      assetId,
      url: new URL(`/artifacts/${assetId.replace(/-/gu, "")}.csv`, url).href,
      delivery: {
        status: "delivered",
        channelId,
        messageId: created.messageId,
        attachmentId: created.attachmentId,
        permalink: `https://discord.com/channels/${fixture.guildId}/${channelId}/${created.messageId}`,
      },
    });

    const catalog = await accept(
      app(artifactCatalogContract).list({
        headers: signIn(admin),
        query: {},
      }),
      [200],
    );
    expect(catalog.body.artifacts).toHaveLength(1);
    const [listedArtifact] = catalog.body.artifacts;
    if (!listedArtifact) {
      throw new Error("Expected one catalog artifact");
    }
    expect(listedArtifact.kind).toBe("file");

    const detail = await accept(
      app(artifactCatalogContract).get({
        headers: signIn(admin),
        params: { artifactId: listedArtifact.id },
      }),
      [200],
    );
    expect(detail.body.kind).toBe("file");
    if (detail.body.kind !== "file") {
      throw new Error("Expected a file artifact detail");
    }
    expect(detail.body.file).toMatchObject({
      id: assetId,
      filename: "report.csv",
      contentType: "text/csv",
      size: bytes.byteLength,
      url: new URL(`/artifacts/${assetId.replace(/-/gu, "")}.csv`, url).href,
    });
  });

  it("integrations-discord-files-026 records the receipt when Discord normalizes the attachment filename", async () => {
    const { admin, fixture } = await bindAdminDiscord();
    createStorageMock();
    const channelId = uniqueDiscordSnowflake();
    const bytes = Buffer.from("quarter,sales\nQ1,500\n", "utf8");
    const world = serveDiscordWorld(fixture, {
      channels: [
        { id: channelId, type: 0, guild_id: fixture.guildId, name: "general" },
      ],
      normalizeAttachmentFilename: (name) => {
        return name.replaceAll(" ", "_");
      },
    });

    const initialized = await accept(
      app(integrationsDiscordUploadInitContract).init({
        headers: signIn(admin),
        body: {
          filename: "quarterly report.csv",
          length: bytes.byteLength,
          contentType: "text/csv",
          checksumSha256: sha256Hex(bytes),
          channelId,
        },
      }),
      [200],
    );
    await putUploadedBytes(
      initialized.body.uploadUrl,
      bytes,
      "text/csv",
      initialized.body.uploadHeaders,
    );

    const completed = await accept(
      app(integrationsDiscordUploadCompleteContract).complete({
        headers: signIn(admin),
        body: { assetId: initialized.body.assetId, channelId },
      }),
      [200],
    );

    const [created] = world.createdMessages;
    if (!created) {
      throw new Error("Expected one delivered Discord message");
    }
    expect(completed.body.delivery).toStrictEqual({
      status: "delivered",
      channelId,
      messageId: created.messageId,
      attachmentId: created.attachmentId,
      permalink: `https://discord.com/channels/${fixture.guildId}/${channelId}/${created.messageId}`,
    });
  });

  it("integrations-discord-files-027 reports a Discord rate limit as a failed file delivery", async () => {
    const { admin, fixture } = await bindAdminDiscord();
    createStorageMock();
    const channelId = uniqueDiscordSnowflake();
    const bytes = Buffer.from("status,ok\ntrue,1\n", "utf8");
    const world = serveDiscordWorld(fixture, {
      channels: [
        { id: channelId, type: 0, guild_id: fixture.guildId, name: "general" },
      ],
      rateLimitUploads: true,
    });

    const initialized = await accept(
      app(integrationsDiscordUploadInitContract).init({
        headers: signIn(admin),
        body: {
          filename: "report.csv",
          length: bytes.byteLength,
          contentType: "text/csv",
          checksumSha256: sha256Hex(bytes),
          channelId,
        },
      }),
      [200],
    );
    await putUploadedBytes(
      initialized.body.uploadUrl,
      bytes,
      "text/csv",
      initialized.body.uploadHeaders,
    );

    const first = await accept(
      app(integrationsDiscordUploadCompleteContract).complete({
        headers: signIn(admin),
        body: { assetId: initialized.body.assetId, channelId },
      }),
      [200],
    );

    expect(first.body.delivery).toStrictEqual({
      status: "failed",
      message: "Discord rejected the file delivery",
    });
    expect(world.uploads).toHaveLength(1);
  });

  it("integrations-discord-files-029 denies completion after the verified connection is removed", async () => {
    const { admin, fixture } = await bindAdminDiscord();
    createStorageMock();
    const channelId = uniqueDiscordSnowflake();
    const bytes = Buffer.from("id,name\n1,alpha\n", "utf8");
    const world = serveDiscordWorld(fixture, {
      channels: [
        { id: channelId, type: 0, guild_id: fixture.guildId, name: "general" },
      ],
    });

    const initialized = await accept(
      app(integrationsDiscordUploadInitContract).init({
        headers: signIn(admin),
        body: {
          filename: "report.csv",
          length: bytes.byteLength,
          contentType: "text/csv",
          checksumSha256: sha256Hex(bytes),
          channelId,
        },
      }),
      [200],
    );
    await putUploadedBytes(
      initialized.body.uploadUrl,
      bytes,
      "text/csv",
      initialized.body.uploadHeaders,
    );

    await removePublicDiscordBinding(context, admin);

    const afterRemoval = await accept(
      app(integrationsDiscordUploadCompleteContract).complete({
        headers: signIn(admin),
        body: { assetId: initialized.body.assetId, channelId },
      }),
      [404],
    );
    expect(afterRemoval.body.error.code).toBe("NOT_FOUND");
    expect(world.uploads).toHaveLength(0);
  });
});
