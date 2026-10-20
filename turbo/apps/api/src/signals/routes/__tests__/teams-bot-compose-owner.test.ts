import { randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createPublicTeamsDispatchFixture } from "./helpers/public-teams-dispatch-fixture";
import {
  postTeamsActivityForTest,
  teamsMessageActivityForTest,
  type TeamsConnectFixture,
} from "./helpers/teams-connect";

const context = testContext();

function configurePersonalConversationMocks(tenantId: string): void {
  server.use(
    http.post(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      () => {
        return HttpResponse.json({
          access_token: "teams-graph-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      },
    ),
    http.get(
      "https://graph.microsoft.com/v1.0/users/:userId/teamwork/installedApps",
      () => {
        return HttpResponse.json({ value: [] });
      },
    ),
  );
}

function absentSenderResponse(
  installation: TeamsConnectFixture,
  activityId: string,
  conversationId: string,
  prompt: string,
) {
  return {
    ok: true,
    activity: {
      kind: "message",
      activityId,
      tenantId: installation.teamsTenantId,
      tenantName: installation.teamsTenantName,
      teamsAppId: null,
      serviceUrl: installation.serviceUrl,
      conversationId,
      conversationType: "personal",
      teamId: null,
      teamAadGroupId: null,
      teamName: null,
      channelId: null,
      timestamp: "2026-06-30T09:10:00.000Z",
      idempotencyKey: `${conversationId}:message:${activityId}`,
      threadId: activityId,
      sender: {
        id: "",
        name: null,
        aadObjectId: null,
        userPrincipalName: null,
      },
      recipient: {
        id: installation.teamsBotId,
        name: "Nova",
        aadObjectId: null,
        userPrincipalName: null,
      },
      rawText: prompt,
      text: prompt,
      value: null,
      mentionsRecipient: false,
      attachments: [],
    },
    connectUrl: null,
  };
}

test("selects the onboarded default agent for a public Teams personal message", async () => {
  const owner = createPublicTeamsDispatchFixture(context);
  await owner.run(async () => {
    const runs = createRunsApi(context);
    runs.configureRunnerGroup();
    const fixture = await owner.create({ withDefaultAgent: true });
    server.use(
      http.post(
        `https://login.microsoftonline.com/${fixture.installation.teamsTenantId}/oauth2/v2.0/token`,
        () => {
          return HttpResponse.json({
            access_token: "teams-graph-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
        },
      ),
      http.get(
        "https://graph.microsoft.com/v1.0/users/:userId/teamwork/installedApps",
        () => {
          return HttpResponse.json({ value: [] });
        },
      ),
    );

    const prompt = "Summarize the Teams compose selection for this message";
    await owner.dispatch(fixture, prompt);
    const reads = createRunReadsApi(context);
    const listed = await reads.requestListLogs(
      fixture.actor,
      { limit: 50 },
      [200],
    );
    expect(fixture.defaultAgentId).toStrictEqual(expect.any(String));
    expect(listed.body.data).toHaveLength(1);
    const run = listed.body.data[0];
    if (!run) {
      throw new Error("Expected the public Teams message to launch a Run");
    }
    expect(run).toMatchObject({
      agentId: fixture.defaultAgentId,
      prompt,
      triggerSource: "teams",
      status: "pending",
      startedAt: null,
    });

    await runs.requestCancelRun(fixture.actor, run.id, [200]);
    await flushWaitUntilForTest();
    const cancelled = await reads.requestReadLogById(
      fixture.actor,
      run.id,
      [200],
    );
    expect(cancelled.body).toMatchObject({
      id: run.id,
      agentId: fixture.defaultAgentId,
      prompt,
      status: "cancelled",
      startedAt: null,
    });
  });
});

test("refreshes a connected Teams sender ID without changing its Aad identity", async () => {
  const owner = createPublicTeamsDispatchFixture(context);
  await owner.run(async () => {
    const runs = createRunsApi(context);
    runs.configureRunnerGroup();
    const fixture = await owner.create({ withDefaultAgent: true });
    configurePersonalConversationMocks(fixture.installation.teamsTenantId);
    const originalAccount = {
      tenantId: fixture.installation.teamsTenantId,
      teamsUserId: fixture.installation.teamsUserId,
      teamsAadObjectId: fixture.installation.teamsAadObjectId,
      displayName: "Teams User",
      userPrincipalName: fixture.installation.teamsUserPrincipalName,
    };
    const before = await owner.status(fixture);
    expect(before.linkedAccounts).toStrictEqual([originalAccount]);

    const teamsUserId = `29:refreshed-${randomUUID()}`;
    const prompt = "Summarize the message from the refreshed Teams sender";
    await owner.dispatch(
      {
        ...fixture,
        installation: { ...fixture.installation, teamsUserId },
      },
      prompt,
    );
    const after = await owner.status(fixture);
    expect(after.linkedAccounts).toStrictEqual([
      { ...originalAccount, teamsUserId },
    ]);
    const reads = createRunReadsApi(context);
    const listed = await reads.requestListLogs(
      fixture.actor,
      { limit: 50 },
      [200],
    );
    expect(fixture.defaultAgentId).toStrictEqual(expect.any(String));
    expect(listed.body.data).toHaveLength(1);
    const run = listed.body.data[0];
    if (!run) {
      throw new Error("Expected the refreshed Teams sender to launch a Run");
    }
    expect(run).toMatchObject({
      agentId: fixture.defaultAgentId,
      prompt,
      triggerSource: "teams",
      status: "pending",
      startedAt: null,
    });

    await runs.requestCancelRun(fixture.actor, run.id, [200]);
    await flushWaitUntilForTest();
    const cancelled = await reads.requestReadLogById(
      fixture.actor,
      run.id,
      [200],
    );
    expect(cancelled.body).toMatchObject({
      id: run.id,
      agentId: fixture.defaultAgentId,
      prompt,
      status: "cancelled",
      startedAt: null,
    });
  });
});

test("falls back to the connected Teams sender when the Aad identity is unknown", async () => {
  const owner = createPublicTeamsDispatchFixture(context);
  await owner.run(async () => {
    const runs = createRunsApi(context);
    runs.configureRunnerGroup();
    const fixture = await owner.create({ withDefaultAgent: true });
    configurePersonalConversationMocks(fixture.installation.teamsTenantId);
    const originalAccount = {
      tenantId: fixture.installation.teamsTenantId,
      teamsUserId: fixture.installation.teamsUserId,
      teamsAadObjectId: fixture.installation.teamsAadObjectId,
      displayName: "Teams User",
      userPrincipalName: fixture.installation.teamsUserPrincipalName,
    };
    const before = await owner.status(fixture);
    expect(before.linkedAccounts).toStrictEqual([originalAccount]);

    const teamsAadObjectId = `unknown-aad-${randomUUID()}`;
    const prompt = "Summarize the message with an unknown Teams Aad identity";
    await owner.dispatch(
      {
        ...fixture,
        installation: { ...fixture.installation, teamsAadObjectId },
      },
      prompt,
    );
    const after = await owner.status(fixture);
    expect(after.linkedAccounts).toStrictEqual([originalAccount]);
    const reads = createRunReadsApi(context);
    const listed = await reads.requestListLogs(
      fixture.actor,
      { limit: 50 },
      [200],
    );
    expect(fixture.defaultAgentId).toStrictEqual(expect.any(String));
    expect(listed.body.data).toHaveLength(1);
    const run = listed.body.data[0];
    if (!run) {
      throw new Error(
        "Expected the connected Teams sender fallback to launch a Run",
      );
    }
    expect(run).toMatchObject({
      agentId: fixture.defaultAgentId,
      prompt,
      triggerSource: "teams",
      status: "pending",
      startedAt: null,
    });

    await runs.requestCancelRun(fixture.actor, run.id, [200]);
    await flushWaitUntilForTest();
    const cancelled = await reads.requestReadLogById(
      fixture.actor,
      run.id,
      [200],
    );
    expect(cancelled.body).toMatchObject({
      id: run.id,
      agentId: fixture.defaultAgentId,
      prompt,
      status: "cancelled",
      startedAt: null,
    });
  });
});

test("returns a connection notice without starting a Run when Teams sender identity is absent", async () => {
  const owner = createPublicTeamsDispatchFixture(context);
  await owner.run(async () => {
    const runs = createRunsApi(context);
    runs.configureRunnerGroup();
    const fixture = await owner.create({ withDefaultAgent: true });
    configurePersonalConversationMocks(fixture.installation.teamsTenantId);
    const before = await owner.status(fixture);
    expect(before.linkedAccounts).toStrictEqual([
      {
        tenantId: fixture.installation.teamsTenantId,
        teamsUserId: fixture.installation.teamsUserId,
        teamsAadObjectId: fixture.installation.teamsAadObjectId,
        displayName: "Teams User",
        userPrincipalName: fixture.installation.teamsUserPrincipalName,
      },
    ]);

    const activityId = `activity-absent-${randomUUID()}`;
    const conversationId = `19:absent-${randomUUID()}@thread.v2`;
    const prompt = "Summarize this message without a Teams sender identity";
    const noticeCount = fixture.notices.length;
    const response = await postTeamsActivityForTest({
      signal: context.signal,
      activity: teamsMessageActivityForTest(fixture.installation, {
        id: activityId,
        conversation: { id: conversationId, conversationType: "personal" },
        channelData: {
          tenant: {
            id: fixture.installation.teamsTenantId,
            name: fixture.installation.teamsTenantName,
          },
        },
        from: {},
        text: prompt,
        entities: [],
        replyToId: null,
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual(
      absentSenderResponse(
        fixture.installation,
        activityId,
        conversationId,
        prompt,
      ),
    );
    await flushWaitUntilForTest();
    expect(fixture.notices.slice(noticeCount)).toStrictEqual([
      "Please connect your account to use Okou in this Teams workspace.",
    ]);
    const reads = createRunReadsApi(context);
    const listed = await reads.requestListLogs(
      fixture.actor,
      { limit: 50 },
      [200],
    );
    expect(listed.body.data).toStrictEqual([]);
    await expect(owner.status(fixture)).resolves.toStrictEqual(before);
  });
});
