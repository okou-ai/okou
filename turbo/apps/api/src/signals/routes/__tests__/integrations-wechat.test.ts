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
import {
  getWechatUpdates,
  WechatSessionExpiredError,
} from "@okouai/core/wechat-client";
import type { WechatMessage } from "@okouai/api-contracts/contracts/wechat-protocol";
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
  wechatReceiverContract,
} from "@okouai/api-contracts/contracts/integrations-wechat";
import { testContext, accept } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now, mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { integrationsWechatRoutes } from "../integrations-wechat";
import { wechatReceiverRoutes } from "../wechat-receiver";
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
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
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
  context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
    id: actor.orgId,
    name: "WeChat test workspace",
  });
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
    typingStatuses: [] as number[],
    sends: [] as unknown[],
  };
  server.use(
    http.post(`${origin}/ilink/bot/sendmessage`, async ({ request }) => {
      provider.sends.push(await request.json());
      return HttpResponse.json({ ret: 0 });
    }),
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
        .object({ connectionId: z.uuid(), generation: z.uuid() })
        .parse(await request.json());
      provider.starts.push(body.connectionId);
      return HttpResponse.json({ ok: true });
    }),
    http.post(`${origin}/ilink/bot/getconfig`, async ({ request }) => {
      expect(request.headers.get("authorization")).toBe(
        "Bearer test-private-bot-token",
      );
      await expect(request.json()).resolves.toMatchObject({
        ilink_user_id: `scanner-${actor.userId}`,
        context_token: expect.any(String),
      });
      return HttpResponse.json({
        ret: 0,
        typing_ticket: "private-typing-ticket",
      });
    }),
    http.post(`${origin}/ilink/bot/sendtyping`, async ({ request }) => {
      expect(request.headers.get("authorization")).toBe(
        "Bearer test-private-bot-token",
      );
      const body = z
        .object({
          ilink_user_id: z.literal(`scanner-${actor.userId}`),
          typing_ticket: z.literal("private-typing-ticket"),
          status: z.union([z.literal(1), z.literal(2)]),
        })
        .parse(await request.json());
      provider.typingStatuses.push(body.status);
      return HttpResponse.json({ ret: 0 });
    }),
  );
  onTestFinished(async () => {
    createRouteMocks(context).clerk.session(
      actor.userId,
      actor.orgId,
      "org:admin",
    );
    await flushWaitUntilForTest();
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
async function receiveBatch(connectionId: string) {
  const receive = await gatewayReceiver(connectionId);
  return receive();
}
async function connectOwner(owner: Awaited<ReturnType<typeof fixture>>) {
  const attempt = await accept(client().connect({ headers }), [200]);
  owner.confirm();
  await accept(
    client().poll({ headers, body: { id: attempt.body.id } }),
    [200],
  );
  await flushWaitUntilForTest();
  return z.uuid().parse(owner.provider.starts.at(-1));
}
function ownerMessage(userId: string): WechatMessage {
  return {
    message_id: "123456789",
    from_user_id: `scanner-${userId}`,
    to_user_id: "test-bot",
    message_type: 1,
    context_token: "private-reply-context",
    item_list: [{ type: 1, text_item: { text: "A private incoming message" } }],
  };
}

async function responseFixture() {
  const connected = await fixture();
  const { actor, provider, confirm } = connected;
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const webhooks = createWebhookCallbackApi(context);
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  context.mocks.ably.publish.mockResolvedValue(undefined);
  const runnerGroup = runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensurePersonalSubscriptionModel(actor);
  await runs.updateUserModelPreference(actor, "claude-fable-5-1");
  await bdd.readOnboardingStatus(actor);
  const sentTexts: string[] = [];
  server.use(
    http.post(`${origin}/ilink/bot/sendmessage`, async ({ request }) => {
      const body = z
        .object({
          msg: z.object({
            item_list: z.array(
              z.object({ text_item: z.object({ text: z.string() }) }),
            ),
          }),
        })
        .parse(await request.json());
      sentTexts.push(
        ...body.msg.item_list.map((item) => {
          return item.text_item.text;
        }),
      );
      return HttpResponse.json({ ret: 0 });
    }),
  );
  const attempt = await accept(client().connect({ headers }), [200]);
  confirm();
  await accept(
    client().poll({ headers, body: { id: attempt.body.id } }),
    [200],
  );
  const connectionId = z.uuid().parse(provider.starts[0]);
  await flushWaitUntilForTest();
  return {
    ...connected,
    connectionId,
    runs,
    webhooks,
    sentTexts,
    async receive(text: string) {
      server.use(
        http.post(`${origin}/ilink/bot/getupdates`, () => {
          return HttpResponse.json({
            msgs: [
              {
                message_id: randomUUID(),
                from_user_id: `scanner-${actor.userId}`,
                to_user_id: "test-bot",
                message_type: 1,
                context_token: "private-reply-context",
                item_list: [{ type: 1, text_item: { text } }],
              },
            ],
          });
        }),
      );
      await receiveBatch(connectionId);
    },
    async claim() {
      let runId: string | undefined;
      await expect
        .poll(
          async () => {
            await runs.heartbeatRunner(runnerGroup);
            runId = (await runs.pollRunner(runnerGroup)).body.job?.runId;
            return runId;
          },
          { timeout: 10_000 },
        )
        .toBeDefined();
      return await runs.claimRunnerJob(z.uuid().parse(runId));
    },
    async finish(
      run: { readonly runId: string; readonly sandboxToken: string },
      text: string,
      exitCode = 0,
      completionStatus: 200 | 500 = 200,
    ) {
      const callbackHeaders = { authorization: `Bearer ${run.sandboxToken}` };
      await webhooks.requestAgentEvents(
        {
          runId: run.runId,
          events: [{ type: "result", sequenceNumber: 0, result: text }],
        },
        callbackHeaders,
        [200],
      );
      await webhooks.requestAgentComplete(
        {
          runId: run.runId,
          exitCode,
          completion: {
            cliAgentType: "claude-code",
            cliAgentSessionId: randomUUID(),
            cliAgentSessionHistoryDisposition: "native_only",
          },
          lastEventSequence: 0,
        },
        callbackHeaders,
        [completionStatus],
      );
    },
  };
}

describe("WeChat reply presentation and processing status", () => {
  it.each(["membership", "feature"] as const)(
    "stops a multi-part reply when %s access is revoked after the first part",
    async (revoked) => {
      const fixture = await responseFixture();
      await fixture.receive("Return a long reply");
      const run = await fixture.claim();
      await flushWaitUntilForTest();
      const text = "🌿".repeat(2050);
      server.use(
        http.post(`${origin}/ilink/bot/sendmessage`, async ({ request }) => {
          const body = z
            .object({
              msg: z.object({
                item_list: z.array(
                  z.object({ text_item: z.object({ text: z.string() }) }),
                ),
              }),
            })
            .parse(await request.json());
          fixture.sentTexts.push(
            ...body.msg.item_list.map((item) => {
              return item.text_item.text;
            }),
          );
          if (revoked === "membership") {
            context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
              { data: [], totalCount: 0 },
            );
          } else {
            await updateFeatureSwitchesForUser(context, fixture.actor, {
              [FeatureSwitchKey.WechatIntegration]: false,
            });
          }
          return HttpResponse.json({ ret: 0, message_id: "first-part" });
        }),
      );
      const finished = await settleIncludingAbort(async () => {
        await fixture.finish(run, text, 0, 500);
        await flushWaitUntilForTest();
        expect(fixture.sentTexts).toStrictEqual([
          expect.stringContaining("You're connected"),
          "🌿".repeat(2000),
        ]);
      });
      context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
        {
          data: [
            {
              publicUserData: { userId: fixture.actor.userId },
              organization: { id: fixture.actor.orgId },
              role: "org:admin",
            },
          ],
          totalCount: 1,
        },
      );
      await updateFeatureSwitchesForUser(context, fixture.actor, {
        [FeatureSwitchKey.WechatIntegration]: true,
      });
      if (!finished.ok) {
        throw finished.error;
      }
      const messages = setupApp({
        context,
        routes: integrationsWechatMessagesRoutes,
      })(integrationsWechatMessagesContract);
      const history = await accept(
        messages.history({
          headers,
          query: { channelId: fixture.connectionId, limit: 50 },
        }),
        [200],
      );
      expect(
        history.body.messages.filter((message) => {
          return message.direction === "outbound";
        }),
      ).toMatchObject([
        { status: "sent", providerMessageId: "first-part" },
        {
          status: "sent",
          content: expect.stringContaining("You're connected"),
        },
      ]);
    },
  );

  it.each(["disconnect", "reconnect"] as const)(
    "rejects a send when a %s happens during credential decryption",
    async (change) => {
      const fixture = await responseFixture();
      await fixture.receive("Hello");
      await fixture.claim();
      await flushWaitUntilForTest();
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      let holdNextDecrypt = true;
      server.use(
        http.post(
          "https://kms.us-west-2.amazonaws.com/",
          async ({ request }) => {
            if (
              holdNextDecrypt &&
              request.headers.get("x-amz-target") === "TrentService.Decrypt"
            ) {
              holdNextDecrypt = false;
              entered.resolve();
              await release.promise;
            }
            // Let the shared KMS HTTP fixture perform the actual decrypt.
          },
        ),
      );
      const messages = setupApp({
        context,
        routes: integrationsWechatMessagesRoutes,
      })(integrationsWechatMessagesContract);
      const sending = messages.sendMessage({
        headers,
        body: {
          channelId: fixture.connectionId,
          operationId: randomUUID(),
          text: "Do not send with obsolete credentials",
        },
      });
      await (async () => {
        await entered.promise;
        if (change === "disconnect") {
          await accept(client().disconnect({ headers }), [204]);
        } else {
          const attempt = await accept(client().connect({ headers }), [200]);
          fixture.confirm();
          await accept(
            client().poll({ headers, body: { id: attempt.body.id } }),
            [200],
          );
        }
      })().finally(() => {
        release.resolve();
      });
      await accept(sending, [404]);
      expect(fixture.sentTexts).toStrictEqual([
        expect.stringContaining("You're connected"),
      ]);
    },
  );

  it("adds one model footer across long Unicode replies and keeps typing for queued follow-ups", async () => {
    const fixture = await responseFixture();
    await fixture.receive("First task");
    const first = await fixture.claim();
    await fixture.receive("A queued follow-up");
    await flushWaitUntilForTest();
    const statusBeforeCompletion = fixture.provider.typingStatuses.length;
    const text = "🌿".repeat(2050);
    await fixture.finish(first, text);
    await flushWaitUntilForTest();
    expect(fixture.sentTexts).toHaveLength(3);
    const [welcome, ...reply] = fixture.sentTexts;
    expect(welcome).toContain("You're connected");
    expect(reply.join("")).toBe(`${text}\n\nClaude Fable 5.1`);
    expect(
      fixture.sentTexts.every((part) => {
        return Array.from(part).length <= 2000;
      }),
    ).toBeTruthy();
    expect(
      fixture.provider.typingStatuses.slice(statusBeforeCompletion),
    ).not.toContain(2);
    const second = await fixture.claim();
    await fixture.finish(second, "Follow-up complete");
    await flushWaitUntilForTest();
    expect(fixture.provider.typingStatuses.at(-1)).toBe(2);
  });

  it.each(["failed", "cancelled"] as const)(
    "clears typing when a run is %s",
    async (outcome) => {
      const fixture = await responseFixture();
      await fixture.receive("Start a task");
      const run = await fixture.claim();
      await flushWaitUntilForTest();
      expect(fixture.provider.typingStatuses.at(-1)).toBe(1);
      if (outcome === "cancelled") {
        await fixture.runs.requestCancelRun(fixture.actor, run.runId, [200]);
      } else {
        await fixture.finish(run, "", 1);
      }
      await flushWaitUntilForTest();
      expect(fixture.provider.typingStatuses.at(-1)).toBe(2);
      expect(fixture.sentTexts.join("")).toContain("Claude Fable 5.1");
    },
  );

  it.each(["missing ticket", "config unavailable", "typing rejected"])(
    "still delivers replies when typing has %s",
    async (failure) => {
      const fixture = await responseFixture();
      if (failure === "typing rejected") {
        server.use(
          http.post(`${origin}/ilink/bot/sendtyping`, () => {
            return HttpResponse.json({ ret: -1, errmsg: "typing unavailable" });
          }),
        );
      } else {
        server.use(
          http.post(`${origin}/ilink/bot/getconfig`, () => {
            return failure === "missing ticket"
              ? HttpResponse.json({ ret: 0 })
              : new HttpResponse(null, { status: 503 });
          }),
        );
      }
      await fixture.receive("Hello");
      const run = await fixture.claim();
      await fixture.finish(run, "Still delivered");
      await flushWaitUntilForTest();
      expect(fixture.sentTexts).toStrictEqual([
        expect.stringContaining("You're connected"),
        "Still delivered\n\nClaude Fable 5.1",
      ]);
    },
  );

  it.each([false, true])(
    "recovers a reply after a pre-send failure (partial=%s)",
    async (partial) => {
      const fixture = await responseFixture();
      await fixture.receive("Recover my reply");
      const run = await fixture.claim();
      await flushWaitUntilForTest();
      const text = "x".repeat(2100);
      const callbackHeaders = { authorization: `Bearer ${run.sandboxToken}` };
      await fixture.webhooks.requestAgentEvents(
        {
          runId: run.runId,
          events: [{ type: "result", sequenceNumber: 0, result: text }],
        },
        callbackHeaders,
        [200],
      );
      const memberships =
        context.mocks.clerk.organizations.getOrganizationMembershipList;
      const available = await memberships({
        organizationId: fixture.actor.orgId,
        userId: [fixture.actor.userId],
        limit: 1,
      });
      let unavailable = !partial;
      const chunks: string[] = [];
      memberships.mockImplementation(() => {
        return unavailable
          ? Promise.reject(new Error("Clerk temporarily unavailable"))
          : Promise.resolve(available);
      });
      server.use(
        http.post(`${origin}/ilink/bot/sendmessage`, async ({ request }) => {
          const body = z
            .object({
              msg: z.object({
                item_list: z.array(
                  z.object({ text_item: z.object({ text: z.string() }) }),
                ),
              }),
            })
            .parse(await request.json());
          chunks.push(
            ...body.msg.item_list.map((item) => {
              return item.text_item.text;
            }),
          );
          if (partial && chunks.length === 1) {
            unavailable = true;
          }
          return HttpResponse.json({ ret: 0 });
        }),
      );
      const completion = {
        runId: run.runId,
        exitCode: 0,
        lastEventSequence: 0,
        completion: {
          cliAgentType: "claude-code" as const,
          cliAgentSessionId: randomUUID(),
          cliAgentSessionHistoryDisposition: "native_only" as const,
        },
      };
      await fixture.webhooks.requestAgentComplete(
        completion,
        callbackHeaders,
        [500],
      );
      expect(chunks).toHaveLength(partial ? 1 : 0);
      unavailable = false;
      if (partial) {
        // Recovery also runs without another completion request from the runner.
        server.use(
          http.post(`${origin}/ilink/bot/getupdates`, () => {
            return HttpResponse.json({ msgs: [] });
          }),
        );
        mockNow(now() + 31_000);
        const connectionId = z.uuid().parse(fixture.provider.starts[0]);
        const body = { connectionId };
        await accept(
          receiverClient().bootstrap({ body, headers: receiverHeaders(body) }),
          [200],
        );
        await flushWaitUntilForTest();
        expect(chunks).toHaveLength(2);
      }
      await fixture.webhooks.requestAgentComplete(
        completion,
        callbackHeaders,
        [200],
      );
      await fixture.webhooks.requestAgentComplete(
        completion,
        callbackHeaders,
        [200],
      );
      expect(chunks).toHaveLength(2);
      expect(chunks.join("")).toBe(`${text}\n\nClaude Fable 5.1`);
    },
  );

  it("accepts new input while reply recovery is waiting for WeChat", async () => {
    const fixture = await responseFixture();
    await fixture.receive("First prompt");
    const run = await fixture.claim();
    await flushWaitUntilForTest();
    const memberships =
      context.mocks.clerk.organizations.getOrganizationMembershipList;
    const available = await memberships({
      organizationId: fixture.actor.orgId,
      userId: [fixture.actor.userId],
      limit: 1,
    });
    memberships.mockRejectedValue(new Error("Clerk temporarily unavailable"));
    await fixture.finish(run, "Recovered answer", 0, 500);
    memberships.mockResolvedValue(available);

    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    const replies: string[] = [];
    server.use(
      http.post(`${origin}/ilink/bot/sendmessage`, async ({ request }) => {
        const body = z
          .object({
            msg: z.object({
              item_list: z.array(
                z.object({
                  text_item: z.object({ text: z.string() }),
                }),
              ),
            }),
          })
          .parse(await request.json());
        replies.push(
          ...body.msg.item_list.map((item) => {
            return item.text_item.text;
          }),
        );
        entered.resolve();
        await release.promise;
        return HttpResponse.json({ ret: 0 });
      }),
    );
    mockNow(now() + 31_000);
    const received = await settleIncludingAbort(async () => {
      await fixture.receive("A later prompt");
      await entered.promise;
      const history = await accept(
        setupApp({ context, routes: integrationsWechatMessagesRoutes })(
          integrationsWechatMessagesContract,
        ).history({
          headers,
          query: {
            channelId: z.uuid().parse(fixture.provider.starts[0]),
            limit: 50,
          },
        }),
        [200],
      );
      expect(history.body.messages).toContainEqual(
        expect.objectContaining({
          direction: "inbound",
          content: "A later prompt",
        }),
      );
    });
    release.resolve();
    await flushWaitUntilForTest();
    if (!received.ok) {
      throw received.error;
    }
    expect(replies).toStrictEqual(["Recovered answer\n\nClaude Fable 5.1"]);
  });

  it.each([0, 91_000])(
    "serializes overlapping completion delivery attempts after %s ms",
    async (elapsed) => {
      const fixture = await responseFixture();
      await fixture.receive("Reply once");
      const run = await fixture.claim();
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      let attempts = 0;
      server.use(
        http.post(`${origin}/ilink/bot/sendmessage`, async () => {
          attempts++;
          entered.resolve();
          await release.promise;
          return HttpResponse.json({ ret: 0 });
        }),
      );
      const completing = settleIncludingAbort(
        fixture.finish(run, "Only one reply"),
      );
      const overlapping = await settleIncludingAbort(async () => {
        await entered.promise;
        mockNow(now() + elapsed);
        await fixture.webhooks.requestAgentComplete(
          { runId: run.runId, exitCode: 0, lastEventSequence: 0 },
          { authorization: `Bearer ${run.sandboxToken}` },
          [500],
        );
        expect(attempts).toBe(1);
      });
      if (!release.settled()) {
        release.resolve();
      }
      const finished = await completing;
      if (!overlapping.ok) {
        throw overlapping.error;
      }
      if (!finished.ok) {
        throw finished.error;
      }
      await fixture.webhooks.requestAgentComplete(
        { runId: run.runId, exitCode: 0, lastEventSequence: 0 },
        { authorization: `Bearer ${run.sandboxToken}` },
        [200],
      );
      expect(attempts).toBe(1);
    },
  );

  it("clears typing even when the reply cannot be delivered", async () => {
    const fixture = await responseFixture();
    await fixture.receive("Hello");
    const run = await fixture.claim();
    await flushWaitUntilForTest();
    expect(fixture.provider.typingStatuses.at(-1)).toBe(1);
    let attempts = 0;
    server.use(
      http.post(`${origin}/ilink/bot/sendmessage`, () => {
        attempts++;
        return new HttpResponse(null, { status: 503 });
      }),
    );
    // Unknown provider delivery is terminal and must not be automatically resent.
    await fixture.finish(run, "Done");
    await flushWaitUntilForTest();
    expect(fixture.sentTexts).toStrictEqual([
      expect.stringContaining("You're connected"),
    ]);
    expect(fixture.provider.typingStatuses.at(-1)).toBe(2);
    server.use(
      http.post(`${origin}/ilink/bot/getupdates`, () => {
        return HttpResponse.json({ msgs: [] });
      }),
    );
    mockNow(now() + 31_000);
    await receiveBatch(z.uuid().parse(fixture.provider.starts[0]));
    await flushWaitUntilForTest();
    await fixture.webhooks.requestAgentComplete(
      { runId: run.runId, exitCode: 0, lastEventSequence: 0 },
      { authorization: `Bearer ${run.sandboxToken}` },
      [200],
    );
    expect(attempts).toBe(1);
  });

  it("does not restore typing when a delayed config read outlives completion", async () => {
    const fixture = await responseFixture();
    await fixture.receive("Hello");
    const run = await fixture.claim();
    await flushWaitUntilForTest();
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    let holdNextRead = true;
    server.use(
      http.post(`${origin}/ilink/bot/getconfig`, async () => {
        if (holdNextRead) {
          holdNextRead = false;
          entered.resolve();
          await release.promise;
        }
        return HttpResponse.json({
          ret: 0,
          typing_ticket: "private-typing-ticket",
        });
      }),
    );
    await fixture.webhooks.requestAgentHeartbeat(
      { runId: run.runId },
      {
        authorization: `Bearer ${run.sandboxToken}`,
      },
      [200],
    );
    await entered.promise;
    await fixture.finish(run, "Done");
    const completedStatus = fixture.provider.typingStatuses.length;
    release.resolve();
    await flushWaitUntilForTest();
    expect(fixture.sentTexts).toStrictEqual([
      expect.stringContaining("You're connected"),
      "Done\n\nClaude Fable 5.1",
    ]);
    expect(
      fixture.provider.typingStatuses.slice(completedStatus),
    ).not.toContain(1);
    expect(fixture.provider.typingStatuses.at(-1)).toBe(2);
  });

  it("does not send typing after the connection is disconnected during a config read", async () => {
    const fixture = await responseFixture();
    await fixture.receive("Hello");
    const run = await fixture.claim();
    await flushWaitUntilForTest();
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    server.use(
      http.post(`${origin}/ilink/bot/getconfig`, async () => {
        entered.resolve();
        await release.promise;
        return HttpResponse.json({
          ret: 0,
          typing_ticket: "private-typing-ticket",
        });
      }),
    );
    await fixture.webhooks.requestAgentHeartbeat(
      { runId: run.runId },
      {
        authorization: `Bearer ${run.sandboxToken}`,
      },
      [200],
    );
    await entered.promise;
    await accept(client().disconnect({ headers }), [204]);
    const beforeDisconnect = [...fixture.provider.typingStatuses];
    release.resolve();
    await flushWaitUntilForTest();
    expect(fixture.provider.typingStatuses).toStrictEqual(beforeDisconnect);
  });
});

