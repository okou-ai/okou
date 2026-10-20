import { createPublicComputerUseScenario } from "./helpers/public-computer-use-scenario";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createStore } from "ccstate";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { captureConnectorExternalState } from "./helpers/public-connector-actor";
import { publicRunOwner } from "./helpers/public-run-owner";

import { integrationsSlackMessageContract } from "@okouai/api-contracts/contracts/integrations";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { integrationsSlackMessageRoutes } from "../integrations-slack-message";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createClaimedRunCredentials } from "./helpers/claimed-run-credentials";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createPublicSlackOrgApi } from "./helpers/slack-public-install";

// Connecting a Slack user resolves the built-in Slack connector OAuth method.
const context = testContext();
const credentials = createClaimedRunCredentials(context);
const store = createStore();
const slackOrgs = createPublicSlackOrgApi(context);
const bdd = createBddApi(context);
const api = createRunsApi(context);

describe("POST /api/integrations/slack/message", () => {
  beforeEach(() => {
    context.mocks.slack.chat.postMessage.mockResolvedValue({
      ok: true,
      ts: "mock.ts",
      channel: "C123456",
    });
    context.mocks.slack.conversations.open.mockResolvedValue({
      ok: true,
      channel: { id: "D-mock-dm" },
    });
  });

  async function seedBaseContext(): Promise<{
    orgId: string;
    userId: string;
  }> {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const userId = `user_${randomUUID().slice(0, 8)}`;
    await store.set(
      seedOrgMembership$,
      { orgId, userId, role: "admin" },
      context.signal,
    );
    return { orgId, userId };
  }

  /** The OAuth flows authenticate other sessions; restore the member's. */
  async function restoreMembership(base: {
    readonly orgId: string;
    readonly userId: string;
  }): Promise<void> {
    await store.set(
      seedOrgMembership$,
      { orgId: base.orgId, userId: base.userId, role: "admin" },
      context.signal,
    );
  }

  /** Connects the member's Slack user through the production flow. */
  async function connectMember(base: {
    readonly orgId: string;
    readonly userId: string;
    readonly slackWorkspaceId: string;
  }): Promise<{ readonly slackUserId: string }> {
    const connection = await slackOrgs.connectMember(base);
    await restoreMembership(base);
    return connection;
  }

  async function seedWithInstallation(): Promise<{
    orgId: string;
    userId: string;
    slackWorkspaceId: string;
  }> {
    const base = await seedBaseContext();
    const fixture = await slackOrgs.installForOrg({ orgId: base.orgId });
    await restoreMembership(base);
    return { ...base, slackWorkspaceId: fixture.slackWorkspaceId };
  }

  /**
   * Creates a real run for an agent named "My Assistant" through the product
   * agent + run APIs, so the message footer can resolve the agent label from
   * the run. Run admission needs org credits (Stripe webhook grant).
   */
  async function seedAgentRun(base: {
    readonly orgId: string;
    readonly userId: string;
  }): Promise<{ readonly runId: string; readonly token: string }> {
    const actor: ApiTestUser = {
      userId: base.userId,
      orgId: base.orgId,
      orgRole: "org:admin",
      email: `${base.userId}@example.test`,
    };
    bdd.acceptAgentStorageWrites();
    await api.grantProEntitlement(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "My Assistant",
      visibility: "private",
    });
    await api.ensurePersonalSubscriptionModel(actor, {
      model: "claude-sonnet-5-5",
    });
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    api.configureRunnerGroup();
    const owner = publicRunOwner(context, actor, {
      restoreEnvironment: captureConnectorExternalState(context),
    });
    return await owner.run(async () => {
      const run = await api.createThreadRun(actor, {
        agentId: agent.agentId,
        prompt: "send slack message",
      });
      // Product run creation authenticates through the Clerk session mocks;
      // restore the membership-list mock the Okou-token auth path relies on.
      await store.set(
        seedOrgMembership$,
        { orgId: base.orgId, userId: base.userId, role: "admin" },
        context.signal,
      );
      await api.heartbeatRunner();
      const claim = await owner.claim(run.runId);
      const token = claim.platformEnvironment?.OKOU_TOKEN;
      if (!token) {
        throw new Error("Expected the claimed Okou token");
      }
      return { runId: run.runId, token };
    });
  }

  it.each(["membership", "organization", "missing"] as const)(
    "selects the installation across the %s boundary",
    async (boundary) => {
      const scenario = createPublicComputerUseScenario(context);
      const first = scenario.user({ orgRole: "org:admin" });
      const member = scenario.user({
        orgId: first.orgId,
        orgRole: "org:member",
      });
      const second = scenario.user({ orgRole: "org:admin" });
      const missing = scenario.user({ orgRole: "org:admin" });
      await scenario.run(async () => {
        for (const actor of [
          first,
          ...(boundary === "membership"
            ? [member]
            : boundary === "organization"
              ? [second]
              : [missing]),
        ]) {
          await scenario.prepareActor(actor);
        }
        const a = await slackOrgs.installOrg({
          actor: first,
          withConnection: true,
        });
        scenario.beforeWorkspaceCleanup(() => {
          return slackOrgs.uninstallWorkspace(a.slackWorkspaceId);
        });
        const b =
          boundary === "organization"
            ? await slackOrgs.installOrg({
                actor: second,
                withConnection: true,
              })
            : undefined;
        scenario.beforeWorkspaceCleanup(() => {
          return b
            ? slackOrgs.uninstallWorkspace(b.slackWorkspaceId)
            : Promise.resolve();
        });
        await flushWaitUntilForTest();
        const requests = [
          { actor: first, installation: a },
          ...(boundary === "membership"
            ? [{ actor: member, installation: a }]
            : boundary === "organization"
              ? [{ actor: second, installation: b }]
              : [{ actor: missing, installation: undefined }]),
          { actor: first, installation: a },
        ];
        const client = setupApp({
          context,
          routes: integrationsSlackMessageRoutes,
        })(integrationsSlackMessageContract);
        for (const [index, request] of requests.entries()) {
          const claim = await scenario.claim(request.actor);
          await flushWaitUntilForTest();
          context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
            {
              data: [
                {
                  role: request.actor.orgRole,
                  organization: { id: request.actor.orgId },
                  publicUserData: { userId: request.actor.userId },
                },
              ],
            },
          );
          const channel = `C_GRAPH_${String(index)}`;
          const text = `request ${String(index)}`;
          const threadTs = `${String(index + 1)}.123`;
          context.mocks.slack.chat.postMessage.mockResolvedValue({
            ok: true,
            ts: threadTs,
            channel,
          });
          const clients = context.mocks.slack.createClient.mock.calls.length;
          const posts = context.mocks.slack.chat.postMessage.mock.calls.length;
          const response = client.sendMessage({
            headers: { authorization: `Bearer ${claim.token}` },
            body: { channel, text, threadTs },
          });
          if (!request.installation) {
            expect((await accept(response, [404])).body.error.code).toBe(
              "NOT_FOUND",
            );
            expect(
              context.mocks.slack.createClient.mock.calls.slice(clients),
            ).toStrictEqual([]);
            expect(
              context.mocks.slack.chat.postMessage.mock.calls.slice(posts),
            ).toStrictEqual([]);
            continue;
          }
          expect((await accept(response, [200])).body).toStrictEqual({
            ok: true,
            ts: threadTs,
            channel,
          });
          expect(
            context.mocks.slack.createClient.mock.calls
              .slice(clients)
              .map(([token]) => {
                return token;
              }),
          ).toStrictEqual([request.installation.botToken]);
          expect(
            context.mocks.slack.chat.postMessage.mock.calls.slice(posts),
          ).toStrictEqual([
            [expect.objectContaining({ channel, text, thread_ts: threadTs })],
          ]);
        }
      });
    },
  );
  it("returns 401 when the token has no active organization membership", async () => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const token = await credentials.okouToken({ userId, orgId });
    await credentials.removeMember({ userId, orgId });

    const client = setupApp({
      context,
      routes: integrationsSlackMessageRoutes,
    })(integrationsSlackMessageContract);
    const response = await accept(
      client.sendMessage({
        body: { channel: "C123", text: "hello" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 403 when sandbox token lacks slack:write", async () => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const token = await credentials.sandboxToken({ userId, orgId });

    const client = setupApp({
      context,
      routes: integrationsSlackMessageRoutes,
    })(integrationsSlackMessageContract);
    const response = await accept(
      client.sendMessage({
        body: { channel: "C123", text: "hello" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );
    expect(response.body.error.message).toContain("slack:write");
  });

  it("sends message successfully and returns Slack response", async () => {
    const { orgId, userId } = await seedWithInstallation();
    const token = await credentials.okouToken({ userId, orgId });

    const client = setupApp({
      context,
      routes: integrationsSlackMessageRoutes,
    })(integrationsSlackMessageContract);
    const response = await accept(
      client.sendMessage({
        body: {
          channel: "C123456",
          text: "Hello from agent",
          threadTs: "1234567890.123456",
        },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(response.body.ok).toBeTruthy();
    expect(response.body.ts).toBe("mock.ts");

    expect(context.mocks.slack.chat.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channel: "C123456",
        text: "Hello from agent",
        thread_ts: "1234567890.123456",
      }),
    );
  });

  it("forwards Slack API error with 400 status", async () => {
    const { orgId, userId } = await seedWithInstallation();
    const token = await credentials.okouToken({ userId, orgId });

    context.mocks.slack.chat.postMessage.mockRejectedValueOnce(
      Object.assign(new Error("channel_not_found"), {
        data: { ok: false, error: "channel_not_found" },
      }),
    );

    const client = setupApp({
      context,
      routes: integrationsSlackMessageRoutes,
    })(integrationsSlackMessageContract);
    const response = await accept(
      client.sendMessage({
        body: { channel: "C-invalid", text: "hello" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [400],
    );
    expect(response.body.error.code).toBe("SLACK_ERROR");
    expect(response.body.error.message).toContain("channel_not_found");
  });

  it("sends DM via user field using conversations.open", async () => {
    const { orgId, userId } = await seedWithInstallation();
    const token = await credentials.okouToken({ userId, orgId });

    const client = setupApp({
      context,
      routes: integrationsSlackMessageRoutes,
    })(integrationsSlackMessageContract);
    const response = await accept(
      client.sendMessage({
        body: { user: "U0A8V9X98QJ", text: "Hello DM!" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(response.body.ok).toBeTruthy();

    expect(context.mocks.slack.conversations.open).toHaveBeenLastCalledWith({
      users: "U0A8V9X98QJ",
    });
    expect(context.mocks.slack.chat.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channel: "D-mock-dm",
        text: "Hello DM!",
      }),
    );
  });

  it("returns 404 when conversations.open fails with user_not_found", async () => {
    const { orgId, userId } = await seedWithInstallation();
    const token = await credentials.okouToken({ userId, orgId });

    context.mocks.slack.conversations.open.mockRejectedValueOnce(
      Object.assign(new Error("user_not_found"), {
        data: { ok: false, error: "user_not_found" },
      }),
    );

    const client = setupApp({
      context,
      routes: integrationsSlackMessageRoutes,
    })(integrationsSlackMessageContract);
    const response = await accept(
      client.sendMessage({
        body: { user: "U-invalid", text: "hello" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [404],
    );
    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(response.body.error.message).toContain("user_not_found");
  });

  it("resolves 'me' to current user's Slack ID and sends DM", async () => {
    const { orgId, userId, slackWorkspaceId } = await seedWithInstallation();
    const { slackUserId } = await connectMember({
      orgId,
      userId,
      slackWorkspaceId,
    });
    const token = await credentials.okouToken({ userId, orgId });

    const client = setupApp({
      context,
      routes: integrationsSlackMessageRoutes,
    })(integrationsSlackMessageContract);
    const response = await accept(
      client.sendMessage({
        body: { user: "me", text: "Hello self!" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(response.body.ok).toBeTruthy();

    expect(context.mocks.slack.conversations.open).toHaveBeenLastCalledWith({
      users: slackUserId,
    });
  });

  it("returns 404 when 'me' is used but no Slack connection exists", async () => {
    const { orgId, userId } = await seedWithInstallation();
    const token = await credentials.okouToken({ userId, orgId });

    const client = setupApp({
      context,
      routes: integrationsSlackMessageRoutes,
    })(integrationsSlackMessageContract);
    const response = await accept(
      client.sendMessage({
        body: { user: "me", text: "hello" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [404],
    );
    expect(response.body.error.message).toContain("No Slack connection found");
  });

  it("appends 'Sent via' footer when agent is resolvable from run", async () => {
    const { orgId, userId } = await seedWithInstallation();
    const { token } = await seedAgentRun({ orgId, userId });

    const client = setupApp({
      context,
      routes: integrationsSlackMessageRoutes,
    })(integrationsSlackMessageContract);
    const response = await accept(
      client.sendMessage({
        body: { channel: "C123456", text: "Hello" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(response.body.ok).toBeTruthy();

    const call = context.mocks.slack.chat.postMessage.mock.calls.at(-1)?.[0] as
      | undefined
      | {
          blocks: {
            type: string;
            text?: { text: string };
            elements?: { text: string }[];
          }[];
        };
    expect(call?.blocks).toBeDefined();
    const blocks = call!.blocks;
    expect(blocks).toHaveLength(3);
    expect(blocks[0]!.type).toBe("section");
    expect(blocks[0]!.text!.text).toBe("Hello");
    expect(blocks[blocks.length - 2]!.type).toBe("divider");
    const footerCtx = blocks[blocks.length - 1]!;
    expect(footerCtx.type).toBe("context");
    expect(footerCtx.elements![0]!.text).toBe(
      "Sent via My Assistant · Claude Sonnet 5.5",
    );
  });

  it("appends user attribution footer when run is user-triggered (not scheduled)", async () => {
    const { orgId, userId, slackWorkspaceId } = await seedWithInstallation();
    const { token } = await seedAgentRun({ orgId, userId });

    const { slackUserId } = await connectMember({
      orgId,
      userId,
      slackWorkspaceId,
    });

    const client = setupApp({
      context,
      routes: integrationsSlackMessageRoutes,
    })(integrationsSlackMessageContract);
    const response = await accept(
      client.sendMessage({
        body: { channel: "C123456", text: "Hello" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(response.body.ok).toBeTruthy();

    const call = context.mocks.slack.chat.postMessage.mock.calls.at(-1)?.[0] as
      | undefined
      | {
          blocks: {
            type: string;
            elements?: { text: string }[];
          }[];
        };
    expect(call?.blocks).toBeDefined();
    const blocks = call!.blocks;
    expect(blocks).toHaveLength(3);

    const footerCtx = blocks[blocks.length - 1]!;
    expect(footerCtx.type).toBe("context");
    expect(footerCtx.elements![0]!.text).toBe(
      `Sent via My Assistant · Triggered by <@${slackUserId}> · Claude Sonnet 5.5`,
    );
  });
});
