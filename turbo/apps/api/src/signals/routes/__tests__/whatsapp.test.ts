import { randomInt, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { integrationsWhatsappContract } from "@okouai/api-contracts/contracts/integrations-whatsapp";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { integrationsWhatsappRoutes } from "../integrations-whatsapp";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { webFileUrlRoutes } from "../web-file-url";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  AGENTPHONE_BDD_PHONE_NUMBER,
  createAgentPhoneBddApi,
  uniquePhoneHandle,
} from "./helpers/api-bdd-agentphone";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { mockClerkUsers } from "./helpers/clerk-users";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const integrations = createBddIntegrationApi(context);
const agentPhone = createAgentPhoneBddApi(context);
const whatsapp = setupApp({ context, routes: integrationsWhatsappRoutes })(
  integrationsWhatsappContract,
);
const uploads = setupApp({ context, routes: uploadsPrepareRoutes })(
  uploadsContract,
);
const webFiles = setupApp({ context, routes: webFileUrlRoutes })(
  webFilesContract,
);
const AGENTPHONE_API = "https://api.agentphone.test";

interface ProviderSend {
  readonly channel: string | undefined;
  readonly fromNumber: string | undefined;
  readonly toNumber: string | undefined;
  readonly body: string | undefined;
  readonly mediaUrls: readonly string[];
}

interface ProviderOptions {
  readonly whatsappEnabled?: boolean;
  readonly reject?: {
    readonly status: number;
    readonly body: Readonly<Record<string, unknown>>;
  };
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * The shared AgentPhone number with a signed webhook. Every provider send is
 * recorded with its transport; the number list reports WhatsApp support.
 */
function sharedNumber(options: ProviderOptions = {}) {
  integrations.configureAgentPhoneProvider();
  integrations.configureAgentPhoneWebhook();
  const sends: ProviderSend[] = [];
  server.use(
    http.get(`${AGENTPHONE_API}/v1/numbers`, () => {
      return HttpResponse.json({
        data: [
          {
            phoneNumber: AGENTPHONE_BDD_PHONE_NUMBER,
            whatsappEnabled: options.whatsappEnabled ?? true,
          },
        ],
        hasMore: false,
      });
    }),
    http.post(`${AGENTPHONE_API}/v1/messages`, async ({ request }) => {
      const raw: unknown = await request.json();
      const record =
        typeof raw === "object" && raw !== null
          ? (raw as Record<string, unknown>)
          : {};
      const send: ProviderSend = {
        channel: stringField(record, "channel"),
        fromNumber: stringField(record, "from_number"),
        toNumber: stringField(record, "to_number"),
        body: stringField(record, "body"),
        mediaUrls: Array.isArray(record.media_urls)
          ? record.media_urls.filter((url): url is string => {
              return typeof url === "string";
            })
          : [],
      };
      sends.push(send);
      if (options.reject) {
        return HttpResponse.json(options.reject.body, {
          status: options.reject.status,
        });
      }
      return HttpResponse.json({
        id: `apmsg_${randomUUID()}`,
        status: "sent",
      });
    }),
    http.post(`${AGENTPHONE_API}/v1/conversations/:id/typing`, () => {
      return HttpResponse.json({ status: "typing indicator sent" });
    }),
  );
  return sends;
}

function germanPhone(): string {
  return `+49${randomInt(100_000_000_000, 1_000_000_000_000)}`;
}

/** A real workspace member with the WhatsApp integration switch on. */
async function whatsappMember(
  options: {
    readonly orgId?: string;
    readonly workspaceName?: string;
    readonly enabled?: boolean;
  } = {},
): Promise<ApiTestUser> {
  const member = integrations.user(
    options.orgId === undefined ? {} : { orgId: options.orgId },
  );
  if (!member.orgId) {
    throw new Error("Expected a workspace member");
  }
  await createStore().set(
    seedOrgMembership$,
    {
      orgId: member.orgId,
      userId: member.userId,
      role: "admin",
      ...(options.workspaceName === undefined
        ? {}
        : { name: options.workspaceName }),
    },
    context.signal,
  );
  if (options.enabled ?? true) {
    await updateFeatureSwitchesForUser(
      context,
      { userId: member.userId, orgId: member.orgId },
      { [FeatureSwitchKey.WhatsappIntegration]: true },
    );
  }
  return member;
}

function signIn(member: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    member.userId,
    member.orgId,
    member.orgRole,
  );
  const emailId = `email_${member.userId}`;
  mockClerkUsers(context, [
    {
      id: member.userId,
      emailAddresses: [{ id: emailId, emailAddress: member.email }],
      primaryEmailAddressId: emailId,
      firstName: "WhatsApp",
      lastName: "Member",
    },
  ]);
  return { authorization: "Bearer clerk-session" };
}

