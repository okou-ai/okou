import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { installSharedThreadStorage } from "./helpers/shared-thread-storage";
import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { CLIENT_REQUEST_ID_HEADER } from "@okouai/api-contracts/contracts/client-headers";
import {
  IMAGE_RECOGNITION_MAX_FILE_BYTES,
  IMAGE_RECOGNITION_MAX_TEXT_CHARS,
  imageRecognitionContract,
} from "@okouai/api-contracts/contracts/image-recognition";
import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import { usageRecordContract } from "@okouai/api-contracts/contracts/usage-record";
import { HttpResponse, http } from "msw";
import { onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { apiTestS3PresignedUrl } from "../../../__tests__/mocks";
import { buildArtifactKey } from "../../../lib/file-url";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import {
  createUsagePricingFixture,
  deleteUsagePricingRows,
  seedOrgMetadata,
  type UsagePricingFixture,
} from "../../../test-fixtures/system-config-seeds";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { readUsageStorageCounts$ } from "./helpers/usage-state";
import { createRouteMocks } from "./helpers/route-test";
import { seedBuiltInDefaultModelKey } from "./helpers/runtime-state";
import { imageRecognitionRoutes } from "../image-recognition";
import { createDeferredPromise } from "../../utils";
import { usageRecordRoutes } from "../usage-record";

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const STARTING_CREDITS = 1000;
const EXPECTED_CHARGE = 3;
const IMAGE_RECOGNITION_PRICING_ROWS = [
  {
    kind: "image-recognition",
    provider: "xiaomi/mimo-v2.5",
    category: "tokens.input",
    unitPrice: 140,
    unitSize: 1_000_000,
  },
  {
    kind: "image-recognition",
    provider: "xiaomi/mimo-v2.5",
    category: "tokens.cache_read",
    unitPrice: 3,
    unitSize: 1_000_000,
  },
  {
    kind: "image-recognition",
    provider: "xiaomi/mimo-v2.5",
    category: "tokens.output",
    unitPrice: 280,
    unitSize: 1_000_000,
  },
] as const;

interface ImageRecognitionActor extends ApiTestUser {
  readonly orgId: string;
  readonly runId: string;
}

interface StoredObject {
  readonly userId: string;
  readonly id: string;
  readonly filename: string;
  readonly size: number;
}

function okouToken(
  actor: ImageRecognitionActor,
  capabilities: readonly Capability[] = ["image-recognition:write"],
): string {
  return createRunsApi(context).okouTokenForRunWithCapabilities(
    actor,
    actor.runId,
    capabilities,
  );
}

async function seedImageRecognitionActor(): Promise<ImageRecognitionActor> {
  const actor = createBddApi(context).user();
  if (!actor.orgId) {
    throw new Error("Image recognition tests require an organization");
  }
  await seedOrgMetadata({
    orgId: actor.orgId,
    tier: "pro",
    credits: STARTING_CREDITS,
  });
  const api = createRunsApi(context);
  const name = `image-recognition-${randomUUID().slice(0, 8)}`;
  const compose = await api.createDirectAgent(actor, {
    version: "1.0",
    agents: {
      [name]: {
        framework: "claude-code",
        environment: { ANTHROPIC_API_KEY: "recognition-test-key" },
      },
    },
  });
  const run = await api.createDirectRun(actor, {
    agentId: compose.agentId,
    prompt: "Recognize an uploaded image",
  });
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [
      {
        role: actor.orgRole ?? "org:admin",
        organization: { id: actor.orgId },
        publicUserData: { userId: actor.userId },
      },
    ],
  });
  return { ...actor, orgId: actor.orgId, runId: run.runId };
}

async function seedAdmittedImageRecognitionActor(): Promise<ImageRecognitionActor> {
  await seedBuiltInDefaultModelKey(context);
  const bdd = createBddApi(context);
  const api = createRunsApi(context);
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Image recognition tests require an organization");
  }
  bdd.acceptAgentStorageWrites();
  api.configureRunnerGroup();
  const completed = await bdd.completeOnboarding(actor);
  expect(completed.status).toBe(200);
  await seedOrgMetadata({ orgId: actor.orgId, tier: "pro", credits: 1 });
  const agent = await bdd.createAgent(actor, {
    displayName: "Admitted recognition agent",
    visibility: "private",
  });
  const run = await api.createRun(actor, {
    agentId: agent.agentId,
    prompt: "Recognize after credit exhaustion",
    modelProvider: "built-in",
  });
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [
      {
        role: actor.orgRole ?? "org:admin",
        organization: { id: actor.orgId },
        publicUserData: { userId: actor.userId },
      },
    ],
  });
  return { ...actor, orgId: actor.orgId, runId: run.runId };
}