describe("WeChat QR owner binding", () => {
  it("handles verification and publishes only a sanitized connection status", async () => {
    const { actor, provider, confirm } = await fixture();
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
      binding: {
        workspace: { id: actor.orgId, name: "WeChat test workspace" },
        accountId: `scanner-${actor.userId}`,
      },
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
  it("stops authenticated receiver requests for missing bindings and rejects forged requests", async () => {
    await fixture();
    const body = { connectionId: randomUUID() };
    const timestamp = String(Math.floor(now() / 1000));
    const sig = createHmac("sha256", secret)
      .update(`${timestamp}.${JSON.stringify(body)}`)
      .digest("hex");
    const gateway = receiverClient();
    expect(
      (
        await accept(
          gateway.bootstrap({
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
      gateway.bootstrap({
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
      const body: unknown = await request.json();
      sends.push(body);
      if (JSON.stringify(body).includes("I will remember Orchid.")) {
        delivered.resolve();
      }
      return HttpResponse.json({ ret: 0 });
    }),
  );
  const attempt = await accept(client().connect({ headers }), [200]);
  confirm();
  await accept(
    client().poll({ headers, body: { id: attempt.body.id } }),
    [200],
  );
  const connectionId = z.uuid().parse(provider.starts[0]);
  await flushWaitUntilForTest();
  async function receive() {
    return await receiveBatch(connectionId);
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
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({
    msg: {
      to_user_id: `scanner-${actor.userId}`,
      item_list: [
        {
          type: 1,
          text_item: { text: expect.stringContaining("You're connected") },
        },
      ],
    },
  });

  expect(
    z
      .object({ msg: z.object({ context_token: z.string().optional() }) })
      .parse(sends[0]).msg.context_token,
  ).toBeUndefined();
  await receive();
  expect(sends).toHaveLength(1);

  const first = await claim();
  await flushWaitUntilForTest();
  expect(provider.typingStatuses.at(-1)).toBe(1);

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
  const beforeRefresh = provider.typingStatuses.length;
  const heartbeat = await webhooks.requestAgentHeartbeat(
    { runId: first.runId },
    callbackHeaders,
    [200],
  );
  expect(heartbeat.body).toStrictEqual({
    ok: true,
    typingRefreshIntervalSeconds: 5,
  });
  await flushWaitUntilForTest();
  expect(provider.typingStatuses.length).toBeGreaterThan(beforeRefresh);
  expect(provider.typingStatuses.at(-1)).toBe(1);
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

  expect(sends).toHaveLength(2);
  expect(sends[1]).toMatchObject({
    msg: {
      to_user_id: `scanner-${actor.userId}`,
      context_token: "private-reply-context",
      item_list: [
        {
          type: 1,
          text_item: { text: "I will remember Orchid.\n\nClaude Fable 5.1" },
        },
      ],
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
      binding: {
        workspace: { id: actor.orgId, name: expect.any(String) },
        accountId: `scanner-${actor.userId}`,
      },
      status: "active",
    },
  ]);
  await flushWaitUntilForTest();
  expect(provider.typingStatuses.at(-1)).toBe(2);
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
    content: "I will remember Orchid.\n\nClaude Fable 5.1",
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
  expect(oldest.body.messages[0]?.providerMessageId).toBe(
    "18446744073709551615",
  );
  const welcome = await accept(
    messages.history({
      headers: agentHeaders,
      query: {
        channelId: connectionId,
        limit: 1,
        before: z.uuid().parse(oldest.body.nextBefore),
      },
    }),
    [200],
  );
  expect(welcome.body.nextBefore).toBeNull();
  expect(welcome.body.messages[0]).toMatchObject({
    direction: "outbound",
    status: "sent",
    content: expect.stringContaining("You're connected"),
  });
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
  // Image-only inputs have no filename or MIME; preserve the detected encoding.
  for (const image of [
    {
      messageId: "18446744073709551611",
      contentType: "image/png",
      base64:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+afo8AAAAASUVORK5CYII=",
    },
    {
      messageId: "18446744073709551607",
      contentType: "image/gif",
      base64: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    },
  ]) {
    const imageBytes = Buffer.from(image.base64, "base64");
    let imageDownloads = 0;
    server.use(
      http.get("https://novac2c.cdn.weixin.qq.com/c2c/download", () => {
        imageDownloads++;
        return new HttpResponse(new Uint8Array(imageBytes));
      }),
    );
    extraItems = [
      {
        type: 2,
        image_item: {
          media: { encrypt_query_param: `image-query-${image.messageId}` },
        },
      },
    ];
    messageId = image.messageId;
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
          return part.type === "file" && part.contentType === image.contentType;
        })
      );
    });
    expect(imageInputs).toHaveLength(1);
    const { input: imageInput } = await runs.nextSteerableInput(
      second.sandboxToken,
      second.runId,
    );
    expect(imageInput?.prompt).toContain(
      `[Web file] image (${image.contentType})`,
    );
    expect(objectStore.puts).toContainEqual(
      expect.objectContaining({ contentType: image.contentType }),
    );
  }
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
  expect(
    (await accept(messages.listChannels({ headers: agentHeaders }), [200])).body
      .channels,
  ).toStrictEqual([]);
  await accept(
    messages.sendMessage({
      headers: agentHeaders,
      body: {
        channelId: connectionId,
        operationId: randomUUID(),
        text: "No longer authorized",
      },
    }),
    [404],
  );
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

describe("WeChat system notices", () => {
  it("keeps only reconnect replies after disconnect, deduplicates retries and revokes native access", async () => {
    const owner = await fixture();
    const connectionId = await connectOwner(owner);
    await accept(client().disconnect({ headers }), [204]);
    mockEnv("APP_URL", "https://app.okou.test");
    let message = ownerMessage(owner.actor.userId);
    const sends: unknown[] = [];
    server.use(
      http.post(`${origin}/ilink/bot/getupdates`, () => {
        return HttpResponse.json({
          msgs: [message],
          get_updates_buf: "detached-cursor",
        });
      }),
      http.post(`${origin}/ilink/bot/sendmessage`, async ({ request }) => {
        sends.push(await request.json());
        return HttpResponse.json({ ret: 0 });
      }),
    );
    expect((await receiveBatch(connectionId)).body).toStrictEqual({
      active: true,
    });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      msg: {
        to_user_id: message.from_user_id,
        context_token: message.context_token,
        item_list: [
          {
            type: 1,
            text_item: {
              text: expect.stringContaining(
                "https://app.okou.test/settings/wechat?token=",
              ),
            },
          },
        ],
      },
    });
    expect(JSON.stringify(sends)).not.toContain("A private incoming message");
    // Repeating either the provider batch or Disconnect cannot duplicate a notice.
    await accept(client().disconnect({ headers }), [204]);
    await receiveBatch(connectionId);
    expect(sends).toHaveLength(1);
    message = { ...message, message_id: "123456790" };
    await receiveBatch(connectionId);
    expect(sends).toHaveLength(2);
    const messages = setupApp({
      context,
      routes: integrationsWechatMessagesRoutes,
    })(integrationsWechatMessagesContract);
    expect(
      (await accept(messages.listChannels({ headers }), [200])).body.channels,
    ).toStrictEqual([]);
    await accept(
      messages.history({
        headers,
        query: { channelId: connectionId, limit: 50 },
      }),
      [404],
    );
    await accept(
      messages.sendMessage({
        headers,
        body: {
          channelId: connectionId,
          operationId: randomUUID(),
          text: "Do not send",
        },
      }),
      [404],
    );
    expect(sends).toHaveLength(2);
    // A new verified QR creates a fresh binding; the old receiver cannot resume it.
    const reconnected = await connectOwner(owner);
    expect(reconnected).not.toBe(connectionId);
    expect((await receiveBatch(connectionId)).body).toStrictEqual({
      active: false,
    });
    expect(
      (
        await accept(
          messages.history({
            headers,
            query: { channelId: reconnected, limit: 50 },
          }),
          [200],
        )
      ).body.messages,
    ).toMatchObject([
      {
        direction: "outbound",
        content: expect.stringContaining("You're connected"),
      },
    ]);
  });

  it("ignores unverified messages and never retries an ambiguous reconnect send", async () => {
    const owner = await fixture();
    const connectionId = await connectOwner(owner);
    await accept(client().disconnect({ headers }), [204]);
    const valid = ownerMessage(owner.actor.userId);
    let msgs: WechatMessage[] = [
      { ...valid, from_user_id: "another-scanner" },
      { ...valid, to_user_id: "another-bot" },
      { ...valid, group_id: "a-group" },
      { ...valid, context_token: "" },
      { ...valid, message_type: 2 },
    ];
    let attempts = 0;
    server.use(
      http.post(`${origin}/ilink/bot/getupdates`, () => {
        return HttpResponse.json({ msgs, get_updates_buf: "cursor" });
      }),
      http.post(`${origin}/ilink/bot/sendmessage`, () => {
        attempts++;
        return new HttpResponse(null, { status: 503 });
      }),
    );
    await receiveBatch(connectionId);
    expect(attempts).toBe(0);
    msgs = [valid];
    await receiveBatch(connectionId);
    await receiveBatch(connectionId);
    expect(attempts).toBe(1);
  });

  it("does not send or enqueue a stale batch completed after disconnect", async () => {
    const owner = await fixture();
    const connectionId = await connectOwner(owner);
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    let attempts = 0;
    server.use(
      http.post(`${origin}/ilink/bot/getupdates`, async () => {
        entered.resolve();
        await release.promise;
        return HttpResponse.json({
          msgs: [ownerMessage(owner.actor.userId)],
          get_updates_buf: "late-cursor",
        });
      }),
      http.post(`${origin}/ilink/bot/sendmessage`, () => {
        attempts++;
        return HttpResponse.json({ ret: 0 });
      }),
    );
    const pending = receiveBatch(connectionId);
    await entered.promise;
    await accept(client().disconnect({ headers }), [204]);
    release.resolve();
    await pending;
    expect(attempts).toBe(0);
    server.use(
      http.post(`${origin}/ilink/bot/getupdates`, () => {
        return HttpResponse.json({
          msgs: [ownerMessage(owner.actor.userId)],
          get_updates_buf: "late-cursor",
        });
      }),
    );
    await receiveBatch(connectionId);
    expect(attempts).toBe(1);
  });

  it("does not create a chat when disconnect completes during the welcome request", async () => {
    const owner = await fixture();
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    server.use(
      http.post(`${origin}/ilink/bot/getupdates`, () => {
        return HttpResponse.json({
          msgs: [ownerMessage(owner.actor.userId)],
          get_updates_buf: "cursor",
        });
      }),
      http.post(`${origin}/ilink/bot/sendmessage`, async () => {
        entered.resolve();
        await release.promise;
        return HttpResponse.json({ ret: 0 });
      }),
    );
    const attempt = await accept(client().connect({ headers }), [200]);
    owner.confirm();
    await accept(
      client().poll({ headers, body: { id: attempt.body.id } }),
      [200],
    );
    await entered.promise;
    await accept(client().disconnect({ headers }), [204]);
    release.resolve();
    await flushWaitUntilForTest();
    expect(
      (await accept(client().status({ headers }), [200])).body.status,
    ).toBe("disconnected");
  });

  it("allows a verified scanner to move to a new owner only after disconnect", async () => {
    const first = await fixture();
    const oldId = await connectOwner(first);
    await accept(client().disconnect({ headers }), [204]);
    const second = await fixture();
    const attempt = await accept(client().connect({ headers }), [200]);
    second.confirm();
    second.provider.status.ilink_user_id = first.provider.status.ilink_user_id;
    await accept(
      client().poll({ headers, body: { id: attempt.body.id } }),
      [200],
    );
    expect(second.provider.starts).toHaveLength(1);
    expect(second.provider.starts[0]).not.toBe(oldId);
    expect((await receiveBatch(oldId)).body).toStrictEqual({ active: false });
  });

  it("preserves the detached receiver when a QR tries to claim another active scanner", async () => {
    const first = await fixture();
    await connectOwner(first);
    const second = await fixture();
    const detachedId = await connectOwner(second);
    await accept(client().disconnect({ headers }), [204]);
    const attempt = await accept(client().connect({ headers }), [200]);
    second.provider.status.ilink_user_id = first.provider.status.ilink_user_id;
    await accept(
      client().poll({ headers, body: { id: attempt.body.id } }),
      [409],
    );
    server.use(
      http.post(`${origin}/ilink/bot/getupdates`, () => {
        return HttpResponse.json({ msgs: [], get_updates_buf: "cursor" });
      }),
    );
    expect((await receiveBatch(detachedId)).body).toStrictEqual({
      active: true,
    });
  });

  it("can bind a different scanner after disconnect", async () => {
    const owner = await fixture();
    const oldId = await connectOwner(owner);
    await accept(client().disconnect({ headers }), [204]);
    const attempt = await accept(client().connect({ headers }), [200]);
    owner.provider.status.ilink_user_id = "a-different-verified-scanner";
    await accept(
      client().poll({ headers, body: { id: attempt.body.id } }),
      [200],
    );
    expect(owner.provider.starts.at(-1)).not.toBe(oldId);
    expect((await receiveBatch(oldId)).body).toStrictEqual({ active: false });
  });

  it("stops the detached receiver when membership is revoked or Tencent expires the session", async () => {
    const owner = await fixture();
    const connectionId = await connectOwner(owner);
    await accept(client().disconnect({ headers }), [204]);
    let polls = 0;
    server.use(
      http.post(`${origin}/ilink/bot/getupdates`, () => {
        polls++;
        return HttpResponse.json({ ret: -14 });
      }),
    );
    await updateFeatureSwitchesForUser(context, owner.actor, {
      [FeatureSwitchKey.WechatIntegration]: false,
    });
    expect((await receiveBatch(connectionId)).body).toStrictEqual({
      active: false,
    });
    expect(polls).toBe(0);
    await updateFeatureSwitchesForUser(context, owner.actor, {
      [FeatureSwitchKey.WechatIntegration]: true,
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      { data: [], totalCount: 0 },
    );
    expect((await receiveBatch(connectionId)).body).toStrictEqual({
      active: false,
    });
    expect(polls).toBe(0);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            publicUserData: { userId: owner.actor.userId },
            organization: { id: owner.actor.orgId },
            role: "org:admin",
          },
        ],
        totalCount: 1,
      },
    );
    expect((await receiveBatch(connectionId)).body).toStrictEqual({
      active: false,
    });
    expect(polls).toBe(1);
    expect((await receiveBatch(connectionId)).body).toStrictEqual({
      active: false,
    });
    expect(polls).toBe(1);
    expect(
      (await accept(client().status({ headers }), [200])).body.status,
    ).toBe("disconnected");
  });

  it("continues processing the first prompt when the welcome delivery fails and welcomes a new binding once", async () => {
    const owner = await fixture();
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    runs.configureRunnerGroup();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    context.mocks.ably.publish.mockResolvedValue(undefined);
    await runs.grantProEntitlement(owner.actor);
    await runs.ensurePersonalSubscriptionModel(owner.actor);
    await runs.updateUserModelPreference(owner.actor, "claude-fable-5-1");
    await bdd.readOnboardingStatus(owner.actor);
    const message = ownerMessage(owner.actor.userId);
    let attempts = 0;
    const messages = setupApp({
      context,
      routes: integrationsWechatMessagesRoutes,
    })(integrationsWechatMessagesContract);
    server.use(
      http.post(`${origin}/ilink/bot/getupdates`, () => {
        return HttpResponse.json({
          msgs: [message],
          get_updates_buf: "cursor",
        });
      }),
      http.post(`${origin}/ilink/bot/sendmessage`, () => {
        attempts++;
        return attempts === 1
          ? new HttpResponse(null, { status: 503 })
          : HttpResponse.json({ ret: 0 });
      }),
    );
    const connectionId = await connectOwner(owner);
    expect(attempts).toBe(1);
    await receiveBatch(connectionId);
    await receiveBatch(connectionId);
    expect(attempts).toBe(1);
    const history = await accept(
      messages.history({
        headers,
        query: { channelId: connectionId, limit: 50 },
      }),
      [200],
    );
    expect(history.body.messages).toMatchObject([
      { direction: "inbound", content: "A private incoming message" },
      {
        direction: "outbound",
        status: "unknown",
        content: expect.stringContaining("You're connected"),
      },
    ]);
    await accept(client().disconnect({ headers }), [204]);
    const newId = await connectOwner(owner);
    await receiveBatch(newId);
    await receiveBatch(newId);
    expect(attempts).toBe(2);
    const newHistory = await accept(
      messages.history({ headers, query: { channelId: newId, limit: 50 } }),
      [200],
    );
    expect(newHistory.body.messages).toMatchObject([
      { direction: "inbound", content: "A private incoming message" },
      {
        direction: "outbound",
        status: "sent",
        content: expect.stringContaining("You're connected"),
      },
    ]);
  });
});

describe("WeChat input failure isolation", () => {
  it("reports a missing default agent once and advances to the next batch", async () => {
    const owner = await fixture();
    const connectionId = await connectOwner(owner);
    const receive = await gatewayReceiver(connectionId);
    const sends: string[] = [];
    let polls = 0;
    server.use(
      http.post(`${origin}/ilink/bot/getupdates`, () => {
        polls++;
        return HttpResponse.json({
          msgs: [ownerMessage(owner.actor.userId)],
          get_updates_buf: `cursor-${polls}`,
        });
      }),
      http.post(`${origin}/ilink/bot/sendmessage`, async ({ request }) => {
        const body = z
          .object({
            msg: z.object({
              item_list: z.array(
                z.object({ text_item: z.object({ text: z.string() }) }),
              ),
            }),
          })
          .parse(await request.json());
        sends.push(
          ...body.msg.item_list.map((item) => {
            return item.text_item.text;
          }),
        );
        return HttpResponse.json({ ret: 0 });
      }),
    );
    await receive();
    await receive();
    expect(polls).toBe(2);
    expect(
      sends.filter((text) => {
        return text.includes("workspace's agent is unavailable");
      }),
    ).toHaveLength(1);
  });

  it.each([false, true])(
    "isolates an unavailable attachment and persists bounded retries (recovers=%s)",
    async (recovers) => {
      const fixture = await responseFixture();
      const connectionId = z.uuid().parse(fixture.provider.starts[0]);
      const receive = await gatewayReceiver(connectionId);
      const fileMessage = {
        ...ownerMessage(fixture.actor.userId),
        message_id: "failed-file",
        item_list: [
          {
            type: 2,
            image_item: { media: { encrypt_query_param: "retry-file" } },
          },
        ],
      };
      const nextMessage = {
        ...ownerMessage(fixture.actor.userId),
        message_id: "later-text",
      };
      let polls = 0;
      let downloads = 0;
      let available = false;
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+afo8AAAAASUVORK5CYII=",
        "base64",
      );
      server.use(
        http.post(`${origin}/ilink/bot/getupdates`, () => {
          polls++;
          return HttpResponse.json({
            msgs:
              polls === 1
                ? [{ message_id: "malformed" }, fileMessage, nextMessage]
                : recovers
                  ? []
                  : [fileMessage],
            get_updates_buf: `cursor-${polls}`,
          });
        }),
        http.get("https://novac2c.cdn.weixin.qq.com/c2c/download", () => {
          downloads++;
          return available
            ? new HttpResponse(new Uint8Array(png))
            : new HttpResponse(null, { status: 503 });
        }),
      );
      await receive();
      expect(downloads).toBe(1);
      const messages = setupApp({
        context,
        routes: integrationsWechatMessagesRoutes,
      })(integrationsWechatMessagesContract);
      const history = await accept(
        messages.history({
          headers,
          query: { channelId: connectionId, limit: 50 },
        }),
        [200],
      );
      expect(
        history.body.messages.some((message) => {
          return message.providerMessageId === "later-text";
        }),
      ).toBeTruthy();
      // A fresh request respects the persisted backoff rather than retrying immediately.
      await receive();
      expect(downloads).toBe(1);
      available = recovers;
      mockNow(now() + 1100);
      await receive();
      expect(downloads).toBe(2);
      if (!recovers) {
        mockNow(now() + 2100);
        await receive();
        expect(downloads).toBe(3);
        expect(
          fixture.sentTexts.filter((text) => {
            return text.includes("couldn't process this message");
          }),
        ).toHaveLength(1);
      }
      await receive();
      expect(polls).toBe(2);
      expect(downloads).toBe(recovers ? 2 : 3);
      const final = await accept(
        messages.history({
          headers,
          query: { channelId: connectionId, limit: 50 },
        }),
        [200],
      );
      expect(
        final.body.messages.filter((message) => {
          return message.providerMessageId === "later-text";
        }),
      ).toHaveLength(1);
      expect(
        final.body.messages.some((message) => {
          return message.providerMessageId === "failed-file";
        }),
      ).toBe(recovers);
    },
  );
});

