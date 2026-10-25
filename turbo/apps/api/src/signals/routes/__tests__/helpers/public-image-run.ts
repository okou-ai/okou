import { randomUUID } from "node:crypto";
import { imageModelIdSchema } from "@okouai/api-contracts/contracts/image-models";
import { builtInGenerationResponseSchema } from "@okouai/api-contracts/contracts/built-in-generation";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { onTestFinished } from "vitest";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { createAppWithRoutes } from "../../../../app-factory-core";
import { env, mockEnv, mockOptionalEnv } from "../../../../lib/env";
import { server } from "../../../../mocks/server";
import { settleIncludingAbort } from "../../../utils";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { billingStatusRoutes } from "../../billing-status";
import { builtInGenerationRoutes } from "../../built-in-generation";
import { cronReconcileImageGenerationsRoutes } from "../../cron-reconcile-image-generations";
import { imageIoGenerateRoutes } from "../../image-io-generate";
import { usageRecordRoutes } from "../../usage-record";
import { userModelPreferenceRoutes } from "../../user-model-preference";
import { webhooksBuiltInGenerationRoutes } from "../../webhooks-built-in-generations";
import { createRouteMocks } from "./route-test";
import { mockClaudeCodeTokenEndpoint } from "./api-bdd-auth-device";
import {
  createChatEventsFixture,
  okouTokenFromClaim,
} from "./chat-events-fixture";
import { captureConnectorExternalState } from "./public-connector-actor";
import { publicRunOwner } from "./public-run-owner";
import { purchaseToolCredits } from "./public-tool-actor";

export const tokenRequest = Object.freeze({
  keyName: "test-key",
  timestamp: 1_700_000_000_000,
  capability: '{"user:test-user":["subscribe"]}',
  clientId: "test-user",
  nonce: "test-nonce",
  mac: "test-mac",
});

interface ImageFixture {
  readonly orgId: string;
  readonly userId: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

export function createImageIoTestApp(
  context: TestContext,
  owner?: {
    readonly run: <T>(operation: () => Promise<T>) => Promise<T>;
  },
) {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: [
      ...builtInGenerationRoutes,
      ...cronReconcileImageGenerationsRoutes,
      ...imageIoGenerateRoutes,
      ...webhooksBuiltInGenerationRoutes,
      ...billingStatusRoutes,
      ...usageRecordRoutes,
    ],
  });
  return {
    request(...args: Parameters<typeof app.request>) {
      const request = async () => {
        return await app.request(...args);
      };
      return owner ? owner.run(request) : request();
    },
  };
}

// Reads the org credit balance through the product billing surface so charge
// assertions stay on externally observable state.
export async function orgCredits(
  context: TestContext,
  fixture: ImageFixture,
): Promise<number> {
  const mocks = createRouteMocks(context);
  mocks.clerk.session(fixture.userId, fixture.orgId);
  const app = createImageIoTestApp(context);
  const response = await app.request("/api/billing/status", {
    headers: authHeaders(),
  });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("credits" in body) ||
    typeof body.credits !== "number"
  ) {
    throw new Error("Expected billing status credits");
  }
  return body.credits;
}

export function readWebhookUrl(requestUrl: string | null): string {
  if (requestUrl) {
    const webhookUrl = new URL(requestUrl).searchParams.get("fal_webhook");
    if (webhookUrl) {
      return webhookUrl;
    }
  }
  throw new Error("Expected Fal request fal_webhook query parameter");
}