function setStoredObjects(objects: readonly StoredObject[]): void {
  context.mocks.s3.getSignedUrl.mockImplementation(
    (_client: unknown, command: unknown) => {
      return Promise.resolve(apiTestS3PresignedUrl(command));
    },
  );
  mocks.s3.listObjects(
    objects.map((object) => {
      return {
        bucket: "test-user-artifacts",
        key: buildArtifactKey(object.userId, object.id, object.filename),
        size: object.size,
      };
    }),
  );
}

function requestImageRecognition(
  args: {
    readonly token?: string;
    readonly fileId: string;
    readonly prompt?: string;
    readonly clientRequestId?: string;
    readonly usagePricingResolution?: UsagePricingFixture["resolution"];
  },
  signal?: AbortSignal,
) {
  const headers = {
    ...(args.token ? { authorization: `Bearer ${args.token}` } : {}),
    ...(args.clientRequestId
      ? { [CLIENT_REQUEST_ID_HEADER]: args.clientRequestId }
      : {}),
  };
  const client = setupApp({
    context,
    routes: imageRecognitionRoutes,
    usagePricingResolution: args.usagePricingResolution,
  })(imageRecognitionContract);
  const request = {
    headers,
    body: {
      fileId: args.fileId,
      prompt: args.prompt ?? "Describe this image",
    },
  };
  return client.imageRecognition({ ...request, fetchOptions: { signal } });
}

async function createConfiguredImageRecognitionPricing(): Promise<UsagePricingFixture> {
  const pricing = await createUsagePricingFixture({
    configured: IMAGE_RECOGNITION_PRICING_ROWS,
  });
  onTestFinished(async () => {
    await pricing.cleanup();
  });
  return pricing;
}

async function createMissingImageRecognitionPricing(): Promise<UsagePricingFixture> {
  const pricing = await createUsagePricingFixture({
    missing: IMAGE_RECOGNITION_PRICING_ROWS,
  });
  onTestFinished(async () => {
    await pricing.cleanup();
  });
  return pricing;
}

async function seedImageRecognitionBilling(
  actor: ImageRecognitionActor,
): Promise<UsagePricingFixture> {
  await seedOrgMetadata({
    orgId: actor.orgId,
    tier: "pro",
    credits: STARTING_CREDITS,
  });
  return await createConfiguredImageRecognitionPricing();
}

function mockClerkUserLookup(): void {
  context.mocks.clerk.users.getUserList.mockResolvedValue({ data: [] });
}

async function readUsageRecord(actor: ImageRecognitionActor) {
  mockClerkUserLookup();
  mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
  const response = await accept(
    setupApp({ context, routes: usageRecordRoutes })(usageRecordContract).get({
      headers: { authorization: "Bearer clerk-session" },
      query: {
        page: 1,
        pageSize: 20,
        scope: "mine",
        range: "24h",
        tz: "UTC",
      },
    }),
    [200],
  );
  return response.body.rows;
}

async function expectNoUsage(actor: ImageRecognitionActor): Promise<void> {
  await expect(
    store.set(
      readUsageStorageCounts$,
      { scope: "organization", id: actor.orgId },
      context.signal,
    ),
  ).resolves.toStrictEqual({ raw: 0, hourly: 0 });
}

