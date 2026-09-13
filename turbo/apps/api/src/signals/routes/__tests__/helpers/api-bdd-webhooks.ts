import { createHmac, randomUUID } from "node:crypto";

import { emailInboundContract } from "@okouai/api-contracts/contracts/email";
import {
  webhookBuiltInGenerationBytePlusContract,
  webhookBuiltInGenerationFalContract,
  webhookCheckpointsContract,
  webhookCheckpointsPrepareHistoryContract,
  webhookClerkContract,
  webhookCompleteContract,
  webhookEventsContract,
  webhookHeartbeatContract,
  webhookStoragesCommitContract,
  webhookStoragesPrepareContract,
  webhookStripeContract,
  webhookTelemetryContract,
  webhookUsageEventContract,
} from "@okouai/api-contracts/contracts/webhooks";
import type StripeSDK from "stripe";
import { Webhook } from "svix";
import type { z } from "zod";

import { createApp } from "../../../../app-factory";
import { env, mockEnv, mockOptionalEnv } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import { generateSandboxToken } from "../../../auth/tokens";
import type { UsagePricingResolution } from "../../../context/usage-pricing-resolution";
import { mockStripeClient } from "../../../external/stripe-client";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { setupAppWithRoutes } from "../../../../__tests__/test-app";
import { registerKnownSessionHistoryBlob } from "./api-bdd-session-history";
import { webhooksAgentCheckpointsRoutes } from "../../webhooks-agent-checkpoints";
import { webhooksAgentCompleteRoutes } from "../../webhooks-agent-complete";
import { webhooksAgentEventsRoutes } from "../../webhooks-agent-events";
import { webhooksAgentHealthUsageTelemetryRoutes } from "../../webhooks-agent-health-usage-telemetry";
import { webhooksAgentStorageRoutes } from "../../webhooks-agent-storage";
import { webhooksBuiltInGenerationRoutes } from "../../webhooks-built-in-generations";
import { webhooksClerkRoutes } from "../../webhooks-clerk";
import { webhooksGithubRoutes } from "../../webhooks-github";
import { webhooksStripeRoutes } from "../../webhooks-stripe";
import { emailInboundRoutes } from "../../email-inbound";

const TEST_APP_ROUTES = Object.freeze([
  ...webhooksAgentCheckpointsRoutes,
  ...webhooksAgentCompleteRoutes,
  ...webhooksAgentEventsRoutes,
  ...webhooksAgentHealthUsageTelemetryRoutes,
  ...webhooksAgentStorageRoutes,
  ...webhooksBuiltInGenerationRoutes,
  ...webhooksClerkRoutes,
  ...webhooksGithubRoutes,
  ...webhooksStripeRoutes,
  ...emailInboundRoutes,
]);

type AgentEventsBody = z.infer<(typeof webhookEventsContract.send)["body"]>;
type AgentCompleteBody = z.infer<
  (typeof webhookCompleteContract.complete)["body"]
>;
type AgentCheckpointBody = z.infer<
  (typeof webhookCheckpointsContract.create)["body"]
>;
type AgentCheckpointPrepareHistoryBody = z.infer<
  (typeof webhookCheckpointsPrepareHistoryContract.prepare)["body"]
>;
type AgentHeartbeatBody = z.infer<
  (typeof webhookHeartbeatContract.send)["body"]
>;
type AgentTelemetryBody = z.infer<
  (typeof webhookTelemetryContract.send)["body"]
>;
type AgentUsageEventBody = z.infer<
  (typeof webhookUsageEventContract.send)["body"]
>;
type AgentStoragePrepareBody = z.infer<
  (typeof webhookStoragesPrepareContract.prepare)["body"]
>;
type AgentStorageCommitBody = z.infer<
  (typeof webhookStoragesCommitContract.commit)["body"]
>;
interface EventConsumerSignatureHeaders {
  readonly "x-okou-signature": string;
  readonly "x-okou-timestamp": string;
}

