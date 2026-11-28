import { randomUUID } from "node:crypto";
import { modelCatalogContract } from "@okouai/api-contracts/contracts/model-catalog";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { modelCatalogRoutes } from "../model-catalog";
import { createBddApi } from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import { createRunExecutionCredentials } from "./helpers/run-execution-credentials";

const context = testContext();
const app = setupApp({ context, routes: modelCatalogRoutes });
const bdd = createBddApi(context);
const credentials = createRunExecutionCredentials(context, {
  preferences: false,
});
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

describe("GET /api/model-catalog", () => {
  it("model-catalog-001 returns only fixed Auto without a personal subscription", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    createRouteMocks(context).clerk.session(userId, orgId);

    const response = await accept(
      app(modelCatalogContract).get({ headers }),
      [200],
    );

    expect(response.body.systemDefaultModel).toBe("auto");
    expect(response.body.models).toContainEqual(
      expect.objectContaining({
        model: "auto",
        displayName: "Auto",
      }),
    );
    const builtInRoutes = response.body.routes.filter((route) => {
      return route.providerType === "built-in";
    });
    expect(builtInRoutes).toHaveLength(1);
    expect(builtInRoutes[0]).toMatchObject({
      model: "auto",
      providerType: "built-in",
      concreteProviderType: "openrouter-codex",
      upstreamModel: "@preset/okou-1-0",
    });
  });

  it(
    "model-catalog-002 allows authenticated okou tokens to read the catalog",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const member = bdd.user({ orgRole: "org:member" });
      const token = await credentials.okouToken(member);

      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        {
          data: [{ role: "org:member", organization: { id: member.orgId } }],
        },
      );

      const response = await accept(
        app(modelCatalogContract).get({
          headers: { authorization: `Bearer ${token}` },
        }),
        [200],
      );

      expect(response.body.models).toContainEqual(
        expect.objectContaining({
          model: response.body.systemDefaultModel,
          displayName: "Auto",
        }),
      );
      expect(response.body.routes.length).toBeGreaterThan(0);
    },
  );

  it(
    "model-catalog-005 rejects an agent token whose user is no longer an organization member",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const admin = bdd.user({ orgRole: "org:admin" });
      const member = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
      const token = await credentials.okouToken(member);

      await credentials.removeMember(member, admin);
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });

      const response = await accept(
        app(modelCatalogContract).get({
          headers: { authorization: `Bearer ${token}` },
        }),
        [401],
      );

      expect(response.status).toBe(401);
    },
  );
});

describe("public selections of replaced models", () => {
  it("model-catalog-008 rejects an explicitly requested replacement whose subscription was never connected", async () => {
    const actor = bdd.user();
    const runs = createRunsApi(context);
    const chat = createChatFilesBddApi(context);
    mockClaudeCodeTokenEndpoint();
    await Promise.all([
      runs.grantProEntitlement(actor),
      runs.createPersonalModelProvider(actor, {
        type: "claude-code-oauth-token",
        secret: `claude-token-${randomUUID()}`,
      }),
    ]);

    const thread = await chat.createThread(actor, { model: null });
    const eventsBefore = await chat.listThreadEvents(actor, thread.id);

    const rejected = await chat.requestSendEvent(
      actor,
      {
        threadId: thread.id,
        prompt: "Use retired GPT 5.5",
        model: "gpt-5.5",
      },
      [400],
    );
    const [eventsAfter, metadata] = await Promise.all([
      chat.listThreadEvents(actor, thread.id),
      chat.readThreadMetadata(actor, thread.id),
    ]);

    expect(rejected.body).toMatchObject({
      error: {
        message:
          "GPT 5.5 was replaced by GPT 6 Luna, which requires a Codex subscription. Select Auto or connect your Codex subscription.",
      },
    });
    expect(eventsAfter).toStrictEqual(eventsBefore);
    expect(metadata.selectedModel).toBe("auto");
  });
});
