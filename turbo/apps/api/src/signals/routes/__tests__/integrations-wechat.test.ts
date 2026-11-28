import { createHmac, randomBytes, randomUUID } from "node:crypto";

import {
  integrationsWechatContract,
  wechatReceiverContract,
} from "@okouai/api-contracts/contracts/integrations-wechat";
import { integrationsWechatMessagesContract } from "@okouai/api-contracts/contracts/integrations-wechat-messages";
import type { WechatMessage } from "@okouai/api-contracts/contracts/wechat-protocol";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { describe, expect, it, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { integrationsWechatRoutes } from "../integrations-wechat";
import { integrationsWechatMessagesRoutes } from "../integrations-wechat-messages";
import { wechatReceiverRoutes } from "../wechat-receiver";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
} from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const directory = createStore();

const TENCENT = "https://ilinkai.weixin.qq.com";
const GATEWAY = "https://wechat-gateway.okou.test";
const WORKSPACE_NAME = "WeChat test workspace";
const AUTH = Object.freeze({ authorization: "Bearer clerk-session" });

interface Actor {
  readonly userId: string;
  readonly orgId: string;
}

interface QrStatusReply {
  readonly status: string;
  readonly bot_token?: string;
  readonly ilink_bot_id?: string;
  readonly ilink_user_id?: string;
  readonly baseurl?: string;
}

interface ReceiverStart {
  readonly connectionId: string;
  readonly generation: string;
}

interface SentText {
  readonly to: string;
  readonly contextToken: string | undefined;
  readonly text: string;
}

interface Tencent {
  readonly starts: ReceiverStart[];
  readonly sent: SentText[];
  readonly verifyCodes: (string | null)[];
  qrRequests: number;
  qrStatus: (verifyCode: string | null) => QrStatusReply;
}

function confirmed(scanner: string): QrStatusReply {
  return {
    status: "confirmed",
    bot_token: `private-bot-token-${scanner}`,
    ilink_bot_id: `bot-${scanner}`,
    ilink_user_id: scanner,
    baseurl: TENCENT,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readSentText(body: unknown): SentText {
  if (!isRecord(body) || !isRecord(body.msg)) {
    throw new Error("Unexpected WeChat sendmessage body");
  }
  const msg = body.msg;
  const items = Array.isArray(msg.item_list) ? msg.item_list : [];
  const first: unknown = items[0];
  const text =
    isRecord(first) &&
    isRecord(first.text_item) &&
    typeof first.text_item.text === "string"
      ? first.text_item.text
      : "";
  return {
    to: typeof msg.to_user_id === "string" ? msg.to_user_id : "",
    contextToken:
      typeof msg.context_token === "string" ? msg.context_token : undefined,
    text,
  };
}

function readStart(body: unknown): ReceiverStart {
  if (
    !isRecord(body) ||
    typeof body.connectionId !== "string" ||
    typeof body.generation !== "string"
  ) {
    throw new Error("Unexpected receiver start body");
  }
  return { connectionId: body.connectionId, generation: body.generation };
}

function installWechat(): Tencent {
  mockEnv("WECHAT_GATEWAY_URL", GATEWAY);
  mockEnv("WECHAT_GATEWAY_SECRET", randomBytes(32).toString("hex"));
  mockEnv("WECHAT_GATEWAY_CONTROL_SECRET", randomBytes(32).toString("hex"));
  mockEnv("APP_URL", "https://app.okou.test");
  const tencent: Tencent = {
    starts: [],
    sent: [],
    verifyCodes: [],
    qrRequests: 0,
    qrStatus: () => {
      return { status: "wait" };
    },
  };
  server.use(
    http.post(`${GATEWAY}/start`, async ({ request }) => {
      tencent.starts.push(readStart(await request.json()));
      return HttpResponse.json({});
    }),
    http.post(`${GATEWAY}/stop`, () => {
      return HttpResponse.json({});
    }),
    http.post(`${TENCENT}/ilink/bot/get_bot_qrcode`, () => {
      tencent.qrRequests += 1;
      return HttpResponse.json({
        qrcode: `qr-${randomUUID()}`,
        qrcode_img_content: "https://weixin.qq.com/test-qr",
      });
    }),
    http.get(`${TENCENT}/ilink/bot/get_qrcode_status`, ({ request }) => {
      const verifyCode = new URL(request.url).searchParams.get("verify_code");
      tencent.verifyCodes.push(verifyCode);
      return HttpResponse.json(tencent.qrStatus(verifyCode));
    }),
    http.post(`${TENCENT}/ilink/bot/sendmessage`, async ({ request }) => {
      tencent.sent.push(readSentText(await request.json()));
      return HttpResponse.json({ ret: 0, message_id: `sent-${randomUUID()}` });
    }),
  );
  return tencent;
}

async function newMember(
  options: { readonly orgId?: string; readonly wechat?: boolean } = {},
): Promise<Actor> {
  const actor = {
    userId: `user_${randomUUID()}`,
    orgId: options.orgId ?? `org_${randomUUID()}`,
  };
  await joinWorkspace(actor);
  if (options.wechat !== false) {
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.WechatIntegration]: true,
    });
  }
  return actor;
}