async function sendWhatsapp(
  from: string,
  body: string,
  extra: { readonly messageId?: string; readonly isGroup?: boolean } = {},
) {
  return await agentPhone.postAgentPhoneInboundMessage({
    channel: "whatsapp",
    from,
    body,
    ...extra,
    ...(extra.isGroup ? { conversationId: `conv-${randomUUID()}` } : {}),
  });
}

/** The signed connection proof carried by the latest connect link. */
function latestProof(sends: readonly ProviderSend[]) {
  const url = [...sends]
    .reverse()
    .map((send) => {
      return send.body?.match(/https?:\/\/\S+\/settings\/whatsapp\?\S+/u)?.[0];
    })
    .find((candidate) => {
      return candidate !== undefined;
    });
  if (!url) {
    throw new Error("Expected a WhatsApp connect link in a provider send");
  }
  const params = new URL(url).searchParams;
  return {
    url,
    proof: {
      phoneHandle: params.get("handle") ?? "",
      agentphoneAgentId: params.get("agent") ?? "",
      timestamp: Number(params.get("ts")),
      signature: params.get("sig") ?? "",
      channel: params.get("channel") ?? undefined,
    },
  };
}

async function requestProof(sends: readonly ProviderSend[], phone: string) {
  await sendWhatsapp(phone, "/connect");
  return latestProof(sends).proof;
}

async function connectWhatsapp(
  member: ApiTestUser,
  sends: readonly ProviderSend[],
  phone: string,
) {
  const proof = await requestProof(sends, phone);
  await accept(
    whatsapp.connectWhatsapp({ headers: signIn(member), body: proof }),
    [200],
  );
}

async function whatsappLink(member: ApiTestUser) {
  const response = await accept(
    whatsapp.getLinkStatus({ headers: signIn(member) }),
    [200],
  );
  return response.body;
}

async function linkCode(member: ApiTestUser): Promise<string> {
  const response = await accept(
    whatsapp.createLinkCode({ headers: signIn(member), body: undefined }),
    [200],
  );
  return response.body.code;
}

async function phoneLinked(member: ApiTestUser): Promise<boolean> {
  const status = await integrations.getAgentPhoneLinkStatus(member);
  return status.linked;
}

/** Link the same phone to the member through the SMS phone integration. */
async function linkPhoneOverSms(member: ApiTestUser, phone: string) {
  const code = await integrations.requestCreateAgentPhoneLinkCode(
    member,
    [200],
  );
  await agentPhone.postAgentPhoneInboundMessage({
    channel: "sms",
    from: phone,
    body: code.body.code,
  });
}

interface StoredObject {
  readonly body: Buffer;
  readonly contentType: string | undefined;
}

