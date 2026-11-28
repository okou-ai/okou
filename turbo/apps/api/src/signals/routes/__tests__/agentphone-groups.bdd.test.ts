import { randomUUID } from "node:crypto";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
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
import type { ApiTestUser } from "./helpers/api-bdd";

const context = testContext();
const integrations = createBddIntegrationApi(context);
const agentPhone = createAgentPhoneBddApi(context);

const AGENTPHONE_API_BASE_URL = "https://api.agentphone.test";

/** AgentPhone with a signed webhook; provider texts are captured. */
function configureSignedAgentPhone(): AgentPhoneSendCapture {
  integrations.configureAgentPhoneProvider();
  integrations.configureAgentPhoneWebhook();
  return agentPhone.captureAgentPhoneSends();
}

async function linkedMember(
  capture: AgentPhoneSendCapture,
  phone: string,
  member: ApiTestUser = integrations.user(),
): Promise<ApiTestUser> {
  const proof = await agentPhone.requestConnectLink(phone, capture);
  await integrations.requestConnectAgentPhone(member, proof, [200]);
  return member;
}

interface ProviderConversation {
  readonly id: string;
  readonly groupId: string;
  readonly groupName?: string | null;
  readonly participants: readonly string[];
}

/**
 * AgentPhone's conversation lookup: each conversation answers with its
 * current roster, a status code for removed or failing conversations, and
 * every requested conversation ID is recorded.
 */
function providerConversations(
  conversations: Readonly<Record<string, ProviderConversation | number>>,
): string[] {
  const lookups: string[] = [];
  server.use(
    http.get(
      `${AGENTPHONE_API_BASE_URL}/v1/conversations/:id`,
      ({ params }) => {
        const id = typeof params.id === "string" ? params.id : "";
        lookups.push(id);
        const conversation = conversations[id];
        if (conversation === undefined) {
          return HttpResponse.json({ detail: "Not found" }, { status: 404 });
        }
        if (typeof conversation === "number") {
          return HttpResponse.json(
            { detail: "Unavailable" },
            { status: conversation },
          );
        }
        return HttpResponse.json({
          id: conversation.id,
          agentId: AGENTPHONE_BDD_AGENT_ID,
          phoneNumber: AGENTPHONE_BDD_PHONE_NUMBER,
          isGroup: true,
          groupId: conversation.groupId,
          groupName: conversation.groupName ?? null,
          participants: conversation.participants.map((identifier) => {
            return { identifier };
          }),
        });
      },
    ),
  );
  return lookups;
}

async function groupMessage(args: {
  readonly from: string;
  readonly conversationId: string;
  readonly participants: readonly string[];
  readonly body?: string;
  readonly groupId?: string;
  readonly receivedAt?: string;
}): Promise<string> {
  return await agentPhone.postAgentPhoneInboundMessage({
    channel: "imessage",
    from: args.from,
    body: args.body ?? "Group plans for Friday",
    conversationId: args.conversationId,
    isGroup: true,
    groupId: args.groupId ?? bddGroupId(args.conversationId),
    participants: args.participants.map((identifier) => {
      return { identifier };
    }),
    ...(args.receivedAt === undefined ? {} : { receivedAt: args.receivedAt }),
  });
}

/** A signed iMessage group webhook carrying no message text or media. */
function emptyGroupWebhookBody(args: {
  readonly messageId: string;
  readonly from: string;
  readonly conversationId: string;
  readonly groupId: string;
}): string {
  return JSON.stringify({
    event: "agent.message",
    channel: "imessage",
    agentId: AGENTPHONE_BDD_AGENT_ID,
    data: {
      messageId: args.messageId,
      from: args.from,
      to: AGENTPHONE_BDD_PHONE_NUMBER,
      message: "",
      mediaUrl: null,
      mediaUrls: [],
      receivedAt: new Date(now()).toISOString(),
      conversationId: args.conversationId,
      group: {
        isGroup: true,
        groupId: args.groupId,
        participants: [{ identifier: args.from }],
      },
      senderIdentifier: args.from,
    },
  });
}

