import { antigravityDeviceAuthContract } from "@okouai/api-contracts/contracts/antigravity-device-auth";
import { ANTIGRAVITY_FIREWALL_PLACEHOLDER } from "@okouai/api-contracts/contracts/model-provider-firewalls";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { VOICE_TRANSCRIPTION_MODEL } from "@okouai/api-contracts/contracts/voice-clips";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { antigravityDeviceAuthRoutes } from "../antigravity-device-auth";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import {
  createChatEventsFixture,
  executionEnvironment,
  requireOrgId,
} from "./helpers/chat-events-fixture";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { publicChatActor } from "./helpers/public-chat-actor";
import { createRouteMocks } from "./helpers/route-test";
import { mockSecretKmsHttp } from "./helpers/secret-kms-http";
import { installSharedThreadStorage } from "./helpers/shared-thread-storage";

const context = testContext();
const fixture = createChatEventsFixture(context);
const firewall = createFirewallApi(context);
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Google issues the sign-in grant once and a fresh access token for the trusted request. */
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

  it("launches agy with placeholders and resolves the access token at the firewall", async () => {
    mockOptionalEnv("ANTIGRAVITY_OAUTH_CLIENT_ID", "agy-client.example");
    mockOptionalEnv("ANTIGRAVITY_OAUTH_CLIENT_SECRET", "agy-client-secret");
    const refreshes = mockGoogle();
    const owned = await publicChatActor(context, {
      actor: fixture.bdd.user({ orgId: createUniqueStaffOrgIdFixture() }),
      optionalEnvironmentNames: [
        "ANTIGRAVITY_OAUTH_CLIENT_ID",
        "ANTIGRAVITY_OAUTH_CLIENT_SECRET",
      ],
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
      const token = {
        access_token: ANTIGRAVITY_FIREWALL_PLACEHOLDER,
        refresh_token: "okou-antigravity-local-refresh-placeholder",
        token_type: "Bearer",
      };
      // agy reads the nested token and personal-account auth method; the
      // guest validates the top-level token fields.
      expect(
        JSON.parse(environment.OKOU_ANTIGRAVITY_OAUTH_TOKEN ?? "null"),
      ).toMatchObject({
        ...token,
        token,
        auth_method: "consumer",
      });
      expect(refreshes).toHaveLength(0);
      expect(JSON.stringify(execution)).not.toContain("test-google-refresh");
      expect(execution.secretConnectorMetadataMap ?? {}).toStrictEqual({});
      expect(execution.firewalls).toContainEqual({
        kind: "builtin",
        name: "model-provider:antigravity",
      });
      const headers = { authorization: `Bearer ${execution.firewallToken}` };
      const authHeaders = {
        Authorization: `Bearer ${secretTemplate("ANTIGRAVITY_ACCESS_TOKEN")}`,
      };
      const result = await firewall.requestFirewallAuth(
        headers,
        { authHeaders },
        [200],
      );
      expect(result.body).toMatchObject({
        headers: { Authorization: "Bearer test-google-run-access" },
        expiresAt: expect.any(Number),
      });
      expect(JSON.stringify(result.body)).not.toContain("test-google-refresh");
      expect(refreshes).toHaveLength(1);
      expect(Object.fromEntries(refreshes[0] ?? [])).toMatchObject({
        grant_type: "refresh_token",
        refresh_token: "test-google-refresh",
        client_id: "agy-client.example",
        client_secret: "agy-client-secret",
      });

      const denied = await firewall.requestFirewallAuth(
        headers,
        { authHeaders, authBase: secretTemplate("ANTIGRAVITY_ACCESS_TOKEN") },
        [424],
      );
      expect(denied.status).toBe(424);
      expect(refreshes).toHaveLength(1);
    });
  });

  it("prompts antigravity runs to run okou transcribe silently across initial and steered voice inputs", async () => {
    mockOptionalEnv("ANTIGRAVITY_OAUTH_CLIENT_ID", "agy-client.example");
    mockOptionalEnv("ANTIGRAVITY_OAUTH_CLIENT_SECRET", "agy-client-secret");
    mockGoogle();
    const owned = await publicChatActor(context, {
      actor: fixture.bdd.user({ orgId: createUniqueStaffOrgIdFixture() }),
      optionalEnvironmentNames: [
        "ANTIGRAVITY_OAUTH_CLIENT_ID",
        "ANTIGRAVITY_OAUTH_CLIENT_SECRET",
      ],
    });
    owned.ownsFeatureSwitches();
    await owned.run(async () => {
      const { actor, sendChatRun, requestSendEvent, runExecution } = owned;
      const orgId = requireOrgId(actor);
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        { [FeatureSwitchKey.GeminiAntigravity]: true },
      );
      await connectGoogleAccount(orgId, actor.userId);
      installSharedThreadStorage(context);

      createRouteMocks(context).clerk.session(actor.userId, orgId);
      const uploads = setupApp({
        context,
        routes: [...uploadsPrepareRoutes, ...uploadsCompleteRoutes],
      })(uploadsContract);
      const uploadVoiceClip = async (label: string) => {
        const audio = `${label}-audio-bytes`.repeat(4);
        const headers = { authorization: "Bearer clerk-session" };
        const { body } = await accept(
          uploads.preparePrivate({
            headers,
            body: {
              filename: `${label}.wav`,
              contentType: "audio/wav",
              size: audio.length,
            },
          }),
          [200],
        );
        if (!("uploadUrl" in body)) {
          throw new Error("Expected direct upload");
        }
        expect(
          (
            await fetch(body.uploadUrl, {
              method: "PUT",
              headers: body.uploadHeaders,
              body: audio,
            })
          ).status,
        ).toBe(200);
        await accept(
          uploads.complete({ headers, body: { id: body.id } }),
          [200],
        );
        return body.id;
      };

      const clip1 = await uploadVoiceClip("clip1");
      const clip2 = await uploadVoiceClip("clip2");
      const steerClip = await uploadVoiceClip("steer");

      const run = await sendChatRun(actor, {
        model: "gemini-4-neon",
        prompt: "[Voice message]",
        userMessage: {
          version: 1,
          parts: [
            { type: "voice", clips: [{ fileId: clip1 }, { fileId: clip2 }] },
          ],
        },
      });
      const { execution } = await runExecution(run.runId);

      expect(execution.cliAgentType).toBe("antigravity");
      expect(executionEnvironment(execution)).toMatchObject({
        OKOU_ANTIGRAVITY_MODEL: "gemini-4-neon",
      });
      expect(execution.prompt).toContain(
        `okou transcribe ${VOICE_TRANSCRIPTION_MODEL} --file-id ${clip1} --file-id ${clip2}`,
      );
      expect(execution.prompt).toContain(
        "before sending any visible reply or progress update",
      );
      expect(execution.appendSystemPrompt).toContain("# Conversation Guidance");

      // Queue a voice message while the Antigravity run is active and verify
      // mid-turn steering uses the same voice command and silent-first guidance.
      await requestSendEvent(
        actor,
        {
          threadId: run.threadId,
          prompt: "[Voice message]",
          userMessage: {
            version: 1,
            parts: [{ type: "voice", clips: [{ fileId: steerClip }] }],
          },
        },
        [201],
      );
      const steered = await fixture.api.nextSteerableInput(
        execution.sandboxToken,
        run.runId,
      );
      if (!steered.input) {
        throw new Error("Expected steered voice input");
      }
      expect(steered.input.prompt).toContain(
        `okou transcribe ${VOICE_TRANSCRIPTION_MODEL} --file-id ${steerClip}`,
      );
      expect(steered.input.prompt).toContain(
        "before sending any visible reply or progress update",
      );
      await expect(
        fixture.api.declareSteeredInput(
          execution.sandboxToken,
          run.runId,
          steered.input.eventId,
        ),
      ).resolves.toStrictEqual({ outcome: "steered" });
    });
  });
});