export async function postFalWebhookEnvelope(
  app: ReturnType<typeof createImageIoTestApp>,
  requestUrl: string | null,
  body: Record<string, unknown>,
): Promise<void> {
  const url = new URL(readWebhookUrl(requestUrl));
  const response = await app.request(`${url.pathname}${url.search}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
}

export function readAcceptedGenerationId(
  body: unknown,
  type: "image",
  userId: string,
): string {
  if (
    typeof body !== "object" ||
    body === null ||
    !("generationId" in body) ||
    typeof body.generationId !== "string"
  ) {
    throw new Error("Expected accepted generation response");
  }
  expect(body).toMatchObject({
    generationId: body.generationId,
    type,
    status: "queued",
    realtime: {
      channelName: `user:${userId}`,
      eventName: `built-in-generation:${body.generationId}`,
      tokenRequest,
    },
  });
  return body.generationId;
}

export function readGenerationResult(body: unknown): unknown {
  if (typeof body === "object" && body !== null && "result" in body) {
    return body.result;
  }
  throw new Error("Expected completed generation result");
}

// These selected callers use real personal-model Runs and the existing image tariffs.
export async function createClaimedImageRun(
  context: TestContext,
  imageModel: string | null,
  credits = 1000,
  providerCleanupBody: Record<string, unknown> = {
    status: "ERROR",
    error: "Image provider request cancelled during cleanup",
  },
) {
  const mocks = createRouteMocks(context);
  const chat = createChatEventsFixture(context);
  const actor = chat.bdd.user();
  if (!actor.orgId) {
    throw new Error("Image tests require an owned organization");
  }
  const fixture = { orgId: actor.orgId, userId: actor.userId };
  const providerRequests = new Set<string>();
  const rememberProviderRequest = ({
    request,
  }: {
    readonly request: Request;
  }) => {
    if (
      request.method === "POST" &&
      new URL(request.url).hostname === "queue.fal.run" &&
      new URL(request.url).searchParams.has("fal_webhook")
    ) {
      providerRequests.add(request.url);
    }
  };
  const environmentNames = [
    "OKOU_API_BACKEND_URL",
    "OKOU_WEB_URL",
    "OPENAI_API_KEY",
    "FAL_KEY",
    "R2_USER_STORAGES_BUCKET_NAME",
    "R2_PRIVATE_ARTIFACTS_BUCKET_NAME",
    "SECRETS_KMS_KEY_ID",
    "SECRETS_ENCRYPTION_KEY",
  ] as const;
  function captureExternalState() {
    const restoreCommon = captureConnectorExternalState(context, [
      "OKOU_PRICE_CUSTOM_CREDIT_UNIT",
      "OKOU_DATA_ROUTER_URL",
      "OKOU_DATA_TOKEN",
    ]);
    const checkout =
      context.mocks.stripe.checkout.sessions.create.getMockImplementation();
    const values = environmentNames.map((name) => {
      return [name, env(name)] as const;
    });
    const handlers = server.listHandlers();
    const restoreIdentity = [
      context.mocks.clerk.authenticateRequest,
      context.mocks.clerk.users.getOrganizationMembershipList,
      context.mocks.clerk.organizations.getOrganizationMembershipList,
      context.mocks.clerk.organizations.getOrganization,
    ].map((mock) => {
      const implementation = mock.getMockImplementation();
      return () => {
        if (implementation) {
          mock.mockImplementation(implementation);
        } else {
          mock.mockReset();
        }
      };
    });
    const send = context.mocks.s3.send.getMockImplementation();
    const sign = context.mocks.s3.getSignedUrl.getMockImplementation();
    const publish = context.mocks.ably.publish.getMockImplementation();
    const createToken =
      context.mocks.ably.createTokenRequest.getMockImplementation();
    return () => {
      restoreCommon();
      context.mocks.stripe.checkout.sessions.create.mockReset();
      if (checkout) {
        context.mocks.stripe.checkout.sessions.create.mockImplementation(
          checkout,
        );
      }
      for (const [name, value] of values) {
        mockEnv(name, value);
      }
      server.resetHandlers(...handlers);
      for (const restore of restoreIdentity) {
        restore();
      }
      if (send) {
        context.mocks.s3.send.mockImplementation(send);
      }
      if (sign) {
        context.mocks.s3.getSignedUrl.mockImplementation(sign);
      }
      if (publish) {
        context.mocks.ably.publish.mockImplementation(publish);
      }
      context.mocks.ably.createTokenRequest.mockReset();
      if (createToken) {
        context.mocks.ably.createTokenRequest.mockImplementation(createToken);
      }
    };
  }
  const runnerGroup = chat.api.configureRunnerGroup();
  let restoreAcceptedState = captureExternalState();
  let restorePreviousState: (() => void) | undefined;
  let restoreSetupExternalState: (() => void) | undefined;
  onTestFinished(() => {
    server.events.removeListener("request:start", rememberProviderRequest);
    restorePreviousState?.();
  });
  server.events.on("request:start", rememberProviderRequest);
  const owner = publicRunOwner(context, actor, {
    restoreEnvironment: () => {
      restorePreviousState ??= captureExternalState();
      restoreAcceptedState();
      restoreSetupExternalState?.();
      if (runnerGroup) {
        mockOptionalEnv("RUNNER_DEFAULT_GROUP", runnerGroup);
      }
    },
    beforeRuns: async () => {
      // The mock provider owns any unfinished accepted image. Settle it through
      // the exact callback URL emitted by the real submission, including on failure.
      const pendingWork = await settleIncludingAbort(flushWaitUntilForTest);
      const terminalIds = new Set<string>();
      for (const [eventName, payload] of context.mocks.ably.publish.mock
        .calls) {
        if (
          typeof eventName !== "string" ||
          !eventName.startsWith("built-in-generation:")
        ) {
          continue;
        }
        const snapshot = builtInGenerationResponseSchema.safeParse(payload);
        if (
          snapshot.success &&
          eventName === `built-in-generation:${snapshot.data.generationId}` &&
          ["completed", "failed"].includes(snapshot.data.status)
        ) {
          terminalIds.add(snapshot.data.generationId);
        }
      }
      const results = await Promise.all(
        [...providerRequests]
          .filter((requestUrl) => {
            const callback = new URL(readWebhookUrl(requestUrl));
            const generationId = callback.pathname.split("/").at(-1);
            return !generationId || !terminalIds.has(generationId);
          })
          .map((requestUrl) => {
            return settleIncludingAbort(() => {
              return postFalWebhookEnvelope(
                createImageIoTestApp(context),
                requestUrl,
                providerCleanupBody,
              );
            });
          }),
      );
      const flushed = await settleIncludingAbort(flushWaitUntilForTest);
      const errors = [pendingWork, ...results, flushed].flatMap((result) => {
        return result.ok ? [] : [result.error];
      });
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "Image provider cleanup failed");
      }
    },
  });
  function run<T>(operation: () => Promise<T>): Promise<T> {
    return owner.run(() => {
      const pending = settleIncludingAbort(operation);
      restoreAcceptedState = captureExternalState();
      return pending.then((result) => {
        if (!result.ok) {
          throw result.error;
        }
        return result.value;
      });
    });
  }
  chat.chatCallbacks.acceptChatObjectStorage();
  chat.api.acceptStorageDownloads();
  chat.api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  chat.chatCallbacks.disableVapid();
  const {
    customerId,
    defaultAgentId: agentId,
    credits: startingCredits,
  } = await run(() => {
    return chat.api.grantProEntitlement(actor, {
      onExternalStateReady: (restore) => {
        restoreSetupExternalState = restore;
      },
    });
  });
  restoreSetupExternalState = undefined;
  await run(async () => {
    mockClaudeCodeTokenEndpoint();
    await chat.api.createPersonalModelProvider(actor, {
      type: "claude-code-oauth-token",
      secret: "bdd-personal-claude-token",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const preferences = setupApp({
      context,
      routes: userModelPreferenceRoutes,
    })(userModelPreferenceContract);
    // The native Run and image model are both chosen by this fixture. Store
    // them together through the ordinary member preference endpoint.
    await accept(
      preferences.update({
        headers: authHeaders(),
        body: {
          selectedModel: "claude-fable-5-1",
          serviceTier: null,
          selectedImageModel:
            imageModel === null ? null : imageModelIdSchema.parse(imageModel),
        },
      }),
      [200],
    );
  });
  // Normal Pro activation grants 20,000 credits before an optional purchase.
  expect(startingCredits).toBe(20_000);
  const initialCredits = 20_000 + credits;
  if (credits !== 0) {
    await run(() => {
      return purchaseToolCredits(context, actor, {
        credits,
        customerId,
        invoiceId: `in_image_${randomUUID()}`,
        onExternalStateReady: (restore) => {
          restoreSetupExternalState = restore;
        },
      });
    });
  }
  restoreSetupExternalState = undefined;
  if (credits !== 0) {
    await expect(
      run(() => {
        return orgCredits(context, fixture);
      }),
    ).resolves.toBe(initialCredits);
  }
  const sent = await run(() => {
    return chat.sendChatRun(actor, {
      agentId,
      prompt: "Generate an image for this Run",
      model: "claude-fable-5-1",
    });
  });
  const claimedRunnerGroup = runnerGroup;
  await run(() => {
    return chat.api.heartbeatRunner(claimedRunnerGroup);
  });
  const claimed = await run(async () => {
    const claim = await chat.api.claimRunnerJob(sent.runId);
    owner.rememberClaim(sent.runId, claim.sandboxToken);
    return {
      ...sent,
      claim,
      sandboxHeaders: { authorization: `Bearer ${claim.sandboxToken}` },
    };
  });
  restoreAcceptedState = captureExternalState();
  return {
    ...fixture,
    actor,
    initialCredits,
    runId: claimed.runId,
    claim: claimed.claim,
    run,
    token: okouTokenFromClaim(claimed.claim),
    request(
      app: ReturnType<typeof createImageIoTestApp>,
      ...args: Parameters<ReturnType<typeof createImageIoTestApp>["request"]>
    ) {
      return run(async () => {
        return await app.request(...args);
      });
    },
    cancelRun: () => {
      return run(() => {
        return chat.cancelChatRun(actor, claimed.runId, claimed.sandboxHeaders);
      });
    },
  };
}
