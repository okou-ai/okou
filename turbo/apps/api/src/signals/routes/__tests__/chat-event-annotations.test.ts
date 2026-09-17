import type { ChatEvent } from "@okouai/api-contracts/contracts/chat-threads";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { seedChatEventAnnotationProjectionFixture } from "../../../test-fixtures/chat-events";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);

function eventText(event: ChatEvent): string | undefined {
  if (
    event.eventType !== "input.prompt" &&
    event.eventType !== "input.rejected"
  ) {
    return undefined;
  }
  return event.userMessage.parts.find((part) => {
    return part.type === "text";
  })?.text;
}

function sourcePartForText(events: readonly ChatEvent[], text: string) {
  const event = events.find((candidate) => {
    return eventText(candidate) === text;
  });
  if (
    event?.eventType !== "input.prompt" &&
    event?.eventType !== "input.rejected"
  ) {
    return undefined;
  }
  return event.userMessage.parts.find((part) => {
    return part.type === "source";
  });
}

describe("chat event annotations", () => {
  async function annotationProjection() {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "Annotation projection agent",
    });
    const thread = await chat.createThread(actor, {
      agentId: agent.agentId,
      title: "Annotation projections",
    });

    const { claimedPendingId, rejectedPendingId } =
      await seedChatEventAnnotationProjectionFixture(thread.id);

    const events = (await chat.listThreadEvents(actor, thread.id)).events;
    return { events, claimedPendingId, rejectedPendingId };
  }

  it("projects precise source links for chat events", async () => {
    const { events } = await annotationProjection();
    expect(sourcePartForText(events, "slack linked")).toStrictEqual({
      type: "source",
      kind: "slack",
      href: "https://vm0.slack.com/archives/C123/p1753257600000100",
    });
    expect(sourcePartForText(events, "feishu linked")).toStrictEqual({
      type: "source",
      kind: "feishu",
      href: "https://applink.feishu.cn/client/chat/open?openChatId=oc_123",
    });
    expect(sourcePartForText(events, "teams channel linked")).toStrictEqual({
      type: "source",
      kind: "teams",
      href: "https://teams.microsoft.com/l/message/19%3Achannel%40thread.tacv2/activity-1?tenantId=tenant-1",
    });
    expect(sourcePartForText(events, "teams personal unlinked")).toStrictEqual({
      type: "source",
      kind: "teams",
    });
    expect(
      sourcePartForText(events, "telegram supergroup linked"),
    ).toStrictEqual({
      type: "source",
      kind: "telegram",
      href: "https://t.me/c/1234567890/42",
    });
    expect(sourcePartForText(events, "telegram dm unlinked")).toStrictEqual({
      type: "source",
      kind: "telegram",
    });
    expect(sourcePartForText(events, "telegram group unlinked")).toStrictEqual({
      type: "source",
      kind: "telegram",
    });
    expect(
      sourcePartForText(events, "github issue comment linked"),
    ).toStrictEqual({
      type: "source",
      kind: "github",
      href: "https://github.com/vm0-ai/vm0/issues/24218#issuecomment-123456",
    });
    expect(
      sourcePartForText(events, "github pull request linked"),
    ).toStrictEqual({
      type: "source",
      kind: "github",
      href: "https://github.com/vm0-ai/vm0/pull/24219",
    });
  });

  it("inherits precise source links across claimed and rejected replacements", async () => {
    const { events, claimedPendingId, rejectedPendingId } =
      await annotationProjection();
    const claimedReplacement = events.find((event) => {
      return event.revokesEventId === claimedPendingId;
    });
    expect(
      claimedReplacement?.eventType === "input.prompt"
        ? claimedReplacement.userMessage.parts.find((part) => {
            return part.type === "source";
          })
        : undefined,
    ).toStrictEqual({
      type: "source",
      kind: "github",
      href: "https://github.com/vm0-ai/vm0/issues/24218#issuecomment-654321",
    });
    const rejectedReplacement = events.find((event) => {
      return (
        event.eventType === "input.rejected" &&
        event.revokesEventId === rejectedPendingId
      );
    });
    expect(
      rejectedReplacement?.eventType === "input.rejected"
        ? rejectedReplacement.userMessage.parts.find((part) => {
            return part.type === "source";
          })
        : undefined,
    ).toStrictEqual({
      type: "source",
      kind: "teams",
      href: "https://teams.microsoft.com/l/message/19%3Areject%40thread.tacv2/activity-rejected?tenantId=tenant-2",
    });
  });
});
