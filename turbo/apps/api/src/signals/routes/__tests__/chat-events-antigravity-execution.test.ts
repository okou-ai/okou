import { antigravityDeviceAuthContract } from "@okouai/api-contracts/contracts/antigravity-device-auth";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { antigravityDeviceAuthRoutes } from "../antigravity-device-auth";
import {
  createChatEventsFixture,
  executionEnvironment,
  requireOrgId,
} from "./helpers/chat-events-fixture";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { publicChatActor } from "./helpers/public-chat-actor";
import { createRouteMocks } from "./helpers/route-test";
import { mockSecretKmsHttp } from "./helpers/secret-kms-http";

const context = testContext();
const fixture = createChatEventsFixture(context);
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Google issues the sign-in grant once and a fresh access token per run. */
function mockGoogle() {
  const refreshes: URLSearchParams[] = [];
  server.use(
    http.post(TOKEN_URL, async ({ request }) => {
      const form = new URLSearchParams(await request.text());
      if (form.get("grant_type") === "refresh_token") {
        refreshes.push(form);
        return HttpResponse.json({
          access_token: "test-google-run-access",
          expires_in: 3599,
          token_type: "Bearer",
        });
      }
      return HttpResponse.json({
        access_token: "test-google-sign-in-access",
        refresh_token: "test-google-refresh",
        expires_in: 3599,
      });
    }),
    http.get("https://www.googleapis.com/oauth2/v1/userinfo", () => {
      return HttpResponse.json({ id: "4242", email: "pilot@gmail.com" });
    }),
  );
  return refreshes;
}

async function connectGoogleAccount(orgId: string, userId: string) {
  createRouteMocks(context).clerk.session(userId, orgId);
  const client = setupApp({ context, routes: antigravityDeviceAuthRoutes })(
    antigravityDeviceAuthContract,
  );
  const headers = { authorization: "Bearer clerk-session" };
  const started = await accept(client.start({ headers, body: {} }), [200]);
  const state = new URL(started.body.browserUrl).searchParams.get("state");
  const redirect = new URL("http://localhost:51121/oauth-callback");
  redirect.searchParams.set("state", state ?? "");
  redirect.searchParams.set("code", "4/0AeaYSHB-code");
  await accept(
    client.complete({
      headers,
      body: {
        sessionToken: started.body.sessionToken,
        authorizationCode: redirect.toString(),
      },
    }),
    [200],
  );
}

describe("Antigravity execution", () => {
  beforeEach(mockSecretKmsHttp);

  it("launches agy with the selected model and a freshly minted credential", async () => {
    mockOptionalEnv("ANTIGRAVITY_OAUTH_CLIENT_ID", "agy-client.example");
    mockOptionalEnv("ANTIGRAVITY_OAUTH_CLIENT_SECRET", "agy-client-secret");
    const refreshes = mockGoogle();
    const owned = await publicChatActor(context, {
      actor: fixture.bdd.user({ orgId: createUniqueStaffOrgIdFixture() }),
    });
    owned.ownsFeatureSwitches();
    await owned.run(async () => {
      const { actor, sendChatRun, runExecution } = owned;
      const orgId = requireOrgId(actor);
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        { [FeatureSwitchKey.GeminiAntigravity]: true },
      );
      await connectGoogleAccount(orgId, actor.userId);

      const run = await sendChatRun(actor, {
        model: "gemini-4-neon",
        prompt: "say hello from Gemini",
        runOptions: { reasoningEffort: "high" },
      });
      const { execution } = await runExecution(run.runId);

      expect(execution.cliAgentType).toBe("antigravity");
      expect(execution.piModelConfig).toBeUndefined();
      const environment = executionEnvironment(execution);
      expect(environment).toMatchObject({
        OKOU_ANTIGRAVITY_MODEL: "gemini-4-neon",
        OKOU_REASONING_EFFORT: "high",
      });
      expect(
        JSON.parse(environment.OKOU_ANTIGRAVITY_OAUTH_TOKEN ?? "null"),
      ).toMatchObject({
        access_token: "test-google-run-access",
        refresh_token: "test-google-refresh",
        token_type: "Bearer",
      });
      // The credential never resolves through firewall secret references.
      expect(execution.secretConnectorMetadataMap ?? {}).toStrictEqual({});
      expect(refreshes).toHaveLength(1);
      expect(Object.fromEntries(refreshes[0] ?? [])).toMatchObject({
        grant_type: "refresh_token",
        refresh_token: "test-google-refresh",
        client_id: "agy-client.example",
        client_secret: "agy-client-secret",
      });
    });
  });
});