test("weChat history keeps time bounds across pages and validates their order", async () => {
  const fixture = await responseFixture();
  const channelId = z.uuid().parse(fixture.provider.starts[0]);
  const oldest = "2026-10-19T01:00:00.000Z";
  const latest = "2026-10-19T02:00:00.000Z";
  mockNow(new Date("2026-10-19T00:00:00.000Z"));
  await fixture.receive("Outside before");
  mockNow(new Date(oldest));
  await fixture.receive("At oldest");
  mockNow(new Date("2026-10-19T01:30:00.000Z"));
  await fixture.receive("Inside window");
  mockNow(new Date(latest));
  await fixture.receive("At latest");
  const messages = setupApp({
    context,
    routes: integrationsWechatMessagesRoutes,
  })(integrationsWechatMessagesContract);
  const query = { channelId, oldest, latest, limit: 1 };
  const first = await accept(messages.history({ headers, query }), [200]);
  expect(
    first.body.messages.map((message) => {
      return message.content;
    }),
  ).toStrictEqual(["Inside window"]);
  const second = await accept(
    messages.history({
      headers,
      query: { ...query, before: z.uuid().parse(first.body.nextBefore) },
    }),
    [200],
  );
  expect(
    second.body.messages.map((message) => {
      return message.content;
    }),
  ).toStrictEqual(["At oldest"]);
  expect(second.body.nextBefore).toBeNull();
  await accept(
    messages.history({
      headers,
      query: { ...query, oldest: latest, latest: oldest },
    }),
    [400],
  );
});

