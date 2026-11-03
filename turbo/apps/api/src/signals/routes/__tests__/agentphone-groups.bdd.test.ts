import { randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import { now } from "../../../lib/time";
import {
  AGENTPHONE_BDD_AGENT_ID,
  AGENTPHONE_BDD_PHONE_NUMBER,
  bddGroupId,
  createAgentPhoneBddApi,
  uniqueConversationId,
  uniquePhoneHandle,
} from "./helpers/api-bdd-agentphone";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";

const context = testContext();

async function linkedGroupMember() {
  const integrations = createBddIntegrationApi(context);
  const ap = createAgentPhoneBddApi(context);
  integrations.configureAgentPhoneProvider();
  integrations.configureAgentPhoneWebhook();
  context.mocks.ably.publish.mockResolvedValue(undefined);
  const sends = ap.captureAgentPhoneSends();
  const actor = integrations.user();
  const phone = uniquePhoneHandle();
  await ap.linkViaWebhookConnectPrompt(actor, phone, sends);
  return { integrations, ap, actor, phone, sends };
}

function currentGroup(args: {
  conversationId: string;
  groupId: string;
  phone: string;
  groupName?: string | null;
}) {
  const { conversationId, groupId, phone, groupName = "Project group" } = args;
  return {
    id: conversationId,
    agentId: AGENTPHONE_BDD_AGENT_ID,
    phoneNumber: AGENTPHONE_BDD_PHONE_NUMBER,
    isGroup: true,
    groupId,
    groupName,
    participants: [
      { identifier: phone },
      { identifier: AGENTPHONE_BDD_PHONE_NUMBER },
    ],
  };
}

describe("iMessage group discovery", () => {
  it("lists each shared group once with its current name and latest visible message time", async () => {
    const { integrations, ap, actor, phone } = await linkedGroupMember();
    const conversationId = uniqueConversationId();
    const groupId = bddGroupId(conversationId);
    const timestamps = [
      new Date(now() + 1000).toISOString(),
      new Date(now() + 2000).toISOString(),
    ];
    for (const receivedAt of timestamps) {
      await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: phone,
        body: "ordinary group conversation",
        conversationId,
        isGroup: true,
        receivedAt,
      });
    }
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "ordinary direct conversation",
      conversationId: uniqueConversationId(),
    });
    server.use(
      http.get(
        `https://api.agentphone.test/v1/conversations/${conversationId}`,
        () => {
          return HttpResponse.json(
            currentGroup({
              conversationId,
              groupId,
              phone,
              groupName: "Renamed group",
            }),
          );
        },
      ),
    );
    const listed = await integrations.requestAgentPhoneGroupList(
      actor,
      { limit: 25 },
      [200],
    );
    expect(listed.body).toStrictEqual({
      groups: [
        {
          groupId,
          conversationId,
          groupName: "Renamed group",
          agentphoneAgentId: AGENTPHONE_BDD_AGENT_ID,
          lastMessageAt: timestamps[1],
        },
      ],
      nextCursor: null,
    });
  });

  it.each([
    "another user",
    "another organization",
    "unlinked phone",
    "departed member",
  ] as const)("does not expose a known group to an %s", async (scenario) => {
    const { integrations, ap, actor, phone, sends } = await linkedGroupMember();
    const conversationId = uniqueConversationId();
    const groupId = bddGroupId(conversationId);
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "ordinary group conversation",
      conversationId,
      isGroup: true,
    });
    let reader = actor;
    if (scenario === "another user") {
      reader = integrations.user({ orgId: actor.orgId });
      await ap.linkViaWebhookConnectPrompt(reader, uniquePhoneHandle(), sends);
    }
    if (scenario === "another organization") {
      reader = { ...actor, orgId: `org_${randomUUID()}` };
    }
    if (scenario === "unlinked phone") {
      await integrations.requestUnlinkAgentPhone(actor, [204]);
    }
    const lookups: string[] = [];
    server.use(
      http.get(
        "https://api.agentphone.test/v1/conversations/:id",
        ({ params }) => {
          lookups.push(String(params.id));
          return HttpResponse.json(
            currentGroup({
              conversationId,
              groupId,
              phone: uniquePhoneHandle(),
            }),
          );
        },
      ),
    );
    if (scenario === "another organization" || scenario === "unlinked phone") {
      const denied = await integrations.requestAgentPhoneGroupList(
        reader,
        { limit: 25 },
        [404],
      );
      expect(denied.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    } else {
      const listed = await integrations.requestAgentPhoneGroupList(
        reader,
        { limit: 25 },
        [200],
      );
      expect(listed.body).toStrictEqual({ groups: [], nextCursor: null });
    }
    expect(lookups).toStrictEqual(
      scenario === "departed member" ? [conversationId] : [],
    );
  });

  it("continues after an empty candidate page and does not repeat a group when new messages arrive", async () => {
    const { integrations, ap, actor, phone } = await linkedGroupMember();
    const prefix = randomUUID();
    const firstConversationId = uniqueConversationId();
    const secondConversationId = uniqueConversationId();
    const firstGroupId = `grp_a_${prefix}`;
    const secondGroupId = `grp_z_${prefix}`;
    for (const [conversationId, groupId] of [
      [firstConversationId, firstGroupId],
      [secondConversationId, secondGroupId],
    ] as const) {
      await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: phone,
        body: "ordinary group conversation",
        conversationId,
        groupId,
        isGroup: true,
      });
    }
    server.use(
      http.get(
        `https://api.agentphone.test/v1/conversations/${firstConversationId}`,
        () => {
          return HttpResponse.json(
            { detail: "Conversation removed" },
            { status: 404 },
          );
        },
      ),
      http.get(
        `https://api.agentphone.test/v1/conversations/${secondConversationId}`,
        () => {
          return HttpResponse.json(
            currentGroup({
              conversationId: secondConversationId,
              groupId: secondGroupId,
              phone,
              groupName: null,
            }),
          );
        },
      ),
    );
    const first = await integrations.requestAgentPhoneGroupList(
      actor,
      { limit: 1 },
      [200],
    );
    expect(first.body.groups).toStrictEqual([]);
    expect(first.body.nextCursor).toStrictEqual(expect.any(String));
    if (!first.body.nextCursor) {
      throw new Error("Expected a continuation cursor");
    }
    await ap.postAgentPhoneInboundMessage({
      channel: "imessage",
      from: phone,
      body: "new message in the first group",
      conversationId: firstConversationId,
      groupId: firstGroupId,
      isGroup: true,
    });
    const second = await integrations.requestAgentPhoneGroupList(
      actor,
      { limit: 1, cursor: first.body.nextCursor },
      [200],
    );
    expect(second.body).toStrictEqual({
      groups: [
        {
          groupId: secondGroupId,
          conversationId: secondConversationId,
          groupName: null,
          agentphoneAgentId: AGENTPHONE_BDD_AGENT_ID,
          lastMessageAt: expect.any(String),
        },
      ],
      nextCursor: null,
    });
  });

  it.each([
    "foreign agent",
    "different group",
    "not a group",
    "different conversation",
    "departed bot",
  ] as const)(
    "omits a candidate when the provider resolves it to a %s",
    async (scenario) => {
      const { integrations, ap, actor, phone } = await linkedGroupMember();
      const conversationId = uniqueConversationId();
      const groupId = bddGroupId(conversationId);
      await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: phone,
        body: "ordinary group conversation",
        conversationId,
        isGroup: true,
      });
      server.use(
        http.get(
          `https://api.agentphone.test/v1/conversations/${conversationId}`,
          () => {
            return HttpResponse.json({
              ...currentGroup({ conversationId, groupId, phone }),
              ...(scenario === "foreign agent"
                ? { agentId: "another-agent" }
                : {}),
              ...(scenario === "different group"
                ? { groupId: "grp_other" }
                : {}),
              ...(scenario === "not a group"
                ? { isGroup: false, groupId: null }
                : {}),
              ...(scenario === "different conversation"
                ? { id: uniqueConversationId() }
                : {}),
              ...(scenario === "departed bot"
                ? { participants: [{ identifier: phone }] }
                : {}),
            });
          },
        ),
      );
      const listed = await integrations.requestAgentPhoneGroupList(
        actor,
        { limit: 25 },
        [200],
      );
      expect(listed.body).toStrictEqual({ groups: [], nextCursor: null });
    },
  );

  it.each(["provider failure", "invalid roster"] as const)(
    "reports %s instead of fabricating an empty list",
    async (scenario) => {
      const { integrations, ap, actor, phone } = await linkedGroupMember();
      const conversationId = uniqueConversationId();
      await ap.postAgentPhoneInboundMessage({
        channel: "imessage",
        from: phone,
        body: "ordinary group conversation",
        conversationId,
        isGroup: true,
      });
      server.use(
        http.get(
          `https://api.agentphone.test/v1/conversations/${conversationId}`,
          () => {
            return scenario === "provider failure"
              ? HttpResponse.json({ detail: "Unavailable" }, { status: 503 })
              : HttpResponse.json({ participants: "invalid" });
          },
        ),
      );
      const failed = await integrations.requestAgentPhoneGroupList(
        actor,
        { limit: 25 },
        [502],
      );
      expect(failed.body).toMatchObject({
        error: { code: "AGENTPHONE_ERROR" },
      });
    },
  );

  it("requires authentication and rejects invalid pagination", async () => {
    const { integrations, actor } = await linkedGroupMember();
    const unauthorized = await integrations.requestAgentPhoneGroupList(
      null,
      { limit: 25 },
      [401],
    );
    expect(unauthorized.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
    for (const query of [
      { limit: 0 },
      { limit: 101 },
      { limit: 25, cursor: "invalid" },
    ]) {
      const invalid = await integrations.requestAgentPhoneGroupList(
        actor,
        query,
        [400],
      );
      expect(invalid.status).toBe(400);
    }
  });
});
