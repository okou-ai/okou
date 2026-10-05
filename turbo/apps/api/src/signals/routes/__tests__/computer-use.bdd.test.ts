import { randomUUID } from "node:crypto";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { teamsConnectContract } from "@okouai/api-contracts/contracts/teams-connect";
import { HttpResponse, http } from "msw";
import type {
  TestComputerUseStateGetResponse,
  TestComputerUseStatePostResponse,
} from "@okouai/api-contracts/contracts/test-computer-use-state";
import {
  COMPUTER_USE_FILESYSTEM_PLUGIN,
  COMPUTER_USE_PLUGIN_CALL_KIND,
  computerUseMcpServerCapability,
  computerUsePluginCapability,
  computerUsePluginToolCapability,
} from "@okouai/api-contracts/contracts/computer-use-plugins";
import { afterEach, describe, expect, it } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv } from "../../../lib/env";
import {
  clearMockNow,
  mockNow,
  now,
  withMockNowForTest,
} from "../../../lib/time";
import { generateSandboxToken } from "../../auth/tokens";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { teamsConnectRoutes } from "../teams-connect";
import { computerUseRoutes } from "../computer-use";
import { testComputerUseStateRoutes } from "../test-computer-use-state";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import {
  createComputerUseBddApi,
  computerUseToken,
} from "./helpers/api-bdd-computer-use";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { uniqueSlackUserId } from "./helpers/slack-public-install";
import {
  installTeamsForTest,
  postTeamsActivityForTest,
  removeTeamsForTest,
  setupTeamsConnectTestEnv,
  teamsConnectFixture,
  teamsMessageActivityForTest,
} from "./helpers/teams-connect";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { readRunLaunchSnapshotFixture } from "./helpers/runtime-state";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";

/*
 * FILE-03 timing notes:
 * - Hosts count as online for COMPUTER_USE_HOST_CLOSED_AFTER_MS (90s) after
 *   their last heartbeat/claim. The offline/ambiguous constructions below
 *   move mocked time forward (+91s/+120s) and rely on host heartbeat/claim
 *   calls refreshing lastSeenAt (#15750) to bring a stale host back online.
 * - The screenshot retention chain builds >30-day-old rows by running the
 *   full command flow under mockNow(now - 40d), then clears the mock before
 *   invoking fixture-scoped cleanup so the retention cutoff is computed at
 *   real time.
 */

const context = testContext();
const bdd = createBddApi(context);
const api = createComputerUseBddApi(context);
const COMPUTER_USE_STATE_ROUTE = "/api/test/computer-use-state";

afterEach(() => {
  clearMockNow();
});

function requireOrg(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected test actor to have an org");
  }
  return actor.orgId;
}

async function enableComputerUseDesktopPlugins(
  actor: ApiTestUser,
): Promise<void> {
  await updateFeatureSwitchesForUser(
    context,
    {
      userId: actor.userId,
      orgId: requireOrg(actor),
      orgRole: actor.orgRole,
    },
    {
      [FeatureSwitchKey.ComputerUseDesktopPlugins]: true,
    },
  );
}

function filesystemToolCapabilities(tool: "read_text_file"): readonly string[] {
  return [
    COMPUTER_USE_PLUGIN_CALL_KIND,
    computerUsePluginCapability(COMPUTER_USE_FILESYSTEM_PLUGIN),
    computerUsePluginToolCapability(COMPUTER_USE_FILESYSTEM_PLUGIN, tool),
  ];
}

interface ComputerUseRunFixture {
  readonly composeId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly threadId: string | null;
}

function requestComputerUseState(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testComputerUseStateRoutes,
  });
  return Promise.resolve(app.request(path, init));
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function deleteComputerUseRunFixture(
  fixture: ComputerUseRunFixture,
): Promise<void> {
  await requestComputerUseState(
    `${COMPUTER_USE_STATE_ROUTE}?run_id=${encodeURIComponent(fixture.runId)}`,
    { method: "DELETE" },
  );
}

const trackComputerUseRun = createFixtureTracker(deleteComputerUseRunFixture);

async function seedAgentRun(args: {
  readonly actor: ApiTestUser;
  readonly triggerSource: "web" | "slack" | "teams";
  readonly canonicalThread?: boolean;
}): Promise<ComputerUseRunFixture> {
  const response = await requestComputerUseState(COMPUTER_USE_STATE_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      user_id: args.actor.userId,
      org_id: requireOrg(args.actor),
      trigger_source: args.triggerSource,
      canonical_thread: args.canonicalThread,
    }),
  });
  expect(response.status).toBe(200);
  const body = await readJson<TestComputerUseStatePostResponse>(response);
  const fixture = {
    composeId: body.compose_id,
    runId: body.run_id,
    sessionId: body.session_id,
    threadId: body.thread_id,
  };
  return await trackComputerUseRun(Promise.resolve(fixture));
}

async function readComputerUseRunState(
  runId: string,
): Promise<TestComputerUseStateGetResponse> {
  const response = await requestComputerUseState(
    `${COMPUTER_USE_STATE_ROUTE}?run_id=${encodeURIComponent(runId)}`,
  );
  expect(response.status).toBe(200);
  return await readJson<TestComputerUseStateGetResponse>(response);
}

async function claimCanonicalIntegrationRun(args: {
  readonly actor: ApiTestUser;
  readonly source: "slack" | "teams";
  readonly prompt: string;
  readonly runs: ReturnType<typeof createRunsApi>;
  readonly runnerGroup: string;
}) {
  await flushWaitUntilForTest();
  const chat = createChatFilesBddApi(context);
  const lifecycle = await chat.requestThreadEvents(args.actor, {}, [200]);
  if (lifecycle.status !== 200) {
    throw new Error("Expected the integration actor's thread lifecycle");
  }
  const created = lifecycle.body.events.filter((event) => {
    return event.kind === "created";
  });
  expect(created).toHaveLength(1);
  const threadId = created[0]?.chatThreadId;
  if (!threadId) {
    throw new Error("Expected one integration-created chat thread");
  }
  const { events } = await chat.listThreadEvents(args.actor, threadId);
  const launched = events.filter((event) => {
    return event.eventType === "input.prompt" && event.runId !== undefined;
  });
  expect(launched).toHaveLength(1);
  const input = launched[0];
  if (!input || input.eventType !== "input.prompt" || !input.runId) {
    throw new Error("Expected one launched integration input");
  }
  expect(input.userMessage?.parts).toContainEqual(
    expect.objectContaining({ type: "source", kind: args.source }),
  );
  await args.runs.heartbeatRunner(args.runnerGroup);
  const claim = await args.runs.claimRunnerJob(input.runId);
  expect(claim.prompt).toContain(args.prompt);
  const log = await createRunReadsApi(context).requestReadLogById(
    args.actor,
    input.runId,
    [200],
  );
  expect(log.body.triggerSource).toBe(args.source);
  const token = claim.platformEnvironment.OKOU_TOKEN;
  if (!token) {
    throw new Error("Expected the Runner claim to issue an Okou token");
  }
  return { runId: input.runId, threadId, token };
}

function requestTokenFromUrl(authorizationUrl: string): string {
  const url = new URL(authorizationUrl);
  const prefix = "/computer-use/authorize/";
  if (!url.pathname.startsWith(prefix)) {
    throw new Error(`Unexpected authorization URL: ${authorizationUrl}`);
  }
  return decodeURIComponent(url.pathname.slice(prefix.length));
}

// Cancel runs before shared teardown aborts and drains their background work.
const trackAuthorizationRun = createFixtureTracker(
  async (fixture: { readonly actor: ApiTestUser; readonly runId: string }) => {
    await createRunsApi(context).requestCancelRun(
      fixture.actor,
      fixture.runId,
      [200],
    );
  },
);

async function createAuthorizationScenario(actor: ApiTestUser) {
  const runs = createRunsApi(context);
  const chat = createChatFilesBddApi(context);
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor, { model: "claude-fable-5-1" });
  const agent = await bdd.createAgent(actor, {
    displayName: "Computer Use authorization boundary",
    visibility: "private",
  });
  const run = await runs.createThreadRun(actor, {
    agentId: agent.agentId,
    prompt: "Authorize this thread to use my desktop",
  });
  await trackAuthorizationRun(Promise.resolve({ actor, runId: run.runId }));
  await runs.heartbeatRunner(runnerGroup);
  const claim = await runs.claimRunnerJob(run.runId);
  const token = claim.platformEnvironment.OKOU_TOKEN;
  if (!token) {
    throw new Error("Expected the Runner claim to issue an Okou token");
  }
  mockClerkMembership(context, actor, "org:admin");
  const created = await api.createComputerUseAuthorizationRequest({
    bearer: token,
  });
  return {
    chat,
    run,
    created,
    requestToken: requestTokenFromUrl(created.authorizationUrl),
  };
}

async function readAuthorizationThreadLifecycle(actor: ApiTestUser) {
  const response = await createChatFilesBddApi(context).requestThreadEvents(
    actor,
    {},
    [200],
  );
  if (response.status !== 200) {
    throw new Error("Expected the actor's thread lifecycle");
  }
  return response.body;
}