interface SvixHeaders {
  readonly "svix-id": string;
  readonly "svix-timestamp": string;
  readonly "svix-signature": string;
}

interface SandboxWebhookHeaders {
  readonly authorization?: string;
}

interface ClerkWebhookEvent {
  readonly type: string;
  readonly data: unknown;
}

type GithubWebhookStatus = 200 | 400 | 401 | 503;

interface GithubWebhookResponse {
  readonly status: GithubWebhookStatus;
  readonly body: unknown;
  readonly headers: Headers;
}

type BuiltInGenerationProvider = "fal" | "byteplus";
const RESEND_WEBHOOK_SECRET = "whsec_test";
interface StripeWebhookResponse {
  readonly status: 200 | 500;
  readonly body: unknown;
}

function serializedContractBody(body: unknown): string {
  return JSON.stringify(body);
}

async function parseRawResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return await response.json();
  }
  if (contentType.startsWith("text/")) {
    return await response.text();
  }
  return await response.blob();
}

function builtInGenerationToken(args: {
  readonly provider: BuiltInGenerationProvider;
  readonly generationId: string;
  readonly visualKey?: string;
}): string {
  return createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update([args.provider, args.generationId, args.visualKey ?? ""].join(":"))
    .digest("hex");
}

function eventConsumerSignatureHeaders(
  body: unknown,
): EventConsumerSignatureHeaders {
  const timestamp = Math.floor(now() / 1000);
  return {
    "x-okou-signature": createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
      .update(`${timestamp}.${serializedContractBody(body)}`)
      .digest("hex"),
    "x-okou-timestamp": String(timestamp),
  };
}

function resendSvixHeaders(body: unknown): SvixHeaders {
  const id = `msg_${randomUUID()}`;
  const timestamp = new Date(now());
  return {
    "svix-id": id,
    "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "svix-signature": new Webhook(RESEND_WEBHOOK_SECRET).sign(
      id,
      timestamp,
      serializedContractBody(body),
    ),
  };
}

function githubWebhookHeaders(
  body: string,
  event: string,
): Record<string, string> {
  return {
    "x-github-delivery": `delivery-${randomUUID()}`,
    "x-github-event": event,
    "x-hub-signature-256": `sha256=${createHmac("sha256", "github-bdd-secret")
      .update(body)
      .digest("hex")}`,
  };
}