async function joinWorkspace(actor: Actor): Promise<void> {
  await directory.set(
    seedOrgMembership$,
    { ...actor, name: WORKSPACE_NAME, membershipId: `orgmem_${randomUUID()}` },
    context.signal,
  );
}

function signIn(actor: Actor): typeof AUTH {
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
  return AUTH;
}

function wechatApi() {
  return setupApp({ context, routes: integrationsWechatRoutes })(
    integrationsWechatContract,
  );
}

function messagesApi() {
  return setupApp({ context, routes: integrationsWechatMessagesRoutes })(
    integrationsWechatMessagesContract,
  );
}

async function expectNoNativeAccess(actor: Actor, channelId: string) {
  await expect(
    accept(messagesApi().listChannels({ headers: signIn(actor) }), [200]),
  ).resolves.toMatchObject({ body: { channels: [] } });
  await accept(
    messagesApi().history({ headers: signIn(actor), query: { channelId } }),
    [404],
  );
  await accept(
    messagesApi().sendMessage({
      headers: signIn(actor),
      body: { channelId, operationId: randomUUID(), text: "Hello" },
    }),
    [404],
  );
}

function receiverApi() {
  return setupApp({ context, routes: wechatReceiverRoutes })(
    wechatReceiverContract,
  );
}

function gatewayHeaders(body: unknown) {
  const timestamp = String(Math.floor(now() / 1000));
  const signature = createHmac("sha256", env("WECHAT_GATEWAY_SECRET") ?? "")
    .update(`${timestamp}.${JSON.stringify(body)}`)
    .digest("hex");
  return {
    "x-wechat-timestamp": timestamp,
    "x-wechat-signature": signature,
  };
}

async function startAttempt(actor: Actor): Promise<string> {
  const attempt = await accept(
    wechatApi().connect({ headers: signIn(actor) }),
    [200],
  );
  return attempt.body.id;
}

async function poll(actor: Actor, id: string, verifyCode?: string) {
  return await accept(
    wechatApi().poll({
      headers: signIn(actor),
      body: verifyCode ? { id, verifyCode } : { id },
    }),
    [200, 409],
  );
}

async function connectByQr(
  tencent: Tencent,
  actor: Actor,
  scanner: string,
): Promise<ReceiverStart> {
  const id = await startAttempt(actor);
  tencent.qrStatus = () => {
    return confirmed(scanner);
  };
  const polled = await poll(actor, id);
  expect(polled.body).toStrictEqual({ status: "connected" });
  await flushWaitUntilForTest();
  const start = tencent.starts.at(-1);
  if (!start) {
    throw new Error("No receiver started");
  }
  return start;
}

