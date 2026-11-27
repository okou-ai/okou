import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
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
  mockGmailConnectorOAuth,
  mockGoogleDriveConnectorOAuth,
} from "./helpers/api-bdd-connectors";

const context = testContext();
const api = createConnectorBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const accounts = setupApp({ context, routes: connectorAccountRoutes })(
  connectorAccountsContract,
);

type Slug = "gmail" | "google-drive" | "webflow";
function provider(slug: Slug, subject: string, email = "account@example.test") {
  if (slug === "gmail") {
    mockGmailConnectorOAuth({
      subject,
      email,
      accessToken: `access-${subject}`,
    });
  } else {
    mockGoogleDriveConnectorOAuth({
      userInfo: { id: subject, email, name: email },
    });
  }
}
function state(authorizationUrl: string) {
  const value = new URL(authorizationUrl).searchParams.get("state");
  if (!value) {
    throw new Error("Missing provider state");
  }
  return value;
}
async function finish(
  slug: Slug,
  started: { authorizationUrl: string; oauthAttemptId: string },
) {
  const result = await api.completeOauthCallbackResult(slug, {
    code: "authorized",
    state: state(started.authorizationUrl),
  });
  expect(result.body.status).toBe("success");
  const completed = await accept(
    accounts.oauthCompletion({
      headers,
      params: { attemptId: started.oauthAttemptId },
      query: { kind: "builtin", connectorSlug: slug },
    }),
    [200],
  );
  return completed.body.connectionId;
}
async function connect(actor: ApiTestUser, slug: Slug) {
  return await finish(slug, await api.startOauth(actor, slug, "oauth"));
}
async function list(slug: Slug) {
  return (
    await accept(
      accounts.connections({
        headers,
        query: { kind: "builtin", connectorSlug: slug },
      }),
      [200],
    )
  ).body;
}

describe("provider account identity on Add account", () => {
  it.each(["unavailable", "missing"] as const)(
    "keeps Webflow accounts independent when provider identity is %s",
    async (identity) => {
      const actor = createBddApi(context).user();
      mockOptionalEnv("WEBFLOW_OAUTH_CLIENT_ID", "webflow-client-id");
      mockOptionalEnv("WEBFLOW_OAUTH_CLIENT_SECRET", "webflow-client-secret");
      server.use(
        http.post("https://api.webflow.com/oauth/access_token", () => {
          return HttpResponse.json({ access_token: "webflow-access-token" });
        }),
        http.get("https://api.webflow.com/v2/token/authorized_by", () => {
          return identity === "unavailable"
            ? HttpResponse.json({}, { status: 503 })
            : HttpResponse.json({ email: "shared@example.test" });
        }),
      );
      const first = await connect(actor, "webflow");
      const second = await connect(actor, "webflow");
      expect(second).not.toBe(first);
      expect((await list("webflow")).connections).toHaveLength(2);
    },
  );
  it.each(["gmail", "google-drive"] as const)(
    "reuses %s identity and policy while replacing authorized account metadata",
    async (slug) => {
      const actor = createBddApi(context).user();
      provider(slug, "same-subject", "before@example.test");
      const first = await connect(actor, slug);
      await accept(
        accounts.rename({
          headers,
          params: { connectionId: first },
          body: {
            target: { kind: "builtin", connectorSlug: slug },
            displayName: "Work mailbox",
          },
        }),
        [200],
      );
      provider(slug, "same-subject", "after@example.test");
      const second = await connect(actor, slug);
      expect(second).toBe(first);
      const saved = await list(slug);
      expect(saved.connections).toHaveLength(1);
      expect(saved.defaultConnection?.id).toBe(first);
      expect(saved.connections[0]).toMatchObject({
        id: first,
        displayName: "Work mailbox",
        externalId: "same-subject",
        externalEmail: "after@example.test",
        connectionStatus: "connected",
      });
    },
  );

  it("does not merge different provider subjects with the same email", async () => {
    const actor = createBddApi(context).user();
    provider("gmail", "first-subject");
    const first = await connect(actor, "gmail");
    provider("gmail", "second-subject");
    const second = await connect(actor, "gmail");
    expect(second).not.toBe(first);
    expect((await list("gmail")).connections).toHaveLength(2);
  });

  it.each([false, true])(
    "deduplicates overlapping first and sibling consent (existing default=%s)",
    async (existingDefault) => {
      const actor = createBddApi(context).user();
      if (existingDefault) {
        provider("gmail", "default-subject");
        await connect(actor, "gmail");
      }
      provider("gmail", "overlapping-subject");
      const starts = await Promise.all([
        api.startOauth(actor, "gmail", "oauth"),
        api.startOauth(actor, "gmail", "oauth"),
      ]);
      const ids = await Promise.all(
        starts.map(async (started) => {
          return await finish("gmail", started);
        }),
      );
      expect(new Set(ids).size).toBe(1);
      const saved = await list("gmail");
      expect(saved.connections).toHaveLength(existingDefault ? 2 : 1);
      expect(
        saved.connections.filter((account) => {
          return account.externalId === "overlapping-subject";
        }),
      ).toHaveLength(1);
    },
  );

  it("keeps a provider account separate for each workspace member", async () => {
    const owner = createBddApi(context).user();
    const peer = createBddApi(context).user({ orgId: owner.orgId });
    provider("gmail", "shared-provider-subject");
    const original = await connect(owner, "gmail");
    const other = await connect(peer, "gmail");
    expect(other).not.toBe(original);
    expect((await list("gmail")).connections).toHaveLength(1);
  });
  it("does not resurrect a deleted connection identity on later consent", async () => {
    const actor = createBddApi(context).user();
    provider("gmail", "returning-subject");
    const first = await connect(actor, "gmail");
    const [, nextStart] = await Promise.all([
      accept(
        accounts.delete({
          headers,
          params: { connectionId: first },
          body: { target: { kind: "builtin", connectorSlug: "gmail" } },
        }),
        [200],
      ),
      api.startOauth(actor, "gmail", "oauth"),
    ]);
    const second = await finish("gmail", nextStart);
    expect(second).not.toBe(first);
    expect((await list("gmail")).connections).toHaveLength(1);
  });
});
