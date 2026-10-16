import { integrationsWechatMessagesContract } from "@okouai/api-contracts/contracts/integrations-wechat-messages";
import {
  integrationsWechatUploadInitContract,
  integrationsWechatUploadMaterializeContract,
  integrationsWechatUploadCompleteContract,
  integrationsWechatDownloadFileContract,
} from "@okouai/api-contracts/contracts/integrations-wechat-files";
import { integrationsWechatMessagesRoutes } from "../integrations-wechat-messages";
import { integrationsWechatFileRoutes } from "../integrations-wechat-files";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { sanitizeArtifactFilename } from "../../../lib/file-url";
import type { WechatMessage } from "../../external/wechat-client";
import {
  createHmac,
  createHash,
  createCipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { describe, expect, it, test, onTestFinished } from "vitest";
import { http, HttpResponse } from "msw";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  integrationsWechatContract as contract,
  wechatGatewayContract,
} from "@okouai/api-contracts/contracts/integrations-wechat";
import { testContext, accept } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { integrationsWechatRoutes } from "../integrations-wechat";
import { wechatGatewayRoutes } from "../wechat-gateway";
import { createRouteMocks } from "./helpers/route-test";
import {
  updateFeatureSwitchesForUser,
  deleteFeatureSwitchesForUser,
} from "./helpers/feature-switches";
import { mockSecretKmsHttp } from "./helpers/secret-kms-http";
import { z } from "zod";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { readProjectedChatEvents } from "./helpers/chat-event-test-reader";
import { createDeferredPromise } from "../../utils";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { flushWaitUntilForTest } from "../../context/wait-until";
const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const origin = "https://ilinkai.weixin.qq.com";
const secret = randomBytes(32).toString("hex");
const client = () => {
  return setupApp({ context, routes: integrationsWechatRoutes })(contract);
};
async function fixture() {
  mockSecretKmsHttp();
  mockEnv("WECHAT_GATEWAY_URL", "https://wechat-receiver.test");
  mockEnv("WECHAT_GATEWAY_SECRET", secret);
  mockEnv("WECHAT_GATEWAY_CONTROL_SECRET", "control-test-secret");
  const actor = {
    userId: `user_wechat_${randomUUID()}`,
    orgId: `org_wechat_${randomUUID()}`,
    orgRole: "org:admin" as const,
    email: "wechat@example.test",
  };
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: [
        {
          id: "membership",
          role: "org:admin",
          publicUserData: { userId: actor.userId },
          organization: { id: actor.orgId, name: "WeChat test" },
        },
      ],
      totalCount: 1,
    },
  );
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    "org:admin",
  );
  await updateFeatureSwitchesForUser(context, actor, {
    [FeatureSwitchKey.WechatIntegration]: true,
  });
  const provider = {
    status: { status: "wait" } as Record<string, unknown>,
    starts: [] as string[],
    verificationCodes: [] as (string | null)[],
  };
  server.use(
    http.post(`${origin}/ilink/bot/get_bot_qrcode`, async ({ request }) => {
      await expect(request.json()).resolves.toStrictEqual({
        local_token_list: [],
      });
      return HttpResponse.json({
        qrcode: randomUUID(),
        qrcode_img_content: "https://weixin.qq.com/test-qr",
      });
    }),
    http.get(`${origin}/ilink/bot/get_qrcode_status`, ({ request }) => {
      provider.verificationCodes.push(
        new URL(request.url).searchParams.get("verify_code"),
      );
      return HttpResponse.json(provider.status);
    }),
    http.post("https://wechat-receiver.test/start", async ({ request }) => {
      const body = z
        .object({ connectionId: z.uuid() })
        .parse(await request.json());
      provider.starts.push(body.connectionId);
      return HttpResponse.json({ ok: true });
    }),
  );
  onTestFinished(async () => {
    createRouteMocks(context).clerk.session(
      actor.userId,
      actor.orgId,
      "org:admin",
    );
    await accept(client().disconnect({ headers }), [204]);
    await deleteFeatureSwitchesForUser(context, actor);
  });
  const confirm = () => {
    provider.status = {
      status: "confirmed",
      bot_token: "test-private-bot-token",
      ilink_bot_id: "test-bot",
      ilink_user_id: `scanner-${actor.userId}`,
      baseurl: origin,
    };
  };
  return { actor, provider, confirm };
}
describe("WeChat QR owner binding", () => {
  it("handles verification and publishes only a sanitized connection status", async () => {
    const { provider, confirm } = await fixture();
    const attempt = await accept(client().connect({ headers }), [200]);
    expect(attempt.body).toMatchObject({
      qrContent: "https://weixin.qq.com/test-qr",
    });
    provider.status = { status: "need_verifycode" };
    expect(
      (
        await accept(
          client().poll({ headers, body: { id: attempt.body.id } }),
          [200],
        )
      ).body.status,
    ).toBe("verification_required");
    confirm();
    expect(
      (
        await accept(
          client().poll({
            headers,
            body: { id: attempt.body.id, verifyCode: "123456" },
          }),
          [200],
        )
      ).body.status,
    ).toBe("connected");
    expect(provider.verificationCodes).toStrictEqual([null, "123456"]);
    expect(provider.starts).toHaveLength(1);
    expect(
      (await accept(client().status({ headers }), [200])).body,
    ).toStrictEqual({
      status: "active",
      configured: true,
    });
    expect(JSON.stringify(attempt.body)).not.toContain(
      "test-private-bot-token",
    );
    await accept(client().disconnect({ headers }), [204]);
    expect(
      (await accept(client().status({ headers }), [200])).body.status,
    ).toBe("disconnected");
  });
  it("a replacement attempt makes an older QR unable to bind", async () => {
    const { confirm, provider } = await fixture();
    const first = await accept(client().connect({ headers }), [200]);
    const second = await accept(client().connect({ headers }), [200]);
    confirm();
    expect(
      (
        await accept(
          client().poll({ headers, body: { id: first.body.id } }),
          [200],
        )
      ).body.status,
    ).toBe("expired");
    expect(provider.starts).toHaveLength(0);
    expect(
      (
        await accept(
          client().poll({ headers, body: { id: second.body.id } }),
          [200],
        )
      ).body.status,
    ).toBe("connected");
  });
  it("cancellation prevents late confirmation and does not start a receiver", async () => {
    const { confirm, provider } = await fixture();
    const attempt = await accept(client().connect({ headers }), [200]);
    await accept(
      client().cancel({ headers, body: { id: attempt.body.id } }),
      [204],
    );
    confirm();
    expect(
      (
        await accept(
          client().poll({ headers, body: { id: attempt.body.id } }),
          [200],
        )
      ).body.status,
    ).toBe("expired");
    expect(provider.starts).toHaveLength(0);
  });
  it("another owner cannot poll or cancel the original owner's QR", async () => {
    const { actor, confirm, provider } = await fixture();
    const attempt = await accept(client().connect({ headers }), [200]);
    const other = {
      userId: `user_other_${randomUUID()}`,
      orgId: actor.orgId,
      orgRole: "org:admin" as const,
    };
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            publicUserData: { userId: other.userId },
            role: "org:admin",
            organization: { id: actor.orgId },
          },
        ],
        totalCount: 1,
      },
    );
    await updateFeatureSwitchesForUser(context, other, {
      [FeatureSwitchKey.WechatIntegration]: true,
    });
    expect(
      (
        await accept(
          client().poll({ headers, body: { id: attempt.body.id } }),
          [200],
        )
      ).body.status,
    ).toBe("expired");
    await accept(
      client().cancel({ headers, body: { id: attempt.body.id } }),
      [204],
    );
    await deleteFeatureSwitchesForUser(context, other);
    createRouteMocks(context).clerk.session(
      actor.userId,
      actor.orgId,
      "org:admin",
    );
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            publicUserData: { userId: actor.userId },
            role: "org:admin",
            organization: { id: actor.orgId },
          },
        ],
        totalCount: 1,
      },
    );
    confirm();
    expect(
      (
        await accept(
          client().poll({ headers, body: { id: attempt.body.id } }),
          [200],
        )
      ).body.status,
    ).toBe("connected");
    expect(provider.starts).toHaveLength(1);
  });
  it("does not contact WeChat when the feature is disabled", async () => {
    const { actor } = await fixture();
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.WechatIntegration]: false,
    });
    const response = await accept(client().connect({ headers }), [403]);
    expect(response.status).toBe(403);
  });
  it("cannot publish a confirmation after cancellation while Tencent is responding", async () => {
    const { confirm, provider } = await fixture();
    const attempt = await accept(client().connect({ headers }), [200]);
    confirm();
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    server.use(
      http.get(`${origin}/ilink/bot/get_qrcode_status`, async () => {
        entered.resolve();
        await release.promise;
        return HttpResponse.json(provider.status);
      }),
    );
    const pending = client().poll({ headers, body: { id: attempt.body.id } });
    await entered.promise;
    await accept(
      client().cancel({ headers, body: { id: attempt.body.id } }),
      [204],
    );
    release.resolve();
    await accept(pending, [409]);
    expect(provider.starts).toHaveLength(0);
    expect(
      (await accept(client().status({ headers }), [200])).body.status,
    ).toBe("disconnected");
  });
  it("does not replace the existing owner when the same scanner connects elsewhere", async () => {
    const first = await fixture();
    const firstAttempt = await accept(client().connect({ headers }), [200]);
    first.confirm();
    await accept(
      client().poll({ headers, body: { id: firstAttempt.body.id } }),
      [200],
    );
    const second = await fixture();
    const secondAttempt = await accept(client().connect({ headers }), [200]);
    second.confirm();
    second.provider.status.ilink_user_id = first.provider.status.ilink_user_id;
    await accept(
      client().poll({ headers, body: { id: secondAttempt.body.id } }),
      [409],
    );
    expect(second.provider.starts).toHaveLength(0);
    expect(
      (await accept(client().status({ headers }), [200])).body.status,
    ).toBe("disconnected");
  });
  it("stops authenticated receiver requests for disconnected bindings and rejects forged requests", async () => {
    await fixture();
    const body = { connectionId: randomUUID() };
    const timestamp = String(Math.floor(now() / 1000));
    const sig = createHmac("sha256", secret)
      .update(`${timestamp}.${JSON.stringify(body)}`)
      .digest("hex");
    const gateway = setupApp({ context, routes: wechatGatewayRoutes })(
      wechatGatewayContract,
    );
    expect(
      (
        await accept(
          gateway.poll({
            body,
            headers: {
              "x-wechat-timestamp": timestamp,
              "x-wechat-signature": sig,
            },
          }),
          [200],
        )
      ).body,
    ).toStrictEqual({ active: false });
    await accept(
      gateway.poll({
        body,
        headers: {
          "x-wechat-timestamp": timestamp,
          "x-wechat-signature": "0".repeat(64),
        },
      }),
      [401],
    );
  });
});

