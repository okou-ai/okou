import { randomUUID } from "node:crypto";

import type { ChatEvent } from "@okouai/api-contracts/contracts/chat-threads";
import { teamsConnectContract } from "@okouai/api-contracts/contracts/teams-connect";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { teamsConnectRoutes } from "../teams-connect";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { findPendingInputEventByText } from "./helpers/chat-event-test-reader";
import { createPublicAnnotationInputs } from "./helpers/chat-annotation-ingress";
import { createRouteMocks } from "./helpers/route-test";
import {
  installTeamsForTest,
  postTeamsActivityForTest,
  removeTeamsForTest,
  setupTeamsConnectTestEnv,
  teamsConnectFixture,
  teamsMessageActivityForTest,
} from "./helpers/teams-connect";

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
  const publicCleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const cleanup of publicCleanups.splice(0)) {
      await cleanup();
      await flushWaitUntilForTest();
    }
  });
  it("projects precise source links for chat events", async () => {
    const inputs = await createPublicAnnotationInputs(context, (cleanup) => {
      publicCleanups.push(cleanup);
    });
    expect(
      sourcePartForText(inputs.slackEvents, "@Slack User slack linked"),
    ).toStrictEqual({
      type: "source",
      kind: "slack",
      href: "https://vm0.slack.com/archives/C123/p1753257600000100",
    });
    expect(
      sourcePartForText(inputs.feishuEvents, "feishu linked"),
    ).toStrictEqual({
      type: "source",
      kind: "feishu",
      href: "https://applink.feishu.cn/client/chat/open?openChatId=oc_123",
    });
    expect(
      sourcePartForText(
        inputs.teamsChannel.events,
        "@Nova teams channel linked",
      ),
    ).toStrictEqual({
      type: "source",
      kind: "teams",
      href: `https://teams.microsoft.com/l/message/19%3Achannel%40thread.tacv2/activity-1?tenantId=${inputs.teamsChannel.tenantId}`,
    });
    expect(
      sourcePartForText(inputs.teamsPersonal.events, "teams personal unlinked"),
    ).toStrictEqual({
      type: "source",
      kind: "teams",
    });
    expect(
      sourcePartForText(
        inputs.telegramSupergroup,
        "telegram supergroup linked",
      ),
    ).toStrictEqual({
      type: "source",
      kind: "telegram",
      href: "https://t.me/c/1234567890/42",
    });
    expect(
      sourcePartForText(inputs.telegramPrivate, "telegram dm unlinked"),
    ).toStrictEqual({
      type: "source",
      kind: "telegram",
    });
    expect(
      sourcePartForText(inputs.telegramGroup, "telegram group unlinked"),
    ).toStrictEqual({
      type: "source",
      kind: "telegram",
    });
    expect(
      sourcePartForText(inputs.githubIssue, "github issue comment linked"),
    ).toStrictEqual({
      type: "source",
      kind: "github",
      href: "https://github.com/okou-ai/okou/issues/24218#issuecomment-123456",
    });
    expect(
      sourcePartForText(inputs.githubPull, "github pull request linked"),
    ).toStrictEqual({
      type: "source",
      kind: "github",
      href: "https://github.com/okou-ai/okou/pull/24219",
    });
  });

  it("inherits precise source links across claimed and rejected replacements", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const group = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor, { model: "claude-fable-5-1" });
    const { defaultAgentId } = await bdd.readOnboardingStatus(actor);
    if (!defaultAgentId) {
      throw new Error("Expected the paid owner's Agent");
    }
    const claimedPendingId = randomUUID();
    const prompt = "github claimed replacement";
    const sent = await chat.sendAndLaunch(actor, {
      agentId: defaultAgentId,
      clientEventId: claimedPendingId,
      prompt,
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: prompt },
          {
            type: "source",
            kind: "github",
            href: "https://github.com/okou-ai/okou/issues/24218#issuecomment-654321",
          },
        ],
      },
    });
    let activeRun = true;
    const cancelClaimed = async () => {
      if (activeRun) {
        await runs.requestCancelRun(actor, sent.runId, [200]);
        activeRun = false;
      }
    };
    publicCleanups.push(cancelClaimed);
    await runs.heartbeatRunner(group);
    await runs.claimRunnerJob(sent.runId);
    await expect(runs.readRun(actor, sent.runId)).resolves.toMatchObject({
      status: "running",
    });
    const { events } = await chat.listThreadEvents(actor, sent.threadId);
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
      href: "https://github.com/okou-ai/okou/issues/24218#issuecomment-654321",
    });
    await cancelClaimed();
    await flushWaitUntilForTest();

    // This owner has only already-expired paid credits. Keeping built-in
    // model selection makes real admission reject the Teams queued input.
    const rejectedActor = bdd.user();
    if (!rejectedActor.orgId) {
      throw new Error("Expected the rejected input's organization");
    }
    await runs.grantProEntitlement(rejectedActor, {
      periodEndUnix: Math.floor(now() / 1000) - 60 * 86_400,
    });
    setupTeamsConnectTestEnv();
    mockEnv("MICROSOFT_TEAMS_BOT_APP_PASSWORD", "teams-annotation-password");
    const fixture = teamsConnectFixture({
      orgId: rejectedActor.orgId,
      userId: rejectedActor.userId,
      teamsChannelId: "19:reject@thread.tacv2",
      teamsActivityId: "activity-rejected",
    });
    const serviceOrigin = fixture.serviceUrl.replace(/\/+$/u, "");
    server.use(
      http.post(
        "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/oauth2/v2.0/token",
        () => {
          return HttpResponse.json({
            access_token: "teams-annotation-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
        },
      ),
      http.post(`${serviceOrigin}/v3/conversations`, () => {
        return HttpResponse.json({ id: `welcome-${fixture.fixtureId}` });
      }),
      http.post(
        `${serviceOrigin}/v3/conversations/:conversationId/activities`,
        () => {
          return HttpResponse.json({ id: `reply-${randomUUID()}` });
        },
      ),
      http.post(
        `${serviceOrigin}/v3/conversations/:conversationId/activities/:activityId`,
        () => {
          return HttpResponse.json({ id: `reply-${randomUUID()}` });
        },
      ),
      http.put(
        `${serviceOrigin}/v3/conversations/:conversationId/activities/:activityId/reactions/:reactionType`,
        () => {
          return new HttpResponse(null, { status: 200 });
        },
      ),
      http.delete(
        `${serviceOrigin}/v3/conversations/:conversationId/activities/:activityId/reactions/:reactionType`,
        () => {
          return new HttpResponse(null, { status: 200 });
        },
      ),
    );
    await installTeamsForTest(context.signal, fixture);
    publicCleanups.push(async () => {
      await removeTeamsForTest(context.signal, fixture);
    });
    await flushWaitUntilForTest();
    createRouteMocks(context).clerk.session(
      rejectedActor.userId,
      rejectedActor.orgId,
      rejectedActor.orgRole,
    );
    await accept(
      setupApp({ context, routes: teamsConnectRoutes })(
        teamsConnectContract,
      ).connect({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          tenantId: fixture.teamsTenantId,
          teamsUserId: fixture.teamsUserId,
          teamsAadObjectId: fixture.teamsAadObjectId,
          teamsUserDisplayName: "Ada Lovelace",
          teamsUserPrincipalName: fixture.teamsUserPrincipalName,
        },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    const rejectedText = `teams rejected replacement ${randomUUID()}`;
    const response = await postTeamsActivityForTest({
      signal: context.signal,
      activity: teamsMessageActivityForTest(fixture, {
        text: `<at>Nova</at> ${rejectedText}`,
      }),
    });
    expect(response.status).toBe(200);
    await response.json();
    await flushWaitUntilForTest();
    const pending = await findPendingInputEventByText(context, {
      actor: rejectedActor,
      text: `@Nova ${rejectedText}`,
    });
    if (!pending) {
      throw new Error("Expected the publicly readable Teams queued input");
    }
    const rejectedPendingId = pending.id;
    const rejectedEvents = await chat.listThreadEvents(
      rejectedActor,
      pending.threadId,
    );
    const rejectedReplacement = rejectedEvents.events.find((event) => {
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
      href: `https://teams.microsoft.com/l/message/19%3Areject%40thread.tacv2/activity-rejected?tenantId=${fixture.teamsTenantId}`,
    });
  });
});
