import { randomUUID } from "node:crypto";

import { accountErasureStatusContract } from "@okouai/api-contracts/contracts/account-erasure-status";
import { LIMITED_FREE1_DEFAULT_RUN_MODEL } from "@okouai/api-contracts/contracts/model-providers";
import { testClerkUserDeletionJobContract } from "@okouai/api-contracts/contracts/test-clerk-user-deletion-job";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { accountErasureStatusRoutes } from "../account-erasure-status";
import { testClerkUserDeletionJobRoutes } from "../test-clerk-user-deletion-job";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  AGENTPHONE_BDD_AGENT_ID,
  createAgentPhoneBddApi,
  uniqueConversationId,
  uniquePhoneHandle,
  type AgentPhoneSendCapture,
} from "./helpers/api-bdd-agentphone";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createSignupClerkDirectory } from "./helpers/agentphone-signup-clerk";
import {
  createChatEventsFixture,
  createGptUsagePricingResolution,
} from "./helpers/chat-events-fixture";
import { piResponsesTextSse } from "./helpers/pi-responses";
import { createRouteMocks } from "./helpers/route-test";
import { seedBuiltInModelKey } from "./helpers/runtime-state";

const context = testContext();
const bdd = createBddApi(context);
const ap = createAgentPhoneBddApi(context);
const integrations = createBddIntegrationApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);

function enableSignup(): void {
  // Configuration-only exception: the anonymous rollout switch is static
  // deployment configuration and cannot be enabled by the per-user API.
  // Every other switch, the webhook, identity, DB, and provisioning stay real.
  context.mocks.overrideAnonymousAgentPhoneSignup(true);
}

function provider(): AgentPhoneSendCapture {
  integrations.configureAgentPhoneProvider();
  integrations.configureAgentPhoneWebhook();
  bdd.acceptAgentStorageWrites();
  context.mocks.ably.publish.mockResolvedValue(undefined);
  return ap.captureAgentPhoneSends();
}

async function createdThreadIds(
  actor: ApiTestUser,
): Promise<readonly string[]> {
  const response = await chat.requestThreadEvents(actor, {}, [200]);
  if (response.status !== 200) {
    throw new Error("Expected the user's chat thread events");
  }
  return response.body.events.flatMap((event) => {
    return event.kind === "created" ? [event.chatThreadId] : [];
  });
}

async function onlyWelcomeThread(actor: ApiTestUser): Promise<string> {
  const threads = await createdThreadIds(actor);
  expect(threads).toHaveLength(1);
  const threadId = threads[0];
  if (!threadId) {
    throw new Error("Expected a welcome thread");
  }
  await expect(
    chat.listThreadEventRows(actor, threadId),
  ).resolves.toMatchObject([
    { seqId: 1, eventType: "output.message", runId: null },
  ]);
  return threadId;
}

function expectWelcome(sends: AgentPhoneSendCapture, phone: string): void {
  expect(
    sends.messages.map((message) => {
      return message.body;
    }),
  ).toStrictEqual([
    expect.stringContaining("Your phone number is now connected to Okou."),
    expect.stringContaining("Save Okou to your contacts"),
    expect.stringContaining("connect the tools you already use"),
    expect.stringContaining("What would you like to start with?"),
  ]);
  expect(
    sends.messages.map((message) => {
      return message.mediaUrls;
    }),
  ).toStrictEqual([
    [],
    [expect.stringMatching(/^https:\/\/static\.vm0\.io\/.+\/okou\.vcf$/u)],
    [],
    [],
  ]);
  expect(
    sends.messages.map((message) => {
      return message.replyToMessageId;
    }),
  ).toStrictEqual([expect.any(String), undefined, undefined, undefined]);
  for (const message of sends.messages) {
    expect(message).toMatchObject({
      agentId: AGENTPHONE_BDD_AGENT_ID,
      toNumber: phone,
      conversationId: undefined,
    });
  }
  expect(
    sends.messages.some((message) => {
      return message.body?.includes("/agentphone/connect?");
    }),
  ).toBeFalsy();
}

function signupMessage(phone: string, messageId = `ap-signup-${randomUUID()}`) {
  return {
    channel: "imessage" as const,
    from: phone,
    body: "signup",
    messageId,
    conversationId: uniqueConversationId(),
  };
}

