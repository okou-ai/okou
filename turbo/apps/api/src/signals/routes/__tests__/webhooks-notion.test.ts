import { randomUUID } from "node:crypto";
import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { builtinConnectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
} from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { chatConnectorAccessRoutes } from "../chat-connector-access";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsRoutes } from "../connectors";
import { builtinConnectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const NOTION_TARGET = Object.freeze({
  kind: "builtin" as const,
  connectorSlug: "notion" as const,
});

const app = setupApp({
  context,
  routes: [
    ...builtinConnectorsRoutes,
    ...builtinConnectorsSlugCallbackRoutes,
    ...connectorAccountRoutes,
    ...chatConnectorAccessRoutes,
    ...chatThreadCreateRoutes,
    ...workflowsRoutes,
    ...workflowAutomationsRoutes,
  ],
});

const oauthStart = app(builtinConnectorOauthStartContract);
const oauthCallback = app(builtinConnectorsSlugCallbackContract);
const connectorAccounts = app(connectorAccountsContract);
const chatConnectorAccess = app(chatConnectorAccessContract);
const chatThreads = app(chatThreadsContract);
const workflows = app(workflowsCollectionContract);
const workflowAutomations = app(workflowAutomationsContract);

function bearerToken(request: Request): string {
  return request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
}

function notionPageUrl(pageId: string): string {
  return `https://www.notion.so/Page-${pageId.replace(/-/gu, "")}`;
}

function setupNotionBoundaries(
  pageTokenRules: Readonly<Record<string, readonly string[]>> = {},
): void {
  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  mockOptionalEnv("NOTION_OAUTH_CLIENT_ID", "notion-client-id");
  mockOptionalEnv("NOTION_OAUTH_CLIENT_SECRET", "notion-client-secret");
  context.mocks.s3.send.mockResolvedValue({});

  server.use(
    http.post("https://api.notion.com/v1/oauth/token", async ({ request }) => {
      const payload: unknown = await request.json();
      const code =
        typeof payload === "object" &&
        payload !== null &&
        "code" in payload &&
        typeof payload.code === "string"
          ? payload.code
          : "code-1";
      const suffix = code.replace(/^code-/u, "");
      return HttpResponse.json({
        access_token: `notion-token-${suffix}`,
        bot_id: `bot-${suffix}`,
        refresh_token: `refresh-${suffix}`,
        expires_in: 3600,
        owner: {
          user: {
            id: `notion-user-${suffix}`,
            name: `Notion ${suffix}`,
          },
        },
      });
    }),
    http.get(
      "https://api.notion.com/v1/pages/:pageId",
      ({ params, request }) => {
        const pageId = String(params.pageId);
        const allowedTokens = pageTokenRules[pageId];
        if (allowedTokens && !allowedTokens.includes(bearerToken(request))) {
          return HttpResponse.json(
            { object: "error", status: 404, code: "object_not_found" },
            { status: 404 },
          );
        }
        return HttpResponse.json({
          object: "page",
          id: pageId,
          url: notionPageUrl(pageId),
          parent: { type: "workspace", workspace: true },
          properties: {
            title: {
              id: "title",
              type: "title",
              title: [{ plain_text: `Parent ${pageId.slice(0, 8)}` }],
            },
          },
        });
      },
    ),
  );
}

async function startNotionOauth(index: number): Promise<string> {
  const started = await accept(
    oauthStart.start({
      headers,
      params: { connectorSlug: "notion" },
      body: {
        authMethod: "oauth",
        account: { intent: "add", displayName: `Notion ${index}` },
      },
    }),
    [200],
  );
  const state = new URL(started.body.authorizationUrl).searchParams.get(
    "state",
  );
  if (!state) {
    throw new Error("Expected state parameter in Notion authorization URL");
  }
  return state;
}

async function completeNotionOauth(
  index: number,
  state: string,
): Promise<void> {
  const completed = await accept(
    oauthCallback.callback({
      params: { connectorSlug: "notion" },
      query: { state, code: `code-${index}`, responseMode: "json" },
    }),
    [200],
  );
  if (completed.body.status !== "success") {
    throw new Error(
      `Notion OAuth callback failed: ${JSON.stringify(completed.body)}`,
    );
  }
}

async function setupNotionChatAutomation(
  accountCount: number,
  options: {
    readonly enableAccountAccessSwitch?: boolean;
    readonly pageTokenRules?: Readonly<Record<string, readonly string[]>>;
  } = {},
) {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  createRouteMocks(context).clerk.session(userId, orgId, "org:member");
  setupNotionBoundaries(options.pageTokenRules);

  const indices = Array.from({ length: accountCount }, (_unused, offset) => {
    return offset + 1;
  });
  const [thread, _featureUpdate, ...states] = await Promise.all([
    accept(chatThreads.create({ headers, body: { model: null } }), [201]),
    options.enableAccountAccessSwitch
      ? updateFeatureSwitchesForUser(
          context,
          { userId, orgId },
          { [FeatureSwitchKey.MemberConnectorAccountAccess]: true },
        ).then(() => {
          createRouteMocks(context).clerk.session(userId, orgId, "org:member");
        })
      : Promise.resolve(),
    ...indices.map((index) => {
      return startNotionOauth(index);
    }),
  ]);

  const [workflow] = await Promise.all([
    accept(
      workflows.create({
        headers,
        body: {
          name: `notion-wf-${randomUUID().slice(0, 8)}`,
          visibility: "private",
          chatThreadId: thread.body.id,
        },
      }),
      [201],
    ),
    ...states.map((state, offset) => {
      return completeNotionOauth(offset + 1, state);
    }),
  ]);

  const parentPageId = randomUUID();
  const [listed, automation] = await Promise.all([
    accept(
      connectorAccounts.connections({
        headers,
        query: NOTION_TARGET,
      }),
      [200],
    ),
    accept(
      workflowAutomations.create({
        headers,
        params: { workflowId: workflow.body.id },
        body: {
          kind: "event",
          eventType: "notion-child-page-created",
          eventConfig: {
            provider: "notion",
            event: "child_page_created",
            parentPageUrl: notionPageUrl(parentPageId),
          },
          enabled: false,
        },
      }),
      [201],
    ),
  ]);

  const defaultConnection = listed.body.connections.find((connection) => {
    return connection.isDefault;
  });
  if (!defaultConnection) {
    throw new Error("Expected default connected Notion account");
  }
  const nonDefaultConnections = listed.body.connections.filter((connection) => {
    return connection.id !== defaultConnection.id;
  });
  const orderedConnections = [defaultConnection, ...nonDefaultConnections];
  const accountIds = orderedConnections.map((connection) => {
    return connection.id;
  });
  const accountTokens = orderedConnections.map((connection) => {
    const suffix = (connection.displayName ?? "Notion 1").replace(
      /^Notion /u,
      "",
    );
    return `notion-token-${suffix}`;
  });

  return {
    accountIds,
    accountTokens,
    threadId: thread.body.id,
    workflowId: workflow.body.id,
    automationId: automation.body.id,
  };
}

async function readAutomationConnectorId(
  automationId: string,
): Promise<string> {
  const response = await accept(
    workflowAutomations.get({
      headers,
      params: { id: automationId },
    }),
    [200],
  );
  if (
    response.body.kind !== "event" ||
    response.body.eventType !== "notion-child-page-created"
  ) {
    throw new Error("Expected notion-child-page-created automation");
  }
  return response.body.eventConfig.connectorId;
}

describe("POST /api/webhooks/notion", () => {
  it("webhooks-notion-021 does not reactivate a denied Notion default when deletion leaves no allowed account", async () => {
    const { accountIds, threadId, automationId } =
      await setupNotionChatAutomation(2);
    const [firstAccount, secondAccount] = accountIds;
    if (!firstAccount || !secondAccount) {
      throw new Error("Expected two Notion accounts");
    }

    const override = await accept(
      chatConnectorAccess.setThreadOverride({
        headers,
        params: { threadId, connectionId: firstAccount },
        body: { target: NOTION_TARGET, enabled: false },
      }),
      [200],
    );
    expect(override.body.currentConnectionId).toBe(secondAccount);

    await accept(
      connectorAccounts.delete({
        headers,
        params: { connectionId: secondAccount },
        body: { target: NOTION_TARGET },
      }),
      [200],
    );

    const [access] = await Promise.all([
      accept(
        chatConnectorAccess.getThread({
          headers,
          params: { threadId },
          query: NOTION_TARGET,
        }),
        [200],
      ),
      accept(
        workflowAutomations.enable({
          headers,
          params: { id: automationId },
        }),
        [400],
      ),
    ]);
    expect(access.body.currentConnectionId).toBeNull();
    expect(access.body.available).toBeFalsy();
  });

  it("webhooks-notion-009 (1/2) moves the Notion automation to the new default account", async () => {
    const { accountIds, automationId } = await setupNotionChatAutomation(2);
    const [, secondAccount] = accountIds;
    if (!secondAccount) {
      throw new Error("Expected second Notion account");
    }

    await accept(
      connectorAccounts.setDefault({
        headers,
        params: { connectionId: secondAccount },
        body: { target: NOTION_TARGET },
      }),
      [200],
    );
    await expect(readAutomationConnectorId(automationId)).resolves.toBe(
      secondAccount,
    );
  });

  it("webhooks-notion-009 (2/2) restores the Notion automation when switching default back to the first account", async () => {
    const { accountIds, automationId } = await setupNotionChatAutomation(2);
    const [firstAccount, secondAccount] = accountIds;
    if (!firstAccount || !secondAccount) {
      throw new Error("Expected two Notion accounts");
    }

    await accept(
      connectorAccounts.setDefault({
        headers,
        params: { connectionId: secondAccount },
        body: { target: NOTION_TARGET },
      }),
      [200],
    );
    await accept(
      connectorAccounts.setDefault({
        headers,
        params: { connectionId: firstAccount },
        body: { target: NOTION_TARGET },
      }),
      [200],
    );
    await expect(readAutomationConnectorId(automationId)).resolves.toBe(
      firstAccount,
    );
  });

  it("webhooks-notion-010 (1/2) keeps Notion listening on the first account when a denied account becomes default", async () => {
    const { accountIds, automationId } = await setupNotionChatAutomation(2, {
      enableAccountAccessSwitch: true,
    });
    const [firstAccount, secondAccount] = accountIds;
    if (!firstAccount || !secondAccount) {
      throw new Error("Expected two Notion accounts");
    }

    await accept(
      chatConnectorAccess.updateAccountPolicy({
        headers,
        params: { connectionId: secondAccount },
        body: { target: NOTION_TARGET, policy: "deny" },
      }),
      [200],
    );
    await accept(
      connectorAccounts.setDefault({
        headers,
        params: { connectionId: secondAccount },
        body: { target: NOTION_TARGET },
      }),
      [200],
    );
    await expect(readAutomationConnectorId(automationId)).resolves.toBe(
      firstAccount,
    );
  });

  it("webhooks-notion-010 (2/2) moves Notion listening to the default account once its policy becomes allow-always", async () => {
    const { accountIds, automationId } = await setupNotionChatAutomation(2, {
      enableAccountAccessSwitch: true,
    });
    const [, secondAccount] = accountIds;
    if (!secondAccount) {
      throw new Error("Expected second Notion account");
    }

    await accept(
      chatConnectorAccess.updateAccountPolicy({
        headers,
        params: { connectionId: secondAccount },
        body: { target: NOTION_TARGET, policy: "deny" },
      }),
      [200],
    );
    await accept(
      connectorAccounts.setDefault({
        headers,
        params: { connectionId: secondAccount },
        body: { target: NOTION_TARGET },
      }),
      [200],
    );
    await accept(
      chatConnectorAccess.updateAccountPolicy({
        headers,
        params: { connectionId: secondAccount },
        body: { target: NOTION_TARGET, policy: "allow-always" },
      }),
      [200],
    );
    await expect(readAutomationConnectorId(automationId)).resolves.toBe(
      secondAccount,
    );
  });

  it("webhooks-notion-012 inherits explicit Notion account selection in new automations", async () => {
    const secondParentPageId = randomUUID();
    const pageTokenRules: Record<string, readonly string[]> = {};
    const { accountIds, accountTokens, threadId, workflowId, automationId } =
      await setupNotionChatAutomation(2, { pageTokenRules });
    const [, secondAccount] = accountIds;
    const [, secondToken] = accountTokens;
    if (!secondAccount || !secondToken) {
      throw new Error("Expected second Notion account");
    }
    pageTokenRules[secondParentPageId] = [secondToken];

    await accept(
      chatConnectorAccess.setThreadCurrent({
        headers,
        params: { threadId },
        body: { target: NOTION_TARGET, connectionId: secondAccount },
      }),
      [200],
    );
    const [existingConnectorId, created] = await Promise.all([
      readAutomationConnectorId(automationId),
      accept(
        workflowAutomations.create({
          headers,
          params: { workflowId },
          body: {
            kind: "event",
            eventType: "notion-child-page-created",
            eventConfig: {
              provider: "notion",
              event: "child_page_created",
              parentPageUrl: notionPageUrl(secondParentPageId),
            },
            enabled: false,
          },
        }),
        [201],
      ),
    ]);

    expect(existingConnectorId).toBe(secondAccount);
    if (
      created.body.kind !== "event" ||
      created.body.eventType !== "notion-child-page-created"
    ) {
      throw new Error("Expected notion-child-page-created automation");
    }
    expect(created.body.eventConfig.connectorId).toBe(secondAccount);
  });

  it("webhooks-notion-019 (1/2) listens on the Chat's selected third Notion account before deletion", async () => {
    const { accountIds, threadId, automationId } =
      await setupNotionChatAutomation(3);
    const [firstAccount, , thirdAccount] = accountIds;
    if (!firstAccount || !thirdAccount) {
      throw new Error("Expected three Notion accounts");
    }

    await accept(
      chatConnectorAccess.setThreadOverride({
        headers,
        params: { threadId, connectionId: firstAccount },
        body: { target: NOTION_TARGET, enabled: false },
      }),
      [200],
    );
    await accept(
      chatConnectorAccess.setThreadCurrent({
        headers,
        params: { threadId },
        body: { target: NOTION_TARGET, connectionId: thirdAccount },
      }),
      [200],
    );
    await expect(readAutomationConnectorId(automationId)).resolves.toBe(
      thirdAccount,
    );
  });

  it("webhooks-notion-019 (2/2) falls back to the allowed second Notion account after deleting the selected third account", async () => {
    const { accountIds, threadId, automationId } =
      await setupNotionChatAutomation(3);
    const [firstAccount, secondAccount, thirdAccount] = accountIds;
    if (!firstAccount || !secondAccount || !thirdAccount) {
      throw new Error("Expected three Notion accounts");
    }

    await accept(
      chatConnectorAccess.setThreadOverride({
        headers,
        params: { threadId, connectionId: firstAccount },
        body: { target: NOTION_TARGET, enabled: false },
      }),
      [200],
    );
    await accept(
      chatConnectorAccess.setThreadCurrent({
        headers,
        params: { threadId },
        body: { target: NOTION_TARGET, connectionId: thirdAccount },
      }),
      [200],
    );
    await accept(
      connectorAccounts.delete({
        headers,
        params: { connectionId: thirdAccount },
        body: { target: NOTION_TARGET },
      }),
      [200],
    );

    const [access, listenerConnectorId] = await Promise.all([
      accept(
        chatConnectorAccess.getThread({
          headers,
          params: { threadId },
          query: NOTION_TARGET,
        }),
        [200],
      ),
      readAutomationConnectorId(automationId),
    ]);
    expect(access.body.currentConnectionId).toBe(secondAccount);
    expect(listenerConnectorId).toBe(secondAccount);
  });
});
