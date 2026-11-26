import { randomUUID } from "node:crypto";

import { billingUsagePackCreditsContract } from "@okouai/api-contracts/contracts/billing";
import { GET_STARTED_REWARDS_CHANGED_EVENT } from "@okouai/api-contracts/contracts/get-started";
import { HttpResponse, http } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  AGENTPHONE_BDD_AGENT_ID,
  AGENTPHONE_BDD_PHONE_NUMBER,
  bddGroupId,
  createAgentPhoneBddApi,
  uniqueConversationId,
  uniquePhoneHandle,
  type AgentPhoneSendCapture,
} from "./helpers/api-bdd-agentphone";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import {
  marketingRewardConsumer,
  settleMarketingRequest,
} from "./helpers/marketing-reward-consumer";
import { channelsPublishedTo } from "./helpers/realtime-publications";
import { createRouteMocks } from "./helpers/route-test";
import {
  generatedStripeCustomerId,
  generatedStripeSubscriptionId,
  postSubscriptionInvoicePaid,
} from "./helpers/stripe-billing-webhook";

const context = testContext();

const AGENTPHONE_API_BASE_URL = "https://api.agentphone.test";
const AUTH_HEADERS = Object.freeze({ authorization: "Bearer clerk-session" });

function expectProp<T extends object, K extends string>(
  body: T,
  key: K,
): Extract<T, Record<K, unknown>> {
  if (!(key in body)) {
    throw new Error(`Expected property ${key} on response body`);
  }
  const hasKey = (value: T): value is Extract<T, Record<K, unknown>> => {
    return key in value;
  };
  if (!hasKey(body)) {
    throw new Error(`Expected property ${key} on response body`);
  }
  return body;
}

function expectErrorBody(body: object): {
  readonly error: { readonly message: string; readonly code: string };
} {
  if (
    !("error" in body) ||
    typeof body.error !== "object" ||
    body.error === null ||
    !("code" in body.error) ||
    typeof body.error.code !== "string" ||
    !("message" in body.error) ||
    typeof body.error.message !== "string"
  ) {
    throw new Error("Expected error body");
  }
  return { error: { code: body.error.code, message: body.error.message } };
}

function expectLinkedPhoneHandle(
  status:
    | { readonly linked: true; readonly phoneHandle: string }
    | { readonly linked: false },
): string {
  if (!status.linked) {
    throw new Error("Expected linked AgentPhone status");
  }
  return status.phoneHandle;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function firstHttpsUrl(text: string | undefined): URL {
  if (!text) {
    throw new Error("Expected message text containing an HTTPS URL");
  }
  const token = text.split(/\s+/u).find((part) => {
    return part.startsWith("https://");
  });
  if (!token) {
    throw new Error(`Expected an HTTPS URL in: ${text}`);
  }
  return new URL(token);
}

function connectRequestFromPrompt(text: string | undefined) {
  const url = firstHttpsUrl(text);
  const timestamp = Number(url.searchParams.get("ts") ?? "");
  if (!Number.isFinite(timestamp)) {
    throw new Error("Expected finite ts query parameter in connect URL");
  }
  return {
    phoneHandle: url.searchParams.get("handle") ?? "",
    agentphoneAgentId: url.searchParams.get("agent") ?? "",
    timestamp,
    signature: url.searchParams.get("sig") ?? "",
    channel: url.searchParams.get("channel") ?? undefined,
  };
}

function setupAgentPhoneSuite() {
  onTestFinished(() => {
    clearMockNow();
  });
  mockEnv("APP_URL", "https://app.okou.test");
  mockEnv("ENV", "development");
  const bdd = createBddApi(context);
  const integrations = createBddIntegrationApi(context);
  const agentPhone = createAgentPhoneBddApi(context);
  integrations.configureAgentPhoneProvider();
  integrations.configureAgentPhoneWebhook();
  const sends = agentPhone.captureAgentPhoneSends();
  const reactions = agentPhone.captureAgentPhoneReactions();

  async function linkWithCode(
    actor: ApiTestUser,
    handle: string,
    channel: "imessage" | "sms" = "imessage",
  ) {
    const issued = await integrations.requestCreateAgentPhoneLinkCode(
      actor,
      [200],
    );
    await agentPhone.postAgentPhoneInboundMessage({
      channel,
      from: handle,
      body: issued.body.code,
    });
    return issued.body;
  }

  function overrideConversationRoster(
    conversationId: string,
    participants: readonly string[],
  ): void {
    server.use(
      http.get(
        `${AGENTPHONE_API_BASE_URL}/v1/conversations/:id`,
        ({ params }) => {
          if (String(params.id) !== conversationId) {
            return HttpResponse.json({ participants: [] });
          }
          return HttpResponse.json({
            participants: participants.map((identifier) => {
              return { identifier, name: null };
            }),
          });
        },
      ),
    );
  }

  function mockWorkspaceName(actor: ApiTestUser, name: string): void {
    context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
      id: actor.orgId,
      slug: `org-${(actor.orgId ?? "ws").slice(-8)}`,
      name,
      createdBy: actor.userId,
    });
  }

  async function provisionProMember(
    actor: ApiTestUser,
    workspaceName?: string,
  ): Promise<void> {
    if (!actor.orgId) {
      throw new Error("Expected organization on Pro member");
    }
    await postSubscriptionInvoicePaid(context.signal, {
      orgId: actor.orgId,
      userId: actor.userId,
      tier: "pro",
      customerId: generatedStripeCustomerId(),
      subscriptionId: generatedStripeSubscriptionId(),
      currentPeriodEnd: new Date(now() + 30 * 24 * 60 * 60 * 1000),
    });
    if (workspaceName) {
      mockWorkspaceName(actor, workspaceName);
    }
  }

  return {
    bdd,
    integrations,
    agentPhone,
    sends,
    reactions,
    linkWithCode,
    overrideConversationRoster,
    mockWorkspaceName,
    provisionProMember,
  };
}

function expectThreePartWelcome(
  messages: AgentPhoneSendCapture["messages"],
  toHandle: string,
  firstReplyToMessageId?: string,
): void {
  expect(messages).toHaveLength(3);
  const [first, second, third] = messages;
  expect(first?.toNumber).toBe(toHandle);
  expect(first?.conversationId).toBeUndefined();
  expect(first?.mediaUrl).toBeUndefined();
  expect(first?.mediaUrls).toStrictEqual([]);
  expect(first?.body).toContain("Your phone number is now connected to Okou.");
  if (firstReplyToMessageId !== undefined) {
    expect(first?.replyToMessageId).toBe(firstReplyToMessageId);
  }
  expect(second?.toNumber).toBe(toHandle);
  expect(second?.conversationId).toBeUndefined();
  expect(second?.replyToMessageId).toBeUndefined();
  expect(second?.mediaUrl).toBeUndefined();
  expect(second?.mediaUrls).toStrictEqual([]);
  expect(second?.body).toBeTruthy();
  expect(third?.toNumber).toBe(toHandle);
  expect(third?.conversationId).toBeUndefined();
  expect(third?.replyToMessageId).toBeUndefined();
  expect(third?.mediaUrl).toBeUndefined();
  expect(third?.mediaUrls).toStrictEqual([]);
  expect(third?.body).toContain("What would you like to start with?");
}