async function disconnect(
  tencent: Tencent,
  actor: Actor,
): Promise<ReceiverStart> {
  await accept(
    wechatApi().disconnect({ headers: signIn(actor), body: undefined }),
    [204],
  );
  const start = tencent.starts.at(-1);
  if (!start) {
    throw new Error("No receiver refreshed");
  }
  return start;
}

async function status(actor: Actor) {
  return (await accept(wechatApi().status({ headers: signIn(actor) }), [200]))
    .body;
}

async function bootstrap(connectionId: string, generation?: string) {
  const body = generation ? { connectionId, generation } : { connectionId };
  return (
    await accept(
      receiverApi().bootstrap({ headers: gatewayHeaders(body), body }),
      [200],
    )
  ).body;
}

function ownerMessage(scanner: string, messageId: string): WechatMessage {
  return {
    message_id: messageId,
    from_user_id: scanner,
    to_user_id: `bot-${scanner}`,
    message_type: 1,
    create_time_ms: now(),
    context_token: `context-${messageId}`,
    item_list: [{ type: 1, text_item: { text: "A private incoming message" } }],
  };
}

async function deliver(
  receiver: ReceiverStart,
  messages: readonly WechatMessage[],
) {
  const body = {
    connectionId: receiver.connectionId,
    generation: receiver.generation,
    updates: { get_updates_buf: `cursor-${randomUUID()}`, msgs: [...messages] },
  };
  return (
    await accept(
      receiverApi().deliver({ headers: gatewayHeaders(body), body }),
      [200],
    )
  ).body;
}

function reconnectToken(text: string): string {
  const link = text.split(/\s+/u).find((word) => {
    return URL.canParse(word) && new URL(word).pathname === "/settings/wechat";
  });
  const token = link ? new URL(link).searchParams.get("token") : null;
  if (!token) {
    throw new Error("No reconnect link in the notice");
  }
  return token;
}

async function connectedThenDisconnected(tencent: Tencent, actor: Actor) {
  const scanner = `scanner-${actor.userId}`;
  const first = await connectByQr(tencent, actor, scanner);
  const detached = await disconnect(tencent, actor);
  return { scanner, first, detached };
}

async function receiveReconnectLink(
  tencent: Tencent,
  scanner: string,
  detached: ReceiverStart,
): Promise<string> {
  await deliver(detached, [ownerMessage(scanner, `message-${randomUUID()}`)]);
  const notice = tencent.sent.at(-1);
  if (!notice) {
    throw new Error("No reconnect notice sent");
  }
  return reconnectToken(notice.text);
}

