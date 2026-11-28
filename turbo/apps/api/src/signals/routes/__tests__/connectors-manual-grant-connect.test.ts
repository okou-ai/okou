import { randomUUID } from "node:crypto";

import { CLIENT_TYPE_CLI } from "@okouai/api-contracts/contracts/client-headers";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  builtinConnectorManualGrantContract,
  builtinConnectorNoAuthGrantContract,
  builtinConnectorsMainContract,
} from "@okouai/api-contracts/contracts/connectors";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsRoutes } from "../connectors";
import { createBddApi } from "./helpers/api-bdd";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import {
  createChatEventsFixture,
  executionEnvironment,
} from "./helpers/chat-events-fixture";
import { publicRunOwner } from "./helpers/public-run-owner";
import { channelsPublishedTo } from "./helpers/realtime-publications";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

interface Member {
  readonly userId: string;
  readonly orgId: string;
}

function newMember(): Member {
  return { userId: `user_${randomUUID()}`, orgId: `org_${randomUUID()}` };
}

function signIn(member: Member) {
  createRouteMocks(context).clerk.session(member.userId, member.orgId);
}

function manualGrantClient() {
  return setupApp({ context, routes: builtinConnectorsRoutes })(
    builtinConnectorManualGrantContract,
  );
}

function accountsClient() {
  return setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  );
}

type ManualGrantBody = Parameters<
  ReturnType<typeof manualGrantClient>["connect"]
>[0]["body"];

function manualGrant(
  member: Member,
  connectorSlug: string,
  body: ManualGrantBody,
  extraHeaders?: Record<string, string>,
) {
  signIn(member);
  return manualGrantClient().connect({
    params: { connectorSlug },
    headers,
    body,
    ...(extraHeaders ? { extraHeaders } : {}),
  });
}

async function addOpenAi(member: Member, displayName?: string) {
  const response = await accept(
    manualGrant(member, "openai", {
      authMethod: "api-token",
      account: displayName ? { intent: "add", displayName } : { intent: "add" },
      values: { apiKey: `sk-${randomUUID()}` },
    }),
    [200],
  );
  return response.body.connectionId;
}

async function listAccounts(member: Member, connectorSlug: string) {
  signIn(member);
  const response = await accept(
    accountsClient().connections({
      headers,
      query: { kind: "builtin", connectorSlug, limit: 100 },
    }),
    [200],
  );
  return response.body;
}