/** In-memory private artifact storage behind presigned upload URLs. */
function installArtifactStorage() {
  const objects = new Map<string, StoredObject>();
  const signed = new Map<string, string>();
  context.mocks.s3.getSignedUrl.mockImplementation(
    (_client: unknown, command: unknown) => {
      const { input } = command as {
        readonly input: { readonly Bucket: string; readonly Key: string };
      };
      const url = `https://r2.example.com/${input.Bucket}/${input.Key}?X-Amz-Signature=${randomUUID()}`;
      signed.set(url, `${input.Bucket}/${input.Key}`);
      return Promise.resolve(url);
    },
  );
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const { constructor, input } = command as {
      readonly constructor: { readonly name: string };
      readonly input: Record<string, unknown>;
    };
    const id = `${String(input.Bucket)}/${String(input.Key)}`;
    const stored = objects.get(id);
    switch (constructor.name) {
      case "PutObjectCommand": {
        objects.set(id, {
          body: Buffer.from(input.Body as string | Uint8Array),
          contentType: input.ContentType as string | undefined,
        });
        return Promise.resolve({ ETag: '"put"' });
      }
      case "HeadObjectCommand": {
        if (!stored) {
          return Promise.reject(
            Object.assign(new Error("Not found"), {
              name: "NotFound",
              $metadata: { httpStatusCode: 404 },
            }),
          );
        }
        return Promise.resolve({
          ContentLength: stored.body.byteLength,
          ContentType: stored.contentType,
          LastModified: new Date("2026-01-01T00:00:00.000Z"),
          Metadata: {},
          ETag: '"head"',
        });
      }
      case "GetObjectCommand": {
        if (!stored) {
          return Promise.reject(
            Object.assign(new Error("Not found"), {
              name: "NoSuchKey",
              $metadata: { httpStatusCode: 404 },
            }),
          );
        }
        return Promise.resolve({
          ContentLength: stored.body.byteLength,
          ContentType: stored.contentType,
          LastModified: new Date("2026-01-01T00:00:00.000Z"),
          Metadata: {},
          ETag: '"get"',
          Body: Readable.from([stored.body]),
        });
      }
      default: {
        return Promise.resolve({});
      }
    }
  });
  return {
    upload(uploadUrl: string, body: Buffer, contentType: string): void {
      const target = signed.get(uploadUrl);
      if (!target) {
        throw new Error(`Unknown upload URL ${uploadUrl}`);
      }
      objects.set(target, { body, contentType });
    },
  };
}

type ArtifactStorage = ReturnType<typeof installArtifactStorage>;

/** The member uploads a private artifact through the browser upload flow. */
async function uploadPrivateFile(
  member: ApiTestUser,
  storage: ArtifactStorage,
  file: {
    readonly filename: string;
    readonly contentType: string;
    readonly size: number;
  },
) {
  const prepared = await accept(
    uploads.preparePrivate({ headers: signIn(member), body: file }),
    [200],
  );
  if ("multipart" in prepared.body) {
    throw new Error("Expected a single-part upload");
  }
  storage.upload(
    prepared.body.uploadUrl,
    Buffer.alloc(file.size, 1),
    file.contentType,
  );
  return prepared.body;
}

async function publicUrl(member: ApiTestUser, fileId: string) {
  const response = await accept(
    webFiles.fileUrl({ headers: signIn(member), query: { file_id: fileId } }),
    [200],
  );
  return response.body.publicUrl;
}

