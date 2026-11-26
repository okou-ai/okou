import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockNow } from "../../../lib/time";
import {
  createAgentPhoneBddApi,
  uniquePhoneHandle,
} from "./helpers/api-bdd-agentphone";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { marketingRewardConsumer } from "./helpers/marketing-reward-consumer";

const context = testContext();
const integrations = createBddIntegrationApi(context);
const agentPhone = createAgentPhoneBddApi(context);

describe("Marketing reward source events", () => {
  it("marketing-reward-events-004 publishes immutable iMessage owner facts through repeated requests, switching and source deletion", async () => {
    const consumer = marketingRewardConsumer();
    integrations.configureAgentPhoneProvider();
    integrations.configureAgentPhoneWebhook();
    const capture = agentPhone.captureAgentPhoneSends();
    const occurredAt = "2026-01-01T08:00:00.000Z";
    mockNow(new Date(occurredAt));
    const member = integrations.user({ orgRole: "org:member" });
    const firstPhone = uniquePhoneHandle();
    const secondPhone = uniquePhoneHandle();
    const firstProof = await agentPhone.requestConnectLink(firstPhone, capture);
    const secondProof = await agentPhone.requestConnectLink(
      secondPhone,
      capture,
    );

    await integrations.requestConnectAgentPhone(member, firstProof, [200]);
    await integrations.requestConnectAgentPhone(member, firstProof, [200]);
    const afterFirstConnects = [...consumer.received];
    await integrations.requestConnectAgentPhone(member, secondProof, [409]);
    const switchBody = { ...secondProof, replacePhoneHandle: firstPhone };
    await integrations.requestConnectAgentPhone(member, switchBody, [200]);
    await integrations.requestConnectAgentPhone(member, switchBody, [200]);
    await integrations.requestUnlinkAgentPhone(member, [204]);
    const link = await integrations.getAgentPhoneLinkStatus(member);

    expect(afterFirstConnects).toStrictEqual([
      {
        version: 2,
        id: expect.any(String),
        environment: "development",
        type: "imessage.identity-linked",
        occurredAt,
        orgId: member.orgId,
        userId: member.userId,
        linkId: expect.any(String),
      },
    ]);
    expect(link.linked).toBeFalsy();
    expect(consumer.received).toHaveLength(2);
    const [first, switched] = consumer.received;
    if (
      first?.type !== "imessage.identity-linked" ||
      switched?.type !== "imessage.identity-linked"
    ) {
      throw new Error("expected two iMessage identity events");
    }
    expect(switched.id).not.toBe(first.id);
    expect(switched.linkId).not.toBe(first.linkId);
    expect(switched).toMatchObject({
      orgId: member.orgId,
      userId: member.userId,
    });
  });
});
