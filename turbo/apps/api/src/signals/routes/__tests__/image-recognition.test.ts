import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { CLIENT_REQUEST_ID_HEADER } from "@okouai/api-contracts/contracts/client-headers";
import {
  IMAGE_RECOGNITION_MAX_FILE_BYTES,
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

function requestImageRecognition(args: {
  readonly token?: string;
  readonly fileId: string;
  readonly prompt?: string;
  readonly clientRequestId?: string;
  readonly usagePricingResolution?: UsagePricingFixture["resolution"];
}) {
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
  return client.imageRecognition(request);
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
        runId: actor.runId,
        tokens: 8000,
        credits: EXPECTED_CHARGE * 2,
      }),
    ]);
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