describe("WeChat QR owner binding", () => {
  it("integrations-wechat-027 refuses to start a QR when the WeChat switch is off", async () => {
    const tencent = installWechat();
    const member = await newMember({ wechat: false });

    await accept(wechatApi().connect({ headers: signIn(member) }), [403]);
    expect(tencent.qrRequests).toBe(0);
  });

  it("integrations-wechat-023 handles verification and publishes only a sanitized connection status", async () => {
    const tencent = installWechat();
    const member = await newMember();
    const scanner = `scanner-${member.userId}`;

    const attempt = await accept(
      wechatApi().connect({ headers: signIn(member) }),
      [200],
    );
    expect(attempt.body.qrContent).toBe("https://weixin.qq.com/test-qr");
    expect(JSON.stringify(attempt.body)).not.toContain("private-bot-token");

    tencent.qrStatus = (verifyCode) => {
      return verifyCode === "123456"
        ? confirmed(scanner)
        : { status: "need_verifycode" };
    };
    await expect(poll(member, attempt.body.id)).resolves.toMatchObject({
      body: { status: "verification_required" },
    });
    await expect(
      poll(member, attempt.body.id, "123456"),
    ).resolves.toMatchObject({ body: { status: "connected" } });
    await flushWaitUntilForTest();
    expect(tencent.verifyCodes).toStrictEqual([null, "123456"]);
    expect(tencent.starts).toHaveLength(1);

    await expect(status(member)).resolves.toStrictEqual({
      status: "active",
      configured: true,
      binding: {
        workspace: { id: member.orgId, name: WORKSPACE_NAME },
        accountId: scanner,
      },
    });

    await accept(
      wechatApi().disconnect({ headers: signIn(member), body: undefined }),
      [204],
    );
    await expect(status(member)).resolves.toMatchObject({
      status: "disconnected",
    });
  });

  it("integrations-wechat-024 a replacement attempt makes an older QR unable to bind", async () => {
    const tencent = installWechat();
    const member = await newMember();
    tencent.qrStatus = () => {
      return confirmed(`scanner-${member.userId}`);
    };

    const first = await startAttempt(member);
    const second = await startAttempt(member);

    await expect(poll(member, first)).resolves.toMatchObject({
      body: { status: "expired" },
    });
    expect(tencent.starts).toHaveLength(0);
    await expect(poll(member, second)).resolves.toMatchObject({
      body: { status: "connected" },
    });
    await flushWaitUntilForTest();
  });

  it("integrations-wechat-025 cancellation prevents late confirmation and does not start a receiver", async () => {
    const tencent = installWechat();
    const member = await newMember();

    const id = await startAttempt(member);
    await accept(
      wechatApi().cancel({ headers: signIn(member), body: { id } }),
      [204],
    );
    tencent.qrStatus = () => {
      return confirmed(`scanner-${member.userId}`);
    };

    await expect(poll(member, id)).resolves.toMatchObject({
      body: { status: "expired" },
    });
    expect(tencent.starts).toHaveLength(0);
  });

  it("integrations-wechat-026 another owner cannot poll or cancel the original owner's QR", async () => {
    const tencent = installWechat();
    const owner = await newMember();
    const other = await newMember({ orgId: owner.orgId });
    const id = await startAttempt(owner);

    await expect(poll(other, id)).resolves.toMatchObject({
      body: { status: "expired" },
    });
    await accept(
      wechatApi().cancel({ headers: signIn(other), body: { id } }),
      [204],
    );

    tencent.qrStatus = () => {
      return confirmed(`scanner-${owner.userId}`);
    };
    await expect(poll(owner, id)).resolves.toMatchObject({
      body: { status: "connected" },
    });
    await flushWaitUntilForTest();
    expect(tencent.starts).toHaveLength(1);
  });

  it("integrations-wechat-029 does not replace the existing owner when the same scanner connects elsewhere", async () => {
    const tencent = installWechat();
    const first = await newMember();
    const scanner = `scanner-${first.userId}`;
    await connectByQr(tencent, first, scanner);
    const startsBefore = tencent.starts.length;
    const second = await newMember();

    const id = await startAttempt(second);
    tencent.qrStatus = () => {
      return confirmed(scanner);
    };
    const polled = await poll(second, id);

    expect(polled.status).toBe(409);
    expect(tencent.starts).toHaveLength(startsBefore);
    await expect(status(second)).resolves.toMatchObject({
      status: "disconnected",
    });
  });

  it("integrations-wechat-030 stops authenticated receiver requests for missing bindings and rejects forged requests", async () => {
    installWechat();
    const body = { connectionId: randomUUID() };

    const valid = await bootstrap(body.connectionId);
    expect(valid).toStrictEqual({ active: false });

    await accept(
      receiverApi().bootstrap({
        headers: {
          ...gatewayHeaders(body),
          "x-wechat-signature": "0".repeat(64),
        },
        body,
      }),
      [401],
    );
  });
});