async function disconnectedLink() {
  const owner = await fixture();
  const connectionId = await connectOwner(owner);
  expect(owner.provider.sends).toHaveLength(1);
  expect(owner.provider.sends[0]).toMatchObject({
    msg: { to_user_id: `scanner-${owner.actor.userId}` },
  });
  await accept(client().disconnect({ headers }), [204]);
  server.use(
    http.post(`${origin}/ilink/bot/getupdates`, () => {
      return HttpResponse.json({
        msgs: [ownerMessage(owner.actor.userId)],
        get_updates_buf: "disconnected-cursor",
      });
    }),
  );
  await receiveBatch(connectionId);
  const notice = z
    .object({
      msg: z.object({
        item_list: z.array(
          z.object({ text_item: z.object({ text: z.string() }) }),
        ),
      }),
    })
    .parse(owner.provider.sends.at(-1));
  const text = z.string().parse(notice.msg.item_list[0]?.text_item.text);
  const url = new URL(z.string().parse(text.split("\n").at(-1)));
  expect(url.pathname).toBe("/settings/wechat");
  expect(url.toString()).not.toMatch(
    /test-private-bot-token|private-reply-context|scanner-/,
  );
  return {
    ...owner,
    connectionId,
    token: z.string().parse(url.searchParams.get("token")),
  };
}

