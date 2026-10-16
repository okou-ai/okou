import { createHmac, randomBytes, randomUUID } from "node:crypto";
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
  let messageId = "18446744073709551615";
  let messageText = "Remember that the project is called Orchid";
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
  senderId = `scanner-${actor.userId}`;
  messageId = "18446744073709551612";
  messageText = "What is the project called?";
  await receive();

  const second = await claim();

  expect(second.platformEnvironment.OKOU_CHAT_THREAD_ID).toBe(threadId);
  expect(second.nativeContinuation?.sessionId).toBe("wechat-native-session");
  expect(second.prompt).toContain(messageText);
  messageId = "18446744073709551611";
  messageText = "Do not deliver this after I disconnect";
  await receive();
  // Disconnect while a run is active; its eventual output must not use a stale binding.
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  await accept(client().disconnect({ headers }), [204]);
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

  expect(sends).toHaveLength(1);
});