test("integrations-wechat-033 native WeChat commands isolate users and workspaces and honor live revocation", async () => {
  const tencent = installWechat();
  const owner = await newMember();
  const receiver = await connectByQr(tencent, owner, `scanner-${owner.userId}`);
  const colleague = await newMember({ orgId: owner.orgId });
  const ownerElsewhere = { userId: owner.userId, orgId: `org_${randomUUID()}` };
  await joinWorkspace(ownerElsewhere);
  await updateFeatureSwitchesForUser(context, ownerElsewhere, {
    [FeatureSwitchKey.WechatIntegration]: true,
  });

  await expectNoNativeAccess(colleague, receiver.connectionId);
  await expectNoNativeAccess(ownerElsewhere, receiver.connectionId);

  const query = { channelId: receiver.connectionId };
  await updateFeatureSwitchesForUser(context, owner, {
    [FeatureSwitchKey.WechatIntegration]: false,
  });
  await expect(
    accept(messagesApi().history({ headers: signIn(owner), query }), [403]),
  ).resolves.toMatchObject({ status: 403 });
  await updateFeatureSwitchesForUser(context, owner, {
    [FeatureSwitchKey.WechatIntegration]: true,
  });
  await directory.set(deleteOrgMembership$, owner, context.signal);
  await expect(
    accept(messagesApi().history({ headers: signIn(owner), query }), [403]),
  ).resolves.toMatchObject({ status: 403 });
});

describe("WeChat system notices", () => {
  it("integrations-wechat-034 keeps only reconnect replies after disconnect, deduplicates retries and revokes native access", async () => {
    const tencent = installWechat();
    const member = await newMember();
    const { scanner, first, detached } = await connectedThenDisconnected(
      tencent,
      member,
    );
    const sentBefore = tencent.sent.length;
    const message = ownerMessage(scanner, "owner-message-1");

    await expect(deliver(detached, [message])).resolves.toStrictEqual({
      active: true,
    });
    expect(tencent.sent).toHaveLength(sentBefore + 1);
    const reply = tencent.sent.at(-1);
    expect(reply?.to).toBe(scanner);
    expect(reply?.contextToken).toBe("context-owner-message-1");
    expect(reply?.text).toContain(
      "https://app.okou.test/settings/wechat?token=",
    );
    expect(reply?.text).not.toContain("A private incoming message");

    await disconnect(tencent, member);
    await deliver(detached, [message]);
    expect(tencent.sent).toHaveLength(sentBefore + 1);
    await deliver(detached, [ownerMessage(scanner, "owner-message-2")]);
    expect(tencent.sent).toHaveLength(sentBefore + 2);

    await expectNoNativeAccess(member, first.connectionId);
    expect(tencent.sent).toHaveLength(sentBefore + 2);

    const renewed = await connectByQr(tencent, member, scanner);
    expect(renewed.connectionId).not.toBe(first.connectionId);
    await expect(bootstrap(first.connectionId)).resolves.toStrictEqual({
      active: false,
    });
    const history = await accept(
      messagesApi().history({
        headers: signIn(member),
        query: { channelId: renewed.connectionId },
      }),
      [200],
    );
    expect(history.body.messages).toHaveLength(1);
    expect(history.body.messages[0]).toMatchObject({ direction: "outbound" });
    expect(history.body.messages[0]?.content).toContain("You're connected");
  });

  it("integrations-wechat-038 allows a verified scanner to move to a new owner only after disconnect", async () => {
    const tencent = installWechat();
    const first = await newMember();
    const { scanner, first: old } = await connectedThenDisconnected(
      tencent,
      first,
    );
    const startsBefore = tencent.starts.length;
    const second = await newMember();

    const id = await startAttempt(second);
    tencent.qrStatus = () => {
      return confirmed(scanner);
    };
    const polled = await poll(second, id);
    await flushWaitUntilForTest();

    expect(polled.status).toBe(200);
    expect(tencent.starts).toHaveLength(startsBefore + 1);
    expect(tencent.starts.at(-1)?.connectionId).not.toBe(old.connectionId);
    await expect(bootstrap(old.connectionId)).resolves.toStrictEqual({
      active: false,
    });
  });

  it("integrations-wechat-040 can bind a different scanner after disconnect", async () => {
    const tencent = installWechat();
    const member = await newMember();
    const { first } = await connectedThenDisconnected(tencent, member);

    const id = await startAttempt(member);
    tencent.qrStatus = () => {
      return confirmed(`other-scanner-${member.userId}`);
    };
    const polled = await poll(member, id);
    await flushWaitUntilForTest();

    expect(polled.status).toBe(200);
    expect(tencent.starts.at(-1)?.connectionId).not.toBe(first.connectionId);
    await expect(bootstrap(first.connectionId)).resolves.toStrictEqual({
      active: false,
    });
  });

  it("integrations-wechat-041 stops the detached receiver when membership is revoked or Tencent expires the session", async () => {
    const tencent = installWechat();
    const member = await newMember();
    const { detached } = await connectedThenDisconnected(tencent, member);

    await updateFeatureSwitchesForUser(context, member, {
      [FeatureSwitchKey.WechatIntegration]: false,
    });
    await expect(bootstrap(detached.connectionId)).resolves.toStrictEqual({
      active: false,
    });
    await updateFeatureSwitchesForUser(context, member, {
      [FeatureSwitchKey.WechatIntegration]: true,
    });
    await directory.set(deleteOrgMembership$, member, context.signal);
    await expect(bootstrap(detached.connectionId)).resolves.toStrictEqual({
      active: false,
    });
    await joinWorkspace(member);

    const session = await bootstrap(detached.connectionId);
    if (!session.active) {
      throw new Error("Restored receiver was not active");
    }
    const expired = {
      connectionId: detached.connectionId,
      generation: session.generation,
    };
    await expect(
      accept(
        receiverApi().expire({
          headers: gatewayHeaders(expired),
          body: expired,
        }),
        [200],
      ),
    ).resolves.toMatchObject({ body: { active: false } });
    await expect(bootstrap(detached.connectionId)).resolves.toStrictEqual({
      active: false,
    });
    await expect(status(member)).resolves.toMatchObject({
      status: "disconnected",
    });
  });
});