describe("WeChat reconnect links", () => {
  it("requires confirmation, restores without a new QR, and consumes concurrent and old links", async () => {
    const owner = await disconnectedLink();
    let qrRequests = 0;
    server.use(
      http.post(`${origin}/ilink/bot/get_bot_qrcode`, () => {
        qrRequests++;
        return HttpResponse.json({
          qrcode: randomUUID(),
          qrcode_img_content: "https://weixin.qq.com/unexpected",
        });
      }),
    );
    const query = { token: owner.token };
    expect(
      (await accept(client().reconnectStatus({ headers, query }), [200])).body
        .available,
    ).toBeTruthy();
    expect(
      (await accept(client().status({ headers }), [200])).body.status,
    ).toBe("disconnected");
    const results = await Promise.all([
      client().reconnect({ headers, body: query }),
      client().reconnect({ headers, body: query }),
    ]);
    expect(
      results
        .map((result) => {
          return result.status;
        })
        .sort(),
    ).toStrictEqual([204, 409]);
    await flushWaitUntilForTest();
    expect(qrRequests).toBe(0);
    expect(owner.provider.starts.at(-1)).toBe(owner.connectionId);
    expect(
      (await accept(client().status({ headers }), [200])).body.status,
    ).toBe("active");
    expect(owner.provider.sends).toHaveLength(3);
    const welcome = z
      .object({
        msg: z.object({
          context_token: z.string().optional(),
          item_list: z.array(
            z.object({ text_item: z.object({ text: z.string() }) }),
          ),
        }),
      })
      .parse(owner.provider.sends.at(-1));
    expect(welcome.msg.context_token).toBeUndefined();
    expect(welcome.msg.item_list[0]?.text_item.text).toContain(
      "You're connected",
    );
    await accept(client().disconnect({ headers }), [204]);
    expect(
      (await accept(client().reconnectStatus({ headers, query }), [200])).body
        .available,
    ).toBeFalsy();
    await accept(client().reconnect({ headers, body: query }), [409]);
  });

  it("rejects a different owner or workspace without exposing the binding", async () => {
    const owner = await disconnectedLink();
    const other = await fixture();
    const query = { token: owner.token };
    expect(
      (await accept(client().reconnectStatus({ headers, query }), [200])).body
        .available,
    ).toBeFalsy();
    await accept(client().reconnect({ headers, body: query }), [409]);
    createRouteMocks(context).clerk.session(
      owner.actor.userId,
      other.actor.orgId,
      "org:admin",
    );
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            publicUserData: { userId: owner.actor.userId },
            organization: { id: other.actor.orgId },
            role: "org:admin",
          },
        ],
        totalCount: 1,
      },
    );
    const otherWorkspace = { ...owner.actor, orgId: other.actor.orgId };
    await updateFeatureSwitchesForUser(context, otherWorkspace, {
      [FeatureSwitchKey.WechatIntegration]: true,
    });
    expect(
      (await accept(client().reconnectStatus({ headers, query }), [200])).body
        .available,
    ).toBeFalsy();
    await accept(client().reconnect({ headers, body: query }), [409]);
    await deleteFeatureSwitchesForUser(context, otherWorkspace);
  });

  it("rejects forged and expired links and accepts a newly issued link", async () => {
    const owner = await disconnectedLink();
    const query = { token: `${owner.token}tampered` };
    expect(
      (await accept(client().reconnectStatus({ headers, query }), [200])).body
        .available,
    ).toBeFalsy();
    await accept(client().reconnect({ headers, body: query }), [409]);
    mockNow(now() + 10 * 60_000);
    query.token = owner.token;
    expect(
      (await accept(client().reconnectStatus({ headers, query }), [200])).body
        .available,
    ).toBeFalsy();
    await accept(client().reconnect({ headers, body: query }), [409]);
    server.use(
      http.post(`${origin}/ilink/bot/getupdates`, () => {
        return HttpResponse.json({
          msgs: [
            { ...ownerMessage(owner.actor.userId), message_id: "new-link" },
          ],
        });
      }),
    );
    await receiveBatch(owner.connectionId);
    const notice = z
      .object({
        msg: z.object({
          item_list: z.array(
            z.object({ text_item: z.object({ text: z.string() }) }),
          ),
        }),
      })
      .parse(owner.provider.sends.at(-1));
    const text = z.string().parse(notice.msg.item_list[0]?.text_item.text);
    query.token = z
      .string()
      .parse(
        new URL(z.string().parse(text.split("\n").at(-1))).searchParams.get(
          "token",
        ),
      );
    await accept(client().reconnect({ headers, body: query }), [204]);
    await flushWaitUntilForTest();
  });

  it("rejects revoked access and expired transports", async () => {
    const owner = await disconnectedLink();
    const query = { token: owner.token };
    await updateFeatureSwitchesForUser(context, owner.actor, {
      [FeatureSwitchKey.WechatIntegration]: false,
    });
    await accept(client().reconnectStatus({ headers, query }), [403]);
    await accept(client().reconnect({ headers, body: query }), [403]);
    await updateFeatureSwitchesForUser(context, owner.actor, {
      [FeatureSwitchKey.WechatIntegration]: true,
    });
    server.use(
      http.post(`${origin}/ilink/bot/getupdates`, () => {
        return HttpResponse.json({ ret: -14 });
      }),
    );
    expect((await receiveBatch(owner.connectionId)).body.active).toBeFalsy();
    expect(
      (await accept(client().reconnectStatus({ headers, query }), [200])).body
        .available,
    ).toBeFalsy();
    await accept(client().reconnect({ headers, body: query }), [409]);
  });

  it("discards a disconnected poll response completed after restoration", async () => {
    const owner = await disconnectedLink();
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    server.use(
      http.post(`${origin}/ilink/bot/getupdates`, async () => {
        entered.resolve();
        await release.promise;
        return HttpResponse.json({
          msgs: [
            {
              ...ownerMessage(owner.actor.userId),
              message_id: "late-disconnected-message",
            },
          ],
          get_updates_buf: "late",
        });
      }),
    );
    const pending = receiveBatch(owner.connectionId);
    await entered.promise;
    await accept(
      client().reconnect({ headers, body: { token: owner.token } }),
      [204],
    );
    await flushWaitUntilForTest();
    release.resolve();
    await pending;
    expect(owner.provider.sends).toHaveLength(3);
    const messages = setupApp({
      context,
      routes: integrationsWechatMessagesRoutes,
    })(integrationsWechatMessagesContract);
    const history = await accept(
      messages.history({
        headers,
        query: { channelId: owner.connectionId, limit: 50 },
      }),
      [200],
    );
    expect(history.body.messages).toMatchObject([
      {
        direction: "outbound",
        content: expect.stringContaining("You're connected"),
      },
    ]);
  });
});

