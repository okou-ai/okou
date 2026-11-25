import {
  connectorAccountsContract,
  type ConnectorAccountMutationIntent,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { mockOptionalEnv } from "../../../lib/env";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { connectorAccountRoutes } from "../connector-accounts";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockSlackConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { mockNotionConnectorOAuth } from "./helpers/api-bdd-workflows";

const context = testContext();
const api = createConnectorBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const accounts = setupApp({ context, routes: connectorAccountRoutes })(
  connectorAccountsContract,
);
type ScopedSlug = "notion" | "slack" | "hubspot";
function provider(slug: ScopedSlug, namespace?: string) {
  if (slug === "notion") {
    mockNotionConnectorOAuth({
      botId: namespace,
      ownerId: "same-notion-owner",
    });
  } else if (slug === "slack") {
    mockSlackConnectorOAuth();
    server.use(
      http.post("https://slack.com/api/oauth.v2.access", () => {
        return HttpResponse.json({
          ok: true,
          team: namespace ? { id: namespace } : undefined,
          authed_user: {
            id: "U012AB3CD",
            access_token: "xoxp-scoped-user-token",
            scope: "channels:read,chat:write",
          },
        });
      }),
    );
  } else {
    mockOptionalEnv("HUBSPOT_OAUTH_CLIENT_ID", "hubspot-client-id");
    mockOptionalEnv("HUBSPOT_OAUTH_CLIENT_SECRET", "hubspot-client-secret");
    server.use(
      http.post("https://api.hubapi.com/oauth/v1/token", () => {
        return HttpResponse.json({
          access_token: "hubspot-access-token",
          refresh_token: "hubspot-refresh-token",
        });
      }),
      http.get("https://api.hubapi.com/oauth/v1/access-tokens/:token", () => {
        return HttpResponse.json({
          user_id: 123,
          hub_id: namespace ? Number(namespace) : undefined,
          user: "owner@example.test",
        });
      }),
    );
  }
}
async function authorize(
  actor: ApiTestUser,
  slug: ScopedSlug,
  namespace?: string,
  account?: ConnectorAccountMutationIntent,
) {
  provider(slug, namespace);
  const started = await api.startOauth(actor, slug, "oauth", account);
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Missing scoped authorization state");
  }
  return await api.completeOauthCallbackResult(slug, {
    code: "scoped-authorization",
    state,
  });
}
async function connections(slug: ScopedSlug) {
  return (
    await accept(
      accounts.connections({
        headers,
        query: { kind: "builtin", connectorSlug: slug },
      }),
      [200],
    )
  ).body.connections;
}

describe.each(["notion", "slack", "hubspot"] as const)(
  "%s authorization identity",
  (slug) => {
    it("preserves different authorizations owned by the same provider user", async () => {
      const actor = createBddApi(context).user();
      expect((await authorize(actor, slug, "1001")).body.status).toBe(
        "success",
      );
      expect((await authorize(actor, slug, "1002")).body.status).toBe(
        "success",
      );
      const saved = await connections(slug);
      expect(saved).toHaveLength(2);
      expect(
        new Set(
          saved.map((account) => {
            return account.externalId;
          }),
        ).size,
      ).toBe(1);
    });

    it("rejects reconnecting a known authorization to a different workspace grant", async () => {
      const actor = createBddApi(context).user();
      await authorize(actor, slug, "1001");
      const [original] = await connections(slug);
      if (!original) {
        throw new Error("Missing original provider connection");
      }
      const replaced = await authorize(actor, slug, "1002", {
        intent: "reconnect",
        connectionId: original.id,
      });
      expect(replaced.body.status).toBe("error");
      expect(
        (await connections(slug)).map((account) => {
          return account.id;
        }),
      ).toStrictEqual([original.id]);
    });

    it("keeps grants independent when their authorization identity is unavailable", async () => {
      const actor = createBddApi(context).user();
      expect((await authorize(actor, slug)).body.status).toBe("success");
      expect((await authorize(actor, slug)).body.status).toBe("success");
      await expect(connections(slug)).resolves.toHaveLength(2);
    });
  },
);