describe("FILE-03 desktop computer-use runtime", () => {
  it("creates a delegated authorization link and applies the selected host to the chat thread", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    const orgId = `org_${randomUUID()}`;
    const actor = bdd.user({ orgId });
    const run = await seedAgentRun({ actor, triggerSource: "web" });
    await expect(
      readRunLaunchSnapshotFixture(context, run.runId),
    ).resolves.toStrictEqual({
      exists: true,
      launch_snapshot: null,
    });
    if (!run.threadId) {
      throw new Error("Expected web run fixture to create a chat thread");
    }

    const host = await api.startComputerUseHost(actor, {
      hostName: "Studio Mac",
    });
    mockClerkMembership(context, actor, "org:admin");
    const legacyToken = generateSandboxToken(actor.userId, run.runId, orgId);
    const legacyCreated = await api.createComputerUseAuthorizationRequest({
      bearer: legacyToken,
    });
    expect(new URL(legacyCreated.authorizationUrl).origin).toBe(
      "https://app.okou.ai",
    );
    const token = computerUseToken({
      userId: actor.userId,
      orgId,
      runId: run.runId,
      capabilities: ["connector:read"],
    }).token;

    const created = await api.createComputerUseAuthorizationRequest({
      bearer: token,
    });
    expect(created).toMatchObject({
      source: "chat",
    });
    expect(created.authorizationUrl).toContain("/computer-use/authorize/");
    expect(new URL(created.authorizationUrl).origin).toBe(
      "https://app.okou.ai",
    );

    const requestToken = requestTokenFromUrl(created.authorizationUrl);
    const readable = await api.readComputerUseAuthorizationRequest(
      actor,
      requestToken,
    );
    expect(readable).toMatchObject({
      source: "chat",
      completedAt: null,
      computerUseHostId: null,
      hosts: [expect.objectContaining({ id: host.hostId })],
    });

    const applied = await api.applyComputerUseAuthorizationRequest(
      actor,
      requestToken,
      host.hostId,
    );
    expect(applied).toStrictEqual({
      ok: true,
      source: "chat",
      computerUseHostId: host.hostId,
    });

    await expect(readComputerUseRunState(run.runId)).resolves.toStrictEqual({
      source: "web",
      computer_use_host_id: host.hostId,
    });

    const completed = await api.readComputerUseAuthorizationRequest(
      actor,
      requestToken,
    );
    expect(completed.completedAt).not.toBeNull();
    expect(completed.computerUseHostId).toBe(host.hostId);
  });

  it.each(["another user in the same org", "the same user in another org"])(
    "denies authorization tokens to %s without changing their owner's state",
    async (identity) => {
      await withMockNowForTest(now(), async () => {
        const actor = bdd.user();
        const peer =
          identity === "another user in the same org"
            ? bdd.user({ orgId: requireOrg(actor) })
            : bdd.user({ userId: actor.userId, orgId: `org_${randomUUID()}` });
        const { chat, run, requestToken } =
          await createAuthorizationScenario(actor);
        const host = await api.startComputerUseHost(actor);
        const requestBefore = await api.readComputerUseAuthorizationRequest(
          actor,
          requestToken,
        );
        const threadBefore = await chat.readThreadMetadata(actor, run.threadId);
        const eventsBefore = await readAuthorizationThreadLifecycle(actor);
        mockClerkMembership(context, peer, "org:admin");
        const deniedRead = await api.requestReadComputerUseAuthorizationRequest(
          peer,
          requestToken,
          [404],
        );
        expectApiError(deniedRead.body);
        expect(deniedRead.body.error.message).toBe(
          "Computer Use authorization request not found",
        );
        const deniedApply =
          await api.requestApplyComputerUseAuthorizationRequest(
            peer,
            requestToken,
            host.hostId,
            [404],
          );
        expectApiError(deniedApply.body);
        expect(deniedApply.body.error.message).toBe(
          "Computer Use authorization request not found",
        );
        mockClerkMembership(context, actor, "org:admin");
        await expect(
          api.readComputerUseAuthorizationRequest(actor, requestToken),
        ).resolves.toStrictEqual(requestBefore);
        await expect(
          chat.readThreadMetadata(actor, run.threadId),
        ).resolves.toStrictEqual(threadBefore);
        await expect(
          readAuthorizationThreadLifecycle(actor),
        ).resolves.toStrictEqual(eventsBefore);
      });
    },
  );

  it.each(["another user in the same org", "the same user in another org"])(
    "rejects an online host owned by %s without completing authorization",
    async (identity) => {
      await withMockNowForTest(now(), async () => {
        const actor = bdd.user();
        const peer =
          identity === "another user in the same org"
            ? bdd.user({ orgId: requireOrg(actor) })
            : bdd.user({ userId: actor.userId, orgId: `org_${randomUUID()}` });
        const { chat, run, requestToken } =
          await createAuthorizationScenario(actor);
        const foreignHost = await api.startComputerUseHost(peer);
        const requestBefore = await api.readComputerUseAuthorizationRequest(
          actor,
          requestToken,
        );
        expect(requestBefore).toMatchObject({
          completedAt: null,
          computerUseHostId: null,
          hosts: [],
        });
        const threadBefore = await chat.readThreadMetadata(actor, run.threadId);
        const eventsBefore = await readAuthorizationThreadLifecycle(actor);
        const denied = await api.requestApplyComputerUseAuthorizationRequest(
          actor,
          requestToken,
          foreignHost.hostId,
          [404],
        );
        expectApiError(denied.body);
        expect(denied.body.error.message).toBe("Computer-use host not found");
        await expect(
          api.readComputerUseAuthorizationRequest(actor, requestToken),
        ).resolves.toStrictEqual(requestBefore);
        await expect(
          chat.readThreadMetadata(actor, run.threadId),
        ).resolves.toStrictEqual(threadBefore);
        await expect(
          readAuthorizationThreadLifecycle(actor),
        ).resolves.toStrictEqual(eventsBefore);
      });
    },
  );

  it.each([
    { state: "pending", completeBeforeExpiry: false },
    { state: "completed", completeBeforeExpiry: true },
  ])(
    "expires a $state authorization at the inclusive one-hour boundary",
    async ({ completeBeforeExpiry }) => {
      const base = now();
      await withMockNowForTest(base, async () => {
        const actor = bdd.user();
        const { chat, run, created, requestToken } =
          await createAuthorizationScenario(actor);
        const host = await api.startComputerUseHost(actor);
        const expiresAt = base + 60 * 60 * 1000;
        expect(created.expiresAt).toBe(new Date(expiresAt).toISOString());
        mockNow(expiresAt - 1);
        await api.heartbeatComputerUseHost(host.hostToken);
        const readable = await api.readComputerUseAuthorizationRequest(
          actor,
          requestToken,
        );
        expect(readable).toMatchObject({
          completedAt: null,
          computerUseHostId: null,
          hosts: [expect.objectContaining({ id: host.hostId })],
        });
        if (completeBeforeExpiry) {
          await expect(
            api.applyComputerUseAuthorizationRequest(
              actor,
              requestToken,
              host.hostId,
            ),
          ).resolves.toStrictEqual({
            ok: true,
            source: "chat",
            computerUseHostId: host.hostId,
          });
          await expect(
            api.readComputerUseAuthorizationRequest(actor, requestToken),
          ).resolves.toMatchObject({
            completedAt: new Date(expiresAt - 1).toISOString(),
            computerUseHostId: host.hostId,
          });
        }
        const threadBefore = await chat.readThreadMetadata(actor, run.threadId);
        const eventsBefore = await readAuthorizationThreadLifecycle(actor);
        mockNow(expiresAt);
        const expiredRead =
          await api.requestReadComputerUseAuthorizationRequest(
            actor,
            requestToken,
            [410],
          );
        expectApiError(expiredRead.body);
        expect(expiredRead.body.error.code).toBe("GONE");
        const expiredApply =
          await api.requestApplyComputerUseAuthorizationRequest(
            actor,
            requestToken,
            host.hostId,
            [410],
          );
        expectApiError(expiredApply.body);
        expect(expiredApply.body.error.code).toBe("GONE");
        await expect(
          chat.readThreadMetadata(actor, run.threadId),
        ).resolves.toStrictEqual(threadBefore);
        await expect(
          readAuthorizationThreadLifecycle(actor),
        ).resolves.toStrictEqual(eventsBefore);
      });
    },
  );

  it("accepts repeat authorization with updated completion and distinct ordered events", async () => {
    const base = now();
    await withMockNowForTest(base, async () => {
      const actor = bdd.user();
      const { chat, run, created, requestToken } =
        await createAuthorizationScenario(actor);
      const host = await api.startComputerUseHost(actor);
      for (const offset of [1000, 2000]) {
        mockNow(base + offset);
        await expect(
          api.applyComputerUseAuthorizationRequest(
            actor,
            requestToken,
            host.hostId,
          ),
        ).resolves.toStrictEqual({
          ok: true,
          source: "chat",
          computerUseHostId: host.hostId,
        });
        await expect(
          api.readComputerUseAuthorizationRequest(actor, requestToken),
        ).resolves.toMatchObject({
          expiresAt: created.expiresAt,
          completedAt: new Date(base + offset).toISOString(),
          computerUseHostId: host.hostId,
        });
        await expect(
          chat.readThreadMetadata(actor, run.threadId),
        ).resolves.toMatchObject({
          computerUseHostId: host.hostId,
          cloudBrowserEnabled: false,
        });
      }
      const lifecycle = await readAuthorizationThreadLifecycle(actor);
      const appliedEvents = lifecycle.events.filter((event) => {
        return (
          event.kind === "computer_use_host_updated" &&
          event.chatThreadId === run.threadId
        );
      });
      expect(appliedEvents).toStrictEqual([
        expect.objectContaining({
          computerUseHostId: host.hostId,
          cloudBrowserEnabled: false,
          createdAt: new Date(base + 1000).toISOString(),
        }),
        expect.objectContaining({
          computerUseHostId: host.hostId,
          cloudBrowserEnabled: false,
          createdAt: new Date(base + 2000).toISOString(),
        }),
      ]);
      const [first, second] = appliedEvents;
      if (!first || !second) {
        throw new Error("Expected both authorization events");
      }
      expect(second.seqId).toBeGreaterThan(first.seqId);
      expect(second.id).not.toBe(first.id);
    });
  });

  it("only exposes online hosts for delegated authorization requests", async () => {
    const orgId = `org_${randomUUID()}`;
    const actor = bdd.user({ orgId });
    const runs = createRunsApi(context);
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor, { model: "claude-fable-5-1" });
    const agent = await bdd.createAgent(actor, {
      displayName: "Online host authorization",
      visibility: "private",
    });
    const run = await runs.createThreadRun(actor, {
      agentId: agent.agentId,
      prompt: "Select an online computer-use host",
    });
    await runs.heartbeatRunner(runnerGroup);
    await runs.claimRunnerJob(run.runId);

    const base = now();
    mockNow(base);
    const staleHost = await api.startComputerUseHost(actor, {
      hostName: "Stale Mac",
    });
    const stoppedHost = await api.startComputerUseHost(actor, {
      installationId: randomUUID(),
      hostName: "Closed Mac",
    });
    await api.stopComputerUseHost(stoppedHost.hostToken);

    mockNow(base + 120_000);
    const onlineHost = await api.startComputerUseHost(actor, {
      hostName: "Studio Mac",
    });
    mockClerkMembership(context, actor, "org:admin");
    const token = computerUseToken({
      userId: actor.userId,
      orgId,
      runId: run.runId,
      capabilities: ["connector:read"],
    }).token;

    const created = await api.createComputerUseAuthorizationRequest({
      bearer: token,
    });
    const requestToken = requestTokenFromUrl(created.authorizationUrl);
    const readable = await api.readComputerUseAuthorizationRequest(
      actor,
      requestToken,
    );
    expect(
      readable.hosts.map((host) => {
        return host.id;
      }),
    ).toStrictEqual([onlineHost.hostId]);

    const staleApply = await api.requestApplyComputerUseAuthorizationRequest(
      actor,
      requestToken,
      staleHost.hostId,
      [404],
    );
    expectApiError(staleApply.body);
    expect(staleApply.body.error.message).toBe("Computer-use host not found");

    const stoppedApply = await api.requestApplyComputerUseAuthorizationRequest(
      actor,
      requestToken,
      stoppedHost.hostId,
      [404],
    );
    expectApiError(stoppedApply.body);
    expect(stoppedApply.body.error.message).toBe("Computer-use host not found");

    const applied = await api.applyComputerUseAuthorizationRequest(
      actor,
      requestToken,
      onlineHost.hostId,
    );
    expect(applied).toStrictEqual({
      ok: true,
      source: "chat",
      computerUseHostId: onlineHost.hostId,
    });

    await expect(
      createChatFilesBddApi(context).readThreadMetadata(actor, run.threadId),
    ).resolves.toMatchObject({ computerUseHostId: onlineHost.hostId });
    await runs.requestCancelRun(actor, run.runId, [200]);
  });

  it("uses chat-thread authorization for a canonical Slack run", async () => {
    const actor = bdd.user();
    const runs = createRunsApi(context);
    const integrations = createBddIntegrationApi(context);
    const runnerGroup = runs.configureRunnerGroup();
    integrations.configureSlackAppMocks();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor, { model: "claude-fable-5-1" });
    const slackUserId = uniqueSlackUserId();
    const { teamId } = await integrations.installSlackWorkspace(actor, {
      installerSlackUserId: slackUserId,
    });
    const prompt = "Authorize this Slack thread to use my desktop";
    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUserId,
      text: prompt,
      ts: "2900.000100",
      channel: `C_${randomUUID()}`,
      channel_type: "channel",
    });
    const run = await claimCanonicalIntegrationRun({
      actor,
      source: "slack",
      prompt,
      runs,
      runnerGroup,
    });

    const host = await api.startComputerUseHost(actor, {
      hostName: "Canonical Slack Desktop",
    });
    mockClerkMembership(context, actor, "org:admin");
    const created = await api.createComputerUseAuthorizationRequest({
      bearer: run.token,
    });
    expect(created.source).toBe("chat");

    const requestToken = requestTokenFromUrl(created.authorizationUrl);
    const applied = await api.applyComputerUseAuthorizationRequest(
      actor,
      requestToken,
      host.hostId,
    );
    expect(applied).toStrictEqual({
      ok: true,
      source: "chat",
      computerUseHostId: host.hostId,
    });

    await expect(
      createChatFilesBddApi(context).readThreadMetadata(actor, run.threadId),
    ).resolves.toMatchObject({ computerUseHostId: host.hostId });
    await runs.requestCancelRun(actor, run.runId, [200]);
    await integrations.postSlackEvent(teamId, { type: "app_uninstalled" });
  });

  it("uses chat-thread authorization for a canonical Teams run", async () => {
    const fixture = teamsConnectFixture();
    const actor = bdd.user({ userId: fixture.userId, orgId: fixture.orgId });
    const runs = createRunsApi(context);
    const runnerGroup = runs.configureRunnerGroup();
    setupTeamsConnectTestEnv();
    mockEnv("MICROSOFT_TEAMS_BOT_APP_PASSWORD", "computer-use-teams-password");
    const serviceUrl = fixture.serviceUrl.replace(/\/+$/u, "");
    server.use(
      http.post(
        "https://login.microsoftonline.com/:tenantId/oauth2/v2.0/token",
        () => {
          return HttpResponse.json({
            access_token: "computer-use-teams-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
        },
      ),
      http.post(`${serviceUrl}/v3/conversations/:id/activities`, () => {
        return HttpResponse.json({ id: randomUUID() });
      }),
      http.post(
        `${serviceUrl}/v3/conversations/:id/activities/:activityId`,
        () => {
          return HttpResponse.json({ id: randomUUID() });
        },
      ),
      http.put(
        `${serviceUrl}/v3/conversations/:id/activities/:activityId/reactions/:reaction`,
        () => {
          return new HttpResponse(null, { status: 200 });
        },
      ),
      http.delete(
        `${serviceUrl}/v3/conversations/:id/activities/:activityId/reactions/:reaction`,
        () => {
          return new HttpResponse(null, { status: 200 });
        },
      ),
      http.get(
        "https://graph.microsoft.com/v1.0/teams/:teamId/channels/:channelId/messages",
        () => {
          return HttpResponse.json({ value: [] });
        },
      ),
    );
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor, { model: "claude-fable-5-1" });
    await installTeamsForTest(context.signal, fixture);
    createRouteMocks(context).clerk.session(
      actor.userId,
      actor.orgId,
      actor.orgRole,
    );
    await accept(
      setupApp({ context, routes: teamsConnectRoutes })(
        teamsConnectContract,
      ).connect({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          tenantId: fixture.teamsTenantId,
          teamsAadObjectId: fixture.teamsAadObjectId,
          teamsUserDisplayName: "Ada Lovelace",
          teamsUserPrincipalName: fixture.teamsUserPrincipalName,
        },
      }),
      [200],
    );
    const prompt = "Authorize this Teams thread to use my desktop";
    const message = await postTeamsActivityForTest({
      signal: context.signal,
      activity: teamsMessageActivityForTest(fixture, {
        text: `<at>Nova</at> ${prompt}`,
        replyToId: null,
      }),
    });
    expect(message.status).toBe(200);
    const run = await claimCanonicalIntegrationRun({
      actor,
      source: "teams",
      prompt,
      runs,
      runnerGroup,
    });

    const host = await api.startComputerUseHost(actor, {
      hostName: "Canonical Teams Desktop",
    });
    mockClerkMembership(context, actor, "org:admin");
    const created = await api.createComputerUseAuthorizationRequest({
      bearer: run.token,
    });
    expect(created.source).toBe("chat");

    const requestToken = requestTokenFromUrl(created.authorizationUrl);
    const applied = await api.applyComputerUseAuthorizationRequest(
      actor,
      requestToken,
      host.hostId,
    );
    expect(applied).toStrictEqual({
      ok: true,
      source: "chat",
      computerUseHostId: host.hostId,
    });
    const chat = createChatFilesBddApi(context);
    await expect(
      chat.readThreadMetadata(actor, run.threadId),
    ).resolves.toMatchObject({ computerUseHostId: host.hostId });

    const completed = await api.readComputerUseAuthorizationRequest(
      actor,
      requestToken,
    );
    expect(completed.completedAt).not.toBeNull();
    expect(completed.computerUseHostId).toBe(host.hostId);

    // Stopping an installation host leaves it offline but still bound.
    await api.stopComputerUseHost(host.hostToken);
    await expect(
      chat.readThreadMetadata(actor, run.threadId),
    ).resolves.toMatchObject({ computerUseHostId: host.hostId });
    await runs.requestCancelRun(actor, run.runId, [200]);
    await removeTeamsForTest(context.signal, fixture);
  });

  it("chains host start, command claim, completion, audit, and host stop", async () => {
    const orgId = `org_${randomUUID()}`;
    const actor = bdd.user({ orgId });
    const peer = bdd.user({ orgId });

    const initialHosts = await api.listComputerUseHosts(actor);
    expect(initialHosts.hosts).toStrictEqual([]);

    const hostName = "lancy-macbook-pro.local";
    const host = await api.startComputerUseHost(actor, { hostName });
    expect(host.hostToken).toMatch(/^vm0_computer_use_host_/);

    const hosts = await api.listComputerUseHosts(actor);
    expect(hosts.hosts).toHaveLength(1);
    expect(hosts.hosts[0]).toMatchObject({
      id: host.hostId,
      hostName,
      displayName: hostName,
      status: "online",
      permissions: { accessibility: true, screenRecording: true },
    });

    const createdCommand = await api.createComputerUseWriteCommand(actor);
    expect(createdCommand).toMatchObject({ status: "queued" });

    const claimed = await api.claimNextComputerUseCommand(host.hostToken);
    expect(claimed.status).toBe("command");
    if (claimed.status !== "command") {
      throw new Error("Expected queued computer-use command to be claimed");
    }
    expect(claimed.command.id).toBe(createdCommand.commandId);
    expect(claimed.command.kind).toBe("app.open");

    await api.completeComputerUseCommand(
      host.hostToken,
      createdCommand.commandId,
    );

    const completedCommand = await api.readComputerUseCommand(
      actor,
      createdCommand.commandId,
    );
    expect(completedCommand).toMatchObject({
      id: createdCommand.commandId,
      kind: "app.open",
      status: "succeeded",
      hostId: host.hostId,
    });

    const peerRead = await api.requestReadComputerUseCommand(
      peer,
      createdCommand.commandId,
      [403, 404],
    );
    expectApiError(peerRead.body);
    expect(["FORBIDDEN", "NOT_FOUND"]).toContain(peerRead.body.error.code);

    const missingScreenshot = await api.requestComputerUseScreenshot(
      actor,
      createdCommand.commandId,
      [404],
    );
    expectApiError(missingScreenshot.body);
    expect(missingScreenshot.body.error.code).toBe("NOT_FOUND");

    const audit = await api.listComputerUseAuditEvents(actor, {
      commandId: createdCommand.commandId,
    });
    expect(
      audit.auditEvents.map((event) => {
        return event.event;
      }),
    ).toStrictEqual(expect.arrayContaining(["completed"]));

    await api.stopComputerUseHost(host.hostToken);
    const afterStop = await api.listComputerUseHosts(actor);
    expect(afterStop.hosts).toMatchObject([
      { id: host.hostId, status: "offline" },
    ]);
    await api.requestComputerUseHeartbeat(host.hostToken, [401]);
  });

  it("rewrites the host row only when heartbeats carry news or liveness goes stale", async () => {
    const actor = bdd.user();
    const base = now();
    mockNow(base);
    const host = await api.startComputerUseHost(actor);
    context.mocks.ably.publish.mockClear();
    const lastSeenAt = async () => {
      const listed = await api.listComputerUseHosts(actor);
      return listed.hosts.find((item) => {
        return item.id === host.hostId;
      })?.lastSeenAt;
    };

    // An unchanged heartbeat inside the refresh window writes nothing.
    mockNow(base + 10_000);
    await expect(
      api.heartbeatComputerUseHost(host.hostToken),
    ).resolves.toStrictEqual({ ok: true, hostId: host.hostId });
    await expect(lastSeenAt()).resolves.toBe(new Date(base).toISOString());

    // Once the stamp is 30s old it is refreshed, without a broadcast.
    mockNow(base + 30_000);
    await api.heartbeatComputerUseHost(host.hostToken);
    await expect(lastSeenAt()).resolves.toBe(
      new Date(base + 30_000).toISOString(),
    );
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    // Changed runtime state is written and broadcast right away.
    mockNow(base + 35_000);
    await api.heartbeatComputerUseHost(host.hostToken, {
      hostName: "Renamed Desktop",
    });
    const listed = await api.listComputerUseHosts(actor);
    expect(listed.hosts).toMatchObject([
      {
        id: host.hostId,
        hostName: "Renamed Desktop",
        lastSeenAt: new Date(base + 35_000).toISOString(),
      },
    ]);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "computerUseHostsChanged",
      null,
    );
  });

  it("refreshes host liveness from idle claim polls only when it is stale", async () => {
    const actor = bdd.user();
    const base = now();
    mockNow(base);
    const host = await api.startComputerUseHost(actor);
    const lastSeenAt = async () => {
      const listed = await api.listComputerUseHosts(actor);
      return listed.hosts.find((item) => {
        return item.id === host.hostId;
      })?.lastSeenAt;
    };

    mockNow(base + 10_000);
    await expect(
      api.claimNextComputerUseCommand(host.hostToken),
    ).resolves.toMatchObject({ status: "idle" });
    await expect(lastSeenAt()).resolves.toBe(new Date(base).toISOString());

    mockNow(base + 40_000);
    await expect(
      api.claimNextComputerUseCommand(host.hostToken),
    ).resolves.toMatchObject({ status: "idle" });
    await expect(lastSeenAt()).resolves.toBe(
      new Date(base + 40_000).toISOString(),
    );
  });

  it("keeps multiple active hosts and lets stale heartbeats recover", async () => {
    const actor = bdd.user();
    const base = now();
    mockNow(base);

    const first = await api.startComputerUseHost(actor, {
      hostName: "Office Mac",
    });
    // Every heartbeat carries the full runtime body, so it also rewrites the
    // host name. Repeat this host's own name to keep its identity stable.
    const heartbeat = await api.heartbeatComputerUseHost(first.hostToken, {
      hostName: "Office Mac",
    });
    expect(heartbeat).toStrictEqual({ ok: true, hostId: first.hostId });

    mockNow(base + 120_000);
    const second = await api.startComputerUseHost(actor, {
      hostName: "Studio Mac",
    });
    expect(second.hostId).not.toBe(first.hostId);

    const staleHeartbeat = await api.heartbeatComputerUseHost(first.hostToken, {
      hostName: "Office Mac",
    });
    expect(staleHeartbeat).toStrictEqual({ ok: true, hostId: first.hostId });

    const visibleHosts = await api.listComputerUseHosts(actor);
    expect(visibleHosts.hosts).toHaveLength(2);
    expect(visibleHosts.hosts).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first.hostId,
          hostName: "Office Mac",
          status: "online",
        }),
        expect.objectContaining({
          id: second.hostId,
          hostName: "Studio Mac",
          status: "online",
        }),
      ]),
    );

    const stopped = await api.stopComputerUseHost(second.hostToken);
    expect(stopped).toStrictEqual({ ok: true, hostId: second.hostId });

    const restarted = await api.startComputerUseHost(actor, {
      hostName: "Recovered Desktop",
    });
    expect(restarted.hostId).not.toBe(second.hostId);

    await api.stopComputerUseHost(restarted.hostToken);
  });

  it("keeps installation hosts stable across stop and restart", async () => {
    const actor = bdd.user();
    const installationId = randomUUID();

    const started = await api.startComputerUseHost(actor, {
      installationId,
      hostName: "Studio Mac",
    });

    await api.stopComputerUseHost(started.hostToken);
    const stoppedHeartbeat = await api.requestComputerUseHeartbeat(
      started.hostToken,
      [401],
    );
    expectApiError(stoppedHeartbeat.body);
    expect(stoppedHeartbeat.body.error.message).toBe(
      "Invalid computer-use host token",
    );

    const stoppedHosts = await api.listComputerUseHosts(actor);
    expect(stoppedHosts.hosts).toStrictEqual([
      expect.objectContaining({
        id: started.hostId,
        hostName: "Studio Mac",
        status: "offline",
      }),
    ]);

    const restarted = await api.startComputerUseHost(actor, {
      installationId,
      hostName: "Renamed Studio Mac",
    });
    expect(restarted.hostId).toBe(started.hostId);
    expect(restarted.hostToken).not.toBe(started.hostToken);

    const restartedHosts = await api.listComputerUseHosts(actor);
    expect(restartedHosts.hosts).toStrictEqual([
      expect.objectContaining({
        id: started.hostId,
        hostName: "Renamed Studio Mac",
        status: "online",
      }),
    ]);
  });

  it("scopes host discovery to the bound host for agent run tokens", async () => {
    const actor = bdd.user();
    await api.startComputerUseHost(actor, {
      hostName: "Other Desktop",
      supportedCapabilities: [
        "plugin.call",
        computerUseMcpServerCapability("other"),
      ],
    });
    const host = await api.startComputerUseHost(actor, {
      hostName: "Apple Notes Desktop",
      supportedCapabilities: [
        "plugin.call",
        computerUseMcpServerCapability("apple-notes"),
      ],
    });
    mockClerkMembership(context, actor, "org:admin");

    const bound = computerUseToken({
      userId: actor.userId,
      orgId: requireOrg(actor),
      capabilities: ["computer-use:write"],
      computerUseHostId: host.hostId,
    });
    const listed = await api.listComputerUseHosts({ bearer: bound.token });
    expect(listed.hosts).toHaveLength(1);
    expect(listed.hosts[0]).toMatchObject({
      id: host.hostId,
      hostName: "Apple Notes Desktop",
      supportedCapabilities: [
        "plugin.call",
        computerUseMcpServerCapability("apple-notes"),
      ],
    });

    const unbound = computerUseToken({
      userId: actor.userId,
      orgId: requireOrg(actor),
      capabilities: ["computer-use:write"],
    });
    const rejected = await api.requestListComputerUseHosts(
      { bearer: unbound.token },
      [403],
    );
    expectApiError(rejected.body);
  });

  it("publishes computer-use host list changes", async () => {
    const actor = bdd.user();
    const base = now();
    mockNow(base);

    context.mocks.ably.publish.mockClear();
    const host = await api.startComputerUseHost(actor, {
      hostName: "Studio Mac",
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "computerUseHostsChanged",
      null,
    );

    context.mocks.ably.publish.mockClear();
    await api.heartbeatComputerUseHost(host.hostToken, {
      hostName: "Studio Mac",
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    mockNow(base + 120_000);
    await api.heartbeatComputerUseHost(host.hostToken, {
      hostName: "Studio Mac",
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "computerUseHostsChanged",
      null,
    );

    context.mocks.ably.publish.mockClear();
    await api.stopComputerUseHost(host.hostToken);
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "computerUseHostsChanged",
      null,
    );

    clearMockNow();
  });

  it("rejects host-token routes with missing or invalid host tokens", async () => {
    const garbageToken = "okou-bdd-garbage-host-token";
    const commandId = randomUUID();
    const completeBody = {
      status: "succeeded" as const,
      result: { app: "Safari", opened: true },
    };

    const missingHeartbeat = await api.requestComputerUseHeartbeat(null, [401]);
    expectApiError(missingHeartbeat.body);
    expect(missingHeartbeat.body.error.message).toBe(
      "Missing computer-use host token",
    );

    const invalidHeartbeat = await api.requestComputerUseHeartbeat(
      garbageToken,
      [401],
    );
    expectApiError(invalidHeartbeat.body);
    expect(invalidHeartbeat.body.error.message).toBe(
      "Invalid computer-use host token",
    );

    const missingStop = await api.requestStopComputerUseHost(null, [401]);
    expectApiError(missingStop.body);
    expect(missingStop.body.error.message).toBe(
      "Missing computer-use host token",
    );

    const invalidStop = await api.requestStopComputerUseHost(
      garbageToken,
      [401],
    );
    expectApiError(invalidStop.body);
    expect(invalidStop.body.error.message).toBe(
      "Invalid computer-use host token",
    );

    const missingNext = await api.requestClaimNextComputerUseCommand(
      null,
      [401],
    );
    expectApiError(missingNext.body);
    expect(missingNext.body.error.message).toBe(
      "Missing computer-use host token",
    );

    const invalidNext = await api.requestClaimNextComputerUseCommand(
      garbageToken,
      [401],
    );
    expectApiError(invalidNext.body);
    expect(invalidNext.body.error.message).toBe(
      "Invalid computer-use host token",
    );

    const missingComplete = await api.requestCompleteComputerUseCommand(
      null,
      commandId,
      completeBody,
      [401],
    );
    expectApiError(missingComplete.body);
    expect(missingComplete.body.error.message).toBe(
      "Missing computer-use host token",
    );

    const invalidComplete = await api.requestCompleteComputerUseCommand(
      garbageToken,
      commandId,
      completeBody,
      [401],
    );
    expectApiError(invalidComplete.body);
    expect(invalidComplete.body.error.message).toBe(
      "Invalid computer-use host token",
    );
  });

  it("routes commands across offline, unsupported, ambiguous, and granted hosts", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const actor = bdd.user({ orgId, userId });

    const noHost = await api.requestCreateComputerUseReadCommand(
      actor,
      { kind: "apps.list" },
      [404],
    );
    expectApiError(noHost.body);
    expect(noHost.body.error.message).toBe("No linked computer-use host found");

    const base = now();
    mockNow(base);
    const hostA = await api.startComputerUseHost(actor);

    mockNow(base + 91_000);
    const offline = await api.requestCreateComputerUseReadCommand(
      actor,
      { kind: "apps.list" },
      [409],
    );
    expectApiError(offline.body);
    expect(offline.body.error.message).toBe(
      "No online computer-use host found",
    );

    const hostB = await api.startComputerUseHost(actor, {
      supportedCapabilities: ["apps.list", "element.click"],
    });

    const unsupported = await api.requestCreateComputerUseReadCommand(
      actor,
      { kind: "app.state", app: "Safari" },
      [409],
    );
    expectApiError(unsupported.body);
    expect(unsupported.body.error.message).toBe(
      "No online computer-use host supports this command",
    );

    // Claim polls refresh lastSeenAt, so host A's idle poll puts both hosts
    // online again for the ambiguity case.
    const idleA = await api.claimNextComputerUseCommand(hostA.hostToken);
    expect(idleA.status).toBe("idle");

    const ambiguous = await api.requestCreateComputerUseReadCommand(
      actor,
      { kind: "apps.list" },
      [409],
    );
    expectApiError(ambiguous.body);
    expect(ambiguous.body.error.message).toBe(
      "Multiple active computer-use hosts are online",
    );

    // Okou-token auth resolves the organization role through Clerk membership lookup.
    mockClerkMembership(context, actor, "org:admin");

    const missingCapability = await api.requestCreateComputerUseReadCommand(
      {
        bearer: computerUseToken({
          userId,
          orgId,
          capabilities: ["connector:read"],
        }).token,
      },
      { kind: "apps.list" },
      [403],
    );
    expectApiError(missingCapability.body);
    expect(missingCapability.body.error.message).toBe(
      "Computer Use is not authorized for this run. Authorize a computer once in the conversation, then retry.",
    );

    const ungranted = await api.requestCreateComputerUseReadCommand(
      {
        bearer: computerUseToken({
          userId,
          orgId,
          capabilities: ["computer-use:write"],
        }).token,
      },
      { kind: "apps.list" },
      [403],
    );
    expectApiError(ungranted.body);
    expect(ungranted.body.error.message).toBe(
      "Computer-use host is not authorized for this run",
    );

    const granted = computerUseToken({
      userId,
      orgId,
      capabilities: ["computer-use:write"],
      computerUseHostId: hostB.hostId,
    });
    const readCreated = await api.createComputerUseReadCommand(
      { bearer: granted.token },
      { kind: "apps.list" },
    );
    expect(readCreated.status).toBe("queued");

    const idleAfterGrant = await api.claimNextComputerUseCommand(
      hostA.hostToken,
    );
    expect(idleAfterGrant.status).toBe("idle");

    const claimedRead = await api.claimNextComputerUseCommand(hostB.hostToken);
    expect(claimedRead.status).toBe("command");
    if (claimedRead.status !== "command") {
      throw new Error("Expected the granted host to claim the read command");
    }
    expect(claimedRead.command).toMatchObject({
      id: readCreated.commandId,
      hostId: hostB.hostId,
      kind: "apps.list",
      status: "running",
    });

    await api.completeComputerUseCommandWith(
      hostB.hostToken,
      readCreated.commandId,
      { status: "succeeded", result: { apps: ["Safari"] } },
    );

    const writeCreated = await api.createComputerUseWriteCommand(
      { bearer: granted.token },
      {
        kind: "element.click",
        app: "Safari",
        snapshotId: "snap_bdd",
        elementIndex: 7,
        button: "left",
        clickCount: 1,
        timeoutMs: 15_000,
      },
    );
    expect(writeCreated.status).toBe("queued");

    const claimedWrite = await api.claimNextComputerUseCommand(hostB.hostToken);
    expect(claimedWrite.status).toBe("command");
    if (claimedWrite.status !== "command") {
      throw new Error("Expected the granted host to claim the write command");
    }
    expect(claimedWrite.command).toMatchObject({
      id: writeCreated.commandId,
      hostId: hostB.hostId,
      kind: "element.click",
      status: "running",
      payload: {
        app: "Safari",
        snapshotId: "snap_bdd",
        elementIndex: 7,
        button: "left",
        clickCount: 1,
      },
    });

    await api.completeComputerUseCommandWith(
      hostB.hostToken,
      writeCreated.commandId,
      {
        status: "succeeded",
        result: {
          summary: "Clicked elementIndex=7",
          elementIndex: 7,
          dispatchMode: "accessibility_action",
          dispatchTarget: "element",
          inputRisk: "targeted_app_action",
          appState: "Computer Use state\n<app_state>\n</app_state>",
          truncated: true,
          truncationReasons: ["max_nodes"],
          metrics: {
            helperDurationMs: 42,
            settle: true,
            rawNodeCount: 5,
            nodeCount: 3,
            appStateChars: 43,
            visibleElementCount: 2,
          },
        },
      },
    );

    const audit = await api.listComputerUseAuditEvents(actor, {
      runId: granted.runId,
      hostId: hostB.hostId,
    });
    expect(audit.auditEvents).toHaveLength(1);
    expect(audit.auditEvents[0]).toMatchObject({
      commandId: writeCreated.commandId,
      runId: granted.runId,
      hostId: hostB.hostId,
      kind: "element.click",
      event: "completed",
      redactedResult: {
        summary: "Clicked elementIndex=7",
        elementIndex: 7,
        dispatchMode: "accessibility_action",
        dispatchTarget: "element",
        inputRisk: "targeted_app_action",
        appStateLength: 43,
        truncated: true,
        truncationReasons: ["max_nodes"],
        metrics: {
          helperDurationMs: 42,
          settle: true,
          rawNodeCount: 5,
          nodeCount: 3,
          appStateChars: 43,
          visibleElementCount: 2,
        },
      },
    });
    expect(JSON.stringify(audit.auditEvents[0]?.redactedResult)).not.toContain(
      "<app_state>",
    );

    mockNow(base + 182_000);
    const idleB = await api.claimNextComputerUseCommand(hostB.hostToken);
    expect(idleB.status).toBe("idle");

    const grantedOffline = computerUseToken({
      userId,
      orgId,
      capabilities: ["computer-use:write"],
      computerUseHostId: hostA.hostId,
    });
    const offlineGrant = await api.requestCreateComputerUseReadCommand(
      { bearer: grantedOffline.token },
      { kind: "apps.list" },
      [409],
    );
    expectApiError(offlineGrant.body);
    expect(offlineGrant.body.error.message).toBe(
      "No online computer-use host found",
    );
  });

  it("withdraws native create and claim admission with non-empty plugin-only capabilities", async () => {
    const actor = bdd.user();
    await enableComputerUseDesktopPlugins(actor);
    const pluginCapabilities = filesystemToolCapabilities("read_text_file");
    const host = await api.startComputerUseHost(actor, {
      supportedCapabilities: ["apps.list", ...pluginCapabilities],
    });
    await api.createComputerUseReadCommand(actor, { kind: "apps.list" });
    const withdrawn = await api.claimNextComputerUseCommand(
      host.hostToken,
      pluginCapabilities,
    );
    expect(withdrawn.status).toBe("idle");
    await api.heartbeatComputerUseHost(host.hostToken, {
      supportedCapabilities: pluginCapabilities,
      permissions: { accessibility: false, screenRecording: false },
    });
    const native = await api.requestCreateComputerUseReadCommand(
      actor,
      { kind: "apps.list" },
      [409],
    );
    expectApiError(native.body);
    const plugin = await api.createComputerUsePluginCommand(actor, {
      plugin: "filesystem",
      tool: "read_text_file",
      arguments: { path: "/tmp/notes.txt" },
    });
    // Empty claim updates retain the last non-empty capability set. They must
    // not restore native support after a plugin-only withdrawal.
    const claimed = await api.claimNextComputerUseCommand(host.hostToken, []);
    expect(claimed).toMatchObject({
      status: "command",
      command: {
        id: plugin.commandId,
        kind: "plugin.call",
        timeoutMs: 60_000,
      },
    });
  });

  it("preserves native create and claim for legacy capability-empty hosts", async () => {
    const actor = bdd.user();
    const host = await api.startComputerUseHost(actor, {
      supportedCapabilities: [],
    });
    const created = await api.createComputerUseReadCommand(actor, {
      kind: "apps.list",
    });
    const claimed = await api.claimNextComputerUseCommand(host.hostToken, []);
    expect(claimed).toMatchObject({
      status: "command",
      command: {
        id: created.commandId,
        kind: "apps.list",
        timeoutMs: 60_000,
        createdAt: expect.any(String),
        claimedAt: expect.any(String),
      },
    });
  });

  it("gates plugin commands by feature switch and routes them by tool capability", async () => {
    const actor = bdd.user();

    const disabled = await api.requestCreateComputerUsePluginCommand(
      actor,
      {
        plugin: "filesystem",
        tool: "read_text_file",
        arguments: { path: "/tmp/notes.txt" },
      },
      [403],
    );
    expectApiError(disabled.body);
    expect(disabled.body.error.message).toBe(
      "Computer Use Desktop plugins are disabled",
    );

    await enableComputerUseDesktopPlugins(actor);
    const unsupportedHost = await api.startComputerUseHost(actor);

    const unsupported = await api.requestCreateComputerUsePluginCommand(
      actor,
      {
        plugin: "filesystem",
        tool: "read_text_file",
        arguments: { path: "/tmp/notes.txt" },
      },
      [409],
    );
    expectApiError(unsupported.body);
    expect(unsupported.body.error.message).toBe(
      "No online computer-use host supports this plugin tool",
    );

    const pluginCapabilities = filesystemToolCapabilities("read_text_file");
    const pluginHost = await api.startComputerUseHost(actor, {
      supportedCapabilities: pluginCapabilities,
    });
    const created = await api.createComputerUsePluginCommand(actor, {
      plugin: "filesystem",
      tool: "read_text_file",
      arguments: { path: "/tmp/notes.txt" },
    });

    const unsupportedClaim = await api.claimNextComputerUseCommand(
      unsupportedHost.hostToken,
    );
    expect(unsupportedClaim.status).toBe("idle");

    const claimed = await api.claimNextComputerUseCommand(
      pluginHost.hostToken,
      pluginCapabilities,
    );
    expect(claimed.status).toBe("command");
    if (claimed.status !== "command") {
      throw new Error("Expected plugin host to claim the plugin command");
    }
    expect(claimed.command).toMatchObject({
      id: created.commandId,
      hostId: pluginHost.hostId,
      kind: "plugin.call",
      payload: {
        plugin: "filesystem",
        tool: "read_text_file",
        arguments: { path: "/tmp/notes.txt" },
      },
    });
  });

  it("routes mcp plugin commands by server capability and passes arguments through", async () => {
    const actor = bdd.user();
    await enableComputerUseDesktopPlugins(actor);

    const invalidName = await api.requestCreateComputerUsePluginCommand(
      actor,
      {
        plugin: "mcp",
        server: "Bad Name!",
        tool: "create_note",
        arguments: {},
      },
      [400],
    );
    expectApiError(invalidName.body);

    const notesHost = await api.startComputerUseHost(actor, {
      supportedCapabilities: ["plugin.call", "plugin.mcp.notes"],
    });

    const unsupported = await api.requestCreateComputerUsePluginCommand(
      actor,
      {
        plugin: "mcp",
        server: "figma",
        tool: "get_selection",
        arguments: {},
      },
      [409],
    );
    expectApiError(unsupported.body);
    expect(unsupported.body.error.message).toBe(
      "No online computer-use host supports this plugin tool",
    );

    const created = await api.createComputerUsePluginCommand(actor, {
      plugin: "mcp",
      server: "notes",
      tool: "create_note",
      arguments: { title: "hello", nested: { tags: ["a", "b"] } },
    });

    const claimed = await api.claimNextComputerUseCommand(notesHost.hostToken, [
      "plugin.call",
      "plugin.mcp.notes",
    ]);
    expect(claimed.status).toBe("command");
    if (claimed.status !== "command") {
      throw new Error("Expected notes host to claim the mcp plugin command");
    }
    expect(claimed.command).toMatchObject({
      id: created.commandId,
      hostId: notesHost.hostId,
      kind: "plugin.call",
      payload: {
        plugin: "mcp",
        server: "notes",
        tool: "create_note",
        arguments: { title: "hello", nested: { tags: ["a", "b"] } },
      },
    });
  });

  it("offloads filesystem plugin content and records metadata-only audit", async () => {
    const fake = api.installComputerUseS3Fake();
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const actor = bdd.user({ orgId, userId });
    await enableComputerUseDesktopPlugins(actor);

    const pluginCapabilities = filesystemToolCapabilities("read_text_file");
    const host = await api.startComputerUseHost(actor, {
      supportedCapabilities: pluginCapabilities,
    });
    mockClerkMembership(context, actor, "org:admin");
    const granted = computerUseToken({
      userId,
      orgId,
      capabilities: ["computer-use:write"],
      computerUseHostId: host.hostId,
    });

    const created = await api.createComputerUsePluginCommand(
      { bearer: granted.token },
      {
        plugin: "filesystem",
        tool: "read_text_file",
        arguments: { path: "/tmp/notes.txt" },
      },
    );
    const claimed = await api.claimNextComputerUseCommand(
      host.hostToken,
      pluginCapabilities,
    );
    expect(claimed.status).toBe("command");

    const content = Buffer.from("private local notes");
    await api.completeComputerUseCommandWith(
      host.hostToken,
      created.commandId,
      {
        status: "succeeded",
        result: {
          plugin: "filesystem",
          tool: "read_text_file",
          sizeBytes: content.length,
          pluginContent: {
            dataBase64: content.toString("base64"),
            mimeType: "text/plain",
            fileName: "notes.txt",
          },
        },
      },
    );

    const key = `computer-use/${orgId}/${userId}/${created.commandId}/plugin-content.txt`;
    expect(fake.puts).toHaveLength(1);
    expect(fake.puts[0]).toMatchObject({
      bucket: "test-user-storages",
      key,
      contentType: "text/plain",
    });
    expect(fake.puts[0]?.body.equals(content)).toBeTruthy();

    const detail = await api.readComputerUseCommand(actor, created.commandId);
    expect(detail.result?.pluginContent).toStrictEqual({
      type: "s3",
      mimeType: "text/plain",
      sizeBytes: content.length,
      fileName: "notes.txt",
    });
    expect(JSON.stringify(detail.result)).not.toContain(
      content.toString("base64"),
    );

    const downloaded = await api.downloadComputerUsePluginContent(
      actor,
      created.commandId,
    );
    expect(downloaded.contentType).toBe("text/plain");
    expect(downloaded.fileName).toBe("notes.txt");
    expect(downloaded.bytes.equals(content)).toBeTruthy();

    const audit = await api.listComputerUseAuditEvents(actor, {
      runId: granted.runId,
      hostId: host.hostId,
    });
    expect(audit.auditEvents).toHaveLength(1);
    expect(audit.auditEvents[0]).toMatchObject({
      commandId: created.commandId,
      runId: granted.runId,
      hostId: host.hostId,
      kind: "plugin.call",
      redactedResult: {
        plugin: "filesystem",
        tool: "read_text_file",
        status: "succeeded",
        destructive: false,
        path: "/tmp/notes.txt",
        offloaded: true,
        sizeBytes: content.length,
        fileName: "notes.txt",
        mimeType: "text/plain",
      },
    });
    expect(JSON.stringify(audit.auditEvents[0]?.redactedResult)).not.toContain(
      "private local notes",
    );
  });

  it("normalizes NUL characters in completion results and errors", async () => {
    const actor = bdd.user();
    const host = await api.startComputerUseHost(actor);

    const succeeded = await api.createComputerUseWriteCommand(actor);
    const claimedSucceeded = await api.claimNextComputerUseCommand(
      host.hostToken,
    );
    expect(claimedSucceeded.status).toBe("command");
    if (claimedSucceeded.status !== "command") {
      throw new Error("Expected the successful command to be claimed");
    }
    expect(claimedSucceeded.command.id).toBe(succeeded.commandId);

    const nestedNulKey = "nested\0key";
    const nestedReplacementKey = "nested\uFFFDkey";
    const collisionNulKey = "collision\0key";
    const collisionReplacementKey = "collision\uFFFDkey";
    const succeededBody = {
      status: "succeeded" as const,
      result: {
        payload: {
          [nestedNulKey]: ["before\0after", { unicode: "中文🙂" }],
          collision: {
            [collisionNulKey]: "replaced",
            [collisionReplacementKey]: "preserved",
          },
        },
      },
    };
    await api.completeComputerUseCommandWith(
      host.hostToken,
      succeeded.commandId,
      succeededBody,
    );
    await api.completeComputerUseCommandWith(
      host.hostToken,
      succeeded.commandId,
      succeededBody,
    );

    const completed = await api.readComputerUseCommand(
      actor,
      succeeded.commandId,
    );
    expect(completed).toMatchObject({
      status: "succeeded",
      result: {
        payload: {
          [nestedReplacementKey]: ["before\uFFFDafter", { unicode: "中文🙂" }],
          collision: { [collisionReplacementKey]: "preserved" },
        },
      },
    });
    const succeededAudit = await api.listComputerUseAuditEvents(actor, {
      commandId: succeeded.commandId,
    });
    expect(succeededAudit.auditEvents).toHaveLength(1);
    expect(succeededAudit.auditEvents[0]).toMatchObject({
      event: "completed",
      redactedResult: {
        payload: {
          [nestedReplacementKey]: ["before\uFFFDafter", { unicode: "中文🙂" }],
          collision: { [collisionReplacementKey]: "preserved" },
        },
      },
      error: null,
    });

    const failed = await api.createComputerUseWriteCommand(actor);
    const claimedFailed = await api.claimNextComputerUseCommand(host.hostToken);
    expect(claimedFailed.status).toBe("command");
    if (claimedFailed.status !== "command") {
      throw new Error("Expected the failed command to be claimed");
    }
    expect(claimedFailed.command.id).toBe(failed.commandId);

    await api.completeComputerUseCommandWith(host.hostToken, failed.commandId, {
      status: "failed",
      error: {
        code: "app_not_found",
        message: "Finder\0is unavailable 中文🙂",
      },
    });
    const failedCommand = await api.readComputerUseCommand(
      actor,
      failed.commandId,
    );
    expect(failedCommand).toMatchObject({
      status: "failed",
      error: {
        code: "app_not_found",
        message: "Finder\uFFFDis unavailable 中文🙂",
      },
    });
    const failedAudit = await api.listComputerUseAuditEvents(actor, {
      commandId: failed.commandId,
    });
    expect(failedAudit.auditEvents).toHaveLength(1);
    expect(failedAudit.auditEvents[0]).toMatchObject({
      event: "completed",
      redactedResult: null,
      error: {
        code: "app_not_found",
        message: "Finder\uFFFDis unavailable 中文🙂",
      },
    });
  });

  it("times out stale running commands and reports completion failures", async () => {
    const actor = bdd.user();
    const base = now();
    mockNow(base);
    const host = await api.startComputerUseHost(actor);

    const first = await api.createComputerUseReadCommand(actor, {
      kind: "app.state",
      app: "Safari",
      timeoutMs: 1000,
    });

    const claimedFirst = await api.claimNextComputerUseCommand(host.hostToken);
    expect(claimedFirst.status).toBe("command");
    if (claimedFirst.status !== "command") {
      throw new Error("Expected the first command to be claimed");
    }
    expect(claimedFirst.command.id).toBe(first.commandId);

    const idleWhileRunning = await api.claimNextComputerUseCommand(
      host.hostToken,
    );
    expect(idleWhileRunning.status).toBe("idle");

    const second = await api.createComputerUseReadCommand(actor, {
      kind: "apps.list",
    });

    const queuedComplete = await api.requestCompleteComputerUseCommand(
      host.hostToken,
      second.commandId,
      { status: "succeeded", result: {} },
      [409],
    );
    expectApiError(queuedComplete.body);
    expect(queuedComplete.body.error.message).toBe(
      "Computer-use command is not running",
    );

    mockNow(base + 1500);
    const claimedSecond = await api.claimNextComputerUseCommand(host.hostToken);
    expect(claimedSecond.status).toBe("command");
    if (claimedSecond.status !== "command") {
      throw new Error("Expected the second command after the stale timeout");
    }
    expect(claimedSecond.command.id).toBe(second.commandId);

    const timedOut = await api.readComputerUseCommand(actor, first.commandId);
    expect(timedOut).toMatchObject({
      status: "failed",
      error: {
        code: "timeout",
        message: "Computer-use command timed out after 1000ms",
      },
    });
    expect(timedOut.completedAt).toBe(new Date(base + 1500).toISOString());

    await api.completeComputerUseCommandWith(host.hostToken, second.commandId, {
      status: "failed",
      error: { code: "app_not_found", message: "Finder is not available" },
    });
    const failed = await api.readComputerUseCommand(actor, second.commandId);
    expect(failed).toMatchObject({
      status: "failed",
      error: { code: "app_not_found", message: "Finder is not available" },
    });

    const duplicateComplete = await api.requestCompleteComputerUseCommand(
      host.hostToken,
      second.commandId,
      { status: "succeeded", result: {} },
      [200],
    );
    expect(duplicateComplete.body).toStrictEqual({ ok: true });
    const stillFailed = await api.readComputerUseCommand(
      actor,
      second.commandId,
    );
    expect(stillFailed).toMatchObject({
      status: "failed",
      error: { code: "app_not_found", message: "Finder is not available" },
    });

    const unknownComplete = await api.requestCompleteComputerUseCommand(
      host.hostToken,
      randomUUID(),
      { status: "succeeded", result: {} },
      [404],
    );
    expectApiError(unknownComplete.body);
    expect(unknownComplete.body.error.message).toBe(
      "Computer-use command not found",
    );
  });

  it("offloads, proxies, and expires screenshots through the retention cron", async () => {
    const fake = api.installComputerUseS3Fake();
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const actor = bdd.user({ orgId, userId });
    const peerOrgId = `org_${randomUUID()}`;
    const peerUserId = `user_${randomUUID()}`;
    const peer = bdd.user({ orgId: peerOrgId, userId: peerUserId });

    mockNow(now() - 40 * 24 * 60 * 60 * 1000);
    const host = await api.startComputerUseHost(actor);

    const first = await api.createComputerUseReadCommand(actor, {
      kind: "app.state",
      app: "Safari",
    });
    const claimedFirst = await api.claimNextComputerUseCommand(host.hostToken);
    expect(claimedFirst.status).toBe("command");

    const pngBytes = Buffer.from("bdd-screenshot-png-bytes");
    const screenshotBase64 = pngBytes.toString("base64");
    await api.completeComputerUseCommandWith(host.hostToken, first.commandId, {
      status: "succeeded",
      result: {
        snapshotId: "snap_bdd_old",
        screenshot: `data:image/png;base64,${screenshotBase64}`,
        screenshotWidth: 1363,
        screenshotHeight: 1200,
      },
    });

    const firstKey = `computer-use/${orgId}/${userId}/${first.commandId}/screenshot.png`;
    expect(fake.puts).toHaveLength(1);
    expect(fake.puts[0]).toMatchObject({
      bucket: "test-user-storages",
      key: firstKey,
      contentType: "image/png",
    });
    expect(fake.puts[0]?.body.equals(pngBytes)).toBeTruthy();

    const firstDetail = await api.readComputerUseCommand(
      actor,
      first.commandId,
    );
    expect(firstDetail.result?.screenshot).toStrictEqual({
      type: "s3",
      mimeType: "image/png",
      sizeBytes: pngBytes.length,
      width: 1363,
      height: 1200,
    });
    expect(JSON.stringify(firstDetail.result)).not.toContain(screenshotBase64);

    const download = await api.downloadComputerUseScreenshot(
      actor,
      first.commandId,
    );
    expect(download.contentType).toBe("image/png");
    expect(download.bytes.equals(pngBytes)).toBeTruthy();

    const peerScreenshot = await api.requestComputerUseScreenshot(
      peer,
      first.commandId,
      [404],
    );
    expectApiError(peerScreenshot.body);
    expect(peerScreenshot.body.error.code).toBe("NOT_FOUND");

    const second = await api.createComputerUseReadCommand(actor, {
      kind: "app.state",
      app: "Safari",
    });
    await api.claimNextComputerUseCommand(host.hostToken);
    await api.completeComputerUseCommandWith(host.hostToken, second.commandId, {
      status: "succeeded",
      result: {
        snapshotId: "snap_bdd_legacy",
        screenshot: "legacy-inline-screenshot",
      },
    });

    const secondDetail = await api.readComputerUseCommand(
      actor,
      second.commandId,
    );
    expect(secondDetail.result).toMatchObject({
      screenshot: "legacy-inline-screenshot",
    });
    const legacyScreenshot = await api.requestComputerUseScreenshot(
      actor,
      second.commandId,
      [404],
    );
    expectApiError(legacyScreenshot.body);
    expect(legacyScreenshot.body.error.code).toBe("NOT_FOUND");

    const sentinelHost = await api.startComputerUseHost(peer);
    const sentinel = await api.createComputerUseReadCommand(peer, {
      kind: "app.state",
      app: "Safari",
    });
    const claimedSentinel = await api.claimNextComputerUseCommand(
      sentinelHost.hostToken,
    );
    expect(claimedSentinel.status).toBe("command");
    const sentinelBytes = Buffer.from("bdd-expired-sentinel-png-bytes");
    await api.completeComputerUseCommandWith(
      sentinelHost.hostToken,
      sentinel.commandId,
      {
        status: "succeeded",
        result: {
          snapshotId: "snap_bdd_expired_sentinel",
          screenshot: `data:image/png;base64,${sentinelBytes.toString("base64")}`,
          screenshotWidth: 1024,
          screenshotHeight: 768,
        },
      },
    );
    const sentinelKey = `computer-use/${peerOrgId}/${peerUserId}/${sentinel.commandId}/screenshot.png`;

    // Back to real time: the retention cutoff must be computed against the
    // wall clock so only the 40-day-old rows above fall outside the window.
    clearMockNow();
    const refresh = await api.claimNextComputerUseCommand(host.hostToken);
    expect(refresh.status).toBe("idle");

    const third = await api.createComputerUseReadCommand(actor, {
      kind: "app.state",
      app: "Safari",
    });
    await api.claimNextComputerUseCommand(host.hostToken);
    const recentBytes = Buffer.from("bdd-recent-png-bytes");
    await api.completeComputerUseCommandWith(host.hostToken, third.commandId, {
      status: "succeeded",
      result: {
        snapshotId: "snap_bdd_recent",
        screenshot: `data:image/png;base64,${recentBytes.toString("base64")}`,
        screenshotWidth: 800,
        screenshotHeight: 600,
      },
    });
    const thirdKey = `computer-use/${orgId}/${userId}/${third.commandId}/screenshot.png`;
    const ownedCommandIds = [first.commandId, second.commandId];

    const invalidCron = await api.runComputerUseScreenshotCleanupCron(
      "invalid",
      ownedCommandIds,
    );
    expect(invalidCron.status).toBe(401);
    expectApiError(invalidCron.body);
    expect(invalidCron.body.error.message).toBe("Invalid cron secret");

    const missingCron = await api.runComputerUseScreenshotCleanupCron(
      "missing",
      ownedCommandIds,
    );
    expect(missingCron.status).toBe(401);

    const swept = await api.runComputerUseScreenshotCleanupCron(
      "valid",
      ownedCommandIds,
    );
    if (swept.status !== 200) {
      throw new Error("Expected the screenshot cleanup cron to run");
    }
    expect(swept.body.cleaned).toBe(2);
    expect(fake.deletedKeys).toContain(firstKey);
    expect(fake.deletedKeys).not.toContain(thirdKey);
    expect(fake.deletedKeys).not.toContain(sentinelKey);

    const expiredPointer = await api.readComputerUseCommand(
      actor,
      first.commandId,
    );
    expect(expiredPointer.result?.screenshot).toStrictEqual({
      type: "expired",
    });
    const expiredLegacy = await api.readComputerUseCommand(
      actor,
      second.commandId,
    );
    expect(expiredLegacy.result?.screenshot).toStrictEqual({
      type: "expired",
    });
    const keptRecent = await api.readComputerUseCommand(actor, third.commandId);
    expect(keptRecent.result?.screenshot).toMatchObject({ type: "s3" });
    const keptSentinel = await api.readComputerUseCommand(
      peer,
      sentinel.commandId,
    );
    expect(keptSentinel.result?.screenshot).toMatchObject({ type: "s3" });

    const resweep = await api.runComputerUseScreenshotCleanupCron(
      "valid",
      ownedCommandIds,
    );
    if (resweep.status !== 200) {
      throw new Error("Expected the second cleanup sweep to run");
    }
    expect(resweep.body.cleaned).toBe(0);
  });
});