test("a restored transport ignores provider backlog and accepts only newly created messages", async () => {
  const owner = await disconnectedLink();
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  runs.configureRunnerGroup();
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  context.mocks.ably.publish.mockResolvedValue(undefined);
  await runs.grantProEntitlement(owner.actor);
  await runs.ensurePersonalSubscriptionModel(owner.actor);
  await runs.updateUserModelPreference(owner.actor, "claude-fable-5-1");
  await bdd.readOnboardingStatus(owner.actor);
  const oldMessage = {
    ...ownerMessage(owner.actor.userId),
    create_time_ms: now() - 60_000,
  };
  await accept(
    client().reconnect({ headers, body: { token: owner.token } }),
    [204],
  );
  await flushWaitUntilForTest();
  let msgs: WechatMessage[] = [
    oldMessage,
    { ...ownerMessage(owner.actor.userId), message_id: "unverifiable-age" },
  ];
  const receive = async () => {
    const body = { connectionId: owner.connectionId };
    const claimed = await accept(
      receiverClient().bootstrap({ body, headers: receiverHeaders(body) }),
      [200],
    );
    if (!claimed.body.active) {
      throw new Error("Expected active receiver");
    }
    expect(claimed.body.session?.preserveCursor).toBeTruthy();
    const delivery = {
      ...body,
      generation: claimed.body.generation,
      updates: { msgs, get_updates_buf: "post-reconnect-cursor" },
    };
    await accept(
      receiverClient().deliver({
        body: delivery,
        headers: receiverHeaders(delivery),
      }),
      [200],
    );
  };
  await receive();
  const messages = setupApp({
    context,
    routes: integrationsWechatMessagesRoutes,
  })(integrationsWechatMessagesContract);
  const history = await accept(
    messages.history({
      headers,
      query: { channelId: owner.connectionId, limit: 50 },
    }),
    [200],
  );
  expect(history.body.messages).toMatchObject([
    {
      direction: "outbound",
      content: expect.stringContaining("You're connected"),
    },
  ]);
  msgs = [
    {
      ...ownerMessage(owner.actor.userId),
      message_id: "fresh-message",
      create_time_ms: now(),
    },
  ];
  await receive();
  const fresh = await accept(
    messages.history({
      headers,
      query: { channelId: owner.connectionId, limit: 50 },
    }),
    [200],
  );
  expect(fresh.body.messages).toMatchObject([
    { direction: "inbound", providerMessageId: "fresh-message" },
    {
      direction: "outbound",
      content: expect.stringContaining("You're connected"),
    },
  ]);
  expect(owner.provider.sends).toHaveLength(3);
});