describe("POST /api/image-recognition", () => {
  it("excludes hostile content from the failure record and public response", async () => {
    // The single redaction exception: exercise the real endpoint and HTTP
    // boundaries. #34172 explicitly requires a finite diagnostic contract, so
    // verify the retained evidence together with the excluded content here.
    const secret = "private-image-prompt-provider-url-credential-canary";
    const actor = await seedImageRecognitionActor();
    const pricing = await seedImageRecognitionBilling(actor);
    const fileId = randomUUID();
    setStoredObjects([
      { userId: actor.userId, id: fileId, filename: "image.png", size: 12 },
    ]);
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    const output = context.mocks.console.log;
    onTestFinished(context.mocks.console.capture());
    const records = () => {
      return output.mock.calls.flatMap(([, fields]) => {
        return typeof fields === "object" &&
          fields !== null &&
          "type" in fields &&
          fields.type === "image_recognition_failure"
          ? [fields]
          : [];
      });
    };
    const completion = (
      content: unknown,
      finish = "stop",
      native = "STOP",
      usage: unknown = { prompt_tokens: 100, completion_tokens: 100 },
    ) => {
      return {
        choices: [
          {
            finish_reason: finish,
            native_finish_reason: native,
            message: { content },
            extra: secret,
          },
        ],
        usage,
        extra: secret,
      };
    };
    const bodyFailure = (status: number, code?: string) => {
      return new HttpResponse(
        new ReadableStream({
          start(controller) {
            controller.error(new Error(secret, { cause: { code, secret } }));
          },
        }),
        { status },
      );
    };
    const cases = [
      {
        response: () => {
          return HttpResponse.error();
        },
        status: 502,
        code: "IMAGE_RECOGNITION_FAILED",
        fields: { phase: "fetch", reason: "network" },
      },
      {
        response: () => {
          return bodyFailure(200, "UND_ERR_BODY_TIMEOUT");
        },
        status: 502,
        code: "IMAGE_RECOGNITION_FAILED",
        fields: {
          phase: "body_read",
          reason: "upstream_timeout",
          upstream_status: 200,
        },
      },
      {
        response: () => {
          return bodyFailure(503);
        },
        status: 502,
        code: "IMAGE_RECOGNITION_FAILED",
        fields: { phase: "body_read", reason: "unknown", upstream_status: 503 },
      },
      {
        response: () => {
          return HttpResponse.json(
            {
              error: {
                message: secret,
                code: secret,
                metadata: {
                  error_type: "invalid_image",
                  headers: secret,
                  raw: secret,
                },
              },
            },
            { status: 400 },
          );
        },
        status: 400,
        code: "INVALID_IMAGE",
        fields: {
          phase: "status",
          reason: "invalid_request",
          upstream_status: 400,
        },
      },
      {
        response: () => {
          return HttpResponse.json(
            { error: { message: secret } },
            { status: 429 },
          );
        },
        status: 503,
        code: "PROVIDER_UNAVAILABLE",
        fields: {
          phase: "status",
          reason: "rate_limited",
          upstream_status: 429,
        },
      },
      {
        response: () => {
          return HttpResponse.json({ error: { code: 503, message: secret } });
        },
        status: 503,
        code: "PROVIDER_UNAVAILABLE",
        fields: {
          phase: "output_validation",
          detail: "completion_error",
          reason: "provider_unavailable",
          upstream_status: 200,
        },
      },
      {
        response: () => {
          return HttpResponse.json({
            choices: [
              { finish_reason: "error", error: { code: 408, message: secret } },
            ],
          });
        },
        status: 503,
        code: "PROVIDER_UNAVAILABLE",
        fields: {
          phase: "output_validation",
          detail: "completion_error",
          reason: "upstream_timeout",
          upstream_status: 200,
          finish_reason: "error",
        },
      },
      {
        response: () => {
          return new HttpResponse(secret);
        },
        status: 502,
        code: "IMAGE_RECOGNITION_FAILED",
        fields: {
          phase: "json_validation",
          detail: "invalid_json",
          reason: "invalid_output",
          upstream_status: 200,
        },
      },
      {
        response: () => {
          return HttpResponse.json({ extra: secret });
        },
        status: 502,
        code: "IMAGE_RECOGNITION_FAILED",
        fields: {
          phase: "output_validation",
          detail: "missing_choices",
          reason: "invalid_output",
          upstream_status: 200,
        },
      },
      {
        response: () => {
          return HttpResponse.json(
            completion(secret, secret, secret, {
              completion_tokens: -1,
              completion_tokens_details: { reasoning_tokens: 1.9 },
              extra: secret,
            }),
          );
        },
        status: 502,
        code: "IMAGE_RECOGNITION_FAILED",
        fields: {
          phase: "output_validation",
          detail: "non_stop",
          reason: "invalid_output",
          upstream_status: 200,
          completion_tokens: 0,
          reasoning_tokens: 1,
        },
      },
      {
        response: () => {
          return HttpResponse.json(
            completion(secret, "length", "MAX_TOKENS", {
              completion_tokens: 8192,
              completion_tokens_details: { reasoning_tokens: 8100 },
            }),
          );
        },
        status: 502,
        code: "IMAGE_RECOGNITION_FAILED",
        fields: {
          phase: "output_validation",
          detail: "non_stop",
          reason: "output_truncated",
          upstream_status: 200,
          completion_tokens: 8192,
          reasoning_tokens: 8100,
          finish_reason: "length",
          native_finish_reason: "MAX_TOKENS",
        },
      },
      {
        response: () => {
          return HttpResponse.json(completion({ text: secret }));
        },
        status: 502,
        code: "IMAGE_RECOGNITION_FAILED",
        fields: {
          phase: "output_validation",
          detail: "invalid_content",
          reason: "invalid_output",
          upstream_status: 200,
          completion_tokens: 100,
          finish_reason: "stop",
          native_finish_reason: "STOP",
        },
      },
      {
        response: () => {
          return HttpResponse.json(completion("   "));
        },
        status: 502,
        code: "IMAGE_RECOGNITION_FAILED",
        fields: {
          phase: "output_validation",
          detail: "empty_content",
          reason: "invalid_output",
          upstream_status: 200,
          completion_tokens: 100,
          finish_reason: "stop",
          native_finish_reason: "STOP",
        },
      },
      {
        response: () => {
          return HttpResponse.json(
            completion(secret + "x".repeat(IMAGE_RECOGNITION_MAX_TEXT_CHARS)),
          );
        },
        status: 502,
        code: "IMAGE_RECOGNITION_FAILED",
        fields: {
          phase: "output_validation",
          reason: "output_too_large",
          upstream_status: 200,
          completion_tokens: 100,
          finish_reason: "stop",
          native_finish_reason: "STOP",
        },
      },
      {
        response: () => {
          return HttpResponse.json(
            completion(secret, "stop", secret, {
              completion_tokens: secret,
              completion_tokens_details: { reasoning_tokens: 1e30 },
            }),
          );
        },
        status: 502,
        code: "MISSING_PROVIDER_USAGE",
        fields: {
          phase: "usage_validation",
          reason: "incomplete_usage",
          upstream_status: 200,
          reasoning_tokens: Number.MAX_SAFE_INTEGER,
          finish_reason: "stop",
        },
      },
    ];
    const request = (signal?: AbortSignal) => {
      return requestImageRecognition(
        {
          token: okouToken(actor),
          fileId,
          prompt: secret,
          clientRequestId: secret,
          usagePricingResolution: pricing.resolution,
        },
        signal,
      );
    };
    const denied = await requestImageRecognition({
      token: okouToken(actor, ["file:write"]),
      fileId,
    });
    expect(denied.status).toBe(403);
    expect(records()).toStrictEqual([]);
    for (const testCase of cases) {
      output.mockClear();
      server.use(http.post(OPENROUTER_URL, testCase.response));
      const response = await request();
      expect(response.status).toBe(testCase.status);
      expect(response.body).toMatchObject({ error: { code: testCase.code } });
      expect(records()).toStrictEqual([
        {
          type: "image_recognition_failure",
          operation_id: expect.any(String),
          run_id: actor.runId,
          duration_ms: expect.any(Number),
          request_aborted: false,
          operation_aborted: false,
          public_status: testCase.status,
          public_code: testCase.code,
          ...testCase.fields,
        },
      ]);
      expect(JSON.stringify([records(), response.body])).not.toContain(secret);
    }
    await expect(readUsageRecord(actor)).resolves.toStrictEqual([]);

    // A request can disconnect after the body was read, then reject for an
    // unrelated reason. Inject that infrastructure-only race at Response.text,
    // without replacing fetch, the parser, service, or settlement.
    const controller = new AbortController();
    onTestFinished(() => {
      return controller.abort();
    });
    const restoreText = context.mocks.httpResponse.observeText((body) => {
      if (body.includes("late-provider-result")) {
        controller.abort(new DOMException(secret, "AbortError"));
        throw new Error(secret);
      }
    });
    onTestFinished(restoreText);
    server.use(
      http.post(OPENROUTER_URL, () => {
        return HttpResponse.json(completion("late-provider-result"));
      }),
    );
    output.mockClear();
    const late = await request(controller.signal);
    expect(late.status).toBe(502);
    expect(records()).toStrictEqual([
      {
        type: "image_recognition_failure",
        operation_id: expect.any(String),
        run_id: actor.runId,
        duration_ms: expect.any(Number),
        phase: "body_read",
        reason: "unknown",
        upstream_status: 200,
        public_status: 502,
        public_code: "IMAGE_RECOGNITION_FAILED",
        request_aborted: true,
        operation_aborted: false,
      },
    ]);
    expect(JSON.stringify([records(), late.body])).not.toContain(secret);
    restoreText();

    output.mockClear();
    server.use(
      http.post(OPENROUTER_URL, () => {
        return HttpResponse.json(completion("A usable result"));
      }),
    );
    expect((await request()).status).toBe(200);
    expect(records()).toStrictEqual([]);

    const pricingIdentity = pricing.resolution.find((entry) => {
      return (
        entry.kind === "image-recognition" &&
        entry.provider === "xiaomi/mimo-v2.5"
      );
    });
    if (!pricingIdentity) {
      throw new Error("Expected recognition pricing identity");
    }
    server.use(
      http.post(OPENROUTER_URL, async () => {
        // Pricing administration has no public endpoint. Remove only this
        // fixture's output price after admission to exercise real settlement.
        await deleteUsagePricingRows({
          kind: "image-recognition",
          provider: pricingIdentity.lookupProvider,
          categories: ["tokens.output"],
        });
        return HttpResponse.json(completion(secret));
      }),
    );
    output.mockClear();
    const unsettled = await request();
    expect(unsettled.status).toBe(500);
    expect(records()).toStrictEqual([
      {
        type: "image_recognition_failure",
        operation_id: expect.any(String),
        run_id: actor.runId,
        duration_ms: expect.any(Number),
        phase: "settlement",
        reason: "unsettled",
        upstream_status: 200,
        finish_reason: "stop",
        native_finish_reason: "STOP",
        completion_tokens: 100,
        request_aborted: false,
        operation_aborted: false,
      },
    ]);
    expect(JSON.stringify([records(), unsettled.body])).not.toContain(secret);
  });

  it("settles completed provider work exactly once after the request disconnects", async () => {
    const actor = await seedImageRecognitionActor();
    const pricing = await seedImageRecognitionBilling(actor);
    const fileId = randomUUID();
    setStoredObjects([
      { userId: actor.userId, id: fileId, filename: "image.png", size: 12 },
    ]);
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    const controller = new AbortController();
    onTestFinished(() => {
      return controller.abort();
    });
    let calls = 0;
    server.use(
      http.post(OPENROUTER_URL, () => {
        calls += 1;
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "completed-provider-result" },
            },
          ],
          usage: {
            prompt_tokens: 3000,
            completion_tokens: 1000,
            prompt_tokens_details: { cached_tokens: 1000 },
          },
        });
      }),
    );
    // The HTTP client cannot select the gap after Response.text has consumed
    // the body and before the service settles. Own that exact I/O boundary.
    const restoreText = context.mocks.httpResponse.observeText((body) => {
      if (body.includes("completed-provider-result")) {
        controller.abort(new DOMException("Client disconnected", "AbortError"));
      }
    });
    onTestFinished(restoreText);
    const result = await requestImageRecognition(
      {
        token: okouToken(actor),
        fileId,
        usagePricingResolution: pricing.resolution,
      },
      controller.signal,
    );
    restoreText();
    expect(result.status).toBe(200);
    expect(result.body).toStrictEqual({
      text: "completed-provider-result",
      metadata: { creditsCharged: EXPECTED_CHARGE },
    });
    expect(controller.signal.aborted).toBeTruthy();
    expect(calls).toBe(1);
    await expect(readUsageRecord(actor)).resolves.toStrictEqual([
      expect.objectContaining({
        title: "Unavailable thread",
        threadId: null,
        tokens: 4000,
        credits: EXPECTED_CHARGE,
      }),
    ]);
  });

  it.each([
    ["operation", "AbortError"],
    ["operation", "TimeoutError"],
    ["request", "AbortError"],
    ["request", "TimeoutError"],
  ])(
    "preserves the %s %s outcome when diagnostics fail",
    async (owner, name) => {
      const actor = await seedImageRecognitionActor();
      const pricing = await seedImageRecognitionBilling(actor);
      const fileId = randomUUID();
      setStoredObjects([
        { userId: actor.userId, id: fileId, filename: "image.png", size: 12 },
      ]);
      mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
      const controller = new AbortController();
      onTestFinished(() => {
        return controller.abort();
      });
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      onTestFinished(() => {
        if (!release.settled()) {
          release.resolve(undefined);
        }
      });
      server.use(
        http.post(OPENROUTER_URL, async () => {
          entered.resolve(undefined);
          await release.promise;
          return HttpResponse.json({});
        }),
      );
      // Infrastructure owns the operation signal; HTTP cannot abort that owner.
      const client = setupApp({
        context,
        routes: imageRecognitionRoutes,
        signal: owner === "operation" ? controller.signal : context.signal,
        rethrowErrors: true,
        usagePricingResolution: pricing.resolution,
      })(imageRecognitionContract);
      context.mocks.console.log.mockImplementation((message) => {
        if (
          typeof message === "string" &&
          message.includes("[api:image-recognition]")
        ) {
          throw new DOMException("Exporter unavailable", "AbortError");
        }
      });
      onTestFinished(context.mocks.console.capture());
      const reason = new DOMException("Operation ended", name);
      const request = client.imageRecognition({
        headers: { authorization: `Bearer ${okouToken(actor)}` },
        body: { fileId, prompt: "Describe" },
        fetchOptions: {
          signal: owner === "request" ? controller.signal : undefined,
        },
      });
      // settle propagates AbortError; a request TimeoutError is already a
      // handled 502. Operation cancellation still throws its exact reason.
      const result = (async () => {
        if (owner === "request" && name === "TimeoutError") {
          await expect(request).resolves.toMatchObject({
            status: 502,
            body: {
              error: {
                code: "IMAGE_RECOGNITION_FAILED",
                message:
                  "Image recognition failed to produce a usable response",
              },
            },
          });
        } else {
          await expect(request).rejects.toBe(reason);
        }
      })();
      await entered.promise;
      controller.abort(reason);
      release.resolve(undefined);
      await result;
      await expect(readUsageRecord(actor)).resolves.toStrictEqual([]);
    },
  );

  it("preserves the handled provider result when the logger throws", async () => {
    const actor = await seedImageRecognitionActor();
    const pricing = await seedImageRecognitionBilling(actor);
    const fileId = randomUUID();
    setStoredObjects([
      { userId: actor.userId, id: fileId, filename: "image.png", size: 12 },
    ]);
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    server.use(
      http.post(OPENROUTER_URL, () => {
        return HttpResponse.json({});
      }),
    );
    context.mocks.console.log.mockImplementation((message) => {
      if (
        typeof message === "string" &&
        message.includes("[api:image-recognition]")
      ) {
        throw new Error("Exporter unavailable");
      }
    });
    onTestFinished(context.mocks.console.capture());
    const response = await requestImageRecognition({
      token: okouToken(actor),
      fileId,
      usagePricingResolution: pricing.resolution,
    });
    expect(response.status).toBe(502);
    expect(response.body).toStrictEqual({
      error: {
        code: "IMAGE_RECOGNITION_FAILED",
        message: "Image recognition failed to produce a usable response",
      },
    });
    await expect(readUsageRecord(actor)).resolves.toStrictEqual([]);
  });

  it("recognizes one owned image and settles each real invocation", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    const requestBodies: unknown[] = [];
    server.use(
      http.post(OPENROUTER_URL, async ({ request }) => {
        requestBodies.push(await request.json());
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "A red warning banner is visible." },
            },
          ],
          usage: {
            prompt_tokens: 3000,
            completion_tokens: 1000,
            prompt_tokens_details: { cached_tokens: 1000 },
          },
        });
      }),
    );
    const actor = await seedImageRecognitionActor();
    const pricing = await seedImageRecognitionBilling(actor);
    const fileId = randomUUID();
    setStoredObjects([
      { userId: actor.userId, id: fileId, filename: "screen.png", size: 1024 },
    ]);
    const clientRequestId = randomUUID();

    for (let invocation = 0; invocation < 2; invocation += 1) {
      const response = await requestImageRecognition({
        token: okouToken(actor),
        fileId,
        prompt: "Read the warning",
        clientRequestId,
        usagePricingResolution: pricing.resolution,
      });
      expect(response.status).toBe(200);
      expect(response.body).toStrictEqual({
        text: "A red warning banner is visible.",
        metadata: { creditsCharged: EXPECTED_CHARGE },
      });
    }

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).toMatchObject({
      model: "xiaomi/mimo-v2.5",
      max_tokens: 8192,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Read the warning" },
            {
              type: "image_url",
              image_url: {
                url: expect.stringMatching(
                  new RegExp(`^https://r2\\.example\\.com/.+${fileId}`, "u"),
                ),
              },
            },
          ],
        },
      ],
    });
    await expect(
      store.set(
        readUsageStorageCounts$,
        { scope: "organization", id: actor.orgId },
        context.signal,
      ),
    ).resolves.toStrictEqual({ raw: 6, hourly: 0 });
    await expect(readUsageRecord(actor)).resolves.toStrictEqual([
      expect.objectContaining({
        title: "Unavailable thread",
        threadId: null,
        tokens: 8000,
        credits: EXPECTED_CHARGE * 2,
      }),
    ]);
  });

  it("signs a private input for image recognition after creation is disabled", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    const actor = await seedImageRecognitionActor();
    const pricing = await seedImageRecognitionBilling(actor);
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.PrivateArtifacts]: true,
    });
    installSharedThreadStorage(context);
    const uploads = setupApp({
      context,
      routes: [...uploadsPrepareRoutes, ...uploadsCompleteRoutes],
    })(uploadsContract);
    const headers = { authorization: "Bearer clerk-session" };
    const prepared = await accept(
      uploads.prepare({
        headers,
        body: { filename: "screen.png", contentType: "image/png", size: 12 },
      }),
      [200],
    );
    if (!("uploadUrl" in prepared.body)) {
      throw new Error("Expected single upload");
    }
    await fetch(prepared.body.uploadUrl, {
      method: "PUT",
      body: "image bytes!",
    });
    await accept(
      uploads.complete({ headers, body: { id: prepared.body.id } }),
      [200],
    );
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.PrivateArtifacts]: false,
    });
    const requests: unknown[] = [];
    server.use(
      http.post(OPENROUTER_URL, async ({ request }) => {
        requests.push(await request.json());
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "A private screenshot" },
            },
          ],
          usage: {
            prompt_tokens: 3000,
            completion_tokens: 1000,
            prompt_tokens_details: { cached_tokens: 1000 },
          },
        });
      }),
    );
    const response = await requestImageRecognition({
      token: okouToken(actor),
      fileId: prepared.body.id,
      prompt: "Describe",
      usagePricingResolution: pricing.resolution,
    });
    expect(response.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe" },
            {
              type: "image_url",
              image_url: { url: "https://attachment-storage.example/download" },
            },
          ],
        },
      ],
    });
    const signed = context.mocks.s3.getSignedUrl.mock.calls.at(-1)?.[1];
    expect(signed).toBeInstanceOf(GetObjectCommand);
    expect(signed).toMatchObject({
      input: { Bucket: "test-private-artifacts" },
    });
  });

  it("continues an admitted run after credits are exhausted", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    server.use(
      http.post(OPENROUTER_URL, () => {
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "An admitted run image." },
            },
          ],
          usage: {
            prompt_tokens: 3000,
            completion_tokens: 1000,
            prompt_tokens_details: { cached_tokens: 1000 },
          },
        });
      }),
    );
    const actor = await seedAdmittedImageRecognitionActor();
    const pricing = await createConfiguredImageRecognitionPricing();
    await seedOrgMetadata({ orgId: actor.orgId, tier: "pro", credits: 0 });
    const fileId = randomUUID();
    setStoredObjects([
      { userId: actor.userId, id: fileId, filename: "screen.png", size: 1024 },
    ]);

    const response = await requestImageRecognition({
      token: okouToken(actor),
      fileId,
      usagePricingResolution: pricing.resolution,
    });

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({
      text: "An admitted run image.",
      metadata: { creditsCharged: EXPECTED_CHARGE },
    });
    await expect(
      createRunsApi(context).readBillingStatus(actor),
    ).resolves.toMatchObject({ credits: -EXPECTED_CHARGE });
    await expect(readUsageRecord(actor)).resolves.toStrictEqual([
      expect.objectContaining({
        credits: EXPECTED_CHARGE,
      }),
    ]);
  });

  it("enforces agent-only capability authorization before object access", async () => {
    const actor = await seedImageRecognitionActor();
    const fileId = randomUUID();

    const unauthenticated = await requestImageRecognition({ fileId });
    expect(unauthenticated.status).toBe(401);

    const missingCapability = await requestImageRecognition({
      token: okouToken(actor, ["file:write"]),
      fileId,
    });
    expect(missingCapability.status).toBe(403);

    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    const sessionResponse = await requestImageRecognition({
      token: "clerk-session",
      fileId,
    });
    expect(sessionResponse.status).toBe(403);
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("rejects non-owned and invalid uploaded image metadata", async () => {
    const actor = await seedImageRecognitionActor();
    const otherUserFileId = randomUUID();
    const gifId = randomUUID();
    const emptyId = randomUUID();
    const oversizedId = randomUUID();
    setStoredObjects([
      {
        userId: randomUUID(),
        id: otherUserFileId,
        filename: "other.png",
        size: 10,
      },
      { userId: actor.userId, id: gifId, filename: "image.gif", size: 10 },
      { userId: actor.userId, id: emptyId, filename: "empty.png", size: 0 },
      {
        userId: actor.userId,
        id: oversizedId,
        filename: "large.webp",
        size: IMAGE_RECOGNITION_MAX_FILE_BYTES + 1,
      },
    ]);
    const token = okouToken(actor);

    const cases = [
      { fileId: otherUserFileId, status: 404, code: "NOT_FOUND" },
      { fileId: gifId, status: 400, code: "UNSUPPORTED_IMAGE_TYPE" },
      { fileId: emptyId, status: 400, code: "EMPTY_IMAGE" },
      { fileId: oversizedId, status: 413, code: "IMAGE_TOO_LARGE" },
    ] as const;
    for (const testCase of cases) {
      const response = await requestImageRecognition({
        token,
        fileId: testCase.fileId,
      });
      expect(response.status).toBe(testCase.status);
      expect(response.body).toMatchObject({
        error: { code: testCase.code },
      });
    }
    await expectNoUsage(actor);
  });

  it("fails before the provider when credits or pricing are unavailable", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    let providerCalled = false;
    server.use(
      http.post(OPENROUTER_URL, () => {
        providerCalled = true;
        return HttpResponse.json({});
      }),
    );
    const actor = await seedImageRecognitionActor();
    const configuredPricing = await createConfiguredImageRecognitionPricing();
    const fileId = randomUUID();
    setStoredObjects([
      { userId: actor.userId, id: fileId, filename: "screen.jpg", size: 100 },
    ]);
    await seedOrgMetadata({ orgId: actor.orgId, tier: "pro", credits: 0 });

    const noCredits = await requestImageRecognition({
      token: okouToken(actor),
      fileId,
      usagePricingResolution: configuredPricing.resolution,
    });
    expect(noCredits.status).toBe(402);

    await seedOrgMetadata({
      orgId: actor.orgId,
      tier: "pro",
      credits: STARTING_CREDITS,
    });
    const missingPricing = await createMissingImageRecognitionPricing();
    const noPricing = await requestImageRecognition({
      token: okouToken(actor),
      fileId,
      usagePricingResolution: missingPricing.resolution,
    });
    expect(noPricing.status).toBe(503);
    expect(providerCalled).toBeFalsy();
    await expectNoUsage(actor);
  });

  it("maps provider image errors without exposing raw provider text", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    let providerCall = 0;
    server.use(
      http.post(OPENROUTER_URL, () => {
        providerCall += 1;
        return HttpResponse.json(
          {
            error: {
              message: "raw-provider-secret-detail",
              metadata: {
                error_type:
                  providerCall === 1
                    ? "invalid_image"
                    : "invalid_image\ninjected",
              },
            },
          },
          { status: 400 },
        );
      }),
    );
    const actor = await seedImageRecognitionActor();
    const pricing = await seedImageRecognitionBilling(actor);
    const fileId = randomUUID();
    setStoredObjects([
      { userId: actor.userId, id: fileId, filename: "broken.png", size: 12 },
    ]);

    const response = await requestImageRecognition({
      token: okouToken(actor),
      fileId,
      usagePricingResolution: pricing.resolution,
    });
    expect(response.status).toBe(400);
    const responseText = JSON.stringify(response.body);
    expect(responseText).toContain("INVALID_IMAGE");
    expect(responseText).not.toContain("raw-provider-secret-detail");

    const malformedType = await requestImageRecognition({
      token: okouToken(actor),
      fileId,
      usagePricingResolution: pricing.resolution,
    });
    expect(malformedType.status).toBe(502);
    expect(JSON.stringify(malformedType.body)).not.toContain("injected");
    await expectNoUsage(actor);
  });

  it("rejects usable text when provider usage metadata is incomplete", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    const usages = [
      undefined,
      { prompt_tokens: 10 },
      { completion_tokens: 10 },
    ] as const;
    const actor = await seedImageRecognitionActor();
    const pricing = await seedImageRecognitionBilling(actor);
    const fileId = randomUUID();
    setStoredObjects([
      { userId: actor.userId, id: fileId, filename: "screen.webp", size: 12 },
    ]);

    for (const usage of usages) {
      server.use(
        http.post(OPENROUTER_URL, () => {
          return HttpResponse.json({
            choices: [
              {
                finish_reason: "stop",
                message: { content: "Unbilled result" },
              },
            ],
            ...(usage === undefined ? {} : { usage }),
          });
        }),
      );
      const response = await requestImageRecognition({
        token: okouToken(actor),
        fileId,
        usagePricingResolution: pricing.resolution,
      });
      expect(response.status).toBe(502);
      expect(response.body).toMatchObject({
        error: { code: "MISSING_PROVIDER_USAGE" },
      });
    }
    await expectNoUsage(actor);
  });

  it("rejects incomplete or empty provider output without recording usage", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    let providerCall = 0;
    server.use(
      http.post(OPENROUTER_URL, () => {
        providerCall += 1;
        if (providerCall === 1) {
          return HttpResponse.json({
            choices: [
              {
                finish_reason: "length",
                message: { content: "Incomplete result" },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10 },
          });
        }
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "   " },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        });
      }),
    );
    const actor = await seedImageRecognitionActor();
    const pricing = await seedImageRecognitionBilling(actor);
    const fileId = randomUUID();
    setStoredObjects([
      { userId: actor.userId, id: fileId, filename: "screen.png", size: 12 },
    ]);

    for (let invocation = 0; invocation < 2; invocation += 1) {
      const response = await requestImageRecognition({
        token: okouToken(actor),
        fileId,
        usagePricingResolution: pricing.resolution,
      });
      expect(response.status).toBe(502);
      expect(response.body).toMatchObject({
        error: { code: "IMAGE_RECOGNITION_FAILED" },
      });
    }
    expect(providerCall).toBe(2);
    await expectNoUsage(actor);
  });

  it("does not return text when settlement reports a billing error", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    const actor = await seedImageRecognitionActor();
    const pricing = await seedImageRecognitionBilling(actor);
    const pricingIdentity = pricing.resolution.find((entry) => {
      return (
        entry.kind === "image-recognition" &&
        entry.provider === "xiaomi/mimo-v2.5"
      );
    });
    if (!pricingIdentity) {
      throw new Error(
        "Image recognition pricing fixture requires a lookup identity",
      );
    }
    server.use(
      http.post(OPENROUTER_URL, async () => {
        await deleteUsagePricingRows({
          kind: "image-recognition",
          provider: pricingIdentity.lookupProvider,
          categories: ["tokens.output"],
        });
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "This text must not be returned" },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 100 },
        });
      }),
    );
    const fileId = randomUUID();
    setStoredObjects([
      { userId: actor.userId, id: fileId, filename: "screen.png", size: 12 },
    ]);

    const response = await requestImageRecognition({
      token: okouToken(actor),
      fileId,
      usagePricingResolution: pricing.resolution,
    });
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain(
      "This text must not be returned",
    );
    await expect(
      store.set(
        readUsageStorageCounts$,
        { scope: "organization", id: actor.orgId },
        context.signal,
      ),
    ).resolves.toStrictEqual({ raw: 2, hourly: 0 });
  });
});
