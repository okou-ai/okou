import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { connectorAccountRoutes } from "../connector-accounts";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGmailConnectorOAuth,
} from "./helpers/api-bdd-connectors";

const context = testContext();
const api = createConnectorBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const accounts = setupApp({ context, routes: connectorAccountRoutes })(
  connectorAccountsContract,
);

function provider(subject: string, email = "account@example.test") {
  mockGmailConnectorOAuth({
    subject,
    email,
    accessToken: `access-${subject}`,
  });
}
function state(authorizationUrl: string) {
  const value = new URL(authorizationUrl).searchParams.get("state");
  if (!value) {
    throw new Error("Missing provider state");
  }
  return value;
}
async function finish(started: {
  authorizationUrl: string;
  oauthAttemptId: string;
}) {
  const result = await api.completeOauthCallbackResult("gmail", {
    code: "authorized",
    state: state(started.authorizationUrl),
  });
  expect(result.body.status).toBe("success");
  const completed = await accept(
    accounts.oauthCompletion({
      headers,
      params: { attemptId: started.oauthAttemptId },
      query: { kind: "builtin", connectorSlug: "gmail" },
    }),
    [200],
  );
  return completed.body.connectionId;
}
async function connect(actor: ApiTestUser) {
  return await finish(await api.startOauth(actor, "gmail", "oauth"));
}
async function list() {
  return (
    await accept(
      accounts.connections({
        headers,
        query: { kind: "builtin", connectorSlug: "gmail" },
      }),
      [200],
    )
  ).body;
}

describe("provider account identity on Add account", () => {
  it("reuses gmail identity and policy while replacing authorized account metadata", async () => {
    const actor = createBddApi(context).user();
    provider("same-subject", "before@example.test");
    const first = await connect(actor);
    await accept(
      accounts.rename({
        headers,
        params: { connectionId: first },
        body: {
          target: { kind: "builtin", connectorSlug: "gmail" },
          displayName: "Work mailbox",
        },
      }),
      [200],
    );
    provider("same-subject", "after@example.test");
    const second = await connect(actor);
    expect(second).toBe(first);
    const saved = await list();
    expect(saved.connections).toHaveLength(1);
    expect(saved.defaultConnection?.id).toBe(first);
    expect(saved.connections[0]).toMatchObject({
      id: first,
      displayName: "Work mailbox",
      externalId: "same-subject",
      externalEmail: "after@example.test",
      connectionStatus: "connected",
    });
  });

  it("does not merge different provider subjects with the same email", async () => {
    const actor = createBddApi(context).user();
    provider("first-subject");
    const first = await connect(actor);
    provider("second-subject");
    const second = await connect(actor);
    expect(second).not.toBe(first);
    expect((await list()).connections).toHaveLength(2);
  });

  it("deduplicates overlapping first and sibling consent (existing default=true)", async () => {
    const actor = createBddApi(context).user();
    provider("default-subject");
    await connect(actor);
    provider("overlapping-subject");
    const starts = await Promise.all([
      api.startOauth(actor, "gmail", "oauth"),
      api.startOauth(actor, "gmail", "oauth"),
    ]);
    const ids = await Promise.all(
      starts.map(async (started) => {
        return await finish(started);
      }),
    );
    expect(new Set(ids).size).toBe(1);
    const saved = await list();
    expect(saved.connections).toHaveLength(2);
    expect(
      saved.connections.filter((account) => {
        return account.externalId === "overlapping-subject";
      }),
    ).toHaveLength(1);
  });

  it("keeps a provider account separate for each workspace member", async () => {
    const owner = createBddApi(context).user();
    const peer = createBddApi(context).user({ orgId: owner.orgId });
    provider("shared-provider-subject");
    const original = await connect(owner);
    const other = await connect(peer);
    expect(other).not.toBe(original);
    expect((await list()).connections).toHaveLength(1);
  });
});