describe("WhatsApp through the shared AgentPhone number", () => {
  it("whatsapp-005 answers help and disconnect before connection without starting an agent", async () => {
    const sends = sharedNumber();
    const phone = uniquePhoneHandle();

    await sendWhatsapp(phone, "/help");
    const help = sends.at(-1);
    await sendWhatsapp(phone, "/disconnect");
    const disconnect = sends.at(-1);

    expect(help?.body).toContain("WhatsApp commands");
    expect(disconnect?.body).toContain("not connected. Send /connect");
  });

  it("whatsapp-001 guides an unconnected DM into a signed WhatsApp connection for Hello Okou", async () => {
    const sends = sharedNumber();
    const phone = germanPhone();
    const member = await whatsappMember();

    await sendWhatsapp(phone, "Hello Okou");
    const { url, proof } = latestProof(sends);
    const before = await accept(
      whatsapp.getConnectStatus({ headers: signIn(member), query: proof }),
      [200],
    );
    const beforeLink = await whatsappLink(member);
    await accept(
      whatsapp.connectWhatsapp({ headers: signIn(member), body: proof }),
      [200],
    );
    const after = await accept(
      whatsapp.getConnectStatus({ headers: signIn(member), query: proof }),
      [200],
    );

    expect(new URL(url).pathname).toBe("/settings/whatsapp");
    expect(proof).toMatchObject({ phoneHandle: phone, channel: "whatsapp" });
    expect(before.body).toStrictEqual({ kind: "connect" });
    expect(beforeLink.linked).toBeFalsy();
    expect(after.body).toStrictEqual({ kind: "connected", phoneHandle: phone });
    await expect(phoneLinked(member)).resolves.toBeFalsy();
    const lastThree = sends.slice(-3);
    expect(lastThree).toHaveLength(3);
    for (const send of lastThree) {
      expect(send).toMatchObject({ channel: "whatsapp", toNumber: phone });
    }
    expect(lastThree[2]?.body).toContain("What would you like to start with?");
  });

  it("whatsapp-004 identifies the connected workspace and offers recovery without an agent run", async () => {
    const sends = sharedNumber();
    const phone = uniquePhoneHandle();
    const member = await whatsappMember({
      workspaceName: "WhatsApp workspace",
    });
    await connectWhatsapp(member, sends, phone);

    await sendWhatsapp(phone, "/connect");

    const reply = sends.at(-1);
    expect(reply).toMatchObject({ channel: "whatsapp", toNumber: phone });
    expect(reply?.body).toContain('workspace "WhatsApp workspace"');
    expect(reply?.body).toContain("/switch");
    expect(reply?.body).toContain("/disconnect");
  });

  it("whatsapp-006 rejects cross-channel and expired signed proofs without connecting", async () => {
    const sends = sharedNumber();
    const member = await whatsappMember();
    const proof = await requestProof(sends, uniquePhoneHandle());

    const crossChannel = await whatsapp.connectWhatsapp({
      headers: signIn(member),
      body: { ...proof, channel: "imessage" },
    });
    mockNow(now() + 11 * 60 * 1000);
    const expiredStatus = await whatsapp.getConnectStatus({
      headers: signIn(member),
      query: proof,
    });
    const expiredConnect = await whatsapp.connectWhatsapp({
      headers: signIn(member),
      body: proof,
    });

    expect(crossChannel.status).toBe(400);
    expect(expiredStatus.status).toBe(400);
    expect(expiredConnect.status).toBe(400);
    await expect(whatsappLink(member)).resolves.toMatchObject({
      linked: false,
    });
  });

  it("whatsapp-007 requires explicit number replacement and preserves the old link on a competing claim", async () => {
    const sends = sharedNumber();
    const member = await whatsappMember();
    const other = await whatsappMember({ orgId: member.orgId ?? undefined });
    const firstPhone = uniquePhoneHandle();
    const secondPhone = uniquePhoneHandle();
    await connectWhatsapp(member, sends, firstPhone);
    const proof = await requestProof(sends, secondPhone);

    const status = await accept(
      whatsapp.getConnectStatus({ headers: signIn(member), query: proof }),
      [200],
    );
    const plain = await whatsapp.connectWhatsapp({
      headers: signIn(member),
      body: proof,
    });
    const otherConnect = await whatsapp.connectWhatsapp({
      headers: signIn(other),
      body: proof,
    });
    const replacement = { ...proof, replacePhoneHandle: firstPhone };
    const blocked = await whatsapp.connectWhatsapp({
      headers: signIn(member),
      body: replacement,
    });
    const kept = await whatsappLink(member);
    const unlinked = await whatsapp.unlink({
      headers: signIn(other),
      body: undefined,
    });
    const replaced = await whatsapp.connectWhatsapp({
      headers: signIn(member),
      body: replacement,
    });
    const switched = await whatsappLink(member);
    await sendWhatsapp(secondPhone, "/disconnect");
    await sendWhatsapp(secondPhone, "/connect");

    expect(status.body).toStrictEqual({
      kind: "phone_mismatch",
      currentPhoneHandle: firstPhone,
    });
    expect(plain.status).toBe(409);
    expect(otherConnect.status).toBe(200);
    expect(blocked.status).toBe(409);
    expect(kept).toMatchObject({ linked: true, phoneHandle: firstPhone });
    expect(unlinked.status).toBe(204);
    expect(replaced.status).toBe(200);
    expect(switched).toMatchObject({ linked: true, phoneHandle: secondPhone });
    expect(sends.at(-1)?.body).toContain("/settings/whatsapp?");
  });

  it("whatsapp-008 sends an owned private artifact as one WhatsApp attachment without publishing its fetch URL", async () => {
    const sends = sharedNumber();
    const storage = installArtifactStorage();
    const member = await whatsappMember();
    const other = await whatsappMember();
    const phone = uniquePhoneHandle();
    await connectWhatsapp(member, sends, phone);
    await connectWhatsapp(other, sends, uniquePhoneHandle());
    const file = await uploadPrivateFile(member, storage, {
      filename: "report.pdf",
      contentType: "application/pdf",
      size: 1024,
    });
    const before = sends.length;

    const sent = await accept(
      whatsapp.sendUploadedFile({
        headers: signIn(member),
        body: { fileId: file.id, caption: "Here is the report" },
      }),
      [200],
    );
    const fileSends = sends.slice(before);
    const otherSend = await whatsapp.sendUploadedFile({
      headers: signIn(other),
      body: { fileId: file.id },
    });

    expect(sent.body).toMatchObject({
      channel: "whatsapp",
      toNumber: phone,
      file: { id: file.id, url: file.url, size: 1024 },
    });
    expect(sent.body.messages).toHaveLength(1);
    expect(fileSends).toHaveLength(1);
    expect(fileSends[0]).toMatchObject({
      channel: "whatsapp",
      fromNumber: AGENTPHONE_BDD_PHONE_NUMBER,
      toNumber: phone,
    });
    expect(fileSends[0]?.body).toContain("Here is the report");
    expect(fileSends[0]?.mediaUrls).toHaveLength(1);
    const mediaUrl = new URL(fileSends[0]?.mediaUrls[0] ?? "");
    expect(mediaUrl.protocol).toBe("https:");
    expect(mediaUrl.search).not.toBe("");
    await expect(publicUrl(member, file.id)).resolves.toBeNull();
    expect(otherSend.status).toBe(404);
    expect(sends).toHaveLength(before + 1);
  });

  it("whatsapp-009 preserves the uploaded artifact when file delivery is rejected without retrying", async () => {
    const connectSends = sharedNumber();
    const storage = installArtifactStorage();
    const member = await whatsappMember();
    await connectWhatsapp(member, connectSends, uniquePhoneHandle());
    const file = await uploadPrivateFile(member, storage, {
      filename: "report.pdf",
      contentType: "application/pdf",
      size: 1024,
    });
    const sends = sharedNumber({
      reject: {
        status: 422,
        body: {
          error: {
            code: "CONVERSATION_CONTENT_RESTRICTED",
            message: "The message content was rejected",
          },
        },
      },
    });

    const sent = await accept(
      whatsapp.sendUploadedFile({
        headers: signIn(member),
        body: { fileId: file.id },
      }),
      [400],
    );

    expect(sent.body).toMatchObject({
      delivery: "failed",
      file: { id: file.id, url: file.url },
    });
    expect(sends).toHaveLength(1);
    await expect(publicUrl(member, file.id)).resolves.toBeNull();
  });

  it("whatsapp-012 rejects an audio caption before sending and accepts the same audio without a caption", async () => {
    const sends = sharedNumber();
    const storage = installArtifactStorage();
    const member = await whatsappMember();
    await connectWhatsapp(member, sends, uniquePhoneHandle());
    const file = await uploadPrivateFile(member, storage, {
      filename: "note.mp3",
      contentType: "audio/mpeg",
      size: 2048,
    });
    const before = sends.length;

    const captioned = await accept(
      whatsapp.sendUploadedFile({
        headers: signIn(member),
        body: { fileId: file.id, caption: "Listen" },
      }),
      [400],
    );
    const sendsAfterCaption = sends.length;
    await accept(
      whatsapp.sendUploadedFile({
        headers: signIn(member),
        body: { fileId: file.id },
      }),
      [200],
    );

    expect(captioned.body).toMatchObject({
      delivery: "failed",
      error: { code: "WHATSAPP_AUDIO_CAPTION_UNSUPPORTED" },
    });
    expect(sendsAfterCaption).toBe(before);
    expect(sends.slice(before)).toStrictEqual([
      expect.objectContaining({ channel: "whatsapp", body: "" }),
    ]);
    expect(sends.at(-1)?.mediaUrls).toHaveLength(1);
  });

  it("whatsapp-013 verifies WhatsApp independently and disconnects it without changing the phone link", async () => {
    sharedNumber();
    const member = await whatsappMember();
    const phone = uniquePhoneHandle();
    const code = await linkCode(member);

    await agentPhone.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: code,
    });
    const afterSms = await whatsappLink(member);
    await sendWhatsapp(phone, code);
    const afterWhatsapp = await whatsappLink(member);
    const phoneAfterWhatsapp = await phoneLinked(member);
    await linkPhoneOverSms(member, phone);
    const unlinked = await whatsapp.unlink({
      headers: signIn(member),
      body: undefined,
    });

    expect(afterSms.linked).toBeFalsy();
    expect(afterWhatsapp).toMatchObject({
      linked: true,
      phoneHandle: phone,
      agentPhoneNumber: AGENTPHONE_BDD_PHONE_NUMBER,
    });
    expect(phoneAfterWhatsapp).toBeFalsy();
    expect(unlinked.status).toBe(204);
    await expect(phoneLinked(member)).resolves.toBeTruthy();
    await expect(whatsappLink(member)).resolves.toMatchObject({
      linked: false,
    });
  });

  it("whatsapp-015 disconnect only revokes the WhatsApp link when the same number also has a phone link", async () => {
    const sends = sharedNumber();
    const member = await whatsappMember();
    const phone = uniquePhoneHandle();
    await connectWhatsapp(member, sends, phone);
    await linkPhoneOverSms(member, phone);

    await sendWhatsapp(phone, "/disconnect");

    await expect(whatsappLink(member)).resolves.toMatchObject({
      linked: false,
    });
    await expect(phoneLinked(member)).resolves.toBeTruthy();
    expect(sends.at(-1)).toMatchObject({
      channel: "whatsapp",
      fromNumber: AGENTPHONE_BDD_PHONE_NUMBER,
      toNumber: phone,
    });
  });

  it("whatsapp-016 switch only revokes the WhatsApp link when the same number also has a phone link", async () => {
    const sends = sharedNumber();
    const member = await whatsappMember();
    const phone = uniquePhoneHandle();
    await connectWhatsapp(member, sends, phone);
    await linkPhoneOverSms(member, phone);

    await sendWhatsapp(phone, "/switch");
    const reply = sends.at(-1);
    const afterSwitch = await whatsappLink(member);
    const phoneAfterSwitch = await phoneLinked(member);
    await sendWhatsapp(phone, await linkCode(member));

    expect(afterSwitch.linked).toBeFalsy();
    expect(phoneAfterSwitch).toBeTruthy();
    expect(reply).toMatchObject({
      channel: "whatsapp",
      fromNumber: AGENTPHONE_BDD_PHONE_NUMBER,
      toNumber: phone,
    });
    expect(reply?.body).toContain("/settings/whatsapp?");
    expect(reply?.body).toContain("channel=whatsapp");
    await expect(whatsappLink(member)).resolves.toMatchObject({
      linked: true,
      phoneHandle: phone,
    });
  });

  it("whatsapp-022 sends long Unicode messages only through WhatsApp using the existing shared number", async () => {
    const sends = sharedNumber();
    const member = await whatsappMember();
    const second = await whatsappMember();
    const phone = uniquePhoneHandle();
    await connectWhatsapp(member, sends, phone);
    const before = sends.length;
    const text = "😀".repeat(4100);

    const sent = await accept(
      whatsapp.sendMessage({ headers: signIn(member), body: { text } }),
      [200],
    );
    const parts = sends.slice(before);
    const secondSend = await whatsapp.sendMessage({
      headers: signIn(second),
      body: { text: "Hello" },
    });

    expect(sent.body).toMatchObject({ channel: "whatsapp", toNumber: phone });
    expect(sent.body.messages).toHaveLength(2);
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      expect(part).toMatchObject({
        channel: "whatsapp",
        fromNumber: AGENTPHONE_BDD_PHONE_NUMBER,
        toNumber: phone,
      });
      expect([...(part.body ?? "")].length).toBeLessThanOrEqual(4096);
    }
    expect(
      parts
        .map((part) => {
          return part.body;
        })
        .join(""),
    ).toBe(text);
    expect(secondSend.status).toBe(404);
    expect(sends).toHaveLength(before + 2);
  });

  it("whatsapp-033 rejects expired and replaced codes while leaving the new code usable", async () => {
    sharedNumber();
    const member = await whatsappMember();
    const phone = uniquePhoneHandle();
    const replaced = await linkCode(member);
    const current = await linkCode(member);

    await sendWhatsapp(phone, replaced);
    const afterReplaced = await whatsappLink(member);
    mockNow(now() + 10 * 60 * 1000 + 1);
    await sendWhatsapp(phone, current);
    const afterExpired = await whatsappLink(member);
    await sendWhatsapp(phone, await linkCode(member));
    const afterFresh = await whatsappLink(member);

    expect(afterReplaced.linked).toBeFalsy();
    expect(afterExpired.linked).toBeFalsy();
    expect(afterFresh).toMatchObject({ linked: true, phoneHandle: phone });
  });

  it("whatsapp-034 keeps the integration disabled until enabled and the shared number is provisioned for WhatsApp", async () => {
    sharedNumber({ whatsappEnabled: false });
    const member = await whatsappMember({ enabled: false });

    const disabled = await whatsapp.getLinkStatus({ headers: signIn(member) });
    if (!member.orgId) {
      throw new Error("Expected a workspace member");
    }
    await updateFeatureSwitchesForUser(
      context,
      { userId: member.userId, orgId: member.orgId },
      { [FeatureSwitchKey.WhatsappIntegration]: true },
    );
    mockOptionalEnv("AGENTPHONE_WEBHOOK_SECRET", undefined);
    const withoutSecret = await whatsappLink(member);
    const codeWithoutSecret = await whatsapp.createLinkCode({
      headers: signIn(member),
      body: undefined,
    });
    integrations.configureAgentPhoneWebhook();
    const unprovisioned = await whatsappLink(member);
    const codeUnprovisioned = await whatsapp.createLinkCode({
      headers: signIn(member),
      body: undefined,
    });

    expect(disabled.status).toBe(404);
    expect(withoutSecret.configured).toBeFalsy();
    expect(codeWithoutSecret.status).toBe(503);
    expect(unprovisioned.configured).toBeFalsy();
    expect(codeUnprovisioned.status).toBe(503);
  });

  it("whatsapp-038 applies the configured country prefixes to outbound sends", async () => {
    const sends = sharedNumber();
    const member = await whatsappMember();
    await connectWhatsapp(member, sends, uniquePhoneHandle());
    mockEnv("WHATSAPP_ALLOWED_COUNTRY_PREFIXES", "+49");
    const before = sends.length;

    const sent = await whatsapp.sendMessage({
      headers: signIn(member),
      body: { text: "Your report is ready" },
    });

    expect(sent.status).toBe(404);
    expect(sends).toHaveLength(before);
  });

  it("whatsapp-039 returns the same country restriction reply for a WhatsApp connection code without connecting", async () => {
    mockEnv("APP_URL", "https://app.okou.test");
    mockEnv("WHATSAPP_ALLOWED_COUNTRY_PREFIXES", " +49, +55, +90 ");
    const sends = sharedNumber();
    const member = await whatsappMember();
    const code = await linkCode(member);
    const usPhone = uniquePhoneHandle();
    const messageId = `ap-msg-${randomUUID()}`;

    await sendWhatsapp(usPhone, code, { messageId });
    const afterUs = await whatsappLink(member);
    await sendWhatsapp(usPhone, code, { messageId });
    const usReplies = sends.filter((send) => {
      return send.toNumber === usPhone;
    });
    const phone = germanPhone();
    await sendWhatsapp(phone, code);

    expect(afterUs.linked).toBeFalsy();
    expect(usReplies).toStrictEqual([
      expect.objectContaining({
        channel: "whatsapp",
        body: "Okou isn't available on WhatsApp for your phone number's country or region. Please use Okou on the web: https://app.okou.test",
      }),
    ]);
    await expect(whatsappLink(member)).resolves.toMatchObject({
      linked: true,
      phoneHandle: phone,
    });
  });

  it("whatsapp-045 does not bind or reply to WhatsApp group messages", async () => {
    mockEnv("WHATSAPP_ALLOWED_COUNTRY_PREFIXES", " +49, +55, +90 ");
    const sends = sharedNumber();
    const member = await whatsappMember();
    const code = await linkCode(member);
    const phone = germanPhone();

    await sendWhatsapp(uniquePhoneHandle(), code, { isGroup: true });
    await sendWhatsapp(phone, code, { isGroup: true });
    const afterGroups = await whatsappLink(member);
    const sendsAfterGroups = sends.length;
    await sendWhatsapp(phone, code);

    expect(afterGroups.linked).toBeFalsy();
    expect(sendsAfterGroups).toBe(0);
    await expect(whatsappLink(member)).resolves.toMatchObject({
      linked: true,
      phoneHandle: phone,
    });
  });

  it("whatsapp-048 returns the provider's service-window failure without retrying or changing transports", async () => {
    const connectSends = sharedNumber();
    const member = await whatsappMember();
    await connectWhatsapp(member, connectSends, uniquePhoneHandle());
    const sends = sharedNumber({
      reject: {
        status: 422,
        body: {
          error: {
            code: "CUSTOMER_SERVICE_WINDOW_CLOSED",
            message:
              "Re-engagement message: more than 24 hours have passed since the customer last replied (131047).",
          },
        },
      },
    });

    const followUp = await accept(
      whatsapp.sendMessage({
        headers: signIn(member),
        body: { text: "Follow-up" },
      }),
      [400],
    );
    const attempts = sends.length;
    const done = await accept(
      whatsapp.sendMessage({
        headers: signIn(member),
        body: { text: "Done", taskCompleted: true },
      }),
      [400],
    );

    expect(followUp.body.error.message).toContain("24-hour service window");
    expect(attempts).toBe(1);
    expect(sends[0]?.channel).toBe("whatsapp");
    expect(done.body.error.message).toContain("current run");
    expect(sends).toHaveLength(1);
  });
});
