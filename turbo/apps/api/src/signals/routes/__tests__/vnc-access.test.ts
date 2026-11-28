import { randomUUID } from "node:crypto";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { vncHostsContract } from "@okouai/api-contracts/contracts/vnc-access";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { createStore } from "ccstate";
import { beforeAll, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatRemoteAccessRoutes } from "../chat-remote-access";
import { vncAccessRoutes } from "../vnc-access";
import { vncConnectionsRoutes } from "../vnc-connections";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { publicRunOwner } from "./helpers/public-run-owner";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { vncConnectionBody } from "./helpers/vnc-runtime";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const clerkDirectory = createStore();

interface Actor {
  readonly userId: string;
  readonly orgId: string;
  readonly role: "admin" | "member";
}

function signIn(actor: Actor) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.role === "admin" ? "org:admin" : "org:member",
  );
}

const vncConnections = () => {
  return setupApp({ context, routes: vncConnectionsRoutes })(
    vncConnectionsContract,
  );
};
const remoteAccess = () => {
  return setupApp({ context, routes: chatRemoteAccessRoutes })(
    chatRemoteAccessContract,
  );
};
const vncHosts = () => {
  return setupApp({ context, routes: vncAccessRoutes })(vncHostsContract);
};

async function createEnabledVncHost(actor: Actor, displayName: string) {
  await clerkDirectory.set(seedOrgMembership$, actor, context.signal);
  signIn(actor);
  const created = (
    await accept(
      vncConnections().create({
        headers,
        body: { ...vncConnectionBody(), displayName },
      }),
      [201],
    )
  ).body;
  await accept(
    remoteAccess().updateHostDefault({
      headers,
      params: { protocol: "vnc", connectionId: created.id },
      body: { enabled: true },
    }),
    [200],
  );
  return created;
}

async function startAgentRun(
  actor: Actor,
  options: {
    readonly runnerGroup?: string;
    readonly bootstrapOrg?: boolean;
    readonly grantTeam?: boolean;
  } = {},
) {
  const fixture = createChatEventsFixture(context);
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const apiUser: ApiTestUser = bdd.user({
    userId: actor.userId,
    orgId: actor.orgId,
    orgRole: actor.role === "admin" ? "org:admin" : "org:member",
  });
  const owner = publicRunOwner(context, apiUser);
  fixture.chatCallbacks.acceptChatObjectStorage();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  fixture.chatCallbacks.disableVapid();

  const runnerGroup =
    options.runnerGroup ??
    (await runs.configureRunnerGroup({ maxConcurrent: 4 }));
  if (options.bootstrapOrg !== false) {
    await owner.run(() => {
      return bdd.bootstrapLimitedFreeOnboarding(apiUser);
    });
    if (options.grantTeam) {
      await runs.grantProEntitlement(apiUser, { tier: "team" });
    }
  } else {
    await owner.run(() => {
      return bdd.completeOnboarding(apiUser);
    });
  }

  const launched = await owner.run(() => {
    return fixture.sendChatRun(apiUser, {
      prompt: "Inspect authorized VNC hosts",
      model: null,
    });
  });
  const execution = await owner.executionInput(launched.runId);
  const okouToken = execution.platformEnvironment.OKOU_TOKEN;
  if (!okouToken) {
    throw new Error("Expected OKOU_TOKEN in Run execution input");
  }
  return {
    apiUser,
    runId: launched.runId,
    threadId: launched.threadId,
    runnerGroup,
    execution,
    agentHeaders: { authorization: `Bearer ${okouToken}` },
  };
}