describe("WeChat reconnect links", () => {
  it("integrations-wechat-047 requires confirmation, restores without a new QR, and consumes concurrent and old links", async () => {
    const tencent = installWechat();
    const member = await newMember();
    const { scanner, first, detached } = await connectedThenDisconnected(
      tencent,
      member,
    );
    const token = await receiveReconnectLink(tencent, scanner, detached);
    const linkPayload = Buffer.from(
      token.split(".")[0] ?? "",
      "base64url",
    ).toString("utf8");
    expect(linkPayload).not.toContain("private-bot-token");
    expect(linkPayload).not.toContain("context-message-");
    expect(linkPayload).not.toContain(scanner);
    expect(tencent.sent).toHaveLength(2);
    const qrRequestsBefore = tencent.qrRequests;

    await expect(
      accept(
        wechatApi().reconnectStatus({
          headers: signIn(member),
          query: { token },
        }),
        [200],
      ),
    ).resolves.toMatchObject({ body: { available: true } });
    await expect(status(member)).resolves.toMatchObject({
      status: "disconnected",
    });

    const startsBefore = tencent.starts.length;
    const headers = signIn(member);
    const results = await Promise.all([
      accept(wechatApi().reconnect({ headers, body: { token } }), [204, 409]),
      accept(wechatApi().reconnect({ headers, body: { token } }), [204, 409]),
    ]);
    await flushWaitUntilForTest();
    expect(
      results
        .map((result) => {
          return result.status;
        })
        .sort(),
    ).toStrictEqual([204, 409]);
    expect(tencent.qrRequests).toBe(qrRequestsBefore);
    expect(tencent.starts).toHaveLength(startsBefore + 1);
    expect(tencent.starts.at(-1)?.connectionId).toBe(first.connectionId);
    await expect(status(member)).resolves.toMatchObject({ status: "active" });
    expect(tencent.sent).toHaveLength(3);
    expect(tencent.sent[2]?.text).toContain("You're connected");
    expect(tencent.sent[2]?.contextToken).toBeUndefined();

    await disconnect(tencent, member);
    await expect(
      accept(
        wechatApi().reconnectStatus({
          headers: signIn(member),
          query: { token },
        }),
        [200],
      ),
    ).resolves.toMatchObject({ body: { available: false } });
    await accept(
      wechatApi().reconnect({ headers: signIn(member), body: { token } }),
      [409],
    );
  });

  it("integrations-wechat-048 rejects a different owner or workspace without exposing the binding", async () => {
    const tencent = installWechat();
    const member = await newMember();
    const { scanner, detached } = await connectedThenDisconnected(
      tencent,
      member,
    );
    const token = await receiveReconnectLink(tencent, scanner, detached);
    const other = await newMember();
    const sameUserElsewhere = { userId: member.userId, orgId: other.orgId };
    await joinWorkspace(sameUserElsewhere);
    await updateFeatureSwitchesForUser(context, sameUserElsewhere, {
      [FeatureSwitchKey.WechatIntegration]: true,
    });

    for (const actor of [other, sameUserElsewhere]) {
      await expect(
        accept(
          wechatApi().reconnectStatus({
            headers: signIn(actor),
            query: { token },
          }),
          [200],
        ),
      ).resolves.toMatchObject({ body: { available: false } });
      await accept(
        wechatApi().reconnect({ headers: signIn(actor), body: { token } }),
        [409],
      );
    }
  });

  it("integrations-wechat-049 rejects forged and expired links and accepts a newly issued link", async () => {
    const tencent = installWechat();
    const member = await newMember();
    const { scanner, detached } = await connectedThenDisconnected(
      tencent,
      member,
    );
    const token = await receiveReconnectLink(tencent, scanner, detached);
    const [payload, signature] = token.split(".");
    const tampered = `${payload}x.${signature}`;

    await expect(
      accept(
        wechatApi().reconnectStatus({
          headers: signIn(member),
          query: { token: tampered },
        }),
        [200],
      ),
    ).resolves.toMatchObject({ body: { available: false } });
    await accept(
      wechatApi().reconnect({
        headers: signIn(member),
        body: { token: tampered },
      }),
      [409],
    );

    mockNow(now() + 10 * 60_000);
    await expect(
      accept(
        wechatApi().reconnectStatus({
          headers: signIn(member),
          query: { token },
        }),
        [200],
      ),
    ).resolves.toMatchObject({ body: { available: false } });
    await accept(
      wechatApi().reconnect({ headers: signIn(member), body: { token } }),
      [409],
    );

    const fresh = await receiveReconnectLink(tencent, scanner, detached);
    await accept(
      wechatApi().reconnect({
        headers: signIn(member),
        body: { token: fresh },
      }),
      [204],
    );
    await flushWaitUntilForTest();
  });
});

describe("WeChat Workflow receiver", () => {
  it("integrations-wechat-053 bootstraps a receiver and renews without exposing credentials again", async () => {
    const tencent = installWechat();
    const member = await newMember();
    const scanner = `scanner-${member.userId}`;
    const receiver = await connectByQr(tencent, member, scanner);
    const body = { connectionId: receiver.connectionId };

    await accept(
      receiverApi().bootstrap({
        headers: {
          ...gatewayHeaders(body),
          "x-wechat-signature": "f".repeat(64),
        },
        body,
      }),
      [401],
    );

    const session = await bootstrap(receiver.connectionId);
    if (!session.active) {
      throw new Error("Receiver bootstrap was not active");
    }
    expect(session.session).toMatchObject({
      token: `private-bot-token-${scanner}`,
      cursor: "",
    });

    await expect(
      bootstrap(receiver.connectionId, session.generation),
    ).resolves.toStrictEqual({ active: true, generation: session.generation });
    await expect(status(member)).resolves.toStrictEqual({
      configured: true,
      status: "active",
      binding: {
        workspace: { id: member.orgId, name: WORKSPACE_NAME },
        accountId: scanner,
      },
    });
  });
});