/*
 * AUTH-05 covers the Clerk classification boundary in `getMemberRoleAndUpdateCache$`
 * and `requiredAuthContext$` through the route that escaped as an unhandled
 * request error in production (#33822): `GET /api/computer-use/commands/:commandId`
 * authenticated with a CLI PAT. The membership read happens before the handler,
 * so the command id never has to exist for the classification to be observable.
 *
 * The negative controls are the point of the suite: exactly one predicate may
 * produce `identity_not_found` and exactly one may produce the 503, so every
 * other Clerk or database failure has to keep reaching the unhandled path.
 */
class ClerkApiResponseTestError extends Error {
  static readonly kind = "ClerkAPIResponseError";

  constructor(
    readonly status: number,
    readonly retryAfter = 1,
  ) {
    super(`Clerk Backend API request failed with status ${status}`);
  }
}

function membershipReadMock() {
  return context.mocks.clerk.users.getOrganizationMembershipList;
}

/** Fail the next membership read, from a clean call/delay/capture baseline. */
function failMembershipRead(error: unknown): void {
  membershipReadMock().mockReset();
  membershipReadMock().mockRejectedValue(error);
  context.mocks.signalTimers.delay.mockReset();
  context.mocks.signalTimers.delay.mockResolvedValue(undefined);
  context.mocks.sentry.captureException.mockClear();
}