describe("POST /api/connectors/:connectorSlug/manual-grant", () => {
  it("connectors-manual-grant-connect-018 rejects a connector without a manual grant method", async () => {
    const response = await accept(
      manualGrant(newMember(), "github", {
        authMethod: "api-token",
        account: { intent: "add" },
        values: {},
      }),
      [400],
    );

    expect(response.body.error.message).toContain(
      "github connector does not have api-token auth method",
    );
  });

  it("connectors-manual-grant-connect-004 connects an unlabeled account that then appears as connected", async () => {
    const member = newMember();

    const granted = await accept(
      manualGrant(member, "openai", {
        authMethod: "api-token",
        account: { intent: "add" },
        values: { apiKey: `sk-${randomUUID()}` },
      }),
      [200],
    );
    expect(Object.keys(granted.body)).toStrictEqual(["connectionId"]);

    signIn(member);
    const noAuth = await accept(
      setupApp({ context, routes: builtinConnectorsRoutes })(
        builtinConnectorNoAuthGrantContract,
      ).connect({
        params: { connectorSlug: "openai" },
        headers,
        body: { authMethod: "api-token", account: { intent: "add" } },
      }),
      [400],
    );
    expect(noAuth.body.error.message).toContain(
      "openai api-token auth method does not use a no-auth grant",
    );

    signIn(member);
    const listed = await accept(
      setupApp({ context, routes: builtinConnectorsRoutes })(
        builtinConnectorsMainContract,
      ).list({ headers }),
      [200],
    );
    expect(listed.body.connectors).toContainEqual(
      expect.objectContaining({
        slug: "openai",
        connectionStatus: "connected",
      }),
    );
  });

  it("connectors-manual-grant-connect-006 reconnects a CLI account in place and keeps its sibling", async () => {
    const member = newMember();
    const stranger = newMember();
    const cli = { "X-Client-Type": CLIENT_TYPE_CLI };

    const added = await accept(
      manualGrant(
        member,
        "openai",
        {
          authMethod: "api-token",
          account: { intent: "add", displayName: "Work" },
          values: { apiKey: `sk-${randomUUID()}` },
        },
        cli,
      ),
      [200],
    );
    const workId = added.body.connectionId;

    const reconnected = await accept(
      manualGrant(
        member,
        "openai",
        {
          authMethod: "api-token",
          account: { intent: "reconnect", connectionId: workId },
          values: { apiKey: `sk-${randomUUID()}` },
        },
        cli,
      ),
      [200],
    );
    expect(reconnected.body.connectionId).toBe(workId);

    const sibling = await accept(
      manualGrant(
        member,
        "openai",
        {
          authMethod: "api-token",
          account: { intent: "add", displayName: "Personal" },
          values: { apiKey: `sk-${randomUUID()}` },
        },
        cli,
      ),
      [200],
    );
    expect(sibling.body.connectionId).not.toBe(workId);

    const listed = await listAccounts(member, "openai");
    expect(
      listed.connections
        .map((connection) => {
          return connection.id;
        })
        .sort(),
    ).toStrictEqual([workId, sibling.body.connectionId].sort());

    const reconnectAttempts = [
      { actor: member, connectorSlug: "openai", connectionId: randomUUID() },
      { actor: stranger, connectorSlug: "openai", connectionId: workId },
      { actor: member, connectorSlug: "test-subdomain", connectionId: workId },
    ];
    for (const attempt of reconnectAttempts) {
      const rejected = await accept(
        manualGrant(
          attempt.actor,
          attempt.connectorSlug,
          {
            authMethod: "api-token",
            account: {
              intent: "reconnect",
              connectionId: attempt.connectionId,
            },
            values:
              attempt.connectorSlug === "openai"
                ? { apiKey: `sk-${randomUUID()}` }
                : {
                    apiToken: `token-${randomUUID()}`,
                    email: "support@example.com",
                    subdomain: "example",
                  },
          },
          cli,
        ),
        [404],
      );
      expect(rejected.body.error.message).toBe("Connector account not found");
    }

    const after = await listAccounts(member, "openai");
    expect(after.defaultConnection?.id).toBe(workId);
  });

  it("connectors-manual-grant-connect-009 removes every disconnected Test Subdomain account", async () => {
    const member = newMember();
    const connectionId = (
      await accept(
        manualGrant(member, "test-subdomain", {
          authMethod: "api-token",
          account: { intent: "add" },
          values: {
            apiToken: `token-${randomUUID()}`,
            email: "support@example.com",
            subdomain: "example",
          },
        }),
        [200],
      )
    ).body.connectionId;
    expect(connectionId).toBeTruthy();

    const before = await listAccounts(member, "test-subdomain");
    for (const connection of before.connections) {
      signIn(member);
      await accept(
        accountsClient().delete({
          headers,
          params: { connectionId: connection.id },
          body: {
            target: { kind: "builtin", connectorSlug: "test-subdomain" },
          },
        }),
        [200],
      );
    }

    const after = await listAccounts(member, "test-subdomain");
    expect(after.connections).toStrictEqual([]);
  });

  it("connectors-manual-grant-connect-010 accepts a full InsForge backend URL", async () => {
    const member = newMember();

    const response = await accept(
      manualGrant(member, "insforge", {
        authMethod: "api-token",
        account: { intent: "add" },
        values: {
          apiKey: `ik-${randomUUID()}`,
          domain: "https://9ksx253h.us-west.insforge.app/api/",
        },
      }),
      [200],
    );

    expect(Object.keys(response.body)).toStrictEqual(["connectionId"]);
    const listed = await listAccounts(member, "insforge");
    expect(listed.defaultConnection?.authMethod).toBe("api-token");
  });

  it("connectors-manual-grant-connect-012 replaces Lark app credentials and stays connected", async () => {
    const member = newMember();
    await accept(
      manualGrant(member, "lark", {
        authMethod: "api-token",
        account: { intent: "add" },
        values: { appId: "cli_old", appSecret: `old-${randomUUID()}` },
      }),
      [200],
    );

    await accept(
      manualGrant(member, "lark", {
        authMethod: "api-token",
        account: { intent: "add" },
        values: { appId: "cli_new", appSecret: `new-${randomUUID()}` },
      }),
      [200],
    );

    const listed = await listAccounts(member, "lark");
    expect(listed.defaultConnection).toMatchObject({
      authMethod: "api-token",
      connectionStatus: "connected",
      reconnectReason: null,
      tokenExpiresAt: null,
    });
  });

  it("connectors-manual-grant-connect-016 rejects an unknown field without echoing it", async () => {
    const leaked = `secret-${randomUUID()}`;

    const response = await accept(
      manualGrant(newMember(), "openai", {
        authMethod: "api-token",
        account: { intent: "add" },
        values: { apiKey: `sk-${randomUUID()}`, unknownField: leaked },
      }),
      [400],
    );

    expect(response.body.error.message).toContain("apiKey");
    expect(response.body.error.message).not.toContain("unknownField");
    expect(response.body.error.message).not.toContain(leaked);
  });

  it("connectors-manual-grant-connect-017 rejects a whitespace-only API key by its public name", async () => {
    const response = await accept(
      manualGrant(newMember(), "openai", {
        authMethod: "api-token",
        account: { intent: "add" },
        values: { apiKey: "   \n  " },
      }),
      [400],
    );

    expect(response.body.error.message).toContain("apiKey");
    expect(response.body.error.message).not.toContain("OPENAI_TOKEN");
  });

  it("connectors-manual-grant-connect-021 hides an authored-hidden Cloudflare manual grant", async () => {
    const response = await accept(
      manualGrant(newMember(), "cloudflare", {
        authMethod: "api-token",
        account: { intent: "add" },
        values: {},
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "cloudflare connector is not available",
        code: "FORBIDDEN",
      },
    });
  });

  it("connectors-manual-grant-connect-022 notifies only the member once about the new connection", async () => {
    const member = newMember();

    await addOpenAi(member);
    await flushWaitUntilForTest();

    expect(
      channelsPublishedTo(context.mocks, "connector:changed"),
    ).toStrictEqual([`user:${member.userId}`]);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "connector:changed",
      { connectorSlug: "openai" },
    );
  });

  it(
    "connectors-manual-grant-connect-008 connects Test Subdomain manual grant fields through the API",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const bdd = createBddApi(context);
      const actor = bdd.user();
      if (!actor.orgId) {
        throw new Error("Expected organization actor");
      }
      const member: Member = { userId: actor.userId, orgId: actor.orgId };
      const owner = publicRunOwner(context, actor);
      fixture.chatCallbacks.acceptChatObjectStorage();
      fixture.api.acceptStorageDownloads();
      fixture.api.acceptTelemetryIngest();
      mockOptionalEnv("OPENROUTER_API_KEY", undefined);
      fixture.chatCallbacks.disableVapid();

      const [granted] = await Promise.all([
        accept(
          manualGrant(member, "test-subdomain", {
            authMethod: "api-token",
            account: { intent: "add" },
            values: {
              apiToken: "  test-subdomain-token\n  ",
              email: "  support@example.com \n",
              subdomain: "  example \n",
            },
          }),
          [200],
        ),
        fixture.api.configureRunnerGroup(),
        owner.run(() => {
          return bdd.bootstrapLimitedFreeOnboarding(actor);
        }),
      ]);
      expect(Object.keys(granted.body)).toStrictEqual(["connectionId"]);

      const listed = await listAccounts(member, "test-subdomain");
      expect(listed.defaultConnection).toMatchObject({
        id: granted.body.connectionId,
        authMethod: "api-token",
        connectionStatus: "connected",
      });
      expect(JSON.stringify(listed)).not.toContain("test-subdomain-token");

      const launched = await owner.run(() => {
        return fixture.sendChatRun(actor, {
          prompt: "Use test-subdomain connector credentials",
          model: null,
        });
      });
      const execution = await owner.executionInput(launched.runId);
      const envMap = executionEnvironment(execution);
      expect(envMap.SUBDOMAIN_TEST_EMAIL).toBe("support@example.com");
      expect(envMap.SUBDOMAIN_TEST_SUBDOMAIN).toBe("example");

      const resolved = await createFirewallApi(context).requestFirewallAuth(
        { authorization: `Bearer ${execution.firewallToken}` },
        {
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("SUBDOMAIN_TEST_API_TOKEN")}`,
          },
          secretConnectorMap: execution.secretConnectorMap ?? undefined,
          secretConnectorMetadataMap:
            execution.secretConnectorMetadataMap ?? undefined,
        },
        [200],
      );
      expect(resolved.body.headers).toStrictEqual({
        Authorization: "Bearer test-subdomain-token",
      });
    },
  );
});