async function requestRawGithubWebhook(
  context: TestContext,
  body: string,
  headers: Record<string, string>,
): Promise<GithubWebhookResponse> {
  const response = await createApp({
    signal: context.signal,
    routes: TEST_APP_ROUTES,
  }).request("/api/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
  const result = {
    body: await parseRawResponseBody(response),
    headers: response.headers,
  };

  switch (response.status) {
    case 200: {
      return { status: 200, ...result };
    }
    case 400: {
      return { status: 400, ...result };
    }
    case 401: {
      return { status: 401, ...result };
    }
    case 503: {
      return { status: 503, ...result };
    }
    default: {
      throw new Error(`Unexpected GitHub webhook status ${response.status}`);
    }
  }
}

function sandboxWebhookHeaders(args: {
  readonly runId: string;
  readonly tokenRunId?: string;
}): SandboxWebhookHeaders {
  return {
    authorization: `Bearer ${generateSandboxToken(
      "user_bdd_sandbox_webhook",
      args.tokenRunId ?? args.runId,
      "org_bdd_sandbox_webhook",
    )}`,
  };
}

export function createWebhookCallbackApi(context: TestContext) {
  return {
    disableStripeWebhookSecret(): void {
      mockOptionalEnv("STRIPE_WEBHOOK_SECRET", undefined);
    },

    configureStripeWebhookSecret(): void {
      mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_bdd_stripe");
    },

    /**
     * Full Stripe billing Given for webhook chains: price map, one-time
     * campaign registry, webhook secret, and the mocked Stripe SDK client.
     * Uses the same price ids as `grantProEntitlement`, so the two can be
     * combined in any order within a test.
     */
    configureStripeBillingEnv(): void {
      mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
      mockEnv("OKOU_PRICE_PRO", "price_bdd_pro");
      mockEnv("OKOU_PRICE_TEAM", "price_bdd_team");
      mockEnv("ATOM_GRANT_PRICE", "price_bdd_atom_grant");
      mockEnv("OKOU_PRICE_CONCURRENCY", "price_bdd_concurrency");
      mockEnv(
        "OKOU_ONE_TIME_CAMPAIGN",
        JSON.stringify({
          ZERO100: {
            priceId: "price_bdd_campaign",
            couponId: "coupon_bdd_campaign",
          },
        }),
      );
      mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_bdd_stripe");
    },

    /**
     * Posts one signed Stripe event through the public webhook route. The
     * `constructEvent` trust boundary is mocked once per call so later posts
     * never leak a stale event. Raw request (not contract client) so processing 500s
     * stay assertable.
     */
    async postStripeEvent(
      event: unknown,
      statuses: readonly (200 | 500)[],
    ): Promise<StripeWebhookResponse> {
      context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(event);
      const response = await createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      }).request("/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=bdd" },
        body: serializedContractBody(event),
      });
      const body = await parseRawResponseBody(response);
      const status = response.status;
      if ((status !== 200 && status !== 500) || !statuses.includes(status)) {
        throw new Error(
          `Expected Stripe webhook status in [${statuses.join(", ")}], received ${status}: ${JSON.stringify(body)}`,
        );
      }
      return { status, body };
    },

    acceptNextStripeWebhookEvent(event: unknown): void {
      context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(event);
    },

    rejectNextStripeWebhookSignature(): void {
      context.mocks.stripe.webhooks.constructEvent.mockImplementationOnce(
        () => {
          throw new Error("Invalid Stripe webhook signature");
        },
      );
    },

    async requestStripeWebhook(
      body: string,
      headers: Record<string, string>,
      statuses: readonly (200 | 401 | 503)[],
    ) {
      return await accept(
        setupApp({ context, routes: webhooksStripeRoutes })(
          webhookStripeContract,
        ).post({
          body,
          extraHeaders: headers,
        }),
        statuses,
      );
    },

    configureClerkWebhookSecret(): void {
      mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_bdd_clerk");
    },

    rejectNextClerkWebhookVerification(): void {
      context.mocks.clerk.verifyWebhook.mockRejectedValueOnce(
        new Error("Invalid Clerk webhook verification"),
      );
    },

    verifyNextClerkWebhook(event: ClerkWebhookEvent): void {
      context.mocks.clerk.verifyWebhook.mockResolvedValueOnce(event);
    },

    async requestClerkWebhook(
      body: string,
      headers: Record<string, string>,
      statuses: readonly (200 | 401 | 503)[],
    ) {
      return await accept(
        setupApp({ context, routes: webhooksClerkRoutes })(
          webhookClerkContract,
        ).post({
          body,
          extraHeaders: headers,
        }),
        statuses,
      );
    },

    configureGithubWebhookSecret(): void {
      mockOptionalEnv("GITHUB_APP_WEBHOOK_SECRET", "github-bdd-secret");
    },

    disableGithubWebhookSecret(): void {
      mockOptionalEnv("GITHUB_APP_WEBHOOK_SECRET", undefined);
    },

    configureResendWebhookSecret(): void {
      mockEnv("RESEND_WEBHOOK_SECRET", RESEND_WEBHOOK_SECRET);
    },

    disableResendApiKey(): void {
      mockEnv("RESEND_API_KEY", undefined);
    },

    async requestGithubWebhook(
      body: string,
      headers: Record<string, string>,
      statuses: readonly (200 | 400 | 401 | 503)[],
    ) {
      return await accept(
        requestRawGithubWebhook(context, body, headers),
        statuses,
      );
    },

    signedGithubWebhookHeaders(
      body: string,
      event: string,
    ): Record<string, string> {
      return githubWebhookHeaders(body, event);
    },

    signedResendWebhookHeaders(body: unknown): SvixHeaders {
      return resendSvixHeaders(body);
    },

    async requestResendInboundWebhook(
      body: unknown,
      headers: Partial<SvixHeaders>,
      statuses: readonly (200 | 401)[],
    ) {
      return await accept(
        setupApp({ context, routes: emailInboundRoutes })(
          emailInboundContract,
        ).post({
          headers,
          body,
        }),
        statuses,
      );
    },

    falGenerationWebhookToken(
      generationId: string,
      visualKey?: string,
    ): string {
      return builtInGenerationToken({
        provider: "fal",
        generationId,
        visualKey,
      });
    },

    bytePlusGenerationWebhookToken(
      generationId: string,
      visualKey?: string,
    ): string {
      return builtInGenerationToken({
        provider: "byteplus",
        generationId,
        visualKey,
      });
    },

    async requestFalGenerationWebhook(args: {
      readonly generationId: string;
      readonly token: string;
      readonly visualKey?: string;
      readonly body: unknown;
      readonly statuses: readonly (200 | 400 | 401 | 503)[];
    }) {
      return await accept(
        setupApp({ context, routes: webhooksBuiltInGenerationRoutes })(
          webhookBuiltInGenerationFalContract,
        ).post({
          params: { generationId: args.generationId },
          query: { token: args.token, visualKey: args.visualKey },
          body: args.body as string,
        }),
        args.statuses,
      );
    },

    async requestBytePlusGenerationWebhook(args: {
      readonly generationId: string;
      readonly token: string;
      readonly visualKey?: string;
      readonly body: unknown;
      readonly statuses: readonly (200 | 400 | 401 | 503)[];
    }) {
      return await accept(
        setupApp({ context, routes: webhooksBuiltInGenerationRoutes })(
          webhookBuiltInGenerationBytePlusContract,
        ).post({
          params: { generationId: args.generationId },
          query: { token: args.token, visualKey: args.visualKey },
          body: args.body as string,
        }),
        args.statuses,
      );
    },

    signedEventConsumerHeaders(body: unknown): EventConsumerSignatureHeaders {
      return eventConsumerSignatureHeaders(body);
    },

    sandboxWebhookHeaders,

    async requestAgentEvents(
      body: AgentEventsBody,
      headers: SandboxWebhookHeaders,
      statuses: readonly (200 | 400 | 401 | 404 | 500 | 503)[],
    ) {
      return await accept(
        setupApp({ context, routes: webhooksAgentEventsRoutes })(
          webhookEventsContract,
        ).send({
          headers,
          body,
        }),
        statuses,
      );
    },

    async requestAgentEventsUnchecked(
      body: unknown,
      headers: SandboxWebhookHeaders,
      statuses: readonly (400 | 401 | 404 | 500 | 503)[],
    ) {
      return await accept(
        setupApp({ context, routes: webhooksAgentEventsRoutes })(
          webhookEventsContract,
        ).send({
          headers,
          body: body as AgentEventsBody,
        }),
        statuses,
      );
    },

    async requestAgentComplete(
      body: AgentCompleteBody,
      headers: SandboxWebhookHeaders,
      statuses: readonly (200 | 400 | 401 | 404 | 500 | 503)[],
      signal?: AbortSignal,
      usagePricingResolution?: UsagePricingResolution,
    ) {
      const historyHash = body.checkpoint?.cliAgentSessionHistoryHash;
      if (historyHash !== undefined) {
        const sessionHistoryBlob = registerKnownSessionHistoryBlob(
          context,
          body.runId,
          historyHash,
        );
        if (sessionHistoryBlob && statuses.includes(200)) {
          await accept(
            setupApp({ context, routes: webhooksAgentCheckpointsRoutes })(
              webhookCheckpointsPrepareHistoryContract,
            ).prepare({
              headers,
              body: {
                runId: body.runId,
                hash: historyHash,
                rawSize: sessionHistoryBlob.byteLength,
                encodedSize: sessionHistoryBlob.byteLength,
                encoding: "identity",
              },
            }),
            [200],
          );
        }
      }
      const client = setupAppWithRoutes({
        context,
        routes: webhooksAgentCompleteRoutes,
        ...(signal === undefined ? {} : { signal }),
        ...(usagePricingResolution === undefined
          ? {}
          : { usagePricingResolution }),
      })(webhookCompleteContract);
      return await accept(
        client.complete({
          headers,
          body,
        }),
        statuses,
      );
    },

    async requestAgentCompleteUnchecked(
      body: unknown,
      headers: SandboxWebhookHeaders,
      statuses: readonly (400 | 401 | 404 | 500 | 503)[],
    ) {
      return await accept(
        setupApp({ context, routes: webhooksAgentCompleteRoutes })(
          webhookCompleteContract,
        ).complete({
          headers,
          body: body as AgentCompleteBody,
        }),
        statuses,
      );
    },

    async requestAgentCheckpoint(
      body: AgentCheckpointBody,
      headers: SandboxWebhookHeaders,
      statuses: readonly (200 | 400 | 401 | 404 | 500)[],
    ) {
      const historyHash = body.cliAgentSessionHistoryHash;
      if (historyHash !== undefined) {
        const sessionHistoryBlob = registerKnownSessionHistoryBlob(
          context,
          body.runId,
          historyHash,
        );
        if (sessionHistoryBlob && statuses.includes(200)) {
          await accept(
            setupApp({ context, routes: webhooksAgentCheckpointsRoutes })(
              webhookCheckpointsPrepareHistoryContract,
            ).prepare({
              headers,
              body: {
                runId: body.runId,
                hash: historyHash,
                rawSize: sessionHistoryBlob.byteLength,
                encodedSize: sessionHistoryBlob.byteLength,
                encoding: "identity",
              },
            }),
            [200],
          );
        }
      }
      return await accept(
        setupApp({ context, routes: webhooksAgentCheckpointsRoutes })(
          webhookCheckpointsContract,
        ).create({
          headers,
          body,
        }),
        statuses,
      );
    },

    async requestAgentCheckpointUnchecked(
      body: unknown,
      headers: SandboxWebhookHeaders,
      statuses: readonly (400 | 401 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context, routes: webhooksAgentCheckpointsRoutes })(
          webhookCheckpointsContract,
        ).create({
          headers,
          body: body as AgentCheckpointBody,
        }),
        statuses,
      );
    },

    async requestAgentCheckpointPrepareHistory(
      body: AgentCheckpointPrepareHistoryBody,
      headers: SandboxWebhookHeaders,
      statuses: readonly (200 | 400 | 401 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context, routes: webhooksAgentCheckpointsRoutes })(
          webhookCheckpointsPrepareHistoryContract,
        ).prepare({
          headers,
          body,
        }),
        statuses,
      );
    },

    async requestAgentCheckpointPrepareHistoryUnchecked(
      body: unknown,
      headers: SandboxWebhookHeaders,
      statuses: readonly (400 | 401 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context, routes: webhooksAgentCheckpointsRoutes })(
          webhookCheckpointsPrepareHistoryContract,
        ).prepare({
          headers,
          body: body as AgentCheckpointPrepareHistoryBody,
        }),
        statuses,
      );
    },

    async requestAgentHeartbeat(
      body: AgentHeartbeatBody,
      headers: SandboxWebhookHeaders,
      statuses: readonly (200 | 400 | 401 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context, routes: webhooksAgentHealthUsageTelemetryRoutes })(
          webhookHeartbeatContract,
        ).send({
          headers,
          body,
        }),
        statuses,
      );
    },

    async requestAgentHeartbeatUnchecked(
      body: unknown,
      headers: SandboxWebhookHeaders,
      statuses: readonly (400 | 401 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context, routes: webhooksAgentHealthUsageTelemetryRoutes })(
          webhookHeartbeatContract,
        ).send({
          headers,
          body: body as AgentHeartbeatBody,
        }),
        statuses,
      );
    },

    async requestAgentTelemetry(
      body: AgentTelemetryBody,
      headers: SandboxWebhookHeaders,
      statuses: readonly (200 | 400 | 401 | 404 | 500)[],
      signal?: AbortSignal,
    ) {
      return await accept(
        setupApp({
          context,
          routes: webhooksAgentHealthUsageTelemetryRoutes,
          signal,
        })(webhookTelemetryContract).send({ headers, body }),
        statuses,
      );
    },

    async requestAgentTelemetryUnchecked(
      body: unknown,
      headers: SandboxWebhookHeaders,
      statuses: readonly (200 | 400 | 401 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context, routes: webhooksAgentHealthUsageTelemetryRoutes })(
          webhookTelemetryContract,
        ).send({
          headers,
          body: body as AgentTelemetryBody,
        }),
        statuses,
      );
    },

    async requestAgentUsageEvent(
      body: AgentUsageEventBody,
      headers: SandboxWebhookHeaders,
      statuses: readonly (200 | 400 | 401 | 404 | 500)[],
      usagePricingResolution?: UsagePricingResolution,
    ) {
      return await accept(
        setupApp({
          context,
          routes: webhooksAgentHealthUsageTelemetryRoutes,
          ...(usagePricingResolution === undefined
            ? {}
            : { usagePricingResolution }),
        })(webhookUsageEventContract).send({ headers, body }),
        statuses,
      );
    },

    async requestAgentUsageEventUnchecked(
      body: unknown,
      headers: SandboxWebhookHeaders,
      statuses: readonly (400 | 401 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context, routes: webhooksAgentHealthUsageTelemetryRoutes })(
          webhookUsageEventContract,
        ).send({
          headers,
          body: body as AgentUsageEventBody,
        }),
        statuses,
      );
    },

    async requestAgentStoragePrepare(
      body: AgentStoragePrepareBody,
      headers: SandboxWebhookHeaders,
      statuses: readonly (200 | 400 | 401 | 404 | 413 | 500)[],
    ) {
      return await accept(
        setupApp({ context, routes: webhooksAgentStorageRoutes })(
          webhookStoragesPrepareContract,
        ).prepare({
          headers,
          body,
        }),
        statuses,
      );
    },

    async requestAgentStoragePrepareUnchecked(
      body: unknown,
      headers: SandboxWebhookHeaders,
      statuses: readonly (400 | 401 | 404 | 413 | 500)[],
    ) {
      return await accept(
        setupApp({ context, routes: webhooksAgentStorageRoutes })(
          webhookStoragesPrepareContract,
        ).prepare({
          headers,
          body: body as AgentStoragePrepareBody,
        }),
        statuses,
      );
    },

    async requestAgentStorageCommit(
      body: AgentStorageCommitBody,
      headers: SandboxWebhookHeaders,
      statuses: readonly (200 | 400 | 401 | 404 | 409 | 413 | 500)[],
    ) {
      return await accept(
        setupApp({ context, routes: webhooksAgentStorageRoutes })(
          webhookStoragesCommitContract,
        ).commit({
          headers,
          body,
        }),
        statuses,
      );
    },

    async requestAgentStorageCommitUnchecked(
      body: unknown,
      headers: SandboxWebhookHeaders,
      statuses: readonly (400 | 401 | 404 | 409 | 413 | 500)[],
    ) {
      return await accept(
        setupApp({ context, routes: webhooksAgentStorageRoutes })(
          webhookStoragesCommitContract,
        ).commit({
          headers,
          body: body as AgentStorageCommitBody,
        }),
        statuses,
      );
    },
  };
}