describe("AgentPhone signup", () => {
  it("registers a phone account with a ready workspace, linked phone, and runless welcome", async () => {
    enableSignup();
    const sends = provider();
    const actor = bdd.user();
    const phone = uniquePhoneHandle();
    createSignupClerkDirectory(context, { actor, phone });

    await ap.postAgentPhoneInboundMessage({
      ...signupMessage(phone),
      body: " \n/SiGnUp\t ",
    });

    // Read the delivered thread before onboarding's lazy repair endpoint.
    const threadId = await onlyWelcomeThread(actor);
    const metadata = await chat.readThreadMetadata(actor, threadId);
    expect(metadata.selectedModel).toStrictEqual(expect.any(String));
    const status = await bdd.readOnboardingStatus(actor);
    expect(status).toMatchObject({
      onboardingComplete: true,
      needsOnboarding: false,
      hasOrg: true,
      hasDefaultAgent: true,
      defaultAgentId: metadata.agentId,
    });
    await expect(
      integrations.getAgentPhoneLinkStatus(actor),
    ).resolves.toMatchObject({
      linked: true,
      phoneHandle: phone,
    });
    const billing = await runs.readBillingStatus(actor);
    expect(billing.tier).toBe("limited-free-1");
    expect(billing.credits).toBeGreaterThan(0);
    expectWelcome(sends, phone);
    expect(context.mocks.clerk.users.createUser).toHaveBeenCalledTimes(1);
    expect(
      context.mocks.clerk.organizations.createOrganization,
    ).toHaveBeenCalledTimes(1);
  });

  it("connects an existing workspace member without granting admin or recreating the workspace", async () => {
    enableSignup();
    const sends = provider();
    const admin = bdd.user();
    const defaultAgentId = await bdd.bootstrapLimitedFreeOnboarding(admin, {
      displayName: "Established workspace",
    });
    if (!admin.orgId) {
      throw new Error("Expected an existing workspace");
    }
    const actor = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
    const phone = uniquePhoneHandle();
    createSignupClerkDirectory(context, {
      actor,
      phone,
      registered: true,
      memberships: [
        { orgId: admin.orgId, role: "org:member", createdBy: admin.userId },
      ],
    });

    await ap.postAgentPhoneInboundMessage(signupMessage(phone));

    const seconds = Math.floor(now() / 1000);
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId: actor.userId,
      orgId: admin.orgId,
      runId: `run_${randomUUID()}`,
      capabilities: ["agent:read"],
      iat: seconds,
      exp: seconds + 60,
    });
    const org = await createAuthOrgAgentsBddApi(
      context,
    ).requestReadOrgWithBearer(token, [200]);
    expect(org.body).toMatchObject({ id: admin.orgId, role: "member" });
    const threadId = await onlyWelcomeThread(actor);
    await expect(
      chat.readThreadMetadata(actor, threadId),
    ).resolves.toMatchObject({
      agentId: defaultAgentId,
    });
    await expect(
      integrations.getAgentPhoneLinkStatus(actor),
    ).resolves.toMatchObject({ linked: true, phoneHandle: phone });
    expectWelcome(sends, phone);
    expect(context.mocks.clerk.users.createUser).not.toHaveBeenCalled();
    expect(
      context.mocks.clerk.organizations.createOrganization,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.clerk.organizations.updateOrganizationMembership,
    ).not.toHaveBeenCalled();
  });

  it("executes the first ordinary phone message on the welcome thread without an onboarding visit", async () => {
    enableSignup();
    const sends = provider();
    ap.acceptAgentPhoneObjectStorage();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    const pi = createChatEventsFixture(context);
    pi.mockPiResourceArchiveDownloads();
    pi.mockPiCheckpointObjectStore();
    const pricing = await createGptUsagePricingResolution();
    await seedBuiltInModelKey(context, LIMITED_FREE1_DEFAULT_RUN_MODEL);
    const answer = "Start by listing tomorrow's meetings and their priorities.";
    const modelRequests: unknown[] = [];
    server.use(
      http.post("https://api.openai.com/v1/responses", async ({ request }) => {
        modelRequests.push(await request.json());
        return new HttpResponse(piResponsesTextSse(answer, 1), {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    const actor = bdd.user();
    const phone = uniquePhoneHandle();
    createSignupClerkDirectory(context, { actor, phone });
    const signup = signupMessage(phone);
    await ap.postAgentPhoneInboundMessage(signup);
    expect(modelRequests).toHaveLength(0);
    const prompt = "Help me plan tomorrow's meetings";
    await ap.postAgentPhoneInboundMessage(
      {
        ...signup,
        messageId: `ap-message-${randomUUID()}`,
        body: prompt,
      },
      pricing,
    );

    expect(modelRequests).toStrictEqual([
      expect.objectContaining({ model: LIMITED_FREE1_DEFAULT_RUN_MODEL }),
    ]);
    expect(JSON.stringify(modelRequests[0])).toContain(prompt);
    expect(sends.messages.at(-1)).toMatchObject({
      toNumber: phone,
      body: answer,
    });
    const threadIds = await createdThreadIds(actor);
    expect(threadIds).toHaveLength(1);
    const threadId = threadIds[0];
    if (!threadId) {
      throw new Error("Expected the canonical welcome thread");
    }
    const events = await chat.listThreadEventRows(actor, threadId);
    const runId = events.find((event) => {
      return event.eventType === "run.completed";
    })?.runId;
    if (!runId) {
      throw new Error("Expected signup's first ordinary DM to execute a run");
    }
    expect(events).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          seqId: 1,
          eventType: "output.message",
          runId: null,
        }),
        expect.objectContaining({ eventType: "input.prompt", runId }),
        expect.objectContaining({ eventType: "output.message", runId }),
        expect.objectContaining({ eventType: "run.completed", runId }),
      ]),
    );
    await expect(runs.readRun(actor, runId)).resolves.toMatchObject({
      status: "completed",
    });
    const metadata = await chat.readThreadMetadata(actor, threadId);
    expect(metadata.selectedModel).toBe(LIMITED_FREE1_DEFAULT_RUN_MODEL);
    await expect(bdd.readOnboardingStatus(actor)).resolves.toMatchObject({
      defaultAgentId: metadata.agentId,
      onboardingComplete: true,
    });
    await expect(runs.readBillingStatus(actor)).resolves.toMatchObject({
      tier: "limited-free-1",
    });
  });

  it("deduplicates concurrent webhook deliveries and resends welcome for a new signup message", async () => {
    enableSignup();
    const sends = provider();
    const actor = bdd.user();
    const phone = uniquePhoneHandle();
    const directory = createSignupClerkDirectory(context, { actor, phone });
    const message = signupMessage(phone);

    await Promise.all([
      ap.postAgentPhoneInboundMessage(message),
      ap.postAgentPhoneInboundMessage(message),
    ]);
    const threadId = await onlyWelcomeThread(actor);
    const before = await runs.readBillingStatus(actor);
    const firstWelcome = [...sends.messages];
    expectWelcome(sends, phone);
    directory.apply();

    await ap.postAgentPhoneInboundMessage(message);
    expect(sends.messages).toStrictEqual(firstWelcome);
    await ap.postAgentPhoneInboundMessage({
      ...message,
      messageId: `ap-signup-${randomUUID()}`,
    });

    expect(sends.messages).toHaveLength(firstWelcome.length * 2);
    expectWelcome(
      {
        messages: sends.messages.slice(firstWelcome.length),
        typing: sends.typing,
      },
      phone,
    );
    await expect(createdThreadIds(actor)).resolves.toStrictEqual([threadId]);
    const after = await runs.readBillingStatus(actor);
    expect(after.credits).toBe(before.credits);
    expect(after.creditGrants).toStrictEqual(before.creditGrants);
    expect(context.mocks.clerk.users.createUser).toHaveBeenCalledTimes(1);
    expect(
      context.mocks.clerk.organizations.createOrganization,
    ).toHaveBeenCalledTimes(1);
  });

  it("welcomes an already connected account without requiring a Clerk phone or recreating its workspace", async () => {
    enableSignup();
    const sends = provider();
    const actor = bdd.user();
    const phone = uniquePhoneHandle();
    if (!actor.orgId) {
      throw new Error("Expected an existing workspace");
    }
    const directory = createSignupClerkDirectory(context, {
      actor,
      phone,
      registered: true,
      hasPhone: false,
      memberships: [{ orgId: actor.orgId, role: "org:admin" }],
    });
    await bdd.bootstrapLimitedFreeOnboarding(actor, {
      displayName: "Existing connected workspace",
    });
    await ap.linkViaWebhookConnectPrompt(actor, phone, sends);
    const sentBefore = sends.messages.length;
    directory.apply();

    await ap.postAgentPhoneInboundMessage(signupMessage(phone));

    expectWelcome(
      { messages: sends.messages.slice(sentBefore), typing: sends.typing },
      phone,
    );
    await onlyWelcomeThread(actor);
    await expect(
      integrations.getAgentPhoneLinkStatus(actor),
    ).resolves.toMatchObject({ linked: true, phoneHandle: phone });
    expect(context.mocks.clerk.users.createUser).not.toHaveBeenCalled();
    expect(
      context.mocks.clerk.organizations.createOrganization,
    ).not.toHaveBeenCalled();
  });

  it("converges simultaneous signup messages from one phone on one account, workspace, and welcome thread", async () => {
    enableSignup();
    const sends = provider();
    const actor = bdd.user();
    const phone = uniquePhoneHandle();
    const directory = createSignupClerkDirectory(context, { actor, phone });
    const first = signupMessage(phone);
    const second = { ...first, messageId: `ap-signup-${randomUUID()}` };

    await Promise.all([
      ap.postAgentPhoneInboundMessage(first),
      ap.postAgentPhoneInboundMessage(second),
    ]);
    // One of the competing attempts may need its ordinary provider replay.
    await ap.postAgentPhoneInboundMessage(first);
    await ap.postAgentPhoneInboundMessage(second);

    await onlyWelcomeThread(actor);
    await expect(
      integrations.getAgentPhoneLinkStatus(actor),
    ).resolves.toMatchObject({ linked: true, phoneHandle: phone });
    expect(directory.createdUserIds).toStrictEqual([actor.userId]);
    expect(directory.createdOrganizationIds).toStrictEqual([actor.orgId]);
    expect(sends.messages).toHaveLength(8);
    const welcome = sends.messages.filter((message, index) => {
      return (
        sends.messages.findIndex((candidate) => {
          return candidate.body === message.body;
        }) === index
      );
    });
    // The two explicit requests can interleave, but each complete sequence
    // must arrive exactly once and only its first part replies to the request.
    expectWelcome({ messages: welcome, typing: sends.typing }, phone);
    for (const part of welcome) {
      expect(
        sends.messages.filter((message) => {
          return message.body === part.body;
        }),
      ).toHaveLength(2);
    }
    expect(
      sends.messages
        .flatMap((message) => {
          return message.replyToMessageId ? [message.replyToMessageId] : [];
        })
        .sort(),
    ).toStrictEqual([first.messageId, second.messageId].sort());
  });

  it("resumes a failed workspace creation from the same message without recreating its user", async () => {
    enableSignup();
    const sends = provider();
    const actor = bdd.user();
    const phone = uniquePhoneHandle();
    const directory = createSignupClerkDirectory(context, { actor, phone });
    context.mocks.clerk.organizations.createOrganization.mockRejectedValueOnce(
      Object.assign(new Error("Clerk rate limit"), { status: 429 }),
    );
    const message = signupMessage(phone);

    await ap.postAgentPhoneInboundMessage(message);
    await expect(
      integrations.getAgentPhoneLinkStatus(actor),
    ).resolves.toMatchObject({ linked: false });
    directory.apply();
    await ap.postAgentPhoneInboundMessage(message);

    await onlyWelcomeThread(actor);
    await expect(
      integrations.getAgentPhoneLinkStatus(actor),
    ).resolves.toMatchObject({ linked: true, phoneHandle: phone });
    expectWelcome(sends, phone);
    expect(context.mocks.clerk.users.createUser).toHaveBeenCalledTimes(1);
    expect(
      context.mocks.clerk.organizations.createOrganization,
    ).toHaveBeenCalledTimes(2);
  });

  it("stops retrying a refused workspace creation after five attempts despite saving the user checkpoint", async () => {
    enableSignup();
    const sends = provider();
    const actor = bdd.user();
    const phone = uniquePhoneHandle();
    const directory = createSignupClerkDirectory(context, { actor, phone });
    context.mocks.clerk.organizations.createOrganization.mockRejectedValue(
      Object.assign(new Error("Clerk rate limit"), { status: 429 }),
    );
    const message = signupMessage(phone);

    for (let delivery = 0; delivery < 8; delivery += 1) {
      await ap.postAgentPhoneInboundMessage(message);
    }

    expect(context.mocks.clerk.users.createUser).toHaveBeenCalledTimes(1);
    expect(
      context.mocks.clerk.organizations.createOrganization,
    ).toHaveBeenCalledTimes(5);
    expect(directory.createdOrganizationIds).toStrictEqual([]);
    expect(sends.messages).toHaveLength(0);
  });

  it("does not create a replacement when the pinned Clerk user disappears after partial signup", async () => {
    enableSignup();
    const sends = provider();
    const actor = bdd.user();
    const phone = uniquePhoneHandle();
    const directory = createSignupClerkDirectory(context, { actor, phone });
    context.mocks.clerk.organizations.createOrganization.mockRejectedValueOnce(
      Object.assign(new Error("Clerk rate limit"), { status: 429 }),
    );
    const message = signupMessage(phone);

    await ap.postAgentPhoneInboundMessage(message);
    directory.removeUser();
    await ap.postAgentPhoneInboundMessage(message);
    await ap.postAgentPhoneInboundMessage(message);

    expect(context.mocks.clerk.users.createUser).toHaveBeenCalledTimes(1);
    expect(directory.createdUserIds).toStrictEqual([actor.userId]);
    expect(directory.createdOrganizationIds).toStrictEqual([]);
    expect(sends.messages).toHaveLength(1);
    expect(sends.messages[0]?.body).toContain("unavailable");
  });

  it("does not replace a phone account erased before its initial identity checkpoint", async () => {
    enableSignup();
    const sends = provider();
    const actor = bdd.user();
    const phone = uniquePhoneHandle();
    const directory = createSignupClerkDirectory(context, {
      actor,
      phone,
      registered: true,
    });
    const erasure = setupApp({ context, routes: accountErasureStatusRoutes })(
      accountErasureStatusContract,
    );
    createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
    const capability = await accept(
      erasure.capability({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const statusHeaders = {
      authorization: `Bearer ${capability.body.token}`,
    };
    const deletion = setupApp({
      context,
      routes: testClerkUserDeletionJobRoutes,
    })(testClerkUserDeletionJobContract);
    const readUsers =
      context.mocks.clerk.users.getUserList.getMockImplementation();
    if (!readUsers) {
      throw new Error("Expected the external Clerk directory fixture");
    }
    context.mocks.s3.send.mockResolvedValue({});
    const webhooks = createWebhookCallbackApi(context);
    webhooks.configureClerkWebhookSecret();
    context.mocks.clerk.users.getUserList.mockImplementationOnce(
      async (...args: unknown[]) => {
        const matchedUsers = await readUsers(...args);
        directory.removeUser();
        webhooks.verifyNextClerkWebhook({
          type: "user.deleted",
          data: { id: actor.userId, deleted: true },
        });
        // Wait for observable erasure completion before releasing the stale
        // lookup response. Flushing waitUntil here would await this same
        // signup worker, so advance only the deleted user's owned job.
        await webhooks.requestClerkWebhook("{}", {}, [200]);
        await vi.waitFor(
          async () => {
            const status = await accept(
              erasure.status({ headers: statusHeaders }),
              [200],
            );
            if (status.body.status === "complete") {
              return;
            }
            await accept(
              deletion.retry({ body: { userId: actor.userId } }),
              [200],
            );
            const advanced = await accept(
              erasure.status({ headers: statusHeaders }),
              [200],
            );
            expect(advanced.body.status).toBe("complete");
          },
          { timeout: 10_000, interval: 100 },
        );
        return matchedUsers;
      },
    );
    const message = signupMessage(phone);

    await ap.postAgentPhoneInboundMessage(message);
    await ap.postAgentPhoneInboundMessage(message);
    await ap.postAgentPhoneInboundMessage(message);

    expect(context.mocks.clerk.users.createUser).not.toHaveBeenCalled();
    expect(
      context.mocks.clerk.organizations.createOrganization,
    ).not.toHaveBeenCalled();
    expect(sends.messages).toHaveLength(0);
    await expect(
      integrations.getAgentPhoneLinkStatus(actor),
    ).resolves.toMatchObject({ linked: false });
    await expect(createdThreadIds(actor)).resolves.toStrictEqual([]);
  });

  it("does not recreate an erased account from its original signup webhook", async () => {
    enableSignup();
    const sends = provider();
    const actor = bdd.user();
    const phone = uniquePhoneHandle();
    const directory = createSignupClerkDirectory(context, { actor, phone });
    const message = signupMessage(phone);
    await ap.postAgentPhoneInboundMessage(message);
    await onlyWelcomeThread(actor);
    const originalWelcomeCount = sends.messages.length;
    const erasure = setupApp({ context, routes: accountErasureStatusRoutes })(
      accountErasureStatusContract,
    );
    createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
    const capability = await accept(
      erasure.capability({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const statusHeaders = {
      authorization: `Bearer ${capability.body.token}`,
    };
    directory.removeUser();
    directory.apply();
    context.mocks.s3.send.mockResolvedValue({});
    const webhooks = createWebhookCallbackApi(context);
    webhooks.configureClerkWebhookSecret();
    webhooks.verifyNextClerkWebhook({
      type: "user.deleted",
      data: { id: actor.userId, deleted: true },
    });
    await webhooks.requestClerkWebhook("{}", {}, [200]);
    await flushWaitUntilForTest();
    // The existing owned-job harness advances erasure's verification phase
    // without running the production cron over other tests' identities.
    const deletion = setupApp({
      context,
      routes: testClerkUserDeletionJobRoutes,
    })(testClerkUserDeletionJobContract);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const status = await accept(
        erasure.status({ headers: statusHeaders }),
        [200],
      );
      if (status.body.status === "complete") {
        break;
      }
      await accept(deletion.retry({ body: { userId: actor.userId } }), [200]);
    }
    const erased = await accept(
      erasure.status({ headers: statusHeaders }),
      [200],
    );
    expect(erased.body.status).toBe("complete");

    // A future Clerk registration has a different identity, even when the
    // person intentionally signs up again using the same phone number.
    const replacement = bdd.user();
    createSignupClerkDirectory(context, { actor: replacement, phone });
    await ap.postAgentPhoneInboundMessage(message);
    await ap.postAgentPhoneInboundMessage(message);

    expect(sends.messages).toHaveLength(originalWelcomeCount);
    expect(context.mocks.clerk.users.createUser).toHaveBeenCalledTimes(1);
    await ap.postAgentPhoneInboundMessage({
      ...message,
      messageId: `ap-signup-${randomUUID()}`,
    });
    await onlyWelcomeThread(replacement);
    await expect(
      integrations.getAgentPhoneLinkStatus(replacement),
    ).resolves.toMatchObject({ linked: true, phoneHandle: phone });
    expect(context.mocks.clerk.users.createUser).toHaveBeenCalledTimes(2);
  });

  it("retries an explicitly refused welcome without recreating the account, credits, or Web thread", async () => {
    enableSignup();
    const sends = provider();
    const actor = bdd.user();
    const phone = uniquePhoneHandle();
    const directory = createSignupClerkDirectory(context, { actor, phone });
    server.use(
      http.post(
        "https://api.agentphone.test/v1/messages",
        () => {
          return HttpResponse.json({ detail: "Rate limited" }, { status: 429 });
        },
        { once: true },
      ),
    );
    const message = signupMessage(phone);

    await ap.postAgentPhoneInboundMessage(message);
    expect(sends.messages).toHaveLength(0);
    const threadId = await onlyWelcomeThread(actor);
    const before = await runs.readBillingStatus(actor);
    directory.apply();
    await ap.postAgentPhoneInboundMessage(message);

    expectWelcome(sends, phone);
    await expect(createdThreadIds(actor)).resolves.toStrictEqual([threadId]);
    const after = await runs.readBillingStatus(actor);
    expect(after.credits).toBe(before.credits);
    expect(after.creditGrants).toStrictEqual(before.creditGrants);
    expect(context.mocks.clerk.users.createUser).toHaveBeenCalledTimes(1);
    expect(
      context.mocks.clerk.organizations.createOrganization,
    ).toHaveBeenCalledTimes(1);
  });

  it("resumes a refused second welcome part without resending the acknowledged first part", async () => {
    enableSignup();
    const sends = provider();
    const actor = bdd.user();
    const phone = uniquePhoneHandle();
    const directory = createSignupClerkDirectory(context, { actor, phone });
    let deliveryAttempts = 0;
    server.use(
      http.post("https://api.agentphone.test/v1/messages", () => {
        deliveryAttempts += 1;
        if (deliveryAttempts === 2) {
          return HttpResponse.json({ detail: "Rate limited" }, { status: 429 });
        }
        return undefined;
      }),
    );
    const message = signupMessage(phone);

    await ap.postAgentPhoneInboundMessage(message);

    expect(deliveryAttempts).toBe(2);
    expect(sends.messages).toHaveLength(1);
    expect(sends.messages[0]).toMatchObject({
      body: expect.stringContaining("Your phone number is now connected"),
      replyToMessageId: message.messageId,
      mediaUrls: [],
    });
    const threadId = await onlyWelcomeThread(actor);
    directory.apply();
    await ap.postAgentPhoneInboundMessage(message);

    expect(deliveryAttempts).toBe(5);
    expectWelcome(sends, phone);
    await expect(createdThreadIds(actor)).resolves.toStrictEqual([threadId]);
    await ap.postAgentPhoneInboundMessage(message);

    expect(deliveryAttempts).toBe(5);
    expectWelcome(sends, phone);
    expect(context.mocks.clerk.users.createUser).toHaveBeenCalledTimes(1);
    expect(
      context.mocks.clerk.organizations.createOrganization,
    ).toHaveBeenCalledTimes(1);
  });

  it("does not resend an ambiguously delivered welcome on replay but accepts a new signup request", async () => {
    enableSignup();
    const sends = provider();
    const actor = bdd.user();
    const phone = uniquePhoneHandle();
    const directory = createSignupClerkDirectory(context, { actor, phone });
    const attemptedDeliveries: unknown[] = [];
    server.use(
      http.post(
        "https://api.agentphone.test/v1/messages",
        async ({ request }) => {
          attemptedDeliveries.push(await request.json());
          return HttpResponse.error();
        },
        { once: true },
      ),
    );
    const message = signupMessage(phone);

    await ap.postAgentPhoneInboundMessage(message);
    const threadId = await onlyWelcomeThread(actor);
    directory.apply();
    await ap.postAgentPhoneInboundMessage(message);
    await ap.postAgentPhoneInboundMessage(message);

    expect(attemptedDeliveries).toHaveLength(1);
    expect(sends.messages).toHaveLength(0);
    await ap.postAgentPhoneInboundMessage({
      ...message,
      messageId: `ap-signup-${randomUUID()}`,
    });

    expectWelcome(sends, phone);
    await expect(createdThreadIds(actor)).resolves.toStrictEqual([threadId]);
    expect(directory.createdUserIds).toStrictEqual([actor.userId]);
    expect(directory.createdOrganizationIds).toStrictEqual([actor.orgId]);
  });

  it("preserves an explicit disconnect when the original signup retries its refused welcome", async () => {
    enableSignup();
    const sends = provider();
    const actor = bdd.user();
    const phone = uniquePhoneHandle();
    const directory = createSignupClerkDirectory(context, { actor, phone });
    server.use(
      http.post(
        "https://api.agentphone.test/v1/messages",
        () => {
          return HttpResponse.json({ detail: "Rate limited" }, { status: 429 });
        },
        { once: true },
      ),
    );
    const message = signupMessage(phone);

    await ap.postAgentPhoneInboundMessage(message);
    expect(sends.messages).toHaveLength(0);
    await expect(
      integrations.getAgentPhoneLinkStatus(actor),
    ).resolves.toMatchObject({ linked: true, phoneHandle: phone });
    await integrations.requestUnlinkAgentPhone(actor, [204]);
    directory.apply();

    await ap.postAgentPhoneInboundMessage(message);
    await ap.postAgentPhoneInboundMessage(message);

    expect(sends.messages).toHaveLength(0);
    await expect(
      integrations.getAgentPhoneLinkStatus(actor),
    ).resolves.toMatchObject({ linked: false });
    directory.apply();
    await ap.postAgentPhoneInboundMessage({
      ...message,
      messageId: `ap-signup-${randomUUID()}`,
    });

    expectWelcome(sends, phone);
    await expect(
      integrations.getAgentPhoneLinkStatus(actor),
    ).resolves.toMatchObject({ linked: true, phoneHandle: phone });
    expect(directory.createdUserIds).toStrictEqual([actor.userId]);
    expect(directory.createdOrganizationIds).toStrictEqual([actor.orgId]);
  });

  it("keeps the signed connect flow while the rollout switch is off", async () => {
    const sends = provider();
    const actor = bdd.user();
    const phone = uniquePhoneHandle();
    createSignupClerkDirectory(context, { actor, phone });

    await ap.postAgentPhoneInboundMessage(signupMessage(phone));

    expect(sends.messages.at(-1)?.body).toContain("/agentphone/connect?");
    expect(context.mocks.clerk.users.createUser).not.toHaveBeenCalled();
    expect(
      context.mocks.clerk.organizations.createOrganization,
    ).not.toHaveBeenCalled();
  });

  it("does not auto-register or send a private account welcome into an iMessage group", async () => {
    enableSignup();
    const sends = provider();
    const actor = bdd.user();
    const phone = uniquePhoneHandle();
    createSignupClerkDirectory(context, { actor, phone });

    await ap.postAgentPhoneInboundMessage({
      ...signupMessage(phone),
      isGroup: true,
      mentions: [{ text: "@okou" }],
    });

    expect(sends.messages).toHaveLength(0);
    expect(context.mocks.clerk.users.createUser).not.toHaveBeenCalled();
    expect(
      context.mocks.clerk.organizations.createOrganization,
    ).not.toHaveBeenCalled();
  });

  it.each([
    { label: "SMS", channel: "sms" as const, email: false, body: "signup" },
    {
      label: "Apple ID email",
      channel: "imessage" as const,
      email: true,
      body: "signup",
    },
    {
      label: "ordinary text containing signup",
      channel: "imessage" as const,
      email: false,
      body: "please signup",
    },
  ])(
    "uses signed connect for $label without creating an identity",
    async ({ channel, email, body }) => {
      enableSignup();
      const sends = provider();
      const actor = bdd.user();
      const phone = email
        ? `phone-${randomUUID()}@example.test`
        : uniquePhoneHandle();
      createSignupClerkDirectory(context, { actor, phone });

      await ap.postAgentPhoneInboundMessage({
        ...signupMessage(phone),
        channel,
        body,
      });

      expect(sends.messages.at(-1)?.body).toContain("/agentphone/connect?");
      expect(context.mocks.clerk.users.createUser).not.toHaveBeenCalled();
      expect(
        context.mocks.clerk.organizations.createOrganization,
      ).not.toHaveBeenCalled();
    },
  );

  it("asks a user with multiple workspaces to connect explicitly without choosing one", async () => {
    enableSignup();
    const sends = provider();
    const actor = bdd.user();
    const otherOrgId = `org_${randomUUID()}`;
    if (!actor.orgId) {
      throw new Error("Expected workspace identity");
    }
    const phone = uniquePhoneHandle();
    createSignupClerkDirectory(context, {
      actor,
      phone,
      registered: true,
      memberships: [
        { orgId: actor.orgId, role: "org:admin" },
        { orgId: otherOrgId, role: "org:member" },
      ],
    });

    await ap.postAgentPhoneInboundMessage(signupMessage(phone));

    expect(sends.messages.at(-1)?.body).toContain("/agentphone/connect?");
    await expect(
      integrations.getAgentPhoneLinkStatus(actor),
    ).resolves.toMatchObject({ linked: false });
    await expect(
      integrations.getAgentPhoneLinkStatus({ ...actor, orgId: otherOrgId }),
    ).resolves.toMatchObject({ linked: false });
    expect(context.mocks.clerk.users.createUser).not.toHaveBeenCalled();
    expect(
      context.mocks.clerk.organizations.createOrganization,
    ).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "unverified phone",
      verification: "unverified" as const,
      banned: false,
    },
    { label: "missing phone verification", verification: null, banned: false },
    {
      label: "banned account",
      verification: "verified" as const,
      banned: true,
    },
  ])(
    "does not auto-connect an existing $label",
    async ({ verification, banned }) => {
      enableSignup();
      provider();
      const actor = bdd.user();
      if (!actor.orgId) {
        throw new Error("Expected workspace identity");
      }
      const phone = uniquePhoneHandle();
      createSignupClerkDirectory(context, {
        actor,
        phone,
        registered: true,
        verification,
        banned,
        memberships: [{ orgId: actor.orgId, role: "org:admin" }],
      });

      await ap.postAgentPhoneInboundMessage(signupMessage(phone));

      await expect(
        integrations.getAgentPhoneLinkStatus(actor),
      ).resolves.toMatchObject({ linked: false });
      expect(context.mocks.clerk.users.createUser).not.toHaveBeenCalled();
      expect(
        context.mocks.clerk.organizations.createOrganization,
      ).not.toHaveBeenCalled();
    },
  );
});