describe("iMessage group webhook content admission", () => {
  it("agentphone-groups.bdd-001 returns a retryable rejection for empty content", async () => {
    integrations.configureAgentPhoneWebhook();
    const conversationId = uniqueConversationId();

    const response = await agentPhone.postRawAgentPhoneInboundWebhook(
      emptyGroupWebhookBody({
        messageId: `ap-msg-${randomUUID()}`,
        from: uniquePhoneHandle(),
        conversationId,
        groupId: bddGroupId(conversationId),
      }),
      [500],
    );

    expect(response.body).toBe(
      "iMessage group webhook has no supported message content (empty_content)",
    );
  });

  it("agentphone-groups.bdd-007 stores a corrected retry once after rejecting empty group content", async () => {
    const capture = configureSignedAgentPhone();
    const phone = uniquePhoneHandle();
    const member = await linkedMember(capture, phone);
    const conversationId = uniqueConversationId();
    const groupId = bddGroupId(conversationId);
    const messageId = `ap-msg-${randomUUID()}`;
    const webhookId = `evt-bdd-agentphone-${randomUUID()}`;
    const empty = emptyGroupWebhookBody({
      messageId,
      from: phone,
      conversationId,
      groupId,
    });

    for (const _attempt of [1, 2]) {
      const rejected = await agentPhone.postRawAgentPhoneInboundWebhook(
        empty,
        [500],
        webhookId,
      );
      expect(String(rejected.body)).toContain("(empty_content)");
    }
    for (const _attempt of [1, 2]) {
      await agentPhone.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: phone,
        body: "Corrected group text",
        messageId,
        webhookId,
        conversationId,
        isGroup: true,
        groupId,
        participants: [{ identifier: phone }],
      });
    }

    const history = await integrations.requestAgentPhoneGroupHistory(
      member,
      { groupId, limit: 100 },
      [200],
    );
    if (history.status !== 200) {
      throw new Error("Expected the group history to load");
    }
    expect(
      history.body.messages.map((message) => {
        return { id: message.id, body: message.body };
      }),
    ).toStrictEqual([{ id: messageId, body: "Corrected group text" }]);
  });
});

