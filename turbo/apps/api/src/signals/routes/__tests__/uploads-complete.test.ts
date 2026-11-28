import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { beforeAll } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { buildArtifactKey, buildArtifactKeyV2 } from "../../../lib/file-url";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";
import { createRunExecutionCredentials } from "./helpers/run-execution-credentials";

const context = testContext();
const bdd = createBddApi(context);
const credentials = createRunExecutionCredentials(context, {
  preferences: false,
});
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const ARTIFACTS_BUCKET = "test-user-artifacts";

interface StoredUploadObject {
  readonly bucket: string;
  readonly key: string;
  readonly body: Buffer;
  readonly size: number;
  readonly contentType?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly lastModified: Date;
}

function member() {
  return { userId: `user_${randomUUID()}`, orgId: `org_${randomUUID()}` };
}

function uploadsClient(actor: {
  readonly userId: string;
  readonly orgId: string | null;
}) {
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
  return setupApp({
    context,
    routes: [...uploadsPrepareRoutes, ...uploadsCompleteRoutes],
  })(uploadsContract);
}

function uploadsBearerClient() {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  return setupApp({
    context,
    routes: [...uploadsPrepareRoutes, ...uploadsCompleteRoutes],
  })(uploadsContract);
}

function mockActorMembership(actor: ApiTestUser): void {
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: actor.orgId
      ? [
          {
            role: actor.orgRole ?? "org:admin",
            organization: { id: actor.orgId },
          },
        ]
      : [],
  });
}

function installUploadStorage(
  initialObjects: readonly {
    readonly bucket: string;
    readonly key: string;
    readonly size: number;
    readonly contentType?: string;
    readonly metadata?: Readonly<Record<string, string>>;
    readonly body?: Buffer;
  }[] = [],
) {
  const objects = new Map<string, StoredUploadObject>();
  const defaultDate = new Date("2026-01-01T00:00:00.000Z");

  function putObject(entry: {
    readonly bucket: string;
    readonly key: string;
    readonly size: number;
    readonly contentType?: string;
    readonly metadata?: Readonly<Record<string, string>>;
    readonly body?: Buffer;
  }): void {
    objects.set(`${entry.bucket}/${entry.key}`, {
      bucket: entry.bucket,
      key: entry.key,
      body: entry.body ?? Buffer.alloc(0),
      size: entry.size,
      contentType: entry.contentType,
      metadata: entry.metadata,
      lastModified: defaultDate,
    });
  }

  for (const entry of initialObjects) {
    putObject(entry);
  }

  context.mocks.s3.getSignedUrl.mockResolvedValue(
    "https://r2.example.com/uploads/presigned",
  );
  function readCommandInput(command: unknown) {
    if (
      typeof command !== "object" ||
      command === null ||
      !("input" in command) ||
      typeof command.input !== "object" ||
      command.input === null
    ) {
      return undefined;
    }
    return command.input as {
      readonly Bucket?: unknown;
      readonly Key?: unknown;
      readonly Prefix?: unknown;
      readonly Body?: unknown;
      readonly ContentType?: unknown;
      readonly Metadata?: unknown;
    };
  }

  function handlePutObject(
    bucket: string,
    key: string,
    input: ReturnType<typeof readCommandInput>,
  ) {
    const rawBody = input?.Body;
    const body =
      typeof rawBody === "string"
        ? Buffer.from(rawBody, "utf8")
        : rawBody instanceof Uint8Array
          ? Buffer.from(rawBody)
          : Buffer.alloc(0);
    const metadata =
      typeof input?.Metadata === "object" && input.Metadata !== null
        ? (input.Metadata as Record<string, string>)
        : undefined;
    putObject({
      bucket,
      key,
      body,
      size: body.byteLength,
      contentType:
        typeof input?.ContentType === "string" ? input.ContentType : undefined,
      metadata,
    });
    return Promise.resolve({ ETag: '"etag-1"' });
  }

  function handleGetObject(fullKey: string) {
    const entry = objects.get(fullKey);
    if (!entry) {
      return Promise.reject(
        Object.assign(new Error(`Missing object: ${fullKey}`), {
          name: "NoSuchKey",
          $metadata: { httpStatusCode: 404 },
        }),
      );
    }
    const stream = Readable.from([entry.body]);
    return Promise.resolve({
      ContentLength: entry.size,
      ContentType: entry.contentType,
      ETag: '"etag-1"',
      Body: Object.assign(stream, {
        transformToString: () => {
          return Promise.resolve(entry.body.toString("utf8"));
        },
      }),
    });
  }

  function handleHeadObject(fullKey: string) {
    const entry = objects.get(fullKey);
    if (!entry) {
      return Promise.reject(
        Object.assign(new Error(`Missing object: ${fullKey}`), {
          name: "NotFound",
          $metadata: { httpStatusCode: 404 },
        }),
      );
    }
    return Promise.resolve({
      ContentLength: entry.size,
      ContentType: entry.contentType,
      LastModified: entry.lastModified,
      Metadata: entry.metadata ?? {},
    });
  }

  function handleListObjects(bucket: string, prefix: string) {
    const contents = [...objects.values()]
      .filter((entry) => {
        return entry.bucket === bucket && entry.key.startsWith(prefix);
      })
      .map((entry) => {
        return {
          Key: entry.key,
          Size: entry.size,
          LastModified: entry.lastModified,
        };
      });
    return Promise.resolve({ Contents: contents });
  }

  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const name =
      typeof command === "object" && command !== null
        ? command.constructor.name
        : "";
    const input = readCommandInput(command);
    const bucket = typeof input?.Bucket === "string" ? input.Bucket : "";
    const key = typeof input?.Key === "string" ? input.Key : "";
    const fullKey = `${bucket}/${key}`;

    if (name === "PutObjectCommand" && bucket && key) {
      return handlePutObject(bucket, key, input);
    }
    if (name === "GetObjectCommand") {
      return handleGetObject(fullKey);
    }
    if (name === "HeadObjectCommand") {
      return handleHeadObject(fullKey);
    }
    if (name === "ListObjectsV2Command") {
      return handleListObjects(
        bucket,
        typeof input?.Prefix === "string" ? input.Prefix : "",
      );
    }
    return Promise.resolve({});
  });

  return { putObject };
}