function commandStatusRequest(token: string): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: computerUseRoutes,
  });
  return Promise.resolve(
    app.request(
      new Request(`http://api.test/api/computer-use/commands/${randomUUID()}`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      }),
    ),
  );
}

interface WarmMembershipCache {
  readonly token: string;
  /** Real time observed just before the cache row was written. */
  readonly warmedAt: number;
}

/**
 * Observe whether the warmed `org_members_cache` row survived, using only the
 * route's own behavior. Time moves back inside MEMBER_ROLE_CACHE_TTL_MS of the
 * warm-up write while Clerk still reports the identity as gone, so a surviving
 * row answers from cache and reaches the handler (404 command-not-found) while
 * a dropped row must consult Clerk again and fails closed (401). The probe
 * instant is derived from the warm-up instant rather than the wall clock, so
 * the window never depends on how long the test itself took.
 */
async function statusAfterCacheProbe(
  warm: WarmMembershipCache,
): Promise<number> {
  mockNow(warm.warmedAt + 30_000);
  failMembershipRead(new ClerkApiResponseTestError(404));
  const response = await commandStatusRequest(warm.token);
  return response.status;
}

/** A PAT whose org role is cached, so the next read must re-consult Clerk. */
async function patWithWarmMembershipCache(
  actor: ApiTestUser,
): Promise<WarmMembershipCache> {
  const { token } =
    await createAuthOrgAgentsBddApi(context).createCliToken(actor);
  mockClerkMembership(context, actor, "org:admin");

  const warmedAt = now();
  const warmed = await commandStatusRequest(token);
  // Authentication resolved; only the command itself is missing.
  expect(warmed.status).toBe(404);

  // Expire the cached role without touching MEMBER_ROLE_CACHE_TTL_MS itself.
  mockNow(warmedAt + 61_000);
  return { token, warmedAt };
}