describe("iMessage group discovery", () => {
  it("agentphone-groups.bdd-008 discovers a group from messages received before the participant connected Okou", async () => {
    const capture = configureSignedAgentPhone();
    const firstPhone = uniquePhoneHandle();
    const secondPhone = uniquePhoneHandle();
    await linkedMember(capture, firstPhone);
    const conversationId = uniqueConversationId();
    const groupId = bddGroupId(conversationId);
    const receivedAt = new Date(now() - 60_000).toISOString();
    await groupMessage({
      from: firstPhone,
      conversationId,
      participants: [firstPhone, secondPhone],
      receivedAt,
    });
    const second = await linkedMember(capture, secondPhone);
    providerConversations({
      [conversationId]: {
        id: conversationId,
        groupId,
        participants: [secondPhone, AGENTPHONE_BDD_PHONE_NUMBER],
      },
    });

    const response = await integrations.requestAgentPhoneGroupList(
      second,
      { limit: 25 },
      [200],
    );

    expect(response.body).toStrictEqual({
      groups: [
        {
          groupId,
          conversationId,
          groupName: null,
          agentphoneAgentId: AGENTPHONE_BDD_AGENT_ID,
          lastMessageAt: receivedAt,
        },
      ],
      nextCursor: null,
    });
  });

  it("agentphone-groups.bdd-009 lists each shared group once with its current name and latest visible message time", async () => {
    const capture = configureSignedAgentPhone();
    const phone = uniquePhoneHandle();
    // The direct iMessage arrives before linking, so it is archived without
    // starting an agent reply.
    await agentPhone.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "Direct note",
      conversationId: uniqueConversationId(),
    });
    const member = await linkedMember(capture, phone);
    const conversationId = uniqueConversationId();
    const groupId = bddGroupId(conversationId);
    const firstAt = now() - 10_000;
    const laterAt = new Date(firstAt + 1000).toISOString();
    await groupMessage({
      from: phone,
      conversationId,
      participants: [phone],
      receivedAt: new Date(firstAt).toISOString(),
    });
    await groupMessage({
      from: phone,
      conversationId,
      participants: [phone],
      body: "Second group message",
      receivedAt: laterAt,
    });
    providerConversations({
      [conversationId]: {
        id: conversationId,
        groupId,
        groupName: "Renamed group",
        participants: [phone, AGENTPHONE_BDD_PHONE_NUMBER],
      },
    });

    const response = await integrations.requestAgentPhoneGroupList(
      member,
      { limit: 25 },
      [200],
    );

    expect(response.body).toStrictEqual({
      groups: [
        {
          groupId,
          conversationId,
          groupName: "Renamed group",
          agentphoneAgentId: AGENTPHONE_BDD_AGENT_ID,
          lastMessageAt: laterAt,
        },
      ],
      nextCursor: null,
    });
  });

  it("agentphone-groups.bdd-010 does not expose a known group to an another user", async () => {
    const capture = configureSignedAgentPhone();
    const phone = uniquePhoneHandle();
    const member = await linkedMember(capture, phone);
    const conversationId = uniqueConversationId();
    await groupMessage({ from: phone, conversationId, participants: [phone] });
    const otherPhone = uniquePhoneHandle();
    const other = await linkedMember(
      capture,
      otherPhone,
      integrations.user({ orgId: member.orgId, orgRole: "org:member" }),
    );
    const lookups = providerConversations({
      [conversationId]: {
        id: conversationId,
        groupId: bddGroupId(conversationId),
        participants: [phone, AGENTPHONE_BDD_PHONE_NUMBER],
      },
    });

    const response = await integrations.requestAgentPhoneGroupList(
      other,
      { limit: 25 },
      [200],
    );

    expect(response.body).toStrictEqual({ groups: [], nextCursor: null });
    expect(lookups).toStrictEqual([]);
  });

  it("agentphone-groups.bdd-011 does not expose a known group to an another organization", async () => {
    const capture = configureSignedAgentPhone();
    const phone = uniquePhoneHandle();
    const member = await linkedMember(capture, phone);
    const conversationId = uniqueConversationId();
    await groupMessage({ from: phone, conversationId, participants: [phone] });
    const lookups = providerConversations({
      [conversationId]: {
        id: conversationId,
        groupId: bddGroupId(conversationId),
        participants: [phone, AGENTPHONE_BDD_PHONE_NUMBER],
      },
    });

    const response = await integrations.requestAgentPhoneGroupList(
      { ...member, orgId: `org_${randomUUID()}` },
      { limit: 25 },
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(lookups).toStrictEqual([]);
  });

  it("agentphone-groups.bdd-012 does not expose a known group to an unlinked phone", async () => {
    const capture = configureSignedAgentPhone();
    const phone = uniquePhoneHandle();
    const member = await linkedMember(capture, phone);
    const conversationId = uniqueConversationId();
    await groupMessage({ from: phone, conversationId, participants: [phone] });
    await integrations.requestUnlinkAgentPhone(member, [204]);
    const lookups = providerConversations({
      [conversationId]: {
        id: conversationId,
        groupId: bddGroupId(conversationId),
        participants: [phone, AGENTPHONE_BDD_PHONE_NUMBER],
      },
    });

    const response = await integrations.requestAgentPhoneGroupList(
      member,
      { limit: 25 },
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(lookups).toStrictEqual([]);
  });

  it("agentphone-groups.bdd-013 does not expose a known group to an departed member", async () => {
    const capture = configureSignedAgentPhone();
    const phone = uniquePhoneHandle();
    const member = await linkedMember(capture, phone);
    const conversationId = uniqueConversationId();
    await groupMessage({ from: phone, conversationId, participants: [phone] });
    const lookups = providerConversations({
      [conversationId]: {
        id: conversationId,
        groupId: bddGroupId(conversationId),
        participants: [uniquePhoneHandle(), AGENTPHONE_BDD_PHONE_NUMBER],
      },
    });

    const response = await integrations.requestAgentPhoneGroupList(
      member,
      { limit: 25 },
      [200],
    );

    expect(response.body).toStrictEqual({ groups: [], nextCursor: null });
    expect(lookups).toStrictEqual([conversationId]);
  });

  it("agentphone-groups.bdd-014 continues after an empty candidate page and does not repeat a group when new messages arrive", async () => {
    const capture = configureSignedAgentPhone();
    const phone = uniquePhoneHandle();
    const member = await linkedMember(capture, phone);
    const prefix = `grp_bdd_${randomUUID().slice(0, 8)}`;
    const removed = {
      conversationId: uniqueConversationId(),
      groupId: `${prefix}_a`,
    };
    const current = {
      conversationId: uniqueConversationId(),
      groupId: `${prefix}_b`,
    };
    await groupMessage({ from: phone, participants: [phone], ...removed });
    await groupMessage({ from: phone, participants: [phone], ...current });
    providerConversations({
      [current.conversationId]: {
        id: current.conversationId,
        groupId: current.groupId,
        participants: [phone, AGENTPHONE_BDD_PHONE_NUMBER],
      },
    });

    const first = await integrations.requestAgentPhoneGroupList(
      member,
      { limit: 1 },
      [200],
    );
    expect(first.body.groups).toStrictEqual([]);
    const cursor = first.body.nextCursor;
    if (!cursor) {
      throw new Error("Expected a continuation cursor after the first page");
    }
    await groupMessage({
      from: phone,
      participants: [phone],
      body: "A newer message",
      ...removed,
    });
    const second = await integrations.requestAgentPhoneGroupList(
      member,
      { limit: 1, cursor },
      [200],
    );

    expect(second.body).toStrictEqual({
      groups: [
        {
          groupId: current.groupId,
          conversationId: current.conversationId,
          groupName: null,
          agentphoneAgentId: AGENTPHONE_BDD_AGENT_ID,
          lastMessageAt: expect.any(String),
        },
      ],
      nextCursor: null,
    });
  });

  it("agentphone-groups.bdd-019 omits a candidate when the provider resolves it to a departed bot", async () => {
    const capture = configureSignedAgentPhone();
    const phone = uniquePhoneHandle();
    const member = await linkedMember(capture, phone);
    const conversationId = uniqueConversationId();
    await groupMessage({ from: phone, conversationId, participants: [phone] });
    providerConversations({
      [conversationId]: {
        id: conversationId,
        groupId: bddGroupId(conversationId),
        participants: [phone],
      },
    });

    const response = await integrations.requestAgentPhoneGroupList(
      member,
      { limit: 25 },
      [200],
    );

    expect(response.body).toStrictEqual({ groups: [], nextCursor: null });
  });

  it("agentphone-groups.bdd-020 reports provider failure instead of fabricating an empty list", async () => {
    const capture = configureSignedAgentPhone();
    const phone = uniquePhoneHandle();
    const member = await linkedMember(capture, phone);
    const conversationId = uniqueConversationId();
    await groupMessage({ from: phone, conversationId, participants: [phone] });
    providerConversations({ [conversationId]: 503 });

    const response = await integrations.requestAgentPhoneGroupList(
      member,
      { limit: 25 },
      [502],
    );

    expect(response.body.error.code).toBe("AGENTPHONE_ERROR");
  });
});
