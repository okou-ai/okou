import { mailContract } from "@okouai/api-contracts/contracts/mail";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  createConnectorBddApi,
  mockGmailConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  API_TEST_CONNECTOR_CATALOG,
  catalogWithAuthMethod,
  createPublicConnectorCatalog,
} from "./helpers/public-connector-catalog";
import { createRouteMocks } from "./helpers/route-test";
import { mailRoutes } from "../mail";

const context = testContext();

const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const connectors = createConnectorBddApi(context);
const runs = createRunsApi(context);
const mocks = createRouteMocks(context);

const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const GMAIL_DRAFT_ID = "r-test-draft";

async function seedGmailMailCardFixture() {
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped actor");
  }
  const actorWithOrg = { ...actor, orgId: actor.orgId };
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(actor, {
    displayName: "Nova Mail agent",
    visibility: "private",
  });
  const thread = await chat.createThread(actor, {
    agentId: agent.agentId,
    title: "Mail review",
  });
  mockGmailConnectorOAuth({
    accessToken: "gmail-mail-card-token",
    email: "sender@example.com",
  });
  const start = await connectors.startOauth(actor, "gmail", "oauth");
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected Gmail OAuth state");
  }
  await connectors.completeOauthCallback("gmail", {
    code: "okou-mail-code",
    state,
  });
  const gmail = await connectors.readConnectorBySlug(actor, "gmail");
  await runs.enableAgentConnectors(actor, agent.agentId, ["gmail"]);
  mocks.clerk.session(actor.userId, actorWithOrg.orgId);
  return { actor, agent, thread, gmail };
}

function client(options?: { readonly rethrowErrors?: boolean }) {
  return setupApp({ context, routes: mailRoutes, ...options })(mailContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

describe("POST /api/mail/drafts/link", () => {
  it("does not refresh a known mismatched Gmail storage version", async () => {
    const catalog = createPublicConnectorCatalog(context, { isolatePg: true });
    const versionTwo = catalogWithAuthMethod(
      { connectorSlug: "gmail", authMethodId: "oauth" },
      (method) => {
        return { ...method, storage: { ...method.storage, version: 2 } };
      },
    );
    await catalog.publish(versionTwo);
    const fixture = await seedGmailMailCardFixture();
    server.use(
      http.post("https://oauth2.googleapis.com/token", () => {
        return HttpResponse.json({
          access_token: "gmail-mail-card-token",
          refresh_token: "gmail-refresh-token",
          expires_in: 0,
          token_type: "Bearer",
          scope: GMAIL_MODIFY_SCOPE,
        });
      }),
    );
    const started = await connectors.startOauth(
      fixture.actor,
      "gmail",
      "oauth",
      undefined,
      {
        intent: "reconnect",
        connectionId: fixture.gmail.id,
      },
    );
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Expected Gmail reconnect state");
    }
    await connectors.completeOauthCallback("gmail", {
      code: "expired-version-two",
      state,
    });
    // The real OAuth response makes the token expired without a private date write.
    // Catalog publication leaves the account at version2 while selecting version1.
    await catalog.publish(API_TEST_CONNECTOR_CATALOG);
    let refreshCalls = 0;
    server.use(
      http.post("https://oauth2.googleapis.com/token", () => {
        refreshCalls += 1;
        return HttpResponse.json({
          access_token: "must-not-be-written",
          expires_in: 3600,
        });
      }),
    );

    const response = await accept(
      client().linkDraft({
        headers: authHeaders(),
        body: {
          threadId: fixture.thread.id,
          agentId: fixture.agent.agentId,
          gmailDraftId: GMAIL_DRAFT_ID,
        },
      }),
      [409],
    );
    expect(response.body.error.message).toBe(
      "Connect and authorize Gmail for this agent first",
    );
    expect(refreshCalls).toBe(0);
  });
});