describe("AUTH-05 computer-use auth boundary Clerk classification", () => {
  it("maps a deleted Clerk identity to 401 and drops the stale membership cache row", async () => {
    const actor = bdd.user();
    const warm = await patWithWarmMembershipCache(actor);
    const { token } = warm;
    failMembershipRead(new ClerkApiResponseTestError(404));

    const response = await commandStatusRequest(token);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    // A 404 is terminal: it is neither retried nor reported as unhandled.
    expect(membershipReadMock()).toHaveBeenCalledOnce();
    expect(context.mocks.signalTimers.delay).not.toHaveBeenCalled();
    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
    // The stale row is gone, so cached organization authority cannot be
    // reused by the deleted identity on the next request.
    await expect(statusAfterCacheProbe(warm)).resolves.toBe(401);
  });

  it("maps an exhausted Clerk provider read to a non-cacheable 503", async () => {
    const actor = bdd.user();
    const warm = await patWithWarmMembershipCache(actor);
    const { token } = warm;
    failMembershipRead(new ClerkApiResponseTestError(521));

    const response = await commandStatusRequest(token);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Authentication provider is temporarily unavailable",
        code: "PROVIDER_UNAVAILABLE",
      },
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(membershipReadMock()).toHaveBeenCalledTimes(3);
    expect(context.mocks.signalTimers.delay).toHaveBeenCalledTimes(2);
    // An exhausted provider read is a controlled response, not a crash, so the
    // actionable signal is the error-level provider_unavailable record.
    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
    // A provider outage says nothing about the identity, so the cached role
    // survives for the next attempt.
    await expect(statusAfterCacheProbe(warm)).resolves.toBe(404);
  });

  it("leaves a Clerk rate-limited membership read on its existing path", async () => {
    const actor = bdd.user();
    const warm = await patWithWarmMembershipCache(actor);
    const { token } = warm;
    failMembershipRead(new ClerkApiResponseTestError(429));

    const response = await commandStatusRequest(token);

    expect(response.status).toBe(500);
    expect(membershipReadMock()).toHaveBeenCalledOnce();
    expect(context.mocks.signalTimers.delay).not.toHaveBeenCalled();
    expect(context.mocks.sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ status: 429 }),
    );
    await expect(statusAfterCacheProbe(warm)).resolves.toBe(404);
  });

  it("propagates every other Clerk and database membership failure unchanged", async () => {
    const actor = bdd.user();
    const warm = await patWithWarmMembershipCache(actor);
    const { token } = warm;

    // A Clerk 4xx that is not a resource-not-found must not be absorbed by the
    // identity classification.
    failMembershipRead(new ClerkApiResponseTestError(403));
    const forbidden = await commandStatusRequest(token);
    expect(forbidden.status).toBe(500);
    expect(membershipReadMock()).toHaveBeenCalledOnce();
    expect(context.mocks.sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ status: 403 }),
    );

    // A non-Clerk failure raised by the same read keeps escaping too.
    failMembershipRead(new Error("membership read failed"));
    const unrelated = await commandStatusRequest(token);
    expect(unrelated.status).toBe(500);
    expect(context.mocks.sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "membership read failed" }),
    );

    // Neither failure may clear cached organization authority.
    await expect(statusAfterCacheProbe(warm)).resolves.toBe(404);
  });

  it("keeps a non-member identity on the degraded user-only context", async () => {
    const actor = bdd.user();
    const authOrg = createAuthOrgAgentsBddApi(context);
    const { token } = await patWithWarmMembershipCache(actor);

    // The identity exists; it simply holds no role in this organization.
    membershipReadMock().mockReset();
    membershipReadMock().mockResolvedValue({ data: [] });

    const degraded = await authOrg.requestReadMeWithBearer(token, actor, [200]);

    expect(degraded.body).toMatchObject({
      userId: actor.userId,
      orgId: null,
    });

    // Revalidate after the fixed negative window before classifying deletion.
    mockNow(now() + 5000);
    // The same PAT on the same route fails closed once the identity is gone.
    failMembershipRead(new ClerkApiResponseTestError(404));
    const deleted = await authOrg.requestReadMeWithBearer(token, actor, [401]);

    expectApiError(deleted.body);
    expect(deleted.body.error.code).toBe("UNAUTHORIZED");
  });
});