function receiverHeaders(body: unknown) {
  const timestamp = String(Math.floor(now() / 1000));
  return {
    "x-wechat-timestamp": timestamp,
    "x-wechat-signature": createHmac("sha256", secret)
      .update(`${timestamp}.${JSON.stringify(body)}`)
      .digest("hex"),
  };
}
function receiverClient() {
  return setupApp({ context, routes: wechatReceiverRoutes })(
    wechatReceiverContract,
  );
}
describe("WeChat Workflow receiver", () => {
  it("bootstraps a receiver and renews without exposing credentials again", async () => {
    const owner = await fixture();
    const connectionId = await connectOwner(owner);
    const body = { connectionId };
    await accept(
      receiverClient().bootstrap({
        body,
        headers: { ...receiverHeaders(body), "x-wechat-signature": "forged" },
      }),
      [401],
    );
    const claimed = await accept(
      receiverClient().bootstrap({ body, headers: receiverHeaders(body) }),
      [200],
    );
    expect(claimed.body).toMatchObject({
      active: true,
      session: {
        token: "test-private-bot-token",
        cursor: "",
      },
    });
    if (!claimed.body.active) {
      throw new Error("Expected active receiver");
    }
    const renewal = { connectionId, generation: claimed.body.generation };
    expect(
      (
        await accept(
          receiverClient().bootstrap({
            body: renewal,
            headers: receiverHeaders(renewal),
          }),
          [200],
        )
      ).body,
    ).toStrictEqual({ active: true, generation: claimed.body.generation });
    expect(
      (await accept(client().status({ headers }), [200])).body,
    ).toStrictEqual({
      configured: true,
      status: "active",
      binding: {
        workspace: { id: owner.actor.orgId, name: "WeChat test workspace" },
        accountId: `scanner-${owner.actor.userId}`,
      },
    });
  });
  it("deduplicates delivered messages, rejects stale generations and retains reconnect notices", async () => {
    const owner = await responseFixture();
    const body = { connectionId: owner.connectionId };
    const claimed = await accept(
      receiverClient().bootstrap({ body, headers: receiverHeaders(body) }),
      [200],
    );
    if (!claimed.body.active) {
      throw new Error("Expected active receiver");
    }
    const delivery = {
      ...body,
      generation: claimed.body.generation,
      updates: {
        get_updates_buf: "next",
        msgs: [ownerMessage(owner.actor.userId)],
      },
    };
    for (let retry = 0; retry < 2; retry++) {
      await accept(
        receiverClient().deliver({
          body: delivery,
          headers: receiverHeaders(delivery),
        }),
        [200],
      );
    }
    const messages = setupApp({
      context,
      routes: integrationsWechatMessagesRoutes,
    })(integrationsWechatMessagesContract);
    const history = await accept(
      messages.history({
        headers,
        query: { channelId: owner.connectionId, limit: 50 },
      }),
      [200],
    );
    expect(
      history.body.messages.filter((message) => {
        return message.direction === "inbound";
      }),
    ).toHaveLength(1);
    server.use(
      http.post("https://wechat-receiver.test/start", () => {
        return new HttpResponse(null, { status: 503 });
      }),
    );
    await accept(client().disconnect({ headers }), [204]);
    expect(
      (
        await accept(
          receiverClient().deliver({
            body: delivery,
            headers: receiverHeaders(delivery),
          }),
          [200],
        )
      ).body,
    ).toStrictEqual({ active: true, refresh: true });
    const detached = await accept(
      receiverClient().bootstrap({
        body: { ...body, generation: delivery.generation },
        headers: receiverHeaders({ ...body, generation: delivery.generation }),
      }),
      [200],
    );
    if (!detached.body.active) {
      throw new Error("Expected detached transport");
    }
    const notice = {
      ...delivery,
      generation: detached.body.generation,
      updates: {
        msgs: [
          {
            ...ownerMessage(owner.actor.userId),
            message_id: "detached-notice",
          },
        ],
      },
    };
    const before = owner.sentTexts.length;
    await accept(
      receiverClient().deliver({
        body: notice,
        headers: receiverHeaders(notice),
      }),
      [200],
    );
    await accept(
      receiverClient().deliver({
        body: notice,
        headers: receiverHeaders(notice),
      }),
      [200],
    );
    expect(owner.sentTexts.slice(before)).toHaveLength(1);
    expect(owner.sentTexts.at(-1)).toContain("/settings/wechat?token=");
    await accept(
      messages.history({
        headers,
        query: { channelId: owner.connectionId, limit: 50 },
      }),
      [404],
    );
    const expired = { ...body, generation: detached.body.generation };
    expect(
      (
        await accept(
          receiverClient().expire({
            body: expired,
            headers: receiverHeaders(expired),
          }),
          [200],
        )
      ).body,
    ).toStrictEqual({ active: false });
    expect(
      (
        await accept(
          receiverClient().bootstrap({ body, headers: receiverHeaders(body) }),
          [200],
        )
      ).body,
    ).toStrictEqual({ active: false });
  });
  it("stops renewal when workspace membership is revoked", async () => {
    const owner = await fixture();
    const body = { connectionId: await connectOwner(owner) };
    await accept(
      receiverClient().bootstrap({ body, headers: receiverHeaders(body) }),
      [200],
    );
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      { data: [], totalCount: 0 },
    );
    expect(
      (
        await accept(
          receiverClient().bootstrap({ body, headers: receiverHeaders(body) }),
          [200],
        )
      ).body,
    ).toStrictEqual({ active: false });
  });
});