describe("live chat VNC Run inventory", () => {
  beforeAll(() => {
    setupApp({
      context,
      routes: [
        ...vncConnectionsRoutes,
        ...chatRemoteAccessRoutes,
        ...vncAccessRoutes,
      ],
    });
  });

  it(
    "vnc-access-011 isolates a shared Agent's inventory by the Run owner",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      useSecretKmsProbe();
      const orgId = `org_${randomUUID()}`;
      const creator: Actor = {
        userId: `user_${randomUUID()}`,
        orgId,
        role: "admin",
      };
      const colleague: Actor = {
        userId: `user_${randomUUID()}`,
        orgId,
        role: "member",
      };
      await Promise.all([
        clerkDirectory.set(seedOrgMembership$, creator, context.signal),
        clerkDirectory.set(seedOrgMembership$, colleague, context.signal),
      ]);

      const creatorHost = await createEnabledVncHost(
        creator,
        "Creator desktop",
      );
      const creatorRun = await startAgentRun(creator, { grantTeam: true });
      const colleagueRun = await startAgentRun(colleague, {
        runnerGroup: creatorRun.runnerGroup,
        bootstrapOrg: false,
      });

      const colleagueBefore = await accept(
        vncHosts().list({ headers: colleagueRun.agentHeaders }),
        [200],
      );
      expect(colleagueBefore.body).toStrictEqual({
        hosts: [],
        identities: [],
      });

      const colleagueHost = await createEnabledVncHost(
        colleague,
        "Colleague desktop",
      );

      const [colleagueAfter, creatorFinal, colleagueFinal] = await Promise.all([
        accept(vncHosts().list({ headers: colleagueRun.agentHeaders }), [200]),
        accept(vncHosts().list({ headers: creatorRun.agentHeaders }), [200]),
        accept(vncHosts().list({ headers: colleagueRun.agentHeaders }), [200]),
      ]);
      expect(
        colleagueAfter.body.hosts.map((host) => {
          return host.id;
        }),
      ).toStrictEqual([colleagueHost.id]);
      expect(
        creatorFinal.body.hosts.map((host) => {
          return host.id;
        }),
      ).toStrictEqual([creatorHost.id]);
      expect(
        colleagueFinal.body.hosts.map((host) => {
          return host.id;
        }),
      ).toStrictEqual([colleagueHost.id]);
    },
  );

  it(
    "vnc-access-014 rejects inventory for a completed Run despite an enabled host default",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      useSecretKmsProbe();
      const member: Actor = {
        userId: `user_${randomUUID()}`,
        orgId: `org_${randomUUID()}`,
        role: "member",
      };
      await clerkDirectory.set(seedOrgMembership$, member, context.signal);
      await createEnabledVncHost(member, "Completed Run desktop");

      const run = await startAgentRun(member);
      const sandboxHeaders = {
        authorization: `Bearer ${run.execution.sandboxToken}`,
      };
      const webhooks = createWebhookCallbackApi(context);
      await webhooks.requestAgentEvents(
        {
          runId: run.runId,
          events: [{ type: "system", sequenceNumber: 0 }],
        },
        sandboxHeaders,
        [200],
      );
      await webhooks.requestAgentComplete(
        {
          runId: run.runId,
          exitCode: 0,
          lastEventSequence: 0,
          completion: {
            cliAgentType:
              run.execution.cliAgentType === "pi"
                ? "pi"
                : run.execution.cliAgentType === "codex"
                  ? "codex"
                  : run.execution.cliAgentType === "antigravity"
                    ? "antigravity"
                    : "claude-code",
            cliAgentSessionId: run.execution.piSessionId ?? run.threadId,
            cliAgentSessionHistoryDisposition: "native_only",
          },
        },
        sandboxHeaders,
        [200],
      );
      await flushWaitUntilForTest();

      const completedRun = await createRunsApi(context).readRun(
        run.apiUser,
        run.runId,
      );
      expect(completedRun.status).toBe("completed");

      const rejected = await accept(
        vncHosts().list({ headers: run.agentHeaders }),
        [404],
      );
      expect(rejected.body).toMatchObject({
        error: { code: "VNC_UNAVAILABLE" },
      });
    },
  );
});