describe("INT-03: AgentPhone linked-run lifecycle through public APIs", () => {
  it("agentphone.bdd-059 links an AgentPhone user through the provider connect prompt", async () => {
    const suite = setupAgentPhoneSuite();
    const owner = suite.bdd.user();
    const phone = uniquePhoneHandle();

    await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: "hi",
    });
    const prompt = suite.sends.messages.at(-1);
    const connectBody = connectRequestFromPrompt(prompt?.body);
    await suite.integrations.requestConnectAgentPhone(
      owner,
      connectBody,
      [200],
    );

    expect(suite.sends.messages.at(-1)?.toNumber).toBe(phone);
    expect(suite.sends.messages.at(-1)?.agentId).toBe(AGENTPHONE_BDD_AGENT_ID);
    const status = await suite.integrations.getAgentPhoneLinkStatus(owner);
    expect(status.linked).toBeTruthy();
    expect(expectLinkedPhoneHandle(status)).toBe(phone);
  });

  it("agentphone.bdd-005 lets a recipient add an iMessage reaction to a group message received before connecting", async () => {
    const suite = setupAgentPhoneSuite();
    const firstUser = suite.bdd.user();
    const secondUser = suite.bdd.user();
    const firstPhone = uniquePhoneHandle();
    const secondPhone = uniquePhoneHandle();
    const conversationId = uniqueConversationId();

    await suite.agentPhone.linkViaWebhookConnectPrompt(
      firstUser,
      firstPhone,
      suite.sends,
    );
    const messageId = await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: firstPhone,
      body: "The launch went well",
      conversationId,
      isGroup: true,
      participants: [
        { identifier: firstPhone },
        { identifier: secondPhone },
        { identifier: AGENTPHONE_BDD_PHONE_NUMBER },
      ],
    });

    await suite.agentPhone.linkViaWebhookConnectPrompt(
      secondUser,
      secondPhone,
      suite.sends,
    );

    const response = await suite.integrations.requestSendPhoneReaction(
      secondUser,
      { messageId, reaction: "love" },
      [200],
    );
    expect(expectProp(response.body, "ok").ok).toBeTruthy();
    expect(suite.reactions).toStrictEqual([{ messageId, reaction: "love" }]);
  });

  it("agentphone.bdd-006 denies iMessage reactions to another account's dm", async () => {
    const suite = setupAgentPhoneSuite();
    const owner = suite.bdd.user();
    const sameOrgPeer = suite.bdd.user({ orgId: owner.orgId });
    const foreignOrgOwner = suite.bdd.user({ userId: owner.userId });
    const ownerPhone = uniquePhoneHandle();
    const peerPhone = uniquePhoneHandle();

    await suite.agentPhone.linkViaWebhookConnectPrompt(
      owner,
      ownerPhone,
      suite.sends,
    );
    await suite.agentPhone.linkViaWebhookConnectPrompt(
      sameOrgPeer,
      peerPhone,
      suite.sends,
    );
    const messageId = await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: ownerPhone,
      body: "/help",
    });

    await suite.integrations.requestSendPhoneReaction(
      sameOrgPeer,
      { messageId, reaction: "like" },
      [404],
    );
    await suite.integrations.requestSendPhoneReaction(
      foreignOrgOwner,
      { messageId, reaction: "like" },
      [404],
    );
    await suite.integrations.requestSendPhoneReaction(
      null,
      { messageId, reaction: "like" },
      [401],
    );
    expect(suite.reactions).toHaveLength(0);
  });

  it("agentphone.bdd-007 denies iMessage reactions to another account's group", async () => {
    const suite = setupAgentPhoneSuite();
    const owner = suite.bdd.user();
    const sameOrgPeer = suite.bdd.user({ orgId: owner.orgId });
    const foreignOrgOwner = suite.bdd.user({ userId: owner.userId });
    const ownerPhone = uniquePhoneHandle();
    const peerPhone = uniquePhoneHandle();
    const conversationId = uniqueConversationId();

    await suite.agentPhone.linkViaWebhookConnectPrompt(
      owner,
      ownerPhone,
      suite.sends,
    );
    await suite.agentPhone.linkViaWebhookConnectPrompt(
      sameOrgPeer,
      peerPhone,
      suite.sends,
    );
    const messageId = await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: ownerPhone,
      body: "/help",
      conversationId,
      isGroup: true,
      participants: [
        { identifier: ownerPhone },
        { identifier: AGENTPHONE_BDD_PHONE_NUMBER },
      ],
    });

    await suite.integrations.requestSendPhoneReaction(
      sameOrgPeer,
      { messageId, reaction: "like" },
      [404],
    );
    await suite.integrations.requestSendPhoneReaction(
      foreignOrgOwner,
      { messageId, reaction: "like" },
      [404],
    );
    await suite.integrations.requestSendPhoneReaction(
      null,
      { messageId, reaction: "like" },
      [401],
    );
    expect(suite.reactions).toHaveLength(0);
  });

  it("agentphone.bdd-008 denies an iMessage reaction for a departed member", async () => {
    const suite = setupAgentPhoneSuite();
    const member = suite.bdd.user();
    const memberPhone = uniquePhoneHandle();
    const otherPhone = uniquePhoneHandle();
    const conversationId = uniqueConversationId();

    await suite.agentPhone.linkViaWebhookConnectPrompt(
      member,
      memberPhone,
      suite.sends,
    );
    const messageId = await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: memberPhone,
      body: "Ordinary group update",
      conversationId,
      isGroup: true,
      participants: [
        { identifier: memberPhone },
        { identifier: otherPhone },
        { identifier: AGENTPHONE_BDD_PHONE_NUMBER },
      ],
    });
    suite.overrideConversationRoster(conversationId, [
      otherPhone,
      AGENTPHONE_BDD_PHONE_NUMBER,
    ]);

    await suite.integrations.requestSendPhoneReaction(
      member,
      { messageId, reaction: "like" },
      [404],
    );
    expect(suite.reactions).toHaveLength(0);
  });

  it("agentphone.bdd-010 rejects an iMessage reaction to sms", async () => {
    const suite = setupAgentPhoneSuite();
    const member = suite.bdd.user();
    const phone = uniquePhoneHandle();

    await suite.agentPhone.linkViaWebhookConnectPrompt(
      member,
      phone,
      suite.sends,
    );
    const messageId = await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: "/help",
    });

    const response = await suite.integrations.requestSendPhoneReaction(
      member,
      { messageId, reaction: "like" },
      [400],
    );
    expect(expectErrorBody(response.body).error.code).toBe(
      "UNSUPPORTED_CHANNEL",
    );
    expect(suite.reactions).toHaveLength(0);
  });

  it("agentphone.bdd-019 lets a recipient read history and send with a phone connected later", async () => {
    const suite = setupAgentPhoneSuite();
    const firstUser = suite.bdd.user();
    const secondUser = suite.bdd.user();
    const firstPhone = uniquePhoneHandle();
    const secondPhone = uniquePhoneHandle();
    const conversationId = uniqueConversationId();
    const groupId = bddGroupId(conversationId);

    await suite.agentPhone.linkViaWebhookConnectPrompt(
      firstUser,
      firstPhone,
      suite.sends,
    );
    await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: firstPhone,
      body: "Group history from before the member connected",
      conversationId,
      isGroup: true,
      groupId,
      participants: [
        { identifier: firstPhone },
        { identifier: secondPhone },
        { identifier: AGENTPHONE_BDD_PHONE_NUMBER },
      ],
    });

    await suite.linkWithCode(secondUser, secondPhone, "imessage");

    const beforeSend = await suite.integrations.requestAgentPhoneGroupHistory(
      secondUser,
      { groupId, limit: 100 },
      [200],
    );
    expect(
      expectProp(beforeSend.body, "messages").messages.map((message) => {
        return message.body;
      }),
    ).toStrictEqual(["Group history from before the member connected"]);

    const sent = await suite.integrations.requestSendAgentPhoneGroupMessage(
      secondUser,
      { groupId, text: "Hello from the newly connected member" },
      [200],
    );
    expect(expectProp(sent.body, "ok").ok).toBeTruthy();
    expect(expectProp(sent.body, "toNumber").toNumber).toBe(groupId);
    expect(suite.sends.messages.at(-1)?.toNumber).toBe(groupId);
    expect(suite.sends.messages.at(-1)?.body).toBe(
      "Hello from the newly connected member",
    );

    const afterSend = await suite.integrations.requestAgentPhoneGroupHistory(
      secondUser,
      { groupId, limit: 100 },
      [200],
    );
    expect(
      expectProp(afterSend.body, "messages").messages.map((message) => {
        return message.body;
      }),
    ).toStrictEqual([
      "Group history from before the member connected",
      "Hello from the newly connected member",
    ]);
  });

  it("agentphone.bdd-020 lets a recipient read history and send with a email connected later", async () => {
    const suite = setupAgentPhoneSuite();
    const firstUser = suite.bdd.user();
    const secondUser = suite.bdd.user();
    const firstPhone = uniquePhoneHandle();
    const secondEmail = `imessage-${randomUUID()}@example.test`;
    const conversationId = uniqueConversationId();
    const groupId = bddGroupId(conversationId);

    await suite.agentPhone.linkViaWebhookConnectPrompt(
      firstUser,
      firstPhone,
      suite.sends,
    );
    await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: firstPhone,
      body: "Group history from before the member connected",
      conversationId,
      isGroup: true,
      groupId,
      participants: [
        { identifier: firstPhone },
        { identifier: secondEmail },
        { identifier: AGENTPHONE_BDD_PHONE_NUMBER },
      ],
    });

    await suite.linkWithCode(secondUser, secondEmail, "imessage");

    const beforeSend = await suite.integrations.requestAgentPhoneGroupHistory(
      secondUser,
      { groupId, limit: 100 },
      [200],
    );
    expect(
      expectProp(beforeSend.body, "messages").messages.map((message) => {
        return message.body;
      }),
    ).toStrictEqual(["Group history from before the member connected"]);

    const sent = await suite.integrations.requestSendAgentPhoneGroupMessage(
      secondUser,
      { groupId, text: "Hello from the newly connected member" },
      [200],
    );
    expect(expectProp(sent.body, "ok").ok).toBeTruthy();
    expect(expectProp(sent.body, "toNumber").toNumber).toBe(groupId);
    expect(suite.sends.messages.at(-1)?.toNumber).toBe(groupId);
    expect(suite.sends.messages.at(-1)?.body).toBe(
      "Hello from the newly connected member",
    );

    const afterSend = await suite.integrations.requestAgentPhoneGroupHistory(
      secondUser,
      { groupId, limit: 100 },
      [200],
    );
    expect(
      expectProp(afterSend.body, "messages").messages.map((message) => {
        return message.body;
      }),
    ).toStrictEqual([
      "Group history from before the member connected",
      "Hello from the newly connected member",
    ]);
  });

  it("agentphone.bdd-021 rejects an explicit group send for a unknown group", async () => {
    const suite = setupAgentPhoneSuite();
    const member = suite.bdd.user();
    const phone = uniquePhoneHandle();
    const conversationId = uniqueConversationId();

    await suite.agentPhone.linkViaWebhookConnectPrompt(
      member,
      phone,
      suite.sends,
    );
    await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "Group context",
      conversationId,
      isGroup: true,
      participants: [
        { identifier: phone },
        { identifier: AGENTPHONE_BDD_PHONE_NUMBER },
      ],
    });
    const beforeCount = suite.sends.messages.length;

    const response = await suite.integrations.requestSendAgentPhoneGroupMessage(
      member,
      {
        groupId: `grp_unknown_${randomUUID().slice(0, 8)}`,
        text: "This must not be sent",
      },
      [404],
    );
    expect(expectErrorBody(response.body).error.code).toBe("NOT_FOUND");
    expect(suite.sends.messages.slice(beforeCount)).toHaveLength(0);
  });

  it("agentphone.bdd-022 rejects an explicit group send for a foreign workspace", async () => {
    const suite = setupAgentPhoneSuite();
    const member = suite.bdd.user();
    const foreignOrgMember = suite.bdd.user({ userId: member.userId });
    const phone = uniquePhoneHandle();
    const conversationId = uniqueConversationId();
    const groupId = bddGroupId(conversationId);

    await suite.agentPhone.linkViaWebhookConnectPrompt(
      member,
      phone,
      suite.sends,
    );
    await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "Group context",
      conversationId,
      isGroup: true,
      groupId,
      participants: [
        { identifier: phone },
        { identifier: AGENTPHONE_BDD_PHONE_NUMBER },
      ],
    });
    const beforeCount = suite.sends.messages.length;

    const response = await suite.integrations.requestSendAgentPhoneGroupMessage(
      foreignOrgMember,
      { groupId, text: "This must not be sent" },
      [404],
    );
    expect(expectErrorBody(response.body).error.code).toBe("NOT_FOUND");
    expect(suite.sends.messages.slice(beforeCount)).toHaveLength(0);
  });

  it("agentphone.bdd-023 rejects an explicit group send for a unrelated user", async () => {
    const suite = setupAgentPhoneSuite();
    const member = suite.bdd.user();
    const unrelatedUser = suite.bdd.user({ orgId: member.orgId });
    const memberPhone = uniquePhoneHandle();
    const unrelatedPhone = uniquePhoneHandle();
    const conversationId = uniqueConversationId();
    const groupId = bddGroupId(conversationId);

    await suite.agentPhone.linkViaWebhookConnectPrompt(
      member,
      memberPhone,
      suite.sends,
    );
    await suite.agentPhone.linkViaWebhookConnectPrompt(
      unrelatedUser,
      unrelatedPhone,
      suite.sends,
    );
    await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: memberPhone,
      body: "Group context",
      conversationId,
      isGroup: true,
      groupId,
      participants: [
        { identifier: memberPhone },
        { identifier: AGENTPHONE_BDD_PHONE_NUMBER },
      ],
    });
    const beforeCount = suite.sends.messages.length;

    const response = await suite.integrations.requestSendAgentPhoneGroupMessage(
      unrelatedUser,
      { groupId, text: "This must not be sent" },
      [404],
    );
    expect(expectErrorBody(response.body).error.code).toBe("NOT_FOUND");
    expect(suite.sends.messages.slice(beforeCount)).toHaveLength(0);
  });

  it("agentphone.bdd-024 rejects an explicit group send for a unlinked phone", async () => {
    const suite = setupAgentPhoneSuite();
    const member = suite.bdd.user();
    const phone = uniquePhoneHandle();
    const conversationId = uniqueConversationId();
    const groupId = bddGroupId(conversationId);

    await suite.agentPhone.linkViaWebhookConnectPrompt(
      member,
      phone,
      suite.sends,
    );
    await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "Group context",
      conversationId,
      isGroup: true,
      groupId,
      participants: [
        { identifier: phone },
        { identifier: AGENTPHONE_BDD_PHONE_NUMBER },
      ],
    });
    await suite.integrations.requestUnlinkAgentPhone(member, [204]);
    const beforeCount = suite.sends.messages.length;

    const response = await suite.integrations.requestSendAgentPhoneGroupMessage(
      member,
      { groupId, text: "This must not be sent" },
      [404],
    );
    expect(expectErrorBody(response.body).error.code).toBe("NOT_FOUND");
    expect(suite.sends.messages.slice(beforeCount)).toHaveLength(0);
  });

  it("agentphone.bdd-025 rejects an explicit group send for a departed member", async () => {
    const suite = setupAgentPhoneSuite();
    const member = suite.bdd.user();
    const phone = uniquePhoneHandle();
    const unrelatedPhone = uniquePhoneHandle();
    const conversationId = uniqueConversationId();
    const groupId = bddGroupId(conversationId);

    await suite.agentPhone.linkViaWebhookConnectPrompt(
      member,
      phone,
      suite.sends,
    );
    await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "Group context",
      conversationId,
      isGroup: true,
      groupId,
      participants: [
        { identifier: phone },
        { identifier: AGENTPHONE_BDD_PHONE_NUMBER },
      ],
    });
    suite.overrideConversationRoster(conversationId, [
      unrelatedPhone,
      AGENTPHONE_BDD_PHONE_NUMBER,
    ]);
    const beforeCount = suite.sends.messages.length;

    const response = await suite.integrations.requestSendAgentPhoneGroupMessage(
      member,
      { groupId, text: "This must not be sent" },
      [404],
    );
    expect(expectErrorBody(response.body).error.code).toBe("NOT_FOUND");
    expect(suite.sends.messages.slice(beforeCount)).toHaveLength(0);
  });

  it("agentphone.bdd-050 links a direct-message sender with a one-time connection code", async () => {
    const suite = setupAgentPhoneSuite();
    const member = suite.bdd.user();
    const firstPhone = uniquePhoneHandle();
    const secondPhone = uniquePhoneHandle();
    const issuedAt = now();

    const issued = await suite.integrations.requestCreateAgentPhoneLinkCode(
      member,
      [200],
    );
    expect(/^\d{8}$/u.test(issued.body.code)).toBeTruthy();
    expect(Date.parse(issued.body.expiresAt) - issuedAt).toBeGreaterThan(
      9 * 60 * 1000,
    );

    const codeMessageId = await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: firstPhone,
      body: issued.body.code,
    });
    expectThreePartWelcome(suite.sends.messages, firstPhone, codeMessageId);

    const linkedStatus =
      await suite.integrations.getAgentPhoneLinkStatus(member);
    expect(linkedStatus.linked).toBeTruthy();
    expect(expectLinkedPhoneHandle(linkedStatus)).toBe(firstPhone);

    const beforeReuse = suite.sends.messages.length;
    await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "sms",
      from: secondPhone,
      body: issued.body.code,
    });
    const reuseReplies = suite.sends.messages.slice(beforeReuse);
    expect(reuseReplies).toHaveLength(1);
    expect(reuseReplies[0]?.toNumber).toBe(secondPhone);
    expect(reuseReplies[0]?.body).toContain("invalid or expired");
    const unchangedStatus =
      await suite.integrations.getAgentPhoneLinkStatus(member);
    expect(expectLinkedPhoneHandle(unchangedStatus)).toBe(firstPhone);
  });

  it("agentphone.bdd-051 binds one sender and settles one reward when a connection code is consumed concurrently", async () => {
    const suite = setupAgentPhoneSuite();
    const consumer = marketingRewardConsumer();
    const member = suite.bdd.user({ orgRole: "org:member" });
    const phoneOne = uniquePhoneHandle();
    const phoneTwo = uniquePhoneHandle();
    const issued = await suite.integrations.requestCreateAgentPhoneLinkCode(
      member,
      [200],
    );

    await Promise.all([
      suite.agentPhone.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: phoneOne,
        body: issued.body.code,
      }),
      suite.agentPhone.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: phoneTwo,
        body: issued.body.code,
      }),
    ]);

    const status = await suite.integrations.getAgentPhoneLinkStatus(member);
    expect(status.linked).toBeTruthy();
    expect([phoneOne, phoneTwo]).toContain(expectLinkedPhoneHandle(status));
    const winner = expectLinkedPhoneHandle(status);
    const loser = winner === phoneOne ? phoneTwo : phoneOne;

    const winnerMessages = suite.sends.messages.filter((message) => {
      return message.toNumber === winner;
    });
    const loserMessages = suite.sends.messages.filter((message) => {
      return message.toNumber === loser;
    });
    expectThreePartWelcome(winnerMessages, winner ?? "");
    expect(loserMessages).toHaveLength(1);
    expect(loserMessages[0]?.body).toContain("invalid or expired");

    const linkedFacts = consumer.received.filter((event) => {
      return event.type === "imessage.identity-linked";
    });
    expect(linkedFacts).toHaveLength(1);
    const fact = linkedFacts[0];
    if (fact?.type !== "imessage.identity-linked") {
      throw new Error("Expected imessage.identity-linked fact");
    }

    await settleMarketingRequest(context, {
      version: 1,
      environment: fact.environment,
      policy: "get-started-v1",
      sourceEventId: fact.id,
      questKey: "imessage",
      sourceKey: "agentphone-link",
      rewardKey: `imessage:${member.userId}:agentphone-link`,
      orgId: fact.orgId,
      actorUserId: fact.userId,
      beneficiaryUserId: fact.userId,
      rewardTarget: "user",
      rewardAmount: 1000,
      completedAt: fact.occurredAt,
    });

    createRouteMocks(context).clerk.session(
      member.userId,
      member.orgId,
      member.orgRole,
    );
    const credits = await accept(
      setupApp({ context, routes: billingUsagePackCreditsRoutes })(
        billingUsagePackCreditsContract,
      ).get({ headers: AUTH_HEADERS }),
      [200],
    );
    expect(credits.body.bonusCredits).toBe(1000);
    const bonusGrants = credits.body.creditGrants.filter((grant) => {
      return grant.grantType === "bonus";
    });
    expect(bonusGrants).toHaveLength(1);
    expect(bonusGrants[0]?.remaining).toBe(1000);
    const finalStatus =
      await suite.integrations.getAgentPhoneLinkStatus(member);
    expect(expectLinkedPhoneHandle(finalStatus)).toBe(winner);
  });

  it("agentphone.bdd-052 sends proactive messages and private files to an email-linked iMessage handle", async () => {
    const suite = setupAgentPhoneSuite();
    const storage = suite.agentPhone.acceptAgentPhoneObjectStorage();
    const member = suite.bdd.user();
    const otherUser = suite.bdd.user({ orgId: member.orgId });
    const otherOrgMember = suite.bdd.user({ userId: member.userId });
    const emailHandle = `proactive-${randomUUID()}@example.test`;

    await suite.linkWithCode(member, emailHandle, "imessage");
    const status = await suite.integrations.getAgentPhoneLinkStatus(member);
    expect(status.linked).toBeTruthy();
    expect(expectLinkedPhoneHandle(status)).toBe(emailHandle);

    const sentText = await suite.integrations.requestSendPhoneMessage(
      member,
      {
        text: "proactive hello",
        agentphoneAgentId: AGENTPHONE_BDD_AGENT_ID,
      },
      [200],
    );
    expect(expectProp(sentText.body, "toNumber").toNumber).toBe(emailHandle);
    expect(suite.sends.messages.at(-1)?.body).toBe("proactive hello");

    const beforeForeign = suite.sends.messages.length;
    const foreignAgent = await suite.integrations.requestSendPhoneMessage(
      member,
      { text: "nope", agentphoneAgentId: "agt-foreign-agent" },
      [404],
    );
    expect(expectErrorBody(foreignAgent.body).error.code).toBe("NOT_FOUND");
    expect(suite.sends.messages.slice(beforeForeign)).toHaveLength(0);

    const init = await suite.integrations.requestPhoneUploadInit(
      member,
      { filename: "note.txt", contentType: "text/plain", length: 11 },
      [200],
    );
    storage.addArtifactObject({
      uploadId: expectProp(init.body, "uploadId").uploadId,
      filename: "note.txt",
      size: 11,
    });
    const completed = await suite.integrations.requestPhoneUploadComplete(
      member,
      {
        uploadId: expectProp(init.body, "uploadId").uploadId,
        caption: "proactive file",
        agentphoneAgentId: AGENTPHONE_BDD_AGENT_ID,
      },
      [200],
    );
    expect(expectProp(completed.body, "toNumber").toNumber).toBe(emailHandle);
    const fileUrlPath = new URL(
      expectProp(completed.body, "url").url,
      "https://app.okou.test",
    ).pathname;
    expect(fileUrlPath.startsWith("/artifacts/")).toBeTruthy();
    expect(fileUrlPath.endsWith(".txt")).toBeTruthy();
    expect(
      fileUrlPath.slice("/artifacts/".length, -".txt".length),
    ).toHaveLength(10);
    const providerFileSend = suite.sends.messages.at(-1);
    expect(providerFileSend?.toNumber).toBe(emailHandle);
    expect(providerFileSend?.body).toBe("proactive file");
    expect(providerFileSend?.mediaUrl).toContain(
      expectProp(init.body, "uploadId").uploadId,
    );

    createRouteMocks(context).clerk.session(
      member.userId,
      member.orgId,
      member.orgRole,
    );
    const ownerDownload = await suite.agentPhone.downloadPhoneFileRaw(
      "clerk-session",
      expectProp(completed.body, "messageId").messageId,
    );
    expect(ownerDownload.status).toBe(302);
    expect(ownerDownload.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    expect(ownerDownload.headers.get("x-file-name")).toBe("note.txt");
    expect(ownerDownload.headers.get("x-file-mimetype")).toBe("text/plain");
    expect(ownerDownload.headers.get("x-file-size")).toBe("11");
    expect(ownerDownload.headers.get("location")).toContain(
      expectProp(init.body, "uploadId").uploadId,
    );

    createRouteMocks(context).clerk.session(
      otherUser.userId,
      otherUser.orgId,
      otherUser.orgRole,
    );
    const otherUserDownload = await suite.agentPhone.downloadPhoneFileRaw(
      "clerk-session",
      expectProp(completed.body, "messageId").messageId,
    );
    expect(otherUserDownload.status).toBe(404);

    createRouteMocks(context).clerk.session(
      otherOrgMember.userId,
      otherOrgMember.orgId,
      otherOrgMember.orgRole,
    );
    const otherOrgDownload = await suite.agentPhone.downloadPhoneFileRaw(
      "clerk-session",
      expectProp(completed.body, "messageId").messageId,
    );
    expect(otherOrgDownload.status).toBe(404);

    suite.agentPhone.acceptAgentPhoneObjectStorage();
    createRouteMocks(context).clerk.session(
      member.userId,
      member.orgId,
      member.orgRole,
    );
    const missingDownload = await suite.agentPhone.downloadPhoneFileRaw(
      "clerk-session",
      expectProp(completed.body, "messageId").messageId,
    );
    expect(missingDownload.status).toBe(404);
  });

  it("agentphone.bdd-053 uses linked inbound identity for proactive text and files without an explicit agent id", async () => {
    const suite = setupAgentPhoneSuite();
    const storage = suite.agentPhone.acceptAgentPhoneObjectStorage();
    const member = suite.bdd.user();
    const emailHandle = `linked-id-${randomUUID()}@example.test`;

    await suite.linkWithCode(member, emailHandle, "imessage");
    await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: emailHandle,
      body: "/help",
    });

    const sentText = await suite.integrations.requestSendPhoneMessage(
      member,
      { text: "hello from linked identity" },
      [200],
    );
    expect(expectProp(sentText.body, "toNumber").toNumber).toBe(emailHandle);
    expect(suite.sends.messages.at(-1)?.agentId).toBe(AGENTPHONE_BDD_AGENT_ID);
    expect(suite.sends.messages.at(-1)?.body).toBe(
      "hello from linked identity",
    );

    const init = await suite.integrations.requestPhoneUploadInit(
      member,
      { filename: "linked.txt", contentType: "text/plain", length: 5 },
      [200],
    );
    storage.addArtifactObject({
      uploadId: expectProp(init.body, "uploadId").uploadId,
      filename: "linked.txt",
      size: 5,
    });
    const completed = await suite.integrations.requestPhoneUploadComplete(
      member,
      {
        uploadId: expectProp(init.body, "uploadId").uploadId,
        caption: "linked file caption",
      },
      [200],
    );
    expect(expectProp(completed.body, "toNumber").toNumber).toBe(emailHandle);
    expect(expectProp(completed.body, "filename").filename).toBe("linked.txt");
    expect(expectProp(completed.body, "mimetype").mimetype).toBe("text/plain");
    expect(expectProp(completed.body, "size").size).toBe(5);
    expect(expectProp(completed.body, "url").url).toContain("/artifacts/");

    const providerSend = suite.sends.messages.at(-1);
    expect(providerSend?.agentId).toBe(AGENTPHONE_BDD_AGENT_ID);
    expect(providerSend?.body).toBe("linked file caption");
    expect(providerSend?.mediaUrl).toContain(
      expectProp(init.body, "uploadId").uploadId,
    );
    expect(providerSend?.mediaUrl).not.toBe(
      expectProp(completed.body, "url").url,
    );
  });

  it("agentphone.bdd-054 invalidates a previous connection code when a new one is issued", async () => {
    const suite = setupAgentPhoneSuite();
    const member = suite.bdd.user();
    const phone = uniquePhoneHandle();

    const first = await suite.integrations.requestCreateAgentPhoneLinkCode(
      member,
      [200],
    );
    const second = await suite.integrations.requestCreateAgentPhoneLinkCode(
      member,
      [200],
    );

    await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: first.body.code,
    });
    expect(suite.sends.messages.at(-1)?.body).toContain("invalid or expired");
    expect(
      (await suite.integrations.getAgentPhoneLinkStatus(member)).linked,
    ).toBeFalsy();

    const beforeSecond = suite.sends.messages.length;
    await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: second.body.code,
    });
    expectThreePartWelcome(suite.sends.messages.slice(beforeSecond), phone);
    const status = await suite.integrations.getAgentPhoneLinkStatus(member);
    expect(status.linked).toBeTruthy();
    expect(expectLinkedPhoneHandle(status)).toBe(phone);
  });

  it("agentphone.bdd-055 rewards the Get started iMessage quest once per user", async () => {
    const suite = setupAgentPhoneSuite();
    const member = suite.bdd.user({ orgRole: "org:member" });
    const firstPhone = uniquePhoneHandle();
    const secondPhone = uniquePhoneHandle();

    const firstCode = await suite.integrations.requestCreateAgentPhoneLinkCode(
      member,
      [200],
    );
    const firstMsgId = await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: firstPhone,
      body: firstCode.body.code,
    });
    expectThreePartWelcome(suite.sends.messages, firstPhone, firstMsgId);
    expect(
      channelsPublishedTo(context.mocks, GET_STARTED_REWARDS_CHANGED_EVENT),
    ).toContain(`user:${member.userId}`);

    await suite.integrations.requestUnlinkAgentPhone(member, [204]);

    const beforeSecond = suite.sends.messages.length;
    const secondCode = await suite.integrations.requestCreateAgentPhoneLinkCode(
      member,
      [200],
    );
    const secondMsgId = await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: secondPhone,
      body: secondCode.body.code,
    });
    expectThreePartWelcome(
      suite.sends.messages.slice(beforeSecond),
      secondPhone,
      secondMsgId,
    );
  });

  it("agentphone.bdd-056 rejects an expired connection code", async () => {
    const suite = setupAgentPhoneSuite();
    const member = suite.bdd.user();
    const phone = uniquePhoneHandle();
    const start = now();
    mockNow(start);

    const issued = await suite.integrations.requestCreateAgentPhoneLinkCode(
      member,
      [200],
    );
    mockNow(Date.parse(issued.body.expiresAt) + 1);

    await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: issued.body.code,
    });

    expect(suite.sends.messages.at(-1)?.body).toContain("invalid or expired");
    expect(
      (await suite.integrations.getAgentPhoneLinkStatus(member)).linked,
    ).toBeFalsy();
  });

  it("agentphone.bdd-063 handles a first-contact link restriction when the plain-text greeting is rejected", async () => {
    const suite = setupAgentPhoneSuite();
    const member = suite.bdd.user();
    await suite.provisionProMember(member);
    const newPhone = uniquePhoneHandle();
    const conversationId = uniqueConversationId();
    const groupId = bddGroupId(conversationId);
    const privateAttempts: {
      readonly toNumber: string | undefined;
      readonly body: string | undefined;
      readonly replyToMessageId: string | undefined;
    }[] = [];
    const delivered: {
      readonly toNumber: string | undefined;
      readonly body: string | undefined;
      readonly replyToMessageId: string | undefined;
    }[] = [];

    server.use(
      http.post(
        `${AGENTPHONE_API_BASE_URL}/v1/messages`,
        async ({ request }) => {
          const raw: unknown = await request.json();
          const record = isRecord(raw) ? raw : {};
          const toNumber =
            typeof record.to_number === "string" ? record.to_number : undefined;
          const body =
            typeof record.body === "string" ? record.body : undefined;
          const replyToMessageId =
            typeof record.reply_to_message_id === "string"
              ? record.reply_to_message_id
              : undefined;
          if (toNumber === newPhone) {
            privateAttempts.push({ toNumber, body, replyToMessageId });
            if (privateAttempts.length === 1) {
              return HttpResponse.json(
                {
                  error: {
                    code: "CONVERSATION_CONTENT_RESTRICTED",
                    message: "Links are restricted on first contact",
                  },
                },
                { status: 422 },
              );
            }
            return HttpResponse.json(
              {
                error: {
                  code: "INBOUND_ONLY",
                  message: "Inbound only",
                },
              },
              { status: 422 },
            );
          }
          delivered.push({ toNumber, body, replyToMessageId });
          return HttpResponse.json({
            id: `apmsg_${randomUUID()}`,
            status: "sent",
            channel: "imessage",
            from_number: AGENTPHONE_BDD_PHONE_NUMBER,
            to_number: toNumber ?? null,
            media_urls: [],
          });
        },
      ),
    );

    const groupMessageId = await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: newPhone,
      body: "@Okou hello",
      conversationId,
      isGroup: true,
      groupId,
      participants: [
        { identifier: newPhone },
        { identifier: AGENTPHONE_BDD_PHONE_NUMBER },
      ],
    });

    expect(privateAttempts).toHaveLength(2);
    expect(privateAttempts[0]?.body).toContain("/settings/agentphone?");
    expect(privateAttempts[1]?.replyToMessageId).toBeUndefined();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.toNumber).toBe(groupId);
    expect(delivered[0]?.replyToMessageId).toBe(groupMessageId);
    expect(delivered[0]?.body).toBe(
      "Please message this number directly to get your connection link.",
    );
    expect(delivered[0]?.body).not.toContain("/settings/agentphone?");
    expect(
      (await suite.integrations.getAgentPhoneLinkStatus(member)).linked,
    ).toBeFalsy();
  });

  it("agentphone.bdd-085 offers role-aware recovery for a depleted workspace (org:admin, group=false)", async () => {
    const suite = setupAgentPhoneSuite();
    const start = now();
    mockNow(start);
    const admin = suite.bdd.user({ orgRole: "org:admin" });
    const otherUser = suite.bdd.user();
    const phone = uniquePhoneHandle();

    await suite.bdd.provisionWorkspace(admin);
    suite.mockWorkspaceName(admin, "Original Phone Workspace");
    await suite.agentPhone.linkViaWebhookConnectPrompt(
      admin,
      phone,
      suite.sends,
    );

    mockNow(start + 90 * 24 * 60 * 60 * 1000);
    suite.mockWorkspaceName(admin, "Original Phone Workspace");
    const beforeHelp = suite.sends.messages.length;
    await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "@Okou help me with this report",
    });

    const recoveryReplies = suite.sends.messages.slice(beforeHelp);
    expect(recoveryReplies).toHaveLength(1);
    const recoveryText = recoveryReplies[0]?.body ?? "";
    expect(recoveryText).toContain("Original Phone Workspace");
    expect(recoveryText).toContain("send /switch");
    expect(recoveryText).toContain("Upgrade to Pro");
    expect(recoveryText).toContain("/?settings=billing&billingView=plans");

    const beforeSwitch = suite.sends.messages.length;
    await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "/switch",
    });
    const switchReplies = suite.sends.messages.slice(beforeSwitch);
    expect(switchReplies).toHaveLength(1);
    expect(switchReplies[0]?.body).toContain(
      "Your phone has been disconnected",
    );
    expect(switchReplies[0]?.body).toContain("/settings/agentphone?");
    expect(
      (await suite.integrations.getAgentPhoneLinkStatus(admin)).linked,
    ).toBeFalsy();

    const newConnectBody = connectRequestFromPrompt(switchReplies[0]?.body);
    await suite.integrations.requestConnectAgentPhone(
      otherUser,
      newConnectBody,
      [200],
    );
    const otherStatus =
      await suite.integrations.getAgentPhoneLinkStatus(otherUser);
    expect(otherStatus.linked).toBeTruthy();
    expect(expectLinkedPhoneHandle(otherStatus)).toBe(phone);
    expect(
      (await suite.integrations.getAgentPhoneLinkStatus(admin)).linked,
    ).toBeFalsy();
  });

  it("agentphone.bdd-086 offers role-aware recovery for a depleted workspace (org:member, group=false)", async () => {
    const suite = setupAgentPhoneSuite();
    const start = now();
    mockNow(start);
    const member = suite.bdd.user({ orgRole: "org:member" });
    const otherUser = suite.bdd.user();
    const phone = uniquePhoneHandle();

    await suite.bdd.provisionWorkspace(member);
    suite.mockWorkspaceName(member, "Original Phone Workspace");
    await suite.agentPhone.linkViaWebhookConnectPrompt(
      member,
      phone,
      suite.sends,
    );

    mockNow(start + 90 * 24 * 60 * 60 * 1000);
    suite.mockWorkspaceName(member, "Original Phone Workspace");
    const beforeHelp = suite.sends.messages.length;
    await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "@Okou help me with this report",
    });

    const recoveryReplies = suite.sends.messages.slice(beforeHelp);
    expect(recoveryReplies).toHaveLength(1);
    const recoveryText = recoveryReplies[0]?.body ?? "";
    expect(recoveryText).toContain("Original Phone Workspace");
    expect(recoveryText).toContain("send /switch");
    expect(recoveryText).toContain("Ask a workspace admin");
    expect(recoveryText).not.toContain("?settings=billing");

    const beforeSwitch = suite.sends.messages.length;
    await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "/switch",
    });
    const switchReplies = suite.sends.messages.slice(beforeSwitch);
    expect(switchReplies).toHaveLength(1);
    expect(switchReplies[0]?.body).toContain(
      "Your phone has been disconnected",
    );
    expect(switchReplies[0]?.body).toContain("/settings/agentphone?");
    expect(
      (await suite.integrations.getAgentPhoneLinkStatus(member)).linked,
    ).toBeFalsy();

    const newConnectBody = connectRequestFromPrompt(switchReplies[0]?.body);
    await suite.integrations.requestConnectAgentPhone(
      otherUser,
      newConnectBody,
      [200],
    );
    const otherStatus =
      await suite.integrations.getAgentPhoneLinkStatus(otherUser);
    expect(otherStatus.linked).toBeTruthy();
    expect(expectLinkedPhoneHandle(otherStatus)).toBe(phone);
    expect(
      (await suite.integrations.getAgentPhoneLinkStatus(member)).linked,
    ).toBeFalsy();
  });

  it("agentphone.bdd-087 (1/2) offers role-aware upgrade recovery for a depleted workspace admin in an iMessage group", async () => {
    const suite = setupAgentPhoneSuite();
    const start = now();
    mockNow(start);
    const admin = suite.bdd.user({ orgRole: "org:admin" });
    const phone = uniquePhoneHandle();
    const conversationId = uniqueConversationId();
    const groupId = bddGroupId(conversationId);

    await suite.bdd.provisionWorkspace(admin);
    suite.mockWorkspaceName(admin, "Original Phone Workspace");
    await suite.agentPhone.linkViaWebhookConnectPrompt(
      admin,
      phone,
      suite.sends,
    );

    mockNow(start + 90 * 24 * 60 * 60 * 1000);
    const beforeHelp = suite.sends.messages.length;
    await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "@Okou help me with this report",
      conversationId,
      isGroup: true,
      groupId,
      participants: [
        { identifier: phone },
        { identifier: AGENTPHONE_BDD_PHONE_NUMBER },
      ],
    });

    const recoveryReplies = suite.sends.messages.slice(beforeHelp);
    expect(recoveryReplies).toHaveLength(1);
    const recoveryText = recoveryReplies[0]?.body ?? "";
    expect(recoveryText).toContain("Upgrade to Pro");
    expect(recoveryText).toContain("/?settings=billing&billingView=plans");
    expect(recoveryText).not.toContain("Original Phone Workspace");
    expect(recoveryText).not.toContain("/switch");
  });

  it("agentphone.bdd-087 (2/2) tells the depleted workspace admin to message directly on group /switch and keeps them linked", async () => {
    const suite = setupAgentPhoneSuite();
    const start = now();
    mockNow(start);
    const admin = suite.bdd.user({ orgRole: "org:admin" });
    const phone = uniquePhoneHandle();
    const conversationId = uniqueConversationId();
    const groupId = bddGroupId(conversationId);

    await suite.bdd.provisionWorkspace(admin);
    suite.mockWorkspaceName(admin, "Original Phone Workspace");
    await suite.agentPhone.linkViaWebhookConnectPrompt(
      admin,
      phone,
      suite.sends,
    );

    mockNow(start + 90 * 24 * 60 * 60 * 1000);
    const beforeSwitch = suite.sends.messages.length;
    await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "/switch @Okou",
      conversationId,
      isGroup: true,
      groupId,
      participants: [
        { identifier: phone },
        { identifier: AGENTPHONE_BDD_PHONE_NUMBER },
      ],
    });
    const switchReplies = suite.sends.messages.slice(beforeSwitch);
    expect(switchReplies).toHaveLength(1);
    expect(switchReplies[0]?.body).toContain("message this number directly");
    expect(switchReplies[0]?.body).not.toContain("/settings/agentphone?");
    expect(
      (await suite.integrations.getAgentPhoneLinkStatus(admin)).linked,
    ).toBeTruthy();
  });

  it("agentphone.bdd-106 answers help, connect, disconnect, and switch commands over SMS", async () => {
    const suite = setupAgentPhoneSuite();
    const member = suite.bdd.user();
    const phone = uniquePhoneHandle();
    await suite.provisionProMember(member, "Operations workspace");
    await suite.agentPhone.linkViaWebhookConnectPrompt(
      member,
      phone,
      suite.sends,
    );
    suite.mockWorkspaceName(member, "Operations workspace");

    const smsWarning =
      "Note: SMS and MMS replies may not be delivered reliably.";

    await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: "/help",
    });
    const helpReply = suite.sends.messages.at(-1)?.body ?? "";
    expect(helpReply).toContain("/connect");
    expect(helpReply).toContain("/help");
    expect(helpReply).toContain("/disconnect");
    expect(helpReply).toContain("/switch");
    expect(helpReply).toContain(smsWarning);

    await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: "/connect",
    });
    const connectReply = suite.sends.messages.at(-1)?.body ?? "";
    expect(connectReply).toContain("You are already connected");
    expect(connectReply).toContain("Operations workspace");
    expect(connectReply).toContain("/switch");
    expect(connectReply).toContain(smsWarning);

    await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: "/disconnect",
    });
    expect(
      (await suite.integrations.getAgentPhoneLinkStatus(member)).linked,
    ).toBeFalsy();

    await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: "/disconnect",
    });
    expect(suite.sends.messages.at(-1)?.body).toContain(
      "Error: This phone number is not connected.",
    );

    await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: "/switch",
    });
    const switchReply = suite.sends.messages.at(-1)?.body ?? "";
    expect(switchReply).toContain("/settings/agentphone?");
    expect(switchReply).toContain(smsWarning);

    await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: "hello again",
    });
    const unlinkedReply = suite.sends.messages.at(-1)?.body ?? "";
    expect(unlinkedReply).toContain(
      "Click the link below to start using Okou.",
    );
    expect(unlinkedReply).toContain("/settings/agentphone?");
    expect(unlinkedReply).not.toContain("AgentPhone");
    expect(unlinkedReply).not.toContain(smsWarning);
  });

  it("agentphone.bdd-109 uses message-time participants for history and media regardless of when they connect", async () => {
    const suite = setupAgentPhoneSuite();
    const userOne = suite.bdd.user();
    const userTwo = suite.bdd.user();
    const userThree = suite.bdd.user();
    const newcomer = suite.bdd.user();
    const phoneOne = uniquePhoneHandle();
    const phoneTwo = uniquePhoneHandle();
    const phoneThree = uniquePhoneHandle();
    const newcomerPhone = uniquePhoneHandle();
    const rosterlessConversation = uniqueConversationId();
    const rosterlessGroup = bddGroupId(rosterlessConversation);
    const stableConversation = uniqueConversationId();
    const stableGroup = bddGroupId(stableConversation);
    const preLinkConversation = uniqueConversationId();
    const preLinkGroup = bddGroupId(preLinkConversation);
    const photoUrl = "https://cdn.agentphone.test/media/group-photo.jpg";
    const start = now();
    mockNow(start);

    server.use(
      http.get(photoUrl, () => {
        return new HttpResponse(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
          status: 200,
          headers: { "content-type": "image/jpeg", "content-length": "4" },
        });
      }),
    );

    await suite.linkWithCode(userOne, phoneOne, "imessage");
    await suite.linkWithCode(userTwo, phoneTwo, "imessage");

    await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phoneOne,
      body: "rosterless note",
      conversationId: rosterlessConversation,
      isGroup: true,
      groupId: rosterlessGroup,
      participants: [],
      receivedAt: new Date(start + 1000).toISOString(),
    });
    await suite.agentPhone.postAgentPhoneInboundMessage(
      {
        channel: "imessage",
        from: phoneOne,
        body: "missing timestamp note",
        conversationId: stableConversation,
        isGroup: true,
        groupId: stableGroup,
        participants: [
          { identifier: phoneOne },
          { identifier: AGENTPHONE_BDD_PHONE_NUMBER },
        ],
        receivedAt: null,
      },
      [500],
    );
    await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phoneThree,
      body: "pre-link own message",
      conversationId: preLinkConversation,
      isGroup: true,
      groupId: preLinkGroup,
      participants: [
        { identifier: phoneThree },
        { identifier: AGENTPHONE_BDD_PHONE_NUMBER },
      ],
      receivedAt: new Date(start + 2000).toISOString(),
    });
    const firstNoteId = await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phoneOne,
      body: "first group note",
      conversationId: stableConversation,
      isGroup: true,
      groupId: stableGroup,
      mediaUrl: photoUrl,
      participants: [
        { identifier: phoneOne },
        { identifier: phoneTwo },
        { identifier: phoneThree },
        { identifier: AGENTPHONE_BDD_PHONE_NUMBER },
      ],
      receivedAt: new Date(start + 3000).toISOString(),
    });

    mockNow(start + 4000);
    await suite.linkWithCode(userThree, phoneThree, "imessage");
    await suite.linkWithCode(newcomer, newcomerPhone, "imessage");

    const delayedNoteId = await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phoneOne,
      body: "delayed group note",
      conversationId: stableConversation,
      isGroup: true,
      groupId: stableGroup,
      participants: [
        { identifier: phoneOne },
        { identifier: phoneTwo },
        { identifier: phoneThree },
        { identifier: AGENTPHONE_BDD_PHONE_NUMBER },
      ],
      receivedAt: new Date(start + 5000).toISOString(),
    });
    await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phoneOne,
      messageId: delayedNoteId,
      body: "delayed group note",
      conversationId: stableConversation,
      isGroup: true,
      groupId: stableGroup,
      participants: [
        { identifier: phoneOne },
        { identifier: phoneTwo },
        { identifier: phoneThree },
        { identifier: AGENTPHONE_BDD_PHONE_NUMBER },
      ],
      receivedAt: new Date(start + 5000).toISOString(),
    });
    await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phoneOne,
      body: "second group note",
      conversationId: stableConversation,
      isGroup: true,
      groupId: stableGroup,
      participants: [
        { identifier: phoneOne },
        { identifier: phoneThree },
        { identifier: newcomerPhone },
        { identifier: AGENTPHONE_BDD_PHONE_NUMBER },
      ],
      receivedAt: new Date(start + 6000).toISOString(),
    });

    const rosterlessHistory =
      await suite.integrations.requestAgentPhoneGroupHistory(
        userOne,
        { groupId: rosterlessGroup, limit: 100 },
        [200],
      );
    expect(
      expectProp(rosterlessHistory.body, "messages").messages.map((message) => {
        return message.body;
      }),
    ).toStrictEqual(["rosterless note"]);

    const preLinkHistory =
      await suite.integrations.requestAgentPhoneGroupHistory(
        userThree,
        { groupId: preLinkGroup, limit: 100 },
        [200],
      );
    expect(
      expectProp(preLinkHistory.body, "messages").messages.map((message) => {
        return message.body;
      }),
    ).toStrictEqual(["pre-link own message"]);

    const firstHistory = await suite.integrations.requestAgentPhoneGroupHistory(
      userOne,
      { groupId: stableGroup, limit: 100 },
      [200],
    );
    expect(
      expectProp(firstHistory.body, "messages").messages.map((message) => {
        return message.body;
      }),
    ).toStrictEqual([
      "first group note",
      "delayed group note",
      "second group note",
    ]);

    const secondHistory =
      await suite.integrations.requestAgentPhoneGroupHistory(
        userTwo,
        { groupId: stableGroup, limit: 100 },
        [200],
      );
    expect(
      expectProp(secondHistory.body, "messages").messages.map((message) => {
        return message.body;
      }),
    ).toStrictEqual(["first group note", "delayed group note"]);

    const thirdHistory = await suite.integrations.requestAgentPhoneGroupHistory(
      userThree,
      { groupId: stableGroup, limit: 100 },
      [200],
    );
    expect(
      expectProp(thirdHistory.body, "messages").messages.map((message) => {
        return message.body;
      }),
    ).toStrictEqual([
      "first group note",
      "delayed group note",
      "second group note",
    ]);

    const newcomerHistory =
      await suite.integrations.requestAgentPhoneGroupHistory(
        newcomer,
        { groupId: stableGroup, limit: 100 },
        [200],
      );
    expect(
      expectProp(newcomerHistory.body, "messages").messages.map((message) => {
        return message.body;
      }),
    ).toStrictEqual(["second group note"]);

    createRouteMocks(context).clerk.session(
      userTwo.userId,
      userTwo.orgId,
      userTwo.orgRole,
    );
    expect(
      (
        await suite.agentPhone.downloadPhoneFileRaw(
          "clerk-session",
          firstNoteId,
        )
      ).status,
    ).toBe(200);
    createRouteMocks(context).clerk.session(
      userThree.userId,
      userThree.orgId,
      userThree.orgRole,
    );
    expect(
      (
        await suite.agentPhone.downloadPhoneFileRaw(
          "clerk-session",
          firstNoteId,
        )
      ).status,
    ).toBe(200);
    createRouteMocks(context).clerk.session(
      newcomer.userId,
      newcomer.orgId,
      newcomer.orgRole,
    );
    expect(
      (
        await suite.agentPhone.downloadPhoneFileRaw(
          "clerk-session",
          firstNoteId,
        )
      ).status,
    ).toBe(404);

    const queried = await suite.integrations.requestAgentPhoneGroupHistory(
      userOne,
      { groupId: stableGroup, query: "second", limit: 100 },
      [200],
    );
    expect(
      expectProp(queried.body, "messages").messages.map((message) => {
        return message.body;
      }),
    ).toStrictEqual(["second group note"]);

    const pageOne = await suite.integrations.requestAgentPhoneGroupHistory(
      userOne,
      { groupId: stableGroup, limit: 1 },
      [200],
    );
    expect(expectProp(pageOne.body, "hasMore").hasMore).toBeTruthy();
    expect(expectProp(pageOne.body, "nextCursor").nextCursor).toBeTruthy();
    const pageTwo = await suite.integrations.requestAgentPhoneGroupHistory(
      userOne,
      {
        groupId: stableGroup,
        limit: 1,
        cursor: expectProp(pageOne.body, "nextCursor").nextCursor ?? undefined,
      },
      [200],
    );
    expect(
      expectProp(pageTwo.body, "messages").messages.map((message) => {
        return message.body;
      }),
    ).toStrictEqual(["delayed group note"]);
  });

  it("agentphone.bdd-144 requires current group membership and keeps group uploads scoped to the user, organization, agent, and file owner", async () => {
    const suite = setupAgentPhoneSuite();
    const storage = suite.agentPhone.acceptAgentPhoneObjectStorage();
    const owner = suite.bdd.user();
    const groupMember = suite.bdd.user({ orgId: owner.orgId });
    const outsider = suite.bdd.user({ orgId: owner.orgId });
    const foreignOrgOwner = suite.bdd.user({ userId: owner.userId });
    const ownerPhone = uniquePhoneHandle();
    const memberPhone = uniquePhoneHandle();
    const outsiderPhone = uniquePhoneHandle();
    const conversationId = uniqueConversationId();
    const groupId = bddGroupId(conversationId);

    await suite.linkWithCode(owner, ownerPhone, "imessage");
    await suite.linkWithCode(groupMember, memberPhone, "imessage");
    await suite.linkWithCode(outsider, outsiderPhone, "imessage");
    await suite.agentPhone.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: ownerPhone,
      body: "Initial group message",
      conversationId,
      isGroup: true,
      groupId,
      participants: [
        { identifier: ownerPhone },
        { identifier: memberPhone },
        { identifier: AGENTPHONE_BDD_PHONE_NUMBER },
      ],
    });

    const ownerUpload = await suite.integrations.requestPhoneUploadInit(
      owner,
      { filename: "photo.png", contentType: "image/png", length: 8 },
      [200],
    );
    storage.addArtifactObject({
      uploadId: expectProp(ownerUpload.body, "uploadId").uploadId,
      filename: "photo.png",
      size: 8,
    });
    const outsiderUpload = await suite.integrations.requestPhoneUploadInit(
      outsider,
      { filename: "photo.png", contentType: "image/png", length: 8 },
      [200],
    );
    storage.addArtifactObject({
      uploadId: expectProp(outsiderUpload.body, "uploadId").uploadId,
      filename: "photo.png",
      size: 8,
    });

    const beforeDenials = suite.sends.messages.length;
    await suite.integrations.requestPhoneUploadComplete(
      null,
      {
        uploadId: expectProp(ownerUpload.body, "uploadId").uploadId,
        groupId,
        caption: "Group photo",
      },
      [401],
    );
    await suite.integrations.requestPhoneUploadComplete(
      groupMember,
      {
        uploadId: expectProp(ownerUpload.body, "uploadId").uploadId,
        groupId,
        caption: "Group photo",
      },
      [404],
    );
    await suite.integrations.requestPhoneUploadComplete(
      outsider,
      {
        uploadId: expectProp(outsiderUpload.body, "uploadId").uploadId,
        groupId,
        caption: "Group photo",
      },
      [404],
    );
    await suite.integrations.requestPhoneUploadComplete(
      foreignOrgOwner,
      {
        uploadId: expectProp(ownerUpload.body, "uploadId").uploadId,
        groupId,
        caption: "Group photo",
      },
      [404],
    );
    await suite.integrations.requestPhoneUploadComplete(
      owner,
      {
        uploadId: expectProp(ownerUpload.body, "uploadId").uploadId,
        groupId,
        caption: "Group photo",
        agentphoneAgentId: "agt-unrelated",
      },
      [404],
    );

    suite.overrideConversationRoster(conversationId, [
      memberPhone,
      AGENTPHONE_BDD_PHONE_NUMBER,
    ]);
    await suite.integrations.requestPhoneUploadComplete(
      owner,
      {
        uploadId: expectProp(ownerUpload.body, "uploadId").uploadId,
        groupId,
        caption: "Group photo",
      },
      [403],
    );

    server.use(
      http.get(`${AGENTPHONE_API_BASE_URL}/v1/conversations/:id`, () => {
        return HttpResponse.json({ error: "Not found" }, { status: 404 });
      }),
    );
    await suite.integrations.requestPhoneUploadComplete(
      owner,
      {
        uploadId: expectProp(ownerUpload.body, "uploadId").uploadId,
        groupId,
        caption: "Group photo",
      },
      [404],
    );

    server.use(
      http.get(`${AGENTPHONE_API_BASE_URL}/v1/conversations/:id`, () => {
        return HttpResponse.json({ error: "Unavailable" }, { status: 503 });
      }),
    );
    await suite.integrations.requestPhoneUploadComplete(
      owner,
      {
        uploadId: expectProp(ownerUpload.body, "uploadId").uploadId,
        groupId,
        caption: "Group photo",
      },
      [502],
    );

    server.use(
      http.get(`${AGENTPHONE_API_BASE_URL}/v1/conversations/:id`, () => {
        return HttpResponse.error();
      }),
    );
    await suite.integrations.requestPhoneUploadComplete(
      owner,
      {
        uploadId: expectProp(ownerUpload.body, "uploadId").uploadId,
        groupId,
        caption: "Group photo",
      },
      [502],
    );
    expect(suite.sends.messages.slice(beforeDenials)).toHaveLength(0);

    suite.overrideConversationRoster(conversationId, [
      ownerPhone,
      memberPhone,
      AGENTPHONE_BDD_PHONE_NUMBER,
    ]);
    const completed = await suite.integrations.requestPhoneUploadComplete(
      owner,
      {
        uploadId: expectProp(ownerUpload.body, "uploadId").uploadId,
        groupId,
        caption: "Group photo",
      },
      [200],
    );
    expect(expectProp(completed.body, "toNumber").toNumber).toBe(groupId);
    expect(suite.sends.messages.at(-1)?.body).toBe("Group photo");
    expect(suite.sends.messages.at(-1)?.mediaUrl).toContain(
      expectProp(ownerUpload.body, "uploadId").uploadId,
    );

    const memberHistory =
      await suite.integrations.requestAgentPhoneGroupHistory(
        groupMember,
        { groupId, limit: 100 },
        [200],
      );
    expect(
      expectProp(memberHistory.body, "messages").messages.some((message) => {
        return message.body === "Group photo";
      }),
    ).toBeTruthy();

    const outsiderHistory =
      await suite.integrations.requestAgentPhoneGroupHistory(
        outsider,
        { groupId, limit: 100 },
        [200],
      );
    expect(expectProp(outsiderHistory.body, "messages").messages).toHaveLength(
      0,
    );
  });

  it("agentphone.bdd-145 guards startLink against foreign-owner handles and provider network failures", async () => {
    const suite = setupAgentPhoneSuite();
    const owner = suite.bdd.user();
    const rival = suite.bdd.user();
    const ownerPhone = uniquePhoneHandle();
    const newPhone = uniquePhoneHandle();

    await suite.agentPhone.linkViaWebhookConnectPrompt(
      owner,
      ownerPhone,
      suite.sends,
    );

    const conflictResponse =
      await suite.integrations.requestStartAgentPhoneLink(
        rival,
        { phoneHandle: ownerPhone },
        [409],
      );
    expect(expectErrorBody(conflictResponse.body).error.code).toBe("CONFLICT");
    expect(expectErrorBody(conflictResponse.body).error.message).toBe(
      "This phone number is already connected to another Okou account or organization. Disconnect it first.",
    );

    server.use(
      http.post(`${AGENTPHONE_API_BASE_URL}/v1/messages`, () => {
        return HttpResponse.error();
      }),
    );
    const unavailableResponse =
      await suite.integrations.requestStartAgentPhoneLink(
        rival,
        { phoneHandle: newPhone },
        [503],
      );
    expect(expectErrorBody(unavailableResponse.body).error.code).toBe(
      "PROVIDER_UNAVAILABLE",
    );
  });
});