// Exercise the receiver's public HTTP lifecycle; all state comes from bootstrap
// and provider responses, just as it does for the real Workflows caller.
async function gatewayReceiver(connectionId: string) {
  const body = { connectionId };
  const claimed = await accept(
    receiverClient().bootstrap({ body, headers: receiverHeaders(body) }),
    [200],
  );
  if (!claimed.body.active) {
    return () => {
      return Promise.resolve(claimed);
    };
  }
  if (!claimed.body.session) {
    throw new Error("Expected a receiver session");
  }
  const { generation, session } = claimed.body;
  let cursor = session.cursor;
  let pending = session.pending;
  return async () => {
    if (!pending) {
      const received = await settleIncludingAbort(
        getWechatUpdates(
          session.baseUrl,
          session.token,
          cursor,
          context.signal,
        ),
      );
      if (!received.ok) {
        if (!(received.error instanceof WechatSessionExpiredError)) {
          throw received.error;
        }
        const expired = { connectionId, generation };
        return accept(
          receiverClient().expire({
            body: expired,
            headers: receiverHeaders(expired),
          }),
          [200],
        );
      }
      pending = received.value;
    }
    if (!pending) {
      throw new Error("Expected a provider batch");
    }
    const delivery = { connectionId, generation, updates: pending };
    const result = await accept(
      receiverClient().deliver({
        body: delivery,
        headers: receiverHeaders(delivery),
      }),
      [200],
    );
    if (!result.body.retryAfterMs) {
      cursor = pending.get_updates_buf ?? cursor;
      pending = null;
    }
    return result;
  };
}