test("receives an owner DM once, resumes its native session and delivers the canonical reply", async () => {
  const { actor, provider, confirm } = await fixture();
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  context.mocks.ably.publish.mockResolvedValue(undefined);
  const runnerGroup = runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensurePersonalSubscriptionModel(actor);
  await runs.updateUserModelPreference(actor, "claude-fable-5-1");
  await bdd.readOnboardingStatus(actor);
  const attempt = await accept(client().connect({ headers }), [200]);
  confirm();
  await accept(
    client().poll({ headers, body: { id: attempt.body.id } }),
    [200],
  );
  const connectionId = z.uuid().parse(provider.starts[0]);
  const sends: unknown[] = [];
  const delivered = createDeferredPromise<void>(context.signal);
  let extraItems: NonNullable<WechatMessage["item_list"]> = [];
  let messageId = "18446744073709551615";
  let messageText = `Remember that the project is called Orchid\n${"project detail ".repeat(100)}\nKeep the complete context`;
  let senderId = `scanner-${actor.userId}`;
  server.use(
    http.post(`${origin}/ilink/bot/getupdates`, () => {
      // Keep the uint64 literal exactly as Tencent sends it.
      const payload = JSON.stringify({
        get_updates_buf: "cursor-after-batch",
        msgs: [
          {
            message_id: "ID_PLACEHOLDER",
            from_user_id: senderId,
            to_user_id: "test-bot",
            message_type: 1,
            context_token: "private-reply-context",
            item_list: [
              {
                type: 1,
                text_item: { text: messageText },
                ref_msg: {
                  title: "Earlier quote",
                  message_item: {
                    type: 1,
                    text_item: { text: "Quoted project details" },
                  },
                },
              },
              ...extraItems,
            ],
          },
        ],
      }).replace('"ID_PLACEHOLDER"', messageId);
      return new HttpResponse(payload, {
        headers: { "content-type": "application/json" },
      });
    }),
    http.post(`${origin}/ilink/bot/sendmessage`, async ({ request }) => {
      expect(request.headers.get("authorization")).toBe(
        "Bearer test-private-bot-token",
      );
      sends.push(await request.json());
      delivered.resolve();
      return HttpResponse.json({ ret: 0 });
    }),
  );
  async function receive() {
    const body = { connectionId };
    const timestamp = String(Math.floor(now() / 1000));
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${JSON.stringify(body)}`)
      .digest("hex");
    return await accept(
      setupApp({ context, routes: wechatGatewayRoutes })(
        wechatGatewayContract,
      ).poll({
        body,
        headers: {
          "x-wechat-timestamp": timestamp,
          "x-wechat-signature": signature,
        },
      }),
      [200],
    );
  }
  async function claim() {
    let runId: string | undefined;
    await expect
      .poll(
        async () => {
          await runs.heartbeatRunner(runnerGroup);
          const poll = await runs.pollRunner(runnerGroup);
          runId = poll.body.job?.runId;
          return runId;
        },
        { timeout: 10_000 },
      )
      .toBeDefined();
    return await runs.claimRunnerJob(z.uuid().parse(runId));
  }
  await receive();

  const first = await claim();

  expect(first.prompt).toContain(messageText);
  expect(first.appendSystemPrompt).toContain(
    "You are currently running inside: WeChat",
  );
  expect(first.appendSystemPrompt).toContain("Quoted project details");
  expect(first.appendSystemPrompt).toContain("okou wechat message history");
  expect(first.appendSystemPrompt).toContain(`Channel ID: ${connectionId}`);
  expect(first.appendSystemPrompt).toContain(messageId);
  expect(JSON.stringify(first)).not.toContain("private-reply-context");
  expect(JSON.stringify(first)).not.toContain("test-private-bot-token");
  const threadId = first.platformEnvironment.OKOU_CHAT_THREAD_ID;
  if (!threadId) {
    throw new Error("Expected native chat thread identity");
  }
  await receive();
  senderId = "another-wechat-user";
  messageId = "18446744073709551614";
  await receive();
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  const events = await readProjectedChatEvents(context, { threadId, headers });
  expect(
    events.filter((event) => {
      return event.eventType === "input.prompt" && event.runId === first.runId;
    }),
  ).toHaveLength(1);
  expect(
    events.filter((event) => {
      return event.eventType === "input.prompt" && event.runId === undefined;
    }),
  ).toHaveLength(1);
  expect(JSON.stringify(events)).not.toContain("private-reply-context");
  senderId = `scanner-${actor.userId}`;
  messageId = "18446744073709551613";
  messageText = "Also remember that the deadline is Friday";
  await receive();
  const { input: activeInput } = await runs.nextSteerableInput(
    first.sandboxToken,
    first.runId,
  );
  if (!activeInput) {
    throw new Error("Expected a WeChat active input");
  }
  expect(activeInput.prompt).toContain(messageText);
  expect(activeInput.prompt).toContain("Quoted project details");
  expect(activeInput.prompt).not.toContain("private-reply-context");
  await runs.declareSteeredInput(
    first.sandboxToken,
    first.runId,
    activeInput.eventId,
  );

  const webhooks = createWebhookCallbackApi(context);
  const callbackHeaders = { authorization: `Bearer ${first.sandboxToken}` };
  await webhooks.requestAgentEvents(
    {
      runId: first.runId,
      events: [
        {
          type: "result",
          sequenceNumber: 0,
          result: "I will remember Orchid.",
        },
      ],
    },
    callbackHeaders,
    [200],
  );
  await webhooks.requestAgentComplete(
    {
      runId: first.runId,
      exitCode: 0,
      completion: {
        cliAgentType: "claude-code",
        cliAgentSessionId: "wechat-native-session",
        cliAgentSessionHistoryDisposition: "native_only",
      },
      lastEventSequence: 0,
    },
    callbackHeaders,
    [200],
  );

  await delivered.promise;

  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({
    msg: {
      to_user_id: `scanner-${actor.userId}`,
      context_token: "private-reply-context",
      item_list: [{ type: 1, text_item: { text: "I will remember Orchid." } }],
    },
  });
  const messages = setupApp({
    context,
    routes: integrationsWechatMessagesRoutes,
  })(integrationsWechatMessagesContract);
  const agentHeaders = {
    authorization: `Bearer ${z.string().parse(first.platformEnvironment.OKOU_TOKEN)}`,
  };
  const channels = await accept(
    messages.listChannels({ headers: agentHeaders }),
    [200],
  );
  expect(channels.body.channels).toStrictEqual([
    {
      id: connectionId,
      name: "Your WeChat direct conversation",
      status: "active",
    },
  ]);
  await flushWaitUntilForTest();
  const history = await accept(
    messages.history({
      headers: agentHeaders,
      query: { channelId: connectionId, limit: 1 },
    }),
    [200],
  );
  expect(history.body.messages[0]).toMatchObject({
    direction: "outbound",
    status: "sent",
    content: "I will remember Orchid.",
  });
  const older = await accept(
    messages.history({
      headers: agentHeaders,
      query: {
        channelId: connectionId,
        limit: 1,
        before: z.uuid().parse(history.body.nextBefore),
      },
    }),
    [200],
  );
  expect(older.body.messages[0]?.providerMessageId).toBe(
    "18446744073709551613",
  );
  const oldest = await accept(
    messages.history({
      headers: agentHeaders,
      query: {
        channelId: connectionId,
        limit: 1,
        before: z.uuid().parse(older.body.nextBefore),
      },
    }),
    [200],
  );
  expect(oldest.body.nextBefore).toBeNull();
  expect(oldest.body.messages[0]?.providerMessageId).toBe(
    "18446744073709551615",
  );
  expect(JSON.stringify(history.body)).not.toMatch(
    /private-reply-context|test-private-bot-token/,
  );
  await accept(
    messages.history({
      headers: agentHeaders,
      query: { channelId: randomUUID(), limit: 1 },
    }),
    [404],
  );
  await accept(
    messages.history({
      headers: agentHeaders,
      query: { channelId: connectionId, before: randomUUID(), limit: 1 },
    }),
    [404],
  );
  server.use(
    http.post(`${origin}/ilink/bot/sendmessage`, async ({ request }) => {
      sends.push(await request.json());
      return HttpResponse.json({ ret: 0 });
    }),
  );
  const operation = {
    channelId: connectionId,
    operationId: randomUUID(),
    text: "界".repeat(2100),
  };
  const sent = await accept(
    messages.sendMessage({ headers, body: operation }),
    [200],
  );
  expect(sent.body.messages).toHaveLength(2);
  const sendCount = sends.length;
  expect(
    (await accept(messages.sendMessage({ headers, body: operation }), [200]))
      .body,
  ).toStrictEqual(sent.body);
  expect(sends).toHaveLength(sendCount);
  await accept(
    messages.sendMessage({
      headers,
      body: { ...operation, text: "different content" },
    }),
    [409],
  );
  const concurrentEntered = createDeferredPromise<void>(context.signal);
  const concurrentRelease = createDeferredPromise<void>(context.signal);
  let concurrentSends = 0;
  server.use(
    http.post(`${origin}/ilink/bot/sendmessage`, async () => {
      concurrentSends++;
      concurrentEntered.resolve();
      await concurrentRelease.promise;
      return HttpResponse.json({ ret: 0 });
    }),
  );
  const concurrentOperation = {
    channelId: connectionId,
    operationId: randomUUID(),
    text: "Only once",
  };
  const pendingSend = messages.sendMessage({
    headers,
    body: concurrentOperation,
  });
  await concurrentEntered.promise;
  await accept(
    messages.sendMessage({ headers, body: concurrentOperation }),
    [409],
  );
  concurrentRelease.resolve();
  await accept(pendingSend, [200]);
  expect(concurrentSends).toBe(1);
  let failedAttemptCount = 0;
  server.use(
    http.post(`${origin}/ilink/bot/sendmessage`, () => {
      failedAttemptCount++;
      return failedAttemptCount === 1
        ? HttpResponse.json({ ret: 0 })
        : new HttpResponse(null, { status: 503 });
    }),
  );
  const partialOperation = {
    channelId: connectionId,
    operationId: randomUUID(),
    text: "z".repeat(2100),
  };
  const partial = await accept(
    messages.sendMessage({ headers, body: partialOperation }),
    [502],
  );
  expect(partial.body.error.deliveredMessages).toHaveLength(1);
  expect(partial.body.error.uncertainMessageId).toBeDefined();
  const retry = await accept(
    messages.sendMessage({ headers, body: partialOperation }),
    [409],
  );
  expect(retry.body.error.deliveredMessages).toStrictEqual(
    partial.body.error.deliveredMessages,
  );
  expect(failedAttemptCount).toBe(2);
  const uncertain = await accept(
    messages.history({
      headers: agentHeaders,
      query: { channelId: connectionId, limit: 1 },
    }),
    [200],
  );
  expect(uncertain.body.messages[0]).toMatchObject({
    status: "unknown",
    id: partial.body.error.uncertainMessageId,
  });
  server.use(
    http.post(`${origin}/ilink/bot/sendmessage`, async ({ request }) => {
      sends.push(await request.json());
      return HttpResponse.json({ ret: 0 });
    }),
  );
  const attachmentBytes = Buffer.from("a,b\n1,2\n");
  const attachmentKey = randomBytes(16);
  const attachmentCipher = createCipheriv("aes-128-ecb", attachmentKey, null);
  const encryptedAttachment = Buffer.concat([
    attachmentCipher.update(attachmentBytes),
    attachmentCipher.final(),
  ]);
  extraItems = [
    {
      type: 4,
      file_item: {
        file_name: "report.csv",
        len: String(attachmentBytes.length),
        media: {
          encrypt_query_param: "private-media-query",
          aes_key: attachmentKey.toString("base64"),
          encrypt_type: 1,
        },
      },
    },
  ];
  server.use(
    http.get("https://novac2c.cdn.weixin.qq.com/c2c/download", () => {
      return new HttpResponse(new Uint8Array(encryptedAttachment));
    }),
  );
  senderId = `scanner-${actor.userId}`;
  messageId = "18446744073709551612";
  messageText = "What is the project called?";
  await receive();

  const second = await claim();

  expect(second.platformEnvironment.OKOU_CHAT_THREAD_ID).toBe(threadId);
  expect(second.nativeContinuation?.sessionId).toBe("wechat-native-session");
  expect(second.prompt).toContain(messageText);
  expect(second.prompt).toContain("report.csv");
  expect(second.prompt).toContain("[Web file] report.csv (text/csv)");
  expect(second.appendSystemPrompt).toContain("I will remember Orchid.");
  expect(second.appendSystemPrompt).toContain("# WeChat Thread Context");
  expect(second.appendSystemPrompt).toContain("- RELATIVE_INDEX: -1");
  expect(second.appendSystemPrompt).toContain(
    `- SENDER: {id: scanner-${actor.userId}}`,
  );
  expect(second.appendSystemPrompt).toContain(
    "- SENDER: {id: test-bot, name: Okou}",
  );
  expect(second.appendSystemPrompt).toContain("Keep the complete context");
  const fileEvents = await readProjectedChatEvents(context, {
    threadId,
    headers,
  });
  const fileInput = fileEvents.find((event) => {
    return event.eventType === "input.prompt" && event.runId === second.runId;
  });
  expect(fileInput).toMatchObject({
    userMessage: {
      parts: expect.arrayContaining([
        expect.objectContaining({
          type: "file",
          filenameSnapshot: "report.csv",
          contentType: "text/csv",
        }),
      ]),
    },
  });
  expect(
    context.mocks.s3.send.mock.calls.some(([request]) => {
      return (
        request instanceof PutObjectCommand &&
        request.input.ContentType === "text/csv" &&
        Buffer.isBuffer(request.input.Body) &&
        request.input.Body.equals(attachmentBytes)
      );
    }),
  ).toBeTruthy();
  const withFile = await accept(
    messages.history({
      headers: agentHeaders,
      query: { channelId: connectionId, limit: 1 },
    }),
    [200],
  );
  const incomingFile = withFile.body.messages[0];
  expect(incomingFile?.attachments).toStrictEqual([
    {
      id: "1",
      kind: "file",
      filename: "report.csv",
      size: attachmentBytes.length,
    },
  ]);
  expect(JSON.stringify(withFile.body)).not.toContain("private-media-query");
  expect(JSON.stringify(withFile.body)).not.toContain(
    attachmentKey.toString("base64"),
  );
  const fileApp = setupApp({ context, routes: integrationsWechatFileRoutes });
  const fileQuery = {
    channelId: connectionId,
    messageId: z.uuid().parse(incomingFile?.id),
    attachmentId: "1",
  };
  const downloaded = await accept(
    fileApp(integrationsWechatDownloadFileContract).download({
      headers: agentHeaders,
      query: fileQuery,
    }),
    [200],
  );
  expect(
    Buffer.from(await z.instanceof(Blob).parse(downloaded.body).arrayBuffer()),
  ).toStrictEqual(attachmentBytes);
  await accept(
    fileApp(integrationsWechatDownloadFileContract).download({
      headers: agentHeaders,
      query: { ...fileQuery, channelId: randomUUID() },
    }),
    [404],
  );
  const objectStore = createChatCallbacksApi(context).acceptChatObjectStorage();
  const fileBody = {
    filename: "report.csv",
    length: attachmentBytes.length,
    contentType: "text/csv",
    checksumSha256: createHash("sha256").update(attachmentBytes).digest("hex"),
    operationId: randomUUID(),
    channelId: connectionId,
  };
  const fileInit = fileApp(integrationsWechatUploadInitContract).init;
  const [initialized, repeatedInit] = await Promise.all([
    accept(fileInit({ headers, body: fileBody }), [200]),
    accept(fileInit({ headers, body: fileBody }), [200]),
  ]);
  expect(repeatedInit.body.assetId).toBe(initialized.body.assetId);
  expect(repeatedInit.body.url).toBe(initialized.body.url);
  await accept(
    fileInit({
      headers,
      body: { ...fileBody, comment: "Changed destination" },
    }),
    [409],
  );
  objectStore.addObject({
    bucket: "test-private-artifacts",
    key: `private-artifacts/${initialized.body.assetId}/${sanitizeArtifactFilename(fileBody.filename)}`,
    size: attachmentBytes.length,
    body: attachmentBytes,
    contentType: fileBody.contentType,
    metadata: { "artifact-id": initialized.body.assetId },
  });
  const fileOperation = {
    assetId: initialized.body.assetId,
    operationId: fileBody.operationId,
  };
  const published = await accept(
    fileApp(integrationsWechatUploadMaterializeContract).materialize({
      headers,
      body: fileOperation,
    }),
    [200],
  );
  expect(published.body.delivery.status).toBe("pending");
  let cdnUploads = 0;
  const overlappingUploads = createDeferredPromise<void>(context.signal);
  server.use(
    http.post(`${origin}/ilink/bot/getuploadurl`, () => {
      return HttpResponse.json({
        ret: 0,
        upload_param: "private-upload-query",
      });
    }),
    http.post("https://novac2c.cdn.weixin.qq.com/c2c/upload", async () => {
      cdnUploads++;
      if (cdnUploads <= 3) {
        return new HttpResponse(null, { status: 503 });
      }
      if (cdnUploads === 5) {
        overlappingUploads.resolve();
      }
      await overlappingUploads.promise;
      return new HttpResponse(null, {
        headers: { "x-encrypted-param": "private-file-query" },
      });
    }),
  );
  const sendsBeforeUpload = sends.length;
  const failedUpload = await accept(
    fileApp(integrationsWechatUploadCompleteContract).complete({
      headers,
      body: fileOperation,
    }),
    [503],
  );
  expect(failedUpload.body.error.message).toContain("before sending");
  expect(cdnUploads).toBe(3);
  expect(sends).toHaveLength(sendsBeforeUpload);
  const completions = await Promise.all([
    accept(
      fileApp(integrationsWechatUploadCompleteContract).complete({
        headers,
        body: fileOperation,
      }),
      [200],
    ),
    accept(
      fileApp(integrationsWechatUploadCompleteContract).complete({
        headers,
        body: fileOperation,
      }),
      [200],
    ),
  ]);
  const completed = completions.find((completion) => {
    return completion.body.delivery.status === "delivered";
  });
  if (!completed) {
    throw new Error("Expected a confirmed WeChat file delivery");
  }
  expect(cdnUploads).toBe(5);
  expect(sends).toHaveLength(sendsBeforeUpload + 1);
  expect(completed.body.url).toBe(published.body.url);
  const fileSendCount = sends.length;
  expect(
    (
      await accept(
        fileApp(integrationsWechatUploadCompleteContract).complete({
          headers,
          body: fileOperation,
        }),
        [200],
      )
    ).body,
  ).toStrictEqual(completed.body);
  expect(sends).toHaveLength(fileSendCount);
  const ambiguousInit = await accept(
    fileInit({
      headers,
      body: { ...fileBody, operationId: randomUUID() },
    }),
    [200],
  );
  objectStore.addObject({
    bucket: "test-private-artifacts",
    key: `private-artifacts/${ambiguousInit.body.assetId}/${sanitizeArtifactFilename(fileBody.filename)}`,
    size: attachmentBytes.length,
    body: attachmentBytes,
    contentType: fileBody.contentType,
    metadata: { "artifact-id": ambiguousInit.body.assetId },
  });
  const ambiguousOperation = {
    assetId: ambiguousInit.body.assetId,
    operationId: ambiguousInit.body.operationId,
  };
  await accept(
    fileApp(integrationsWechatUploadMaterializeContract).materialize({
      headers,
      body: ambiguousOperation,
    }),
    [200],
  );
  server.use(
    http.post(`${origin}/ilink/bot/sendmessage`, async ({ request }) => {
      sends.push(await request.json());
      return HttpResponse.error();
    }),
  );
  const ambiguous = await accept(
    fileApp(integrationsWechatUploadCompleteContract).complete({
      headers,
      body: ambiguousOperation,
    }),
    [200],
  );
  expect(ambiguous.body).toMatchObject({
    url: ambiguousInit.body.url,
    delivery: { status: "failed", retryable: false },
  });
  const afterAmbiguousSend = sends.length;
  expect(afterAmbiguousSend).toBe(fileSendCount + 1);
  const inspected = await accept(
    fileApp(integrationsWechatUploadCompleteContract).complete({
      headers,
      body: ambiguousOperation,
    }),
    [200],
  );
  expect(inspected.body).toStrictEqual(ambiguous.body);
  expect(sends).toHaveLength(afterAmbiguousSend);
  // Image-only inputs must retain both their real MIME and canonical file part.
  const imageBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+afo8AAAAASUVORK5CYII=",
    "base64",
  );
  let imageDownloads = 0;
  server.use(
    http.get("https://novac2c.cdn.weixin.qq.com/c2c/download", () => {
      imageDownloads++;
      return new HttpResponse(new Uint8Array(imageBytes));
    }),
  );
  extraItems = [
    { type: 2, image_item: { media: { encrypt_query_param: "image-query" } } },
  ];
  messageId = "18446744073709551611";
  messageText = "";
  await receive();
  await receive();
  expect(imageDownloads).toBe(1);
  const imageEvents = await readProjectedChatEvents(context, {
    threadId,
    headers,
  });
  const imageInputs = imageEvents.filter((event) => {
    return (
      event.eventType === "input.prompt" &&
      event.userMessage.parts.some((part) => {
        return part.type === "file" && part.contentType === "image/png";
      })
    );
  });
  expect(imageInputs).toHaveLength(1);
  const { input: imageInput } = await runs.nextSteerableInput(
    second.sandboxToken,
    second.runId,
  );
  expect(imageInput?.prompt).toContain("[Web file] image (image/png)");
  expect(objectStore.puts).toContainEqual(
    expect.objectContaining({ contentType: "image/png" }),
  );
  for (const unavailable of [
    { messageId: "18446744073709551609", status: 404 },
    { messageId: "18446744073709551608", status: 200 },
  ]) {
    let attempts = 0;
    server.use(
      http.get("https://novac2c.cdn.weixin.qq.com/c2c/download", () => {
        attempts++;
        return new HttpResponse("not an image", { status: unavailable.status });
      }),
    );
    messageId = unavailable.messageId;
    await receive();
    await receive();
    // Permanent failures become failed file parts instead of wedging the batch.
    expect(attempts).toBe(1);
  }
  extraItems = [];

  messageId = "18446744073709551610";
  messageText = "Do not deliver this after I disconnect";
  await receive();
  // Disconnect while a run is active; its eventual output must not use a stale binding.
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  const beforeDisconnectSendCount = sends.length;
  await accept(client().disconnect({ headers }), [204]);
  await accept(
    messages.history({
      headers: agentHeaders,
      query: { channelId: connectionId, limit: 1 },
    }),
    [404],
  );
  await expect(
    runs.nextSteerableInput(second.sandboxToken, second.runId),
  ).resolves.toStrictEqual({ input: null });
  const secondHeaders = { authorization: `Bearer ${second.sandboxToken}` };
  await webhooks.requestAgentEvents(
    {
      runId: second.runId,
      events: [{ type: "result", sequenceNumber: 0, result: "Orchid" }],
    },
    secondHeaders,
    [200],
  );
  await webhooks.requestAgentComplete(
    {
      runId: second.runId,
      exitCode: 0,
      completion: {
        cliAgentType: "claude-code",
        cliAgentSessionId: "wechat-native-session",
        cliAgentSessionHistoryDisposition: "native_only",
      },
      lastEventSequence: 0,
    },
    secondHeaders,
    [200],
  );

  await flushWaitUntilForTest();
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  await expect
    .poll(
      async () => {
        const completedEvents = await readProjectedChatEvents(context, {
          threadId,
          headers,
        });
        return completedEvents.some((event) => {
          return (
            event.runId === second.runId && event.eventType === "run.completed"
          );
        });
      },
      { timeout: 10_000 },
    )
    .toBe(true);

  expect(sends).toHaveLength(beforeDisconnectSendCount);
});

test("native WeChat commands isolate users and workspaces and honor live revocation", async () => {
  const first = await fixture();
  const attempt = await accept(client().connect({ headers }), [200]);
  first.confirm();
  await accept(
    client().poll({ headers, body: { id: attempt.body.id } }),
    [200],
  );
  const channelId = z.uuid().parse(first.provider.starts[0]);
  const messages = setupApp({
    context,
    routes: integrationsWechatMessagesRoutes,
  })(integrationsWechatMessagesContract);
  for (const other of [
    { ...first.actor, userId: `user_other_${randomUUID()}` },
    { ...first.actor, orgId: `org_other_${randomUUID()}` },
  ]) {
    await updateFeatureSwitchesForUser(context, other, {
      [FeatureSwitchKey.WechatIntegration]: true,
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            publicUserData: { userId: other.userId },
            organization: { id: other.orgId },
            role: "org:admin",
          },
        ],
        totalCount: 1,
      },
    );
    expect(
      (await accept(messages.listChannels({ headers }), [200])).body.channels,
    ).toStrictEqual([]);
    await accept(
      messages.history({ headers, query: { channelId, limit: 50 } }),
      [404],
    );
    await accept(
      messages.sendMessage({
        headers,
        body: { channelId, operationId: randomUUID(), text: "unauthorized" },
      }),
      [404],
    );
    await deleteFeatureSwitchesForUser(context, other);
  }
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: [
        {
          publicUserData: { userId: first.actor.userId },
          organization: { id: first.actor.orgId },
          role: "org:admin",
        },
      ],
      totalCount: 1,
    },
  );
  await updateFeatureSwitchesForUser(context, first.actor, {
    [FeatureSwitchKey.WechatIntegration]: false,
  });
  await accept(
    messages.history({ headers, query: { channelId, limit: 50 } }),
    [403],
  );
  await updateFeatureSwitchesForUser(context, first.actor, {
    [FeatureSwitchKey.WechatIntegration]: true,
  });
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    { data: [], totalCount: 0 },
  );
  await accept(
    messages.history({ headers, query: { channelId, limit: 50 } }),
    [403],
  );
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: [
        {
          publicUserData: { userId: first.actor.userId },
          organization: { id: first.actor.orgId },
          role: "org:admin",
        },
      ],
      totalCount: 1,
    },
  );
});
