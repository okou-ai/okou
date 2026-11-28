import { randomUUID } from "node:crypto";
import { antigravityDeviceAuthContract } from "@okouai/api-contracts/contracts/antigravity-device-auth";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import {
  runsByIdContract,
  runsCancelContract,
} from "@okouai/api-contracts/contracts/run-routes";
import {
  runnersHeartbeatContract,
  runnersSteerContract,
} from "@okouai/api-contracts/contracts/runners";
import {
  webhookClerkContract,
  webhookCompleteContract,
  webhookStripeContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { env, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { settleIncludingAbort } from "../../utils";
import { antigravityDeviceAuthRoutes } from "../antigravity-device-auth";
import { chatEventsRoutes } from "../chat-events";
import { featureSwitchesRoutes } from "../feature-switches";
import { runnersRoutes } from "../runners";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { deliverOrganizationCreated } from "./helpers/api-bdd-webhooks";
import {
  createChatEventsFixture,
  executionEnvironment,
  requireOrgId,
} from "./helpers/chat-events-fixture";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/feature-switches";
import { publicRunOwner } from "./helpers/public-run-owner";
import { createRouteMocks } from "./helpers/route-test";
import { mockSecretKmsHttp } from "./helpers/secret-kms-http";
import {
  generatedStripeCustomerId,
  generatedStripeSubscriptionId,
  postSubscriptionInvoicePaid,
} from "./helpers/stripe-billing-webhook";

const context = testContext();
const fixture = createChatEventsFixture(context);
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const antigravityDeviceAuthApi = setupApp({
  context,
  routes: antigravityDeviceAuthRoutes,
})(antigravityDeviceAuthContract);
const chatEventsApi = setupApp({
  context,
  routes: chatEventsRoutes,
})(chatEventsContract);
const featureSwitchesApi = setupApp({
  context,
  routes: featureSwitchesRoutes,
})(featureSwitchesContract);
const runnersHeartbeatApi = setupApp({
  context,
  routes: runnersRoutes,
})(runnersHeartbeatContract);
const runnersSteerApi = setupApp({
  context,
  routes: runnersRoutes,
})(runnersSteerContract);
const runsByIdApi = setupApp({
  context,
  routes: runsRoutes,
})(runsByIdContract);
const runsCancelApi = setupApp({
  context,
  routes: runsCancelRoutes,
})(runsCancelContract);
const webhooksAgentCompleteApi = setupApp({
  context,
  routes: webhooksAgentCompleteRoutes,
})(webhookCompleteContract);
const webhooksClerkApi = setupApp({
  context,
  routes: webhooksClerkRoutes,
})(webhookClerkContract);
const webhooksStripeApi = setupApp({
  context,
  routes: webhooksStripeRoutes,
})(webhookStripeContract);

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
  const headers = { authorization: "Bearer clerk-session" };
  const started = await accept(
    antigravityDeviceAuthApi.start({ headers, body: {} }),
    [200],
  );
  const state = new URL(started.body.browserUrl).searchParams.get("state");
  const redirect = new URL("http://localhost:51121/oauth-callback");
  redirect.searchParams.set("state", state ?? "");
  redirect.searchParams.set("code", "4/0AeaYSHB-code");
  await accept(
    antigravityDeviceAuthApi.complete({
      headers,
      body: {
        sessionToken: started.body.sessionToken,
        authorizationCode: redirect.toString(),
      },
    }),
    [200],
  );
}

function prepareAntigravityMember() {
  mockOptionalEnv("ANTIGRAVITY_OAUTH_CLIENT_ID", "agy-client.example");
  mockOptionalEnv("ANTIGRAVITY_OAUTH_CLIENT_SECRET", "agy-client-secret");
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  const refreshes = mockGoogle();
  const storage = fixture.chatCallbacks.acceptChatObjectStorage();
  fixture.api.acceptStorageDownloads();
  fixture.api.acceptTelemetryIngest();
  fixture.chatCallbacks.disableVapid();
  const actor = fixture.bdd.user({
    orgId: createUniqueStaffOrgIdFixture(),
  });
  const orgId = requireOrgId(actor);
  const owner = publicRunOwner(context, actor, {
    afterRuns: () => {
      return deleteFeatureSwitchesForUser(context, { ...actor, orgId });
    },
  });
  const provision = async () => {
    const periodEnd = nowDate();
    periodEnd.setTime(now() + 30 * 24 * 60 * 60 * 1000);
    await Promise.all([
      fixture.api.configureRunnerGroup(),
      deliverOrganizationCreated(context, actor),
      postSubscriptionInvoicePaid(context.signal, {
        orgId,
        userId: actor.userId,
        tier: "pro",
        customerId: generatedStripeCustomerId(),
        subscriptionId: generatedStripeSubscriptionId(),
        currentPeriodEnd: periodEnd,
      }),
      (async () => {
        await updateFeatureSwitchesForUser(
          context,
          { ...actor, orgId },
          { [FeatureSwitchKey.GeminiAntigravity]: true },
        );
        await connectGoogleAccount(orgId, actor.userId);
      })(),
    ]);
  };
  return { actor, orgId, owner, provision, refreshes, storage };
}

describe("Antigravity execution", () => {
  beforeAll(async () => {
    const previousClerkSecret = optionalEnv("CLERK_WEBHOOK_SIGNING_SECRET");
    const previousStripeSecret = optionalEnv("STRIPE_WEBHOOK_SECRET");
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_warmup");
    mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_warmup");
    context.mocks.clerk.verifyWebhook.mockRejectedValueOnce(
      new Error("warmup"),
    );
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const warmupId = randomUUID();
    const warmed = await settleIncludingAbort(async () => {
      await Promise.all([
        accept(webhooksClerkApi.post({ body: "{}", extraHeaders: {} }), [401]),
        accept(webhooksStripeApi.post({ body: "{}", extraHeaders: {} }), [401]),
        accept(
          antigravityDeviceAuthApi.start({ headers: {}, body: {} }),
          [401],
        ),
        accept(
          antigravityDeviceAuthApi.complete({
            headers: {},
            body: { sessionToken: "warmup", authorizationCode: "warmup" },
          }),
          [401],
        ),
        accept(
          featureSwitchesApi.update({
            headers: {},
            body: { switches: { [FeatureSwitchKey.GeminiAntigravity]: true } },
          }),
          [401],
        ),
        accept(
          chatEventsApi.send({
            headers: {},
            body: {
              prompt: "warmup",
              hasTextContent: true,
              clientEventId: randomUUID(),
              userMessage: {
                version: 1,
                parts: [{ type: "text", text: "warmup" }],
              },
            },
          }),
          [401],
        ),
        accept(
          runnersHeartbeatApi.heartbeat({
            headers: {},
            body: {
              runnerId: warmupId,
              runnerHostname: `runner-${warmupId}.okou.app`,
              group: "vm0/warmup",
              snapshotGeneration: 1,
              snapshotSequence: 1,
              totalVcpu: 8,
              totalMemoryMb: 16_384,
              maxConcurrent: 2,
              allocatedVcpu: 0,
              allocatedMemoryMb: 0,
              runningCount: 0,
              admittableProfiles: ["vm0/default"],
              heldSandboxStates: [],
              heldHomeStates: [],
              activeReuseProducers: [],
              mode: "running",
              ingressServiceActive: true,
            },
          }),
          [401],
        ),
        accept(
          runnersSteerApi.next({
            headers: {},
            params: { runId: warmupId },
          }),
          [401],
        ),
        accept(
          runnersSteerApi.steered({
            headers: {},
            params: { runId: warmupId, eventId: warmupId },
            body: {},
          }),
          [401],
        ),
        accept(
          runsByIdApi.getById({ headers: {}, params: { id: warmupId } }),
          [401],
        ),
        accept(
          runsCancelApi.cancel({ headers: {}, params: { id: warmupId } }),
          [401],
        ),
        accept(
          webhooksAgentCompleteApi.complete({
            headers: {},
            body: { runId: warmupId, exitCode: 0 },
          }),
          [401],
        ),
        fixture.chat.requestPrepareUpload(
          null,
          { filename: "warmup.wav", contentType: "audio/wav", size: 8 },
          [401],
        ),
        fixture.chat.requestCompleteUpload(null, { id: warmupId }, [401]),
      ]);
    });
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", previousClerkSecret);
    mockOptionalEnv("STRIPE_WEBHOOK_SECRET", previousStripeSecret);
    if (!warmed.ok) {
      throw warmed.error;
    }
  });

  beforeEach(mockSecretKmsHttp);

  it(
    "pf-049 launches agy with the selected model and a freshly minted credential",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, owner, provision, refreshes } = prepareAntigravityMember();
      await owner.run(async () => {
        await provision();
        const run = await fixture.sendChatRun(actor, {
          model: "gemini-4-neon",
          prompt: "say hello from Gemini",
          runOptions: { reasoningEffort: "high" },
        });
        const { execution } = await fixture.runExecution(run.runId);
        owner.rememberExecution(run.runId, execution.sandboxToken);

        expect(execution.cliAgentType).toBe("antigravity");
        expect(execution.piModelConfig).toBeUndefined();
        const environment = executionEnvironment(execution);
        expect(environment).toMatchObject({
          OKOU_ANTIGRAVITY_MODEL: "gemini-4-neon",
          OKOU_REASONING_EFFORT: "high",
        });
        const token = {
          access_token: "test-google-run-access",
          refresh_token: "test-google-refresh",
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
        // The credential never resolves through firewall secret references.
        expect(execution.secretConnectorMetadataMap ?? {}).toStrictEqual({});
        expect(Object.fromEntries(refreshes[0] ?? [])).toMatchObject({
          grant_type: "refresh_token",
          refresh_token: "test-google-refresh",
          client_id: "agy-client.example",
          client_secret: "agy-client-secret",
        });
      });
    },
  );

  it(
    "pf-169 instructs antigravity runs to download and read voice clips natively across initial and steered inputs",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const privateBucket = env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME");
      if (!privateBucket) {
        throw new Error("Expected R2_PRIVATE_ARTIFACTS_BUCKET_NAME");
      }
      const { actor, owner, provision, storage } = prepareAntigravityMember();
      await owner.run(async () => {
        await provision();
        const uploadVoiceClip = async (filename: string, payload: string) => {
          const bytes = Buffer.from(payload, "utf8");
          const prepared = await fixture.chat.prepareUpload(actor, {
            filename,
            contentType: "audio/wav",
            size: bytes.byteLength,
          });
          storage.addObject({
            bucket: privateBucket,
            key: `private-artifacts/${prepared.id}/${filename}`,
            body: bytes,
            contentType: "audio/wav",
            size: bytes.byteLength,
          });
          await fixture.chat.completeUpload(actor, { id: prepared.id });
          return prepared.id;
        };

        const [initialClipId, steerClipId] = await Promise.all([
          uploadVoiceClip("initial-note.wav", "RIFF-initial-voice-clip"),
          uploadVoiceClip("followup-note.wav", "RIFF-followup-voice-clip"),
        ]);

        const run = await fixture.sendChatRun(actor, {
          model: "gemini-4-neon",
          prompt: "[Voice message: 1 clips]",
          userMessage: {
            version: 1,
            parts: [{ type: "voice", clips: [{ fileId: initialClipId }] }],
          },
        });
        const { execution } = await fixture.runExecution(run.runId);
        owner.rememberExecution(run.runId, execution.sandboxToken);

        expect(execution.cliAgentType).toBe("antigravity");
        const systemPrompt = execution.appendSystemPrompt ?? "";
        expect(systemPrompt).toContain(
          "download each clip with `okou web download-file <file-id>` and read each downloaded audio file in recording order with `read_file` to listen directly",
        );
        expect(systemPrompt).toContain("Do not call `okou transcribe`.");
        expect(systemPrompt).not.toContain(
          "use `okou transcribe` on those clips",
        );

        expect(execution.prompt).toContain(
          `Clip 1: okou web download-file ${initialClipId}`,
        );
        expect(execution.prompt).toContain(
          "read each returned local file path with `read_file` to listen directly to the audio. Do not use `okou transcribe`.",
        );
        expect(execution.prompt).not.toContain("okou transcribe --file-id");

        const steeredSend = await fixture.chat.requestSendEvent(
          actor,
          {
            threadId: run.threadId,
            prompt: "[Voice message: 1 clips]",
            clientEventId: randomUUID(),
            hasTextContent: true,
            userMessage: {
              version: 1,
              parts: [{ type: "voice", clips: [{ fileId: steerClipId }] }],
            },
          },
          [201],
        );
        expect(steeredSend.status).toBe(201);

        const nextSteer = await accept(
          runnersSteerApi.next({
            headers: { authorization: `Bearer ${execution.sandboxToken}` },
            params: { runId: run.runId },
          }),
          [200],
        );
        const steeredInput = nextSteer.body.input;
        expect(steeredInput).toBeDefined();
        const steeredPrompt = steeredInput?.prompt ?? "";
        expect(steeredPrompt).toContain(
          `Clip 1: okou web download-file ${steerClipId}`,
        );
        expect(steeredPrompt).toContain(
          "read each returned local file path with `read_file` to listen directly to the audio. Do not use `okou transcribe`.",
        );
        expect(steeredPrompt).not.toContain("okou transcribe --file-id");
        if (steeredInput) {
          await accept(
            runnersSteerApi.steered({
              headers: { authorization: `Bearer ${execution.sandboxToken}` },
              params: { runId: run.runId, eventId: steeredInput.eventId },
              body: {},
            }),
            [200],
          );
        }
      });
    },
  );
});
