import { createRouteMocks } from "./helpers/route-test";
import { privateIntegrationArtifact } from "./helpers/integration-output-artifacts";
import { createApp } from "../../../app-factory";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createStore } from "ccstate";

import { integrationsSlackMessageContract } from "@okouai/api-contracts/contracts/integrations";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { seedOrgMembership$ } from "./helpers/org-membership";
import {
  seedSlackOrgConnection$,
  seedSlackOrgInstallation$,
} from "./helpers/integrations-slack";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { integrationsSlackMessageRoutes } from "../integrations-slack-message";

const context = testContext();
const store = createStore();
const bdd = createBddApi(context);
const api = createRunsApi(context);

function okouToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
  readonly capabilities?: readonly string[];
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "okou",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: (args.capabilities ?? ["slack:write"]) as never,
    iat: seconds,
    exp: seconds + 60,
  });
}

function sandboxToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "sandbox",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    iat: seconds,
    exp: seconds + 60,
  });
}

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

  async function seedWithInstallation(): Promise<{
    orgId: string;
    userId: string;
    slackWorkspaceId: string;
  }> {
    const base = await seedBaseContext();
    const fixture = await store.set(
      seedSlackOrgInstallation$,
      { orgId: base.orgId },
      context.signal,
    );
    return { ...base, slackWorkspaceId: fixture.slackWorkspaceId };
  }

  /**
   * Creates a real run for an agent named "My Assistant" through the product
   * agent + run APIs, so the message footer can resolve the agent label from
   * the run. Run admission needs org credits (Stripe webhook grant); the
   * provider-only fixture keeps the run free of a selected model, matching
   * providers without model selection without reading legacy Compose content.
   */
  async function seedAgentRun(base: {
    readonly orgId: string;
    readonly userId: string;
  }): Promise<{ readonly runId: string }> {
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
    await api.createOrgModelProvider(actor, {
      type: "openrouter-api-key",
      secret: "test-openrouter-key",
    });
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    const run = await api.createRun(actor, {
      agentId: agent.agentId,
      prompt: "send slack message",
      modelProvider: "openrouter-api-key",
    });
    // Product run creation authenticates through the Clerk session mocks;
    // restore the membership-list mock the Okou-token auth path relies on.
    await store.set(
      seedOrgMembership$,
      { orgId: base.orgId, userId: base.userId, role: "admin" },
      context.signal,
    );
    return { runId: run.runId };
  }

  it("snapshots private text and nested blocks independently for multiple sends in one run", async () => {
    const base = await seedWithInstallation();
    const actor: ApiTestUser = {
      ...base,
      orgRole: "org:admin",
      email: `${base.userId}@example.test`,
    };
    const artifact = await privateIntegrationArtifact(context, actor);
    context.mocks.slack.chat.postMessage.mockImplementation(async (message) => {
      // Delivery must already be readable when Slack receives the message.
      await artifact.expectDelivered(JSON.stringify(message));
      return { ok: true, ts: "mock.ts", channel: "C123456" };
    });
    const token = okouToken({ ...base, runId: "run-1" });
    const headers = { authorization: `Bearer ${token}` };
    const client = setupApp({
      context,
      routes: integrationsSlackMessageRoutes,
    })(integrationsSlackMessageContract);
    const action = "https://app.okou.test/api/connector/authorize?code=keep";
    const text = `Report "quoted"\n<${artifact.url}|Download report>`;
    const block = {
      type: "section",
      text: { type: "mrkdwn", text },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "Open" },
        url: artifact.url,
      },
    };
    await accept(
      client.sendMessage({
        headers,
        body: {
          channel: "C123456",
          threadTs: "parent",
          text,
          blocks: [
            block,
            { type: "section", text: { type: "mrkdwn", text: action } },
          ],
        },
      }),
      [200],
    );
    const first = context.mocks.slack.chat.postMessage.mock.lastCall?.[0];
    const firstUrl = await artifact.expectDelivered(JSON.stringify(first));
    expect(first).toMatchObject({
      channel: "C123456",
      thread_ts: "parent",
      text: text.replace(artifact.url, firstUrl),
      blocks: [
        {
          ...block,
          text: { type: "mrkdwn", text: text.replace(artifact.url, firstUrl) },
          accessory: { ...block.accessory, url: firstUrl },
        },
        { type: "section", text: { type: "mrkdwn", text: action } },
      ],
    });
    await accept(
      client.sendMessage({
        headers,
        body: { channel: "C-another", blocks: [block] },
      }),
      [200],
    );
    const second = context.mocks.slack.chat.postMessage.mock.lastCall?.[0];
    const secondUrl = await artifact.expectDelivered(JSON.stringify(second));
    expect(secondUrl).not.toBe(firstUrl);
    expect(second).toMatchObject({
      channel: "C-another",
      blocks: [{ accessory: { url: secondUrl } }],
    });
  });

  it("snapshots block-only sends without a run and includes hosted dependencies", async () => {
    const base = await seedWithInstallation();
    const artifact = await privateIntegrationArtifact(context, {
      ...base,
      orgRole: "org:admin",
      email: `${base.userId}@example.test`,
    });
    const siteUrl = await artifact.createSite();
    const client = setupApp({
      context,
      routes: integrationsSlackMessageRoutes,
    })(integrationsSlackMessageContract);
    await accept(
      client.sendMessage({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          user: "U-recipient",
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: siteUrl } },
          ],
        },
      }),
      [200],
    );
    const sent = context.mocks.slack.chat.postMessage.mock.lastCall?.[0];
    expect(sent).toMatchObject({ channel: "D-mock-dm" });
    const serialized = JSON.stringify(sent);
    expect(serialized).not.toContain(siteUrl);
    const deliveredSite = serialized.match(
      /https:\/\/[a-z0-9]+\.okou\.app\//u,
    )?.[0];
    expect(deliveredSite).toBeDefined();
    const page = await fetch(deliveredSite!);
    expect(page.status).toBe(200);
    await artifact.expectDelivered(await page.text());
    const plot = await fetch(`${deliveredSite}plot.svg`);
    expect(plot.status).toBe(200);
    await expect(plot.text()).resolves.toContain("Snapshot plot");
  });

  it("passes public and action links through without creating snapshot storage", async () => {
    const base = await seedWithInstallation();
    await privateIntegrationArtifact(context, {
      ...base,
      orgRole: "org:admin",
      email: `${base.userId}@example.test`,
    });
    const storageCalls = context.mocks.s3.send.mock.calls.length;
    const text =
      "https://a.okou.io/public.pdf https://app.okou.test/api/connector/authorize?code=keep https://example.test/report";
    const client = setupApp({
      context,
      routes: integrationsSlackMessageRoutes,
    })(integrationsSlackMessageContract);
    await accept(
      client.sendMessage({
        headers: { authorization: "Bearer clerk-session" },
        body: { channel: "C123456", text },
      }),
      [200],
    );
    expect(context.mocks.slack.chat.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ text }),
    );
    expect(context.mocks.s3.send.mock.calls).toHaveLength(storageCalls);
  });

  it.each(["missing", "foreign", "copy"] as const)(
    "does not send a private artifact when %s prevents snapshot publication",
    async (failure) => {
      const base = await seedWithInstallation();
      const actor = {
        ...base,
        orgRole: "org:admin" as const,
        email: `${base.userId}@example.test`,
      };
      const artifact = await privateIntegrationArtifact(
        context,
        failure === "foreign"
          ? { ...actor, userId: `user_${randomUUID()}` }
          : actor,
      );
      if (failure === "missing") {
        artifact.removeOriginal();
      }
      if (failure === "copy") {
        artifact.rejectCopies();
      }
      createRouteMocks(context).clerk.session(base.userId, base.orgId);
      const response = await createApp({
        signal: context.signal,
        routes: integrationsSlackMessageRoutes,
      }).request("/api/integrations/slack/message", {
        method: "POST",
        headers: {
          authorization: "Bearer clerk-session",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          channel: "C123456",
          blocks: [
            { type: "image", image_url: artifact.url, alt_text: "Report" },
          ],
        }),
      });
      expect(response.status).toBe(500);
      expect(context.mocks.slack.chat.postMessage).not.toHaveBeenCalled();
    },
  );

  it("returns 401 when no auth token is provided", async () => {
    const client = setupApp({
      context,
      routes: integrationsSlackMessageRoutes,
    })(integrationsSlackMessageContract);
    const response = await accept(
      client.sendMessage({
        body: { channel: "C123", text: "hello" },
        headers: {},
      }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the token has no active organization membership", async () => {
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [],
    });

    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const token = okouToken({ userId, orgId, runId: "run-1" });

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
    const runId = `run_${randomUUID()}`;
    const token = sandboxToken({ userId, orgId, runId });

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

  it("returns 404 when no Slack installation exists for org", async () => {
    const { orgId, userId } = await seedBaseContext();
    const token = okouToken({ userId, orgId, runId: "run-1" });

    const client = setupApp({
      context,
      routes: integrationsSlackMessageRoutes,
    })(integrationsSlackMessageContract);
    const response = await accept(
      client.sendMessage({
        body: { channel: "C123", text: "hello" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [404],
    );
    expect(response.body.error.message).toContain("No Slack installation");
  });

  it("sends message successfully and returns Slack response", async () => {
    const { orgId, userId } = await seedWithInstallation();
    const token = okouToken({ userId, orgId, runId: "run-1" });

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
    const token = okouToken({ userId, orgId, runId: "run-1" });

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
    const token = okouToken({ userId, orgId, runId: "run-1" });

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
    const token = okouToken({ userId, orgId, runId: "run-1" });

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
    const { slackUserId } = await store.set(
      seedSlackOrgConnection$,
      { slackWorkspaceId, userId: userId },
      context.signal,
    );
    const token = okouToken({ userId, orgId, runId: "run-1" });

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
    const token = okouToken({ userId, orgId, runId: "run-1" });

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
    const { runId } = await seedAgentRun({ orgId, userId });
    const token = okouToken({ userId, orgId, runId });

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
    expect(footerCtx.elements![0]!.text).toBe("Sent via My Assistant");
  });

  it("appends user attribution footer when run is user-triggered (not scheduled)", async () => {
    const { orgId, userId, slackWorkspaceId } = await seedWithInstallation();
    const { runId } = await seedAgentRun({ orgId, userId });

    const { slackUserId } = await store.set(
      seedSlackOrgConnection$,
      { slackWorkspaceId, userId: userId },
      context.signal,
    );

    const token = okouToken({ userId, orgId, runId });

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
      `Sent via My Assistant · Triggered by <@${slackUserId}>`,
    );
  });
});
