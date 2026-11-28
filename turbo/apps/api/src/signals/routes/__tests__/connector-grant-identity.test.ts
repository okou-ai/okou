import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);

/** Each token exchange hands out the next workspace grant for the same provider user. */
function grantSequence(grants: readonly string[]) {
  let index = 0;
  return () => {
    const grant = grants[Math.min(index, grants.length - 1)];
    index += 1;
    if (!grant) {
      throw new Error("Expected a provider grant");
    }
    return grant;
  };
}

function mockNotion(grants: readonly string[]) {
  mockOptionalEnv("NOTION_OAUTH_CLIENT_ID", "notion-client-id");
  mockOptionalEnv("NOTION_OAUTH_CLIENT_SECRET", "notion-client-secret");
  const next = grantSequence(grants);
  server.use(
    http.post("https://api.notion.com/v1/oauth/token", () => {
      const bot = next();
      return HttpResponse.json({
        access_token: `notion-access-${bot}`,
        refresh_token: `notion-refresh-${bot}`,
        bot_id: bot,
        owner: {
          user: {
            id: "notion-user-1",
            name: "Notion Owner",
            person: { email: "owner@example.test" },
          },
        },
      });
    }),
  );
}

function mockSlack(teams: readonly string[]) {
  mockOptionalEnv("SLACK_OAUTH_CLIENT_ID", "slack-client-id");
  mockOptionalEnv("SLACK_OAUTH_CLIENT_SECRET", "slack-client-secret");
  const next = grantSequence(teams);
  server.use(
    http.post("https://slack.com/api/oauth.v2.access", () => {
      const team = next();
      return HttpResponse.json({
        ok: true,
        team: { id: team },
        authed_user: {
          id: "U0SAMEUSER",
          access_token: `xoxp-${team}`,
          scope: "channels:read,chat:write",
        },
      });
    }),
    http.get("https://slack.com/api/users.info", () => {
      return HttpResponse.json({
        ok: true,
        user: {
          id: "U0SAMEUSER",
          name: "slackowner",
          real_name: "Slack Owner",
          profile: { email: "owner@example.test" },
        },
      });
    }),
  );
}

function mockHubSpot(hubs: readonly number[]) {
  mockOptionalEnv("HUBSPOT_OAUTH_CLIENT_ID", "hubspot-client-id");
  mockOptionalEnv("HUBSPOT_OAUTH_CLIENT_SECRET", "hubspot-client-secret");
  let index = 0;
  server.use(
    http.post("https://api.hubapi.com/oauth/v1/token", () => {
      const hub = hubs[Math.min(index, hubs.length - 1)];
      index += 1;
      return HttpResponse.json({
        access_token: `hubspot-access-${String(hub)}`,
        refresh_token: `hubspot-refresh-${String(hub)}`,
        expires_in: 1800,
      });
    }),
    http.get(
      "https://api.hubapi.com/oauth/v1/access-tokens/:accessToken",
      ({ params }) => {
        return HttpResponse.json({
          user_id: 4242,
          hub_id: Number(
            String(params.accessToken).slice("hubspot-access-".length),
          ),
          user: "owner@example.test",
          hub_domain: "example.hubspot.test",
        });
      },
    ),
  );
}

async function authorize(
  owner: ApiTestUser,
  slug: ConnectorSlug,
  account?: ConnectorAccountMutationIntent,
) {
  const started = await connectors.startOauth(owner, slug, "oauth", account);
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected OAuth state");
  }
  const response = await connectors.completeOauthCallbackResult(slug, {
    code: `code-${state.slice(0, 8)}`,
    state,
  });
  return response.body.status;
}

async function addsTwoGrantsForOneUser(slug: ConnectorSlug) {
  const owner = bdd.user();

  await expect(authorize(owner, slug)).resolves.toBe("success");
  await expect(authorize(owner, slug)).resolves.toBe("success");

  const accounts = await connectors.listBuiltinConnectorAccounts(owner, slug);
  expect(accounts).toHaveLength(2);
  expect(accounts[0]?.externalId).toBeTruthy();
  expect(accounts[1]?.externalId).toBe(accounts[0]?.externalId);
}

async function rejectsReconnectToAnotherGrant(slug: ConnectorSlug) {
  const owner = bdd.user();
  await expect(authorize(owner, slug)).resolves.toBe("success");
  const original = await connectors.readDefaultBuiltinAccount(owner, slug);

  await expect(
    authorize(owner, slug, {
      intent: "reconnect",
      connectionId: original.id,
    }),
  ).resolves.toBe("error");

  const accounts = await connectors.listBuiltinConnectorAccounts(owner, slug);
  expect(
    accounts.map((account) => {
      return account.id;
    }),
  ).toStrictEqual([original.id]);
}

describe("slack authorization identity", () => {
  it("connector-grant-identity-004 keeps two Slack team grants of the same user", async () => {
    mockSlack(["T0TEAMA", "T0TEAMB"]);

    await expect(addsTwoGrantsForOneUser("slack")).resolves.toBeUndefined();
  });

  it("connector-grant-identity-005 rejects a Slack reconnect to another team grant", async () => {
    mockSlack(["T0TEAMA", "T0TEAMB"]);

    await expect(
      rejectsReconnectToAnotherGrant("slack"),
    ).resolves.toBeUndefined();
  });

  it("pf-061 reuses the same Slack team grant on repeated Add account authorization", async () => {
    mockSlack(["T0TEAMA", "T0TEAMA"]);
    const owner = bdd.user();

    await expect(authorize(owner, "slack")).resolves.toBe("success");
    const first = await connectors.readDefaultBuiltinAccount(owner, "slack");
    await expect(authorize(owner, "slack")).resolves.toBe("success");

    const accounts = await connectors.listBuiltinConnectorAccounts(
      owner,
      "slack",
    );
    expect(
      accounts.map((account) => {
        return account.id;
      }),
    ).toStrictEqual([first.id]);
  });
});

describe("notion authorization identity", () => {
  it("connector-grant-identity-001 keeps two Notion workspace grants of the same user", async () => {
    mockNotion(["bot-workspace-a", "bot-workspace-b"]);

    await expect(addsTwoGrantsForOneUser("notion")).resolves.toBeUndefined();
  });

  it("connector-grant-identity-002 rejects a Notion reconnect to another workspace grant", async () => {
    mockNotion(["bot-workspace-a", "bot-workspace-b"]);

    await expect(
      rejectsReconnectToAnotherGrant("notion"),
    ).resolves.toBeUndefined();
  });
});

describe("hubspot authorization identity", () => {
  it("connector-grant-identity-007 keeps two HubSpot account grants of the same user", async () => {
    mockHubSpot([1001, 1002]);

    await expect(addsTwoGrantsForOneUser("hubspot")).resolves.toBeUndefined();
  });
});