describe("POST /api/uploads/complete", () => {
  beforeAll(async () => {
    await createRunsApi(context).configureRunnerGroup();
  });

  it("uploads-complete-005 completes an ordinary session upload without a run artifact association", async () => {
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/uploads/plain.txt",
    );
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const { constructor, input } = command as {
        readonly constructor: { readonly name: string };
        readonly input?: { readonly Key?: string };
      };
      if (
        constructor.name === "GetObjectCommand" &&
        !input?.Key?.startsWith("private-artifacts/")
      ) {
        return Promise.reject(
          Object.assign(new Error("Missing object"), {
            name: "NoSuchKey",
          }),
        );
      }
      if (constructor.name === "HeadObjectCommand") {
        return Promise.resolve({
          ContentLength: 5,
          ContentType: "text/plain",
        });
      }
      if (constructor.name === "GetObjectCommand") {
        return Promise.resolve({
          ContentLength: 5,
          ContentType: "text/plain",
          Body: Readable.from([Buffer.from("hello")]),
        });
      }
      if (constructor.name === "PutObjectCommand") {
        return Promise.resolve({ ETag: '"etag-1"' });
      }
      return Promise.resolve({});
    });

    const client = uploadsClient(member());
    const prepared = await accept(
      client.prepare({
        headers,
        body: {
          filename: "plain.txt",
          contentType: "text/plain",
          size: 5,
        },
      }),
      [200],
    );

    const completed = await accept(
      client.complete({
        headers,
        body: { id: prepared.body.id },
      }),
      [200],
    );

    expect(completed.body).toMatchObject({
      id: prepared.body.id,
      filename: "plain.txt",
      size: 5,
    });
  });

  it(
    "uploads-complete-007 resolves the CDN from the immutable object layout marker",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const actor = bdd.user();
      const token = await credentials.okouToken(actor);
      const storage = installUploadStorage();

      const prepared = await accept(
        uploadsClient({ userId: actor.userId, orgId: null }).prepare({
          headers,
          body: {
            filename: "okou-report.pdf",
            contentType: "application/pdf",
            size: 256,
          },
        }),
        [200],
      );
      storage.putObject({
        bucket: ARTIFACTS_BUCKET,
        key: buildArtifactKeyV2(prepared.body.id, "okou-report.pdf"),
        size: 256,
        contentType: "application/pdf",
        metadata: {
          "artifact-id": prepared.body.id,
          filename: encodeURIComponent("okou-report.pdf"),
          "user-id": encodeURIComponent(actor.userId),
          "public-brand": "okou",
        },
      });
      mockActorMembership(actor);

      const completed = await accept(
        uploadsBearerClient().complete({
          headers: { authorization: `Bearer ${token}` },
          body: { id: prepared.body.id },
        }),
        [200],
      );

      expect(completed.body).toMatchObject({
        id: prepared.body.id,
        filename: "okou-report.pdf",
      });
      const completedUrl = new URL(completed.body.url);
      expect(completedUrl.origin).toBe("https://a.okou.io");
      expect(completedUrl.pathname.endsWith(".pdf")).toBeTruthy();
      expect(completedUrl.pathname.slice(1, -4)).toHaveLength(10);
    },
  );

  it(
    "uploads-complete-011 infers audio content type from uploaded filename",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const actor = bdd.user();
      const token = await credentials.okouToken(actor);
      const fileId = randomUUID();
      installUploadStorage([
        {
          bucket: ARTIFACTS_BUCKET,
          key: buildArtifactKey(actor.userId, fileId, "clip.mp3"),
          size: 2048,
        },
      ]);
      mockActorMembership(actor);

      const completed = await accept(
        uploadsBearerClient().complete({
          headers: { authorization: `Bearer ${token}` },
          body: { id: fileId },
        }),
        [200],
      );

      expect(completed.body).toMatchObject({
        id: fileId,
        filename: "clip.mp3",
        contentType: "audio/mpeg",
        size: 2048,
      });
    },
  );

  it(
    "uploads-complete-012 is idempotent for repeated completion calls for the same run file",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const actor = bdd.user();
      const token = await credentials.okouToken(actor);
      const fileId = randomUUID();
      installUploadStorage([
        {
          bucket: ARTIFACTS_BUCKET,
          key: buildArtifactKey(actor.userId, fileId, "retry.txt"),
          size: 7,
        },
      ]);
      mockActorMembership(actor);
      const agentHeaders = { authorization: `Bearer ${token}` };

      const first = await accept(
        uploadsBearerClient().complete({
          headers: agentHeaders,
          body: { id: fileId },
        }),
        [200],
      );
      const second = await accept(
        uploadsBearerClient().complete({
          headers: agentHeaders,
          body: { id: fileId },
        }),
        [200],
      );

      expect(second.body).toStrictEqual(first.body);
    },
  );

  it(
    "uploads-complete-014 returns 404 when the uploaded object cannot be found",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const actor = bdd.user();
      const token = await credentials.okouToken(actor);
      installUploadStorage();
      mockActorMembership(actor);

      const response = await accept(
        uploadsBearerClient().complete({
          headers: { authorization: `Bearer ${token}` },
          body: { id: randomUUID() },
        }),
        [404],
      );

      expect(response.body).toStrictEqual({
        error: { message: "Uploaded file not found", code: "NOT_FOUND" },
      });
    },
  );

  it("uploads-complete-015 rejects suspended orgs before completing the upload", async () => {
    const actor = member();
    const suffix = randomUUID();
    const customerId = `cus_unfunded_pro_${suffix}`;
    const subscription = {
      id: `sub_unfunded_pro_${suffix}`,
      customer: customerId,
      status: "active",
      metadata: {},
      cancel_at_period_end: false,
      cancel_at: null,
      schedule: null,
      trial_end: null,
      items: { data: [{ price: { id: "price_bdd_pro" } }] },
    };

    const webhooks = createWebhookCallbackApi(context);
    webhooks.configureStripeBillingEnv();
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      metadata: { orgId: actor.orgId },
    });
    await webhooks.postStripeEvent(
      {
        id: `evt_pro_created_${suffix}`,
        type: "customer.subscription.created",
        created: Math.floor(now() / 1000),
        data: { object: subscription },
      },
      [200],
    );
    await webhooks.postStripeEvent(
      {
        id: `evt_pro_suspended_${suffix}`,
        type: "customer.subscription.updated",
        created: Math.floor(now() / 1000),
        data: { object: { ...subscription, status: "canceled" } },
      },
      [200],
    );
    await flushWaitUntilForTest();

    const response = await accept(
      uploadsClient(actor).complete({
        headers,
        body: { id: randomUUID() },
      }),
      [402],
    );

    expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it(
    "uploads-complete-017 returns 403 for an agent token without file:write capability",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const admin = bdd.user({ orgRole: "org:admin" });
      const sandboxToken = await credentials.sandboxToken(admin);

      const response = await accept(
        uploadsBearerClient().complete({
          headers: { authorization: `Bearer ${sandboxToken}` },
          body: { id: randomUUID() },
        }),
        [403],
      );

      expect(response.body.error.code).toBe("FORBIDDEN");
      expect(response.body.error.message).toContain("file:write");
    },
  );
});
