import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import {
  chatThreadArtifactsContract,
  chatThreadEventsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http } from "msw";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { buildArtifactKey } from "../../../lib/file-url";
import { hostedLinkOrigin } from "../../../lib/link-layout";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { artifactCatalogRoutes } from "../artifact-catalog";
import { artifactReferenceRoutes } from "../artifact-references";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { featureSwitchesRoutes } from "../feature-switches";
import { hostRoutes } from "../host";
import { sharedThreadRoutes } from "../shared-threads";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createHostBddApi } from "./helpers/api-bdd-host";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  mockGoogleText,
  VERTEX_TEXT_URL,
  vertexTextResponse,
} from "./helpers/google-text";
import { createRouteMocks } from "./helpers/route-test";
import { installSharedThreadStorage } from "./helpers/shared-thread-storage";

const context = testContext();
const bdd = createBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function signIn(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return headers;
}

function catalogApi(actor: ApiTestUser) {
  signIn(actor);
  return setupApp({ context, routes: artifactCatalogRoutes })(
    artifactCatalogContract,
  );
}

async function grantProPlan(actor: ApiTestUser): Promise<void> {
  const suffix = randomUUID();
  const customerId = `cus_pro_${suffix}`;
  const webhooks = createWebhookCallbackApi(context);
  webhooks.configureStripeBillingEnv();
  context.mocks.stripe.customers.retrieve.mockResolvedValue({
    id: customerId,
    metadata: { orgId: actor.orgId },
  });
  await webhooks.postStripeEvent(
    {
      id: `evt_pro_${suffix}`,
      type: "customer.subscription.created",
      created: Math.floor(now() / 1000),
      data: {
        object: {
          id: `sub_pro_${suffix}`,
          customer: customerId,
          status: "active",
          metadata: {},
          cancel_at_period_end: false,
          cancel_at: null,
          schedule: null,
          trial_end: null,
          items: { data: [{ price: { id: "price_bdd_pro" } }] },
        },
      },
    },
    [200],
  );
  await flushWaitUntilForTest();
}

async function uploadFile(
  actor: ApiTestUser,
  file: {
    readonly filename: string;
    readonly contentType: string;
    readonly size: number;
    readonly purpose?: "artifact";
  },
) {
  context.mocks.s3.getSignedUrl.mockResolvedValue(
    `https://r2.example.com/uploads/${encodeURIComponent(file.filename)}`,
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
        ContentLength: file.size,
        ContentType: file.contentType,
      });
    }
    if (constructor.name === "GetObjectCommand") {
      return Promise.resolve({
        ContentLength: file.size,
        ContentType: file.contentType,
        Body: Readable.from([Buffer.alloc(Math.max(1, file.size), 0x61)]),
      });
    }
    if (constructor.name === "PutObjectCommand") {
      return Promise.resolve({ ETag: '"etag-1"' });
    }
    return Promise.resolve({});
  });
  signIn(actor);
  const client = setupApp({
    context,
    routes: [...uploadsPrepareRoutes, ...uploadsCompleteRoutes],
  })(uploadsContract);
  const prepared = await accept(
    client.prepare({
      headers,
      body: file,
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
  return completed.body;
}

describe("GET /api/artifacts/catalog", () => {
  it("artifact-catalog.bdd-025 searches artifact titles literally before applying the page limit", async () => {
    const member = bdd.user();
    await grantProPlan(member);
    await uploadFile(member, {
      filename: "Launch-Brief.txt",
      contentType: "text/plain",
      size: 16,
      purpose: "artifact",
    });
    await uploadFile(member, {
      filename: "budget.txt",
      contentType: "text/plain",
      size: 10,
      purpose: "artifact",
    });

    const launchSearch = await accept(
      catalogApi(member).list({
        headers,
        query: { keyword: "launch", limit: 1 },
      }),
      [200],
    );
    expect(launchSearch.body.nextCursor).toBeNull();
    expect(launchSearch.body.artifacts).toHaveLength(1);
    expect(launchSearch.body.artifacts[0]).toMatchObject({
      kind: "file",
      title: "Launch-Brief.txt",
    });

    const wildcardSearch = await accept(
      catalogApi(member).list({
        headers,
        query: { keyword: "%" },
      }),
      [200],
    );
    expect(wildcardSearch.body).toStrictEqual({
      artifacts: [],
      nextCursor: null,
    });
  });

  it("artifact-catalog.bdd-013 catalogues an artifact upload but never a chat attachment", async () => {
    const member = bdd.user();
    await grantProPlan(member);
    const attachment = await uploadFile(member, {
      filename: "meeting-notes.png",
      contentType: "image/png",
      size: 128,
    });
    await uploadFile(member, {
      filename: "quarterly-summary.html",
      contentType: "text/html",
      size: 64,
      purpose: "artifact",
    });

    const beforeSend = await accept(
      catalogApi(member).list({ headers, query: {} }),
      [200],
    );
    expect(beforeSend.body.artifacts).toHaveLength(1);
    expect(beforeSend.body.artifacts[0]).toMatchObject({
      kind: "file",
      title: "quarterly-summary.html",
    });

    signIn(member);
    await accept(
      setupApp({ context, routes: chatEventsRoutes })(chatEventsContract).send({
        headers,
        body: {
          prompt: "Please review the attached image",
          hasTextContent: true,
          clientEventId: randomUUID(),
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: "Please review the attached image" },
              {
                type: "file",
                fileId: attachment.id,
                filenameSnapshot: attachment.filename,
                contentType: attachment.contentType,
              },
            ],
          },
        },
      }),
      [201],
    );

    const afterSend = await accept(
      catalogApi(member).list({ headers, query: {} }),
      [200],
    );
    expect(afterSend.body.artifacts).toHaveLength(1);
    expect(afterSend.body.artifacts[0]).toMatchObject({
      kind: "file",
      title: "quarterly-summary.html",
    });
  });
});

describe("shared thread routes", () => {
  async function createSharedPromptArtifact() {
    const member = bdd.user();
    await grantProPlan(member);
    installSharedThreadStorage(context);
    mockGoogleText();
    server.use(
      http.post(VERTEX_TEXT_URL, () => {
        return vertexTextResponse("Saved conversation");
      }),
    );

    const promptEventId = randomUUID();
    signIn(member);
    const sent = await accept(
      setupApp({ context, routes: chatEventsRoutes })(chatEventsContract).send({
        headers,
        body: {
          prompt: "Share this prompt",
          hasTextContent: true,
          clientEventId: promptEventId,
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: "Share this prompt" }],
          },
        },
      }),
      [201],
    );
    const threadId = sent.body.threadId;

    signIn(member);
    const shared = await accept(
      setupApp({ context, routes: sharedThreadRoutes })(
        sharedThreadsContract,
      ).create({
        headers,
        params: { threadId },
        body: { eventIds: [promptEventId] },
      }),
      [201],
    );

    const listed = await accept(
      catalogApi(member).list({ headers, query: { kind: "shared-thread" } }),
      [200],
    );
    expect(listed.body.artifacts).toHaveLength(1);
    const artifactId = listed.body.artifacts[0]?.id;
    if (!artifactId) {
      throw new Error("Expected a shared-thread catalog artifact");
    }
    return {
      member,
      threadId,
      promptEventId,
      sharedId: shared.body.id,
      artifactId,
    };
  }

  it("artifact-catalog.bdd-030 (1/2) deletes the shared-thread artifact and revokes public snapshot and metadata", async () => {
    const { member, sharedId, artifactId } = await createSharedPromptArtifact();

    await accept(
      catalogApi(member).delete({ headers, params: { artifactId } }),
      [200],
    );

    const afterDelete = await accept(
      catalogApi(member).list({ headers, query: { kind: "shared-thread" } }),
      [200],
    );
    expect(afterDelete.body).toStrictEqual({ artifacts: [], nextCursor: null });

    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const publicApi = setupApp({ context, routes: sharedThreadRoutes })(
      sharedThreadsContract,
    );
    await Promise.all([
      accept(publicApi.get({ params: { id: sharedId } }), [404]),
      accept(publicApi.meta({ params: { id: sharedId } }), [404]),
    ]);
  });

  it("artifact-catalog.bdd-030 (2/2) allows repeated artifact deletion and keeps the source thread prompt", async () => {
    const { member, threadId, promptEventId, artifactId } =
      await createSharedPromptArtifact();

    await accept(
      catalogApi(member).delete({ headers, params: { artifactId } }),
      [200],
    );
    await accept(
      catalogApi(member).delete({ headers, params: { artifactId } }),
      [200],
    );

    signIn(member);
    const events = await accept(
      setupApp({ context, routes: chatThreadRoutes })(
        chatThreadEventsContract,
      ).rows({
        headers,
        params: { threadId },
        query: { sinceSeqId: 0, limit: 50 },
      }),
      [200],
    );
    expect(
      events.body.rows.some((row) => {
        return row.id === promptEventId;
      }),
    ).toBeTruthy();
  });
});

describe("GET /api/artifacts/by-url", () => {
  function referencesApi(actor: ApiTestUser) {
    signIn(actor);
    return setupApp({ context, routes: artifactReferenceRoutes })(
      artifactReferencesContract,
    );
  }

  it("pf-054 reads one owned file from its message links and keeps its metadata private", async () => {
    const owner = bdd.user();
    const peer = bdd.user({ orgId: owner.orgId });
    const stored = createHostBddApi(context).captureHostedSitesS3();
    const fallbackS3 = context.mocks.s3.send.getMockImplementation();
    context.mocks.s3.send.mockImplementation((command: unknown, ...rest) => {
      const { constructor } = command as {
        readonly constructor: { readonly name: string };
      };
      if (constructor.name === "HeadObjectCommand") {
        return Promise.resolve({
          ContentLength: 24,
          ContentType: "text/plain",
        });
      }
      if (fallbackS3) {
        return fallbackS3(command, ...rest);
      }
      if (constructor.name === "PutObjectCommand") {
        return Promise.resolve({ ETag: '"etag-1"' });
      }
      return Promise.resolve({});
    });
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/uploads/private-summary.txt",
    );
    signIn(owner);
    const uploads = setupApp({
      context,
      routes: [...uploadsPrepareRoutes, ...uploadsCompleteRoutes],
    })(uploadsContract);
    const prepared = await accept(
      uploads.prepare({
        headers,
        body: {
          filename: "private-summary.txt",
          contentType: "text/plain",
          size: 24,
          purpose: "artifact",
        },
      }),
      [200],
    );
    const completed = await accept(
      uploads.complete({ headers, body: { id: prepared.body.id } }),
      [200],
    );
    expect(stored.objects.size).toBeGreaterThanOrEqual(0);

    const owned = await accept(
      referencesApi(owner).byUrl({
        headers,
        query: { url: completed.body.url },
      }),
      [200],
    );
    expect(owned.body).toMatchObject({
      filename: "private-summary.txt",
      contentType: "text/plain",
    });

    await accept(
      referencesApi(peer).byUrl({
        headers,
        query: { url: completed.body.url },
      }),
      [404],
    );
  });

  it("pf-055 describes an exact public template without granting the reader owner controls", async () => {
    const reader = bdd.user();
    const templateUrl =
      "https://static.vm0.io/vm0/welcome-thread/2026-09-17-1e76170cef99/campaign-visual.jpg";

    const resolved = await accept(
      referencesApi(reader).byUrl({
        headers,
        query: { url: templateUrl },
      }),
      [200],
    );

    expect(resolved.body).toMatchObject({
      url: templateUrl,
      filename: "campaign-visual.jpg",
      contentType: "image/jpeg",
    });
    expect(resolved.body.owner).toBeUndefined();
  });

  it("pf-056 resolves each immutable site publication and the current alias independently", async () => {
    const owner = bdd.user();
    const host = createHostBddApi(context);
    host.captureHostedSitesS3();
    const siteSlug = `site-${randomUUID().slice(0, 8)}`;

    const firstPrepared = await host.prepareHostedSite(owner, {
      site: siteSlug,
      title: "Release V1",
      visibility: "private",
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<h1>V1</h1>")],
    });
    await host.completeHostedSite(owner, firstPrepared.deploymentId);

    const secondPrepared = await host.prepareHostedSite(owner, {
      site: siteSlug,
      title: "Release V2",
      visibility: "private",
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<h1>V2</h1>")],
    });
    const secondCompleted = await host.completeHostedSite(
      owner,
      secondPrepared.deploymentId,
    );

    const firstImmutableUrl = hostedLinkOrigin(
      "current",
      `dpl-${firstPrepared.deploymentId}`,
    );
    const secondImmutableUrl = hostedLinkOrigin(
      "current",
      `dpl-${secondPrepared.deploymentId}`,
    );
    const liveAliasUrl = secondCompleted.url;

    const api = referencesApi(owner);
    const [firstDetail, secondDetail, aliasDetail] = await Promise.all([
      accept(api.byUrl({ headers, query: { url: firstImmutableUrl } }), [200]),
      accept(api.byUrl({ headers, query: { url: secondImmutableUrl } }), [200]),
      accept(api.byUrl({ headers, query: { url: liveAliasUrl } }), [200]),
    ]);

    expect(firstDetail.body.url).toBe(firstImmutableUrl);
    expect(secondDetail.body.url).toBe(secondImmutableUrl);
    expect(aliasDetail.body.url).toBe(secondImmutableUrl);
    expect(firstDetail.body.owner?.publicationId).toBe(
      firstPrepared.deploymentId,
    );
    expect(secondDetail.body.owner?.publicationId).toBe(
      secondPrepared.deploymentId,
    );
    expect(aliasDetail.body.owner?.publicationId).toBe(
      secondPrepared.deploymentId,
    );
    expect(firstDetail.body.filename).toBe("Release V1.html");
    expect(secondDetail.body.filename).toBe("Release V1.html");
    expect(aliasDetail.body.filename).toBe("Release V1.html");
  });
});

describe("artifact catalog with dispatched Runs", () => {
  const runsApi = createRunsApi(context);
  const chatFilesApi = createChatFilesBddApi(context);
  const webhooksApi = createWebhookCallbackApi(context);
  const STAFF_ORG_ID_005 = createUniqueStaffOrgIdFixture();
  const ARTIFACTS_BUCKET = "test-user-artifacts";

  interface StoredObject {
    readonly bytes: Buffer;
    readonly contentType: string;
    readonly metadata: Readonly<Record<string, string>>;
  }

  interface TrackedRun {
    readonly actor: ApiTestUser;
    readonly runId: string;
    readonly sandboxToken: string;
    done: boolean;
  }

  beforeAll(async () => {
    await settleIncludingAbort(async () => {
      const warmupUser = createBddApi(context).user();
      await runsApi.grantProEntitlement(warmupUser);
      await runsApi.configureRunnerGroup();
    });
  });

  function etagOf(bytes: Buffer): string {
    return `"${createHash("sha256").update(bytes).digest("hex")}"`;
  }

  function installArtifactRunS3() {
    const objects = new Map<string, StoredObject>();
    const deletes: string[] = [];
    let sig = 0;

    function objectKey(bucket: string, key: string): string {
      return `${bucket}/${key}`;
    }

    function readMetadata(raw: unknown): Readonly<Record<string, string>> {
      return typeof raw === "object" && raw !== null
        ? (raw as Readonly<Record<string, string>>)
        : {};
    }

    context.mocks.s3.getSignedUrl.mockImplementation((_client, command) => {
      sig += 1;
      if (command instanceof PutObjectCommand) {
        const bucket = command.input.Bucket ?? "";
        const key = command.input.Key ?? "";
        const size =
          typeof command.input.ContentLength === "number"
            ? command.input.ContentLength
            : 16;
        if (bucket && key) {
          objects.set(objectKey(bucket, key), {
            bytes: Buffer.alloc(Math.max(1, size), 0x61),
            contentType:
              command.input.ContentType ?? "application/octet-stream",
            metadata: readMetadata(command.input.Metadata),
          });
        }
      }
      return Promise.resolve(
        `https://r2.example.test/signed/${String(sig)}?X-Amz-Signature=bdd`,
      );
    });

    function handlePut(command: PutObjectCommand) {
      const bucket = command.input.Bucket ?? "";
      const key = command.input.Key ?? "";
      const fullKey = objectKey(bucket, key);
      const existing = objects.get(fullKey);
      if (command.input.IfNoneMatch === "*" && existing !== undefined) {
        return Promise.reject(
          Object.assign(new Error("Object already exists"), {
            name: "PreconditionFailed",
            $metadata: { httpStatusCode: 412 },
          }),
        );
      }
      if (
        command.input.IfMatch !== undefined &&
        (!existing || etagOf(existing.bytes) !== command.input.IfMatch)
      ) {
        return Promise.reject(
          Object.assign(new Error("Object changed"), {
            name: "PreconditionFailed",
            $metadata: { httpStatusCode: 412 },
          }),
        );
      }
      const rawBody = command.input.Body;
      const bytes =
        typeof rawBody === "string"
          ? Buffer.from(rawBody, "utf8")
          : rawBody instanceof Uint8Array
            ? Buffer.from(rawBody)
            : Buffer.alloc(0);
      objects.set(fullKey, {
        bytes,
        contentType: command.input.ContentType ?? "application/octet-stream",
        metadata: readMetadata(command.input.Metadata),
      });
      return Promise.resolve({ ETag: etagOf(bytes) });
    }

    function handleCopy(command: CopyObjectCommand) {
      const source = objects.get(
        decodeURIComponent(command.input.CopySource ?? ""),
      );
      if (!source) {
        return Promise.reject(
          Object.assign(new Error("Copy source missing"), {
            name: "NoSuchKey",
            $metadata: { httpStatusCode: 404 },
          }),
        );
      }
      const bucket = command.input.Bucket ?? "";
      const key = command.input.Key ?? "";
      objects.set(objectKey(bucket, key), {
        bytes: Buffer.from(source.bytes),
        contentType: command.input.ContentType ?? source.contentType,
        metadata: readMetadata(command.input.Metadata),
      });
      return Promise.resolve({});
    }

    function handleList(command: ListObjectsV2Command) {
      const bucket = command.input.Bucket ?? "";
      const prefix = command.input.Prefix ?? "";
      const bucketPrefix = `${bucket}/`;
      return Promise.resolve({
        Contents: [...objects.entries()]
          .filter(([fullKey]) => {
            return fullKey.startsWith(`${bucketPrefix}${prefix}`);
          })
          .map(([fullKey, obj]) => {
            return {
              Key: fullKey.slice(bucketPrefix.length),
              Size: obj.bytes.length,
              LastModified: new Date(now()),
            };
          }),
      });
    }

    function handleHead(command: HeadObjectCommand) {
      const bucket = command.input.Bucket ?? "";
      const key = command.input.Key ?? "";
      const entry = objects.get(objectKey(bucket, key));
      if (!entry) {
        return Promise.reject(
          Object.assign(new Error(`Missing object: ${key}`), {
            name: "NotFound",
            $metadata: { httpStatusCode: 404 },
          }),
        );
      }
      return Promise.resolve({
        ContentLength: entry.bytes.length,
        ContentType: entry.contentType,
        Metadata: entry.metadata,
        LastModified: new Date(now()),
      });
    }

    function handleGet(command: GetObjectCommand) {
      const bucket = command.input.Bucket ?? "";
      const key = command.input.Key ?? "";
      const entry = objects.get(objectKey(bucket, key));
      if (!entry) {
        return Promise.reject(
          Object.assign(new Error(`Missing object: ${key}`), {
            name: "NoSuchKey",
            $metadata: { httpStatusCode: 404 },
          }),
        );
      }
      return Promise.resolve({
        ContentLength: entry.bytes.length,
        ContentType: entry.contentType,
        ETag: etagOf(entry.bytes),
        Metadata: entry.metadata,
        Body: Readable.from([entry.bytes]),
      });
    }

    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command instanceof PutObjectCommand) {
        return handlePut(command);
      }
      if (command instanceof CopyObjectCommand) {
        return handleCopy(command);
      }
      if (command instanceof DeleteObjectsCommand) {
        const bucket = command.input.Bucket ?? "";
        for (const entry of command.input.Delete?.Objects ?? []) {
          if (typeof entry.Key === "string") {
            objects.delete(objectKey(bucket, entry.Key));
            deletes.push(entry.Key);
          }
        }
        return Promise.resolve({});
      }
      if (command instanceof ListObjectsV2Command) {
        return handleList(command);
      }
      if (command instanceof HeadObjectCommand) {
        return handleHead(command);
      }
      if (command instanceof GetObjectCommand) {
        return handleGet(command);
      }
      return Promise.resolve({});
    });

    return {
      objects,
      deletes,
      seedObject(entry: {
        readonly bucket: string;
        readonly key: string;
        readonly body: Buffer;
        readonly contentType?: string;
        readonly metadata?: Readonly<Record<string, string>>;
      }) {
        objects.set(objectKey(entry.bucket, entry.key), {
          bytes: entry.body,
          contentType: entry.contentType ?? "application/octet-stream",
          metadata: entry.metadata ?? {},
        });
      },
    };
  }

  function mockMemberships(actors: readonly ApiTestUser[]): void {
    context.mocks.clerk.users.getOrganizationMembershipList.mockImplementation(
      (request: unknown) => {
        const userId =
          typeof request === "object" &&
          request !== null &&
          "userId" in request &&
          typeof request.userId === "string"
            ? request.userId
            : undefined;
        const actor = actors.find((candidate) => {
          return candidate.userId === userId;
        });
        return Promise.resolve({
          data: actor?.orgId
            ? [
                {
                  role: actor.orgRole ?? "org:admin",
                  organization: { id: actor.orgId },
                },
              ]
            : [],
        });
      },
    );
  }

  function bearerHeaders(token: string) {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    return { authorization: `Bearer ${token}` };
  }

  function uploadsApi() {
    return setupApp({
      context,
      routes: [...uploadsPrepareRoutes, ...uploadsCompleteRoutes],
    })(uploadsContract);
  }

  function hostApi() {
    return setupApp({ context, routes: hostRoutes })(hostContract);
  }

  function threadArtifactsApi(actor: ApiTestUser) {
    signIn(actor);
    return setupApp({ context, routes: chatThreadRoutes })(
      chatThreadArtifactsContract,
    );
  }

  function featureSwitchesApi(actor: ApiTestUser) {
    signIn(actor);
    return setupApp({ context, routes: featureSwitchesRoutes })(
      featureSwitchesContract,
    );
  }

  function createCatalogRunTracker(
    options: { readonly clockRestoreMs?: number } = {},
  ) {
    const tracked: TrackedRun[] = [];
    let clockRestoreMs = options.clockRestoreMs;

    onTestFinished(async () => {
      context.mocks.ably.publish.mockResolvedValue(undefined);
      runsApi.acceptTelemetryIngest();
      if (clockRestoreMs !== undefined) {
        mockNow(clockRestoreMs);
      }
      const errors: unknown[] = [];
      const initialFlush = await settleIncludingAbort(flushWaitUntilForTest);
      if (!initialFlush.ok) {
        errors.push(initialFlush.error);
      }
      for (const entry of tracked) {
        if (entry.done) {
          continue;
        }
        const cleaned = await settleIncludingAbort(async () => {
          await runsApi.requestCancelRun(entry.actor, entry.runId, [200, 400]);
          await webhooksApi.requestAgentComplete(
            { runId: entry.runId, exitCode: 1, error: "Run cancelled" },
            { authorization: `Bearer ${entry.sandboxToken}` },
            [200, 400],
          );
          entry.done = true;
        });
        if (!cleaned.ok) {
          errors.push(cleaned.error);
        }
      }
      const finalFlush = await settleIncludingAbort(flushWaitUntilForTest);
      if (!finalFlush.ok) {
        errors.push(finalFlush.error);
      }
      if (clockRestoreMs !== undefined) {
        clearMockNow();
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "Artifact catalog Run cleanup failed");
      }
    });

    return {
      setClockRestoreMs(ms: number) {
        clockRestoreMs = ms;
      },
      track(
        actor: ApiTestUser,
        runId: string,
        sandboxToken: string,
      ): TrackedRun {
        const entry: TrackedRun = { actor, runId, sandboxToken, done: false };
        tracked.push(entry);
        return entry;
      },
    };
  }

  async function setupProRunnerActor(
    options: {
      readonly orgId?: string;
      readonly skipPro?: boolean;
      readonly installS3?: boolean;
    } = {},
  ) {
    const tracker = createCatalogRunTracker();
    const s3 = options.installS3 === false ? undefined : installArtifactRunS3();
    const actor = bdd.user({ orgId: options.orgId });

    runsApi.acceptTelemetryIngest();
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-issued-credential-key");
    const runnerGroup = await runsApi.configureRunnerGroup({
      maxConcurrent: 4,
    });
    if (!options.skipPro) {
      await runsApi.grantProEntitlement(actor);
    }

    async function launchChatRun(prompt: string) {
      const thread = await chatFilesApi.createThread(actor, { model: null });
      const run = await runsApi.createThreadRun(actor, {
        threadId: thread.id,
        prompt,
      });
      await runsApi.heartbeatRunner(runnerGroup);
      const execution = await runsApi.executionInput(run.runId);
      const okouToken = execution.platformEnvironment.OKOU_TOKEN;
      if (!okouToken) {
        throw new Error("Expected OKOU_TOKEN on dispatched Run");
      }
      const entry = tracker.track(actor, run.runId, execution.sandboxToken);
      return {
        runId: run.runId,
        threadId: run.threadId,
        okouToken,
        sandboxToken: execution.sandboxToken,
        execution,
        entry,
      };
    }

    return { actor, s3, tracker, runnerGroup, launchChatRun };
  }

  async function runUploadArtifact(
    actor: ApiTestUser,
    okouToken: string,
    file: {
      readonly filename: string;
      readonly contentType: string;
      readonly size: number;
    },
  ) {
    mockMemberships([actor]);
    const tokenHeaders = bearerHeaders(okouToken);
    const prepared = await accept(
      uploadsApi().prepare({
        headers: tokenHeaders,
        body: { ...file, purpose: "artifact" },
      }),
      [200],
    );
    const completed = await accept(
      uploadsApi().complete({
        headers: tokenHeaders,
        body: { id: prepared.body.id },
      }),
      [200],
    );
    return completed.body;
  }

  async function publishHostedSiteWithRunToken(
    actor: ApiTestUser,
    okouToken: string,
    args: {
      readonly site: string;
      readonly title: string;
      readonly artifactKind?: "hosted-site" | "presentation-html";
      readonly visibility?: "private" | "public";
      readonly html?: string;
    },
  ) {
    mockMemberships([actor]);
    const tokenHeaders = bearerHeaders(okouToken);
    const prepared = await accept(
      hostApi().prepare({
        headers: tokenHeaders,
        body: {
          site: args.site,
          title: args.title,
          visibility: args.visibility ?? "public",
          artifactKind: args.artifactKind ?? "hosted-site",
          spaFallback: false,
          files: [
            hostedTextFile(
              "/index.html",
              args.html ?? `<h1>${args.title}</h1>`,
            ),
          ],
        },
      }),
      [200],
    );
    const completed = await accept(
      hostApi().complete({
        headers: tokenHeaders,
        params: { deploymentId: prepared.body.deploymentId },
        body: {},
      }),
      [200],
    );
    return { prepared: prepared.body, completed: completed.body };
  }

  it(
    "artifact-catalog.bdd-003 deletes a hosted-site and restores the catalog only for a new publication",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, launchChatRun } = await setupProRunnerActor();
      const firstRun = await launchChatRun("Publish site v1");
      const secondRun = await launchChatRun("Publish site v2");
      const siteSlug = `site-${randomUUID().slice(0, 8)}`;

      const pub1 = await publishHostedSiteWithRunToken(
        actor,
        firstRun.okouToken,
        { site: siteSlug, title: "Launch site", html: "<h1>V1</h1>" },
      );
      await publishHostedSiteWithRunToken(actor, secondRun.okouToken, {
        site: siteSlug,
        title: "Launch site",
        html: "<h1>V2</h1>",
      });

      const beforeDelete = await accept(
        catalogApi(actor).list({ headers, query: {} }),
        [200],
      );
      expect(beforeDelete.body.artifacts).toHaveLength(1);
      const artifactId = beforeDelete.body.artifacts[0]?.id;
      if (!artifactId) {
        throw new Error("Expected a hosted-site catalog artifact");
      }

      const deleted = await accept(
        catalogApi(actor).delete({ headers, params: { artifactId } }),
        [200],
      );
      expect(deleted.body).toStrictEqual({ deleted: true });

      const afterDeleteList = await accept(
        catalogApi(actor).list({ headers, query: {} }),
        [200],
      );
      expect(afterDeleteList.body).toStrictEqual({
        artifacts: [],
        nextCursor: null,
      });

      const [thread1Artifacts, thread2Artifacts] = await Promise.all([
        accept(
          threadArtifactsApi(actor).list({
            headers,
            params: { threadId: firstRun.threadId },
          }),
          [200],
        ),
        accept(
          threadArtifactsApi(actor).list({
            headers,
            params: { threadId: secondRun.threadId },
          }),
          [200],
        ),
      ]);
      expect(thread1Artifacts.body).toStrictEqual({ runs: [] });
      expect(thread2Artifacts.body).toStrictEqual({ runs: [] });

      await accept(
        catalogApi(actor).get({ headers, params: { artifactId } }),
        [404],
      );

      signIn(actor);
      await accept(
        hostApi().files({
          headers,
          params: { publicSlug: pub1.completed.publicSlug },
          query: {},
        }),
        [409],
      );

      const repeatDelete = await accept(
        catalogApi(actor).delete({ headers, params: { artifactId } }),
        [200],
      );
      expect(repeatDelete.body).toStrictEqual({ deleted: true });

      const pub3 = await publishHostedSiteWithRunToken(
        actor,
        secondRun.okouToken,
        { site: siteSlug, title: "Launch site", html: "<h1>V3</h1>" },
      );
      expect(pub3.completed.deploymentVersion).toBe(3);

      const restoredList = await accept(
        catalogApi(actor).list({ headers, query: {} }),
        [200],
      );
      expect(restoredList.body.artifacts).toHaveLength(1);
      expect(restoredList.body.artifacts[0]?.id).toBe(artifactId);

      const restoredDetail = await accept(
        catalogApi(actor).get({ headers, params: { artifactId } }),
        [200],
      );
      expect(restoredDetail.body.kind).toBe("hosted-site");
      if (restoredDetail.body.kind !== "hosted-site") {
        throw new Error("Expected hosted-site detail");
      }
      expect(restoredDetail.body.site.deploymentVersion).toBe(3);

      const [thread1After, thread2After] = await Promise.all([
        accept(
          threadArtifactsApi(actor).list({
            headers,
            params: { threadId: firstRun.threadId },
          }),
          [200],
        ),
        accept(
          threadArtifactsApi(actor).list({
            headers,
            params: { threadId: secondRun.threadId },
          }),
          [200],
        ),
      ]);
      expect(thread1After.body).toStrictEqual({ runs: [] });
      expect(thread2After.body).toStrictEqual({ runs: [] });

      signIn(actor);
      await accept(
        hostApi().files({
          headers,
          params: { publicSlug: `dpl-${pub1.completed.deploymentId}` },
          query: {},
        }),
        [409],
      );
    },
  );

  it(
    "artifact-catalog.bdd-005 shares the explicit site title across Artifacts and retains renames on redeploy",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, launchChatRun } = await setupProRunnerActor({
        orgId: STAFF_ORG_ID_005,
      });
      const run = await launchChatRun("Publish quarterly sales report");
      const siteSlug = `sales-${randomUUID().slice(0, 8)}`;

      const firstPub = await publishHostedSiteWithRunToken(
        actor,
        run.okouToken,
        { site: siteSlug, title: "Quarterly sales report" },
      );

      const initialList = await accept(
        catalogApi(actor).list({ headers, query: {} }),
        [200],
      );
      expect(initialList.body.artifacts).toHaveLength(1);
      const initialEntry = initialList.body.artifacts[0];
      if (!initialEntry) {
        throw new Error("Expected hosted-site catalog entry");
      }
      expect(initialEntry.title).toBe("Quarterly sales report");

      signIn(actor);
      const renamed = await accept(
        hostApi().updateSiteTitle({
          headers,
          params: { publicSlug: firstPub.completed.publicSlug },
          body: { title: " 季度销售报告 " },
        }),
        [200],
      );
      expect(renamed.body).toMatchObject({
        siteId: firstPub.completed.siteId,
        publicSlug: firstPub.completed.publicSlug,
        title: "季度销售报告",
      });

      const detail = await accept(
        catalogApi(actor).get({
          headers,
          params: { artifactId: initialEntry.id },
        }),
        [200],
      );
      expect(detail.body.title).toBe("季度销售报告");
      if (detail.body.kind !== "hosted-site") {
        throw new Error("Expected hosted-site detail");
      }
      expect(detail.body.site).toMatchObject({
        id: firstPub.completed.siteId,
        publicSlug: firstPub.completed.publicSlug,
        url: firstPub.completed.aliasUrl,
      });

      await accept(
        featureSwitchesApi(actor).update({
          headers,
          body: { switches: { [FeatureSwitchKey.ArtifactLibrary]: true } },
        }),
        [200],
      );

      const slugSearch = await accept(
        catalogApi(actor).list({
          headers,
          query: { keyword: siteSlug },
        }),
        [200],
      );
      expect(slugSearch.body).toStrictEqual({
        artifacts: [],
        nextCursor: null,
      });

      const titleAscSearch = await accept(
        catalogApi(actor).list({
          headers,
          query: { keyword: "季度销售报告", direction: "asc" },
        }),
        [200],
      );
      expect(titleAscSearch.body.artifacts).toHaveLength(1);
      expect(titleAscSearch.body.artifacts[0]).toMatchObject({
        id: initialEntry.id,
        title: "季度销售报告",
      });

      const secondPub = await publishHostedSiteWithRunToken(
        actor,
        run.okouToken,
        {
          site: siteSlug,
          title: "Quarterly sales report",
          html: "<h1>Redeployed</h1>",
        },
      );
      expect(secondPub.completed.siteId).toBe(firstPub.completed.siteId);

      const afterRedeploy = await accept(
        catalogApi(actor).list({ headers, query: {} }),
        [200],
      );
      expect(afterRedeploy.body.artifacts).toHaveLength(1);
      expect(afterRedeploy.body.artifacts[0]).toMatchObject({
        id: initialEntry.id,
        title: "季度销售报告",
        createdAt: initialEntry.createdAt,
      });
    },
  );

  it(
    "artifact-catalog.bdd-007 denies other owners site title edits without changing the title",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, launchChatRun } = await setupProRunnerActor();
      const sameOrgPeer = bdd.user({ orgId: actor.orgId });
      const outsider = bdd.user();
      const run = await launchChatRun("Publish owned report");
      const siteSlug = `owned-${randomUUID().slice(0, 8)}`;

      const published = await publishHostedSiteWithRunToken(
        actor,
        run.okouToken,
        { site: siteSlug, title: "Original report" },
      );

      signIn(sameOrgPeer);
      await accept(
        hostApi().updateSiteTitle({
          headers,
          params: { publicSlug: published.completed.publicSlug },
          body: { title: "Renamed report" },
        }),
        [404],
      );

      signIn(outsider);
      await accept(
        hostApi().updateSiteTitle({
          headers,
          params: { publicSlug: published.completed.publicSlug },
          body: { title: "Renamed report" },
        }),
        [404],
      );

      const catalog = await accept(
        catalogApi(actor).list({ headers, query: {} }),
        [200],
      );
      expect(catalog.body.artifacts).toHaveLength(1);
      expect(catalog.body.artifacts[0]?.title).toBe("Original report");
    },
  );

  it(
    "artifact-catalog.bdd-008 lists an uploaded file as one artifact and hides other callers",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, launchChatRun } = await setupProRunnerActor();
      const outsider = bdd.user();
      const run = await launchChatRun("Upload quarterly report");

      const uploaded = await runUploadArtifact(actor, run.okouToken, {
        filename: "quarterly-report.txt",
        contentType: "text/plain",
        size: 256,
      });

      signIn(outsider);
      const outsiderPrepared = await accept(
        uploadsApi().prepare({
          headers,
          body: {
            filename: "outsider-report.txt",
            contentType: "text/plain",
            size: 64,
            purpose: "artifact",
          },
        }),
        [200],
      );
      await accept(
        uploadsApi().complete({
          headers,
          body: { id: outsiderPrepared.body.id },
        }),
        [200],
      );

      const list = await accept(
        catalogApi(actor).list({ headers, query: {} }),
        [200],
      );
      expect(list.body.nextCursor).toBeNull();
      expect(list.body.artifacts).toHaveLength(1);
      const entry = list.body.artifacts[0];
      if (!entry) {
        throw new Error("Expected uploaded file artifact");
      }
      expect(entry).toMatchObject({
        kind: "file",
        title: "quarterly-report.txt",
        sourceUrl: uploaded.url,
        thumbnail: null,
      });

      const detail = await accept(
        catalogApi(actor).get({ headers, params: { artifactId: entry.id } }),
        [200],
      );
      expect(detail.body.kind).toBe("file");
      if (detail.body.kind !== "file") {
        throw new Error("Expected file detail");
      }
      expect(detail.body.file).toMatchObject({
        filename: "quarterly-report.txt",
        contentType: "text/plain",
        size: 256,
        url: uploaded.url,
        previewImageUrl: null,
      });
    },
  );

  it(
    "artifact-catalog.bdd-009 lists native PPTX files as presentations while retaining file-backed detail and deletion",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, launchChatRun } = await setupProRunnerActor();
      const run = await launchChatRun("Upload PPTX and PDF deliverables");

      const deckA = await runUploadArtifact(actor, run.okouToken, {
        filename: "quarterly-review.pptx",
        contentType: "application/octet-stream",
        size: 512,
      });
      const deckB = await runUploadArtifact(actor, run.okouToken, {
        filename: "BOARD-UPDATE.PPTX",
        contentType: "application/octet-stream",
        size: 768,
      });
      await runUploadArtifact(actor, run.okouToken, {
        filename: "supporting-notes.pdf",
        contentType: "application/pdf",
        size: 128,
      });

      const presentations = await accept(
        catalogApi(actor).list({ headers, query: { kind: "presentation" } }),
        [200],
      );
      expect(presentations.body.artifacts).toHaveLength(2);
      expect(
        presentations.body.artifacts
          .map((item) => {
            return item.title;
          })
          .sort(),
      ).toStrictEqual(["BOARD-UPDATE.PPTX", "quarterly-review.pptx"]);

      const files = await accept(
        catalogApi(actor).list({ headers, query: { kind: "file" } }),
        [200],
      );
      expect(files.body.artifacts).toHaveLength(1);
      expect(files.body.artifacts[0]?.title).toBe("supporting-notes.pdf");

      const expectedUrlByTitle = new Map<string, string>([
        ["quarterly-review.pptx", deckA.url],
        ["BOARD-UPDATE.PPTX", deckB.url],
      ]);

      for (const item of presentations.body.artifacts) {
        const detail = await accept(
          catalogApi(actor).get({ headers, params: { artifactId: item.id } }),
          [200],
        );
        expect(detail.body.kind).toBe("file");
        if (detail.body.kind !== "file") {
          throw new Error("Expected file-backed detail for native PPTX");
        }
        expect(detail.body.file.filename).toBe(item.title);
        expect(detail.body.file.url).toBe(expectedUrlByTitle.get(item.title));

        await accept(
          catalogApi(actor).delete({
            headers,
            params: { artifactId: item.id },
          }),
          [200],
        );
      }

      const [presentationsAfter, filesAfter] = await Promise.all([
        accept(
          catalogApi(actor).list({ headers, query: { kind: "presentation" } }),
          [200],
        ),
        accept(
          catalogApi(actor).list({ headers, query: { kind: "file" } }),
          [200],
        ),
      ]);
      expect(presentationsAfter.body.artifacts).toHaveLength(0);
      expect(filesAfter.body.artifacts).toHaveLength(1);
      expect(filesAfter.body.artifacts[0]?.title).toBe("supporting-notes.pdf");
    },
  );

  it(
    "artifact-catalog.bdd-010 keeps completed file lists and catalog filters scoped to their owning thread",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, launchChatRun } = await setupProRunnerActor();
      const outsider = bdd.user();
      const sameOrgPeer = bdd.user({ orgId: actor.orgId });
      const sameUserOtherOrg = bdd.user({ userId: actor.userId });

      const firstRun = await launchChatRun("First thread report");
      const secondRun = await launchChatRun("Second thread report");

      await runUploadArtifact(actor, firstRun.okouToken, {
        filename: "first-thread-report.txt",
        contentType: "text/plain",
        size: 32,
      });
      await runUploadArtifact(actor, secondRun.okouToken, {
        filename: "second-thread-report.txt",
        contentType: "text/plain",
        size: 48,
      });

      const firstCatalog = await accept(
        catalogApi(actor).list({
          headers,
          query: { chatThreadId: firstRun.threadId },
        }),
        [200],
      );
      expect(firstCatalog.body.artifacts).toHaveLength(1);
      expect(firstCatalog.body.artifacts[0]?.title).toBe(
        "first-thread-report.txt",
      );

      const secondCatalog = await accept(
        catalogApi(actor).list({
          headers,
          query: { chatThreadId: secondRun.threadId },
        }),
        [200],
      );
      expect(secondCatalog.body.artifacts).toHaveLength(1);
      expect(secondCatalog.body.artifacts[0]?.title).toBe(
        "second-thread-report.txt",
      );

      const ownerArtifacts = await accept(
        threadArtifactsApi(actor).list({
          headers,
          params: { threadId: firstRun.threadId },
        }),
        [200],
      );
      expect(ownerArtifacts.body).toStrictEqual({ runs: [] });

      const outsiderArtifacts = await accept(
        threadArtifactsApi(outsider).list({
          headers,
          params: { threadId: firstRun.threadId },
        }),
        [404],
      );
      expect(outsiderArtifacts.body.error.code).toBe("NOT_FOUND");

      for (const caller of [outsider, sameOrgPeer, sameUserOtherOrg]) {
        const foreignCatalog = await accept(
          catalogApi(caller).list({
            headers,
            query: { chatThreadId: firstRun.threadId },
          }),
          [200],
        );
        expect(foreignCatalog.body).toStrictEqual({
          artifacts: [],
          nextCursor: null,
        });
      }
    },
  );

  it(
    "artifact-catalog.bdd-014 keeps repeated projections of one file URL as one artifact",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, s3, launchChatRun } = await setupProRunnerActor();
      const firstRun = await launchChatRun("First projection");
      const secondRun = await launchChatRun("Second projection");

      const sharedFileId = randomUUID();
      s3?.seedObject({
        bucket: ARTIFACTS_BUCKET,
        key: buildArtifactKey(
          actor.userId,
          sharedFileId,
          "repeatable-report.txt",
        ),
        body: Buffer.from("repeatable content", "utf8"),
        contentType: "text/plain",
      });

      mockMemberships([actor]);
      await accept(
        uploadsApi().complete({
          headers: bearerHeaders(firstRun.okouToken),
          body: { id: sharedFileId },
        }),
        [200],
      );
      mockMemberships([actor]);
      await accept(
        uploadsApi().complete({
          headers: bearerHeaders(secondRun.okouToken),
          body: { id: sharedFileId },
        }),
        [200],
      );

      const catalog = await accept(
        catalogApi(actor).list({ headers, query: {} }),
        [200],
      );
      expect(catalog.body.artifacts).toHaveLength(1);
      expect(catalog.body.artifacts[0]).toMatchObject({
        kind: "file",
        title: "repeatable-report.txt",
      });
    },
  );

  it(
    "artifact-catalog.bdd-015 lists the source URL for a mp4 video without a poster",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, launchChatRun } = await setupProRunnerActor();
      const run = await launchChatRun("Upload mp4 video");

      const completed = await runUploadArtifact(actor, run.okouToken, {
        filename: "source-fallback.mp4",
        contentType: "video/mp4",
        size: 1024,
      });

      const list = await accept(
        catalogApi(actor).list({ headers, query: {} }),
        [200],
      );
      expect(list.body.artifacts).toHaveLength(1);
      expect(list.body.artifacts[0]).toMatchObject({
        kind: "file",
        title: "source-fallback.mp4",
        sourceUrl: completed.url,
        thumbnail: null,
      });

      const videoFiltered = await accept(
        catalogApi(actor).list({ headers, query: { kind: "video" } }),
        [200],
      );
      expect(videoFiltered.body.artifacts).toHaveLength(1);
      expect(videoFiltered.body.artifacts[0]?.title).toBe(
        "source-fallback.mp4",
      );
    },
  );

  it(
    "artifact-catalog.bdd-022 catalogues a published deck as a presentation",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, launchChatRun } = await setupProRunnerActor();
      const run = await launchChatRun("Publish HTML deck");
      const siteSlug = `deck-${randomUUID().slice(0, 8)}`;

      await publishHostedSiteWithRunToken(actor, run.okouToken, {
        site: siteSlug,
        title: "Board Strategy Deck",
        artifactKind: "presentation-html",
      });

      const list = await accept(
        catalogApi(actor).list({ headers, query: { kind: "presentation" } }),
        [200],
      );
      expect(list.body.artifacts).toHaveLength(1);
      expect(list.body.artifacts[0]).toMatchObject({
        kind: "presentation",
        title: "Board Strategy Deck",
      });
    },
  );

  it(
    "artifact-catalog.bdd-024 filters by kind without leaking other kinds",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, launchChatRun } = await setupProRunnerActor();
      const run = await launchChatRun("Upload notes and publish site");
      const siteSlug = `filter-${randomUUID().slice(0, 8)}`;

      await runUploadArtifact(actor, run.okouToken, {
        filename: "notes.txt",
        contentType: "text/plain",
        size: 32,
      });
      await publishHostedSiteWithRunToken(actor, run.okouToken, {
        site: siteSlug,
        title: "Product Overview",
      });

      const [fileList, siteList, avatarList, videoList, sharedList] =
        await Promise.all([
          accept(
            catalogApi(actor).list({ headers, query: { kind: "file" } }),
            [200],
          ),
          accept(
            catalogApi(actor).list({ headers, query: { kind: "hosted-site" } }),
            [200],
          ),
          accept(
            catalogApi(actor).list({ headers, query: { kind: "avatar" } }),
            [200],
          ),
          accept(
            catalogApi(actor).list({ headers, query: { kind: "video" } }),
            [200],
          ),
          accept(
            catalogApi(actor).list({
              headers,
              query: { kind: "shared-thread" },
            }),
            [200],
          ),
        ]);

      expect(fileList.body.artifacts).toHaveLength(1);
      expect(fileList.body.artifacts[0]?.kind).toBe("file");
      expect(siteList.body.artifacts).toHaveLength(1);
      expect(siteList.body.artifacts[0]?.title).toBe("Product Overview");
      expect(avatarList.body).toStrictEqual({
        artifacts: [],
        nextCursor: null,
      });
      expect(videoList.body).toStrictEqual({ artifacts: [], nextCursor: null });
      expect(sharedList.body).toStrictEqual({
        artifacts: [],
        nextCursor: null,
      });
    },
  );

  it(
    "artifact-catalog.bdd-026 paginates a thread and kind filtered catalog without repeats or foreign-thread entries",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, tracker, launchChatRun } = await setupProRunnerActor();
      const issuedAt = now();
      tracker.setClockRestoreMs(issuedAt);

      const firstRun = await launchChatRun("Upload three paged files");
      const secondRun = await launchChatRun("Upload foreign thread file");

      mockNow(issuedAt + 1000);
      await runUploadArtifact(actor, firstRun.okouToken, {
        filename: "page-one.txt",
        contentType: "text/plain",
        size: 16,
      });
      mockNow(issuedAt + 2000);
      await runUploadArtifact(actor, firstRun.okouToken, {
        filename: "page-two.txt",
        contentType: "text/plain",
        size: 16,
      });
      mockNow(issuedAt + 3000);
      await runUploadArtifact(actor, firstRun.okouToken, {
        filename: "page-three.txt",
        contentType: "text/plain",
        size: 16,
      });
      mockNow(issuedAt + 4000);
      await runUploadArtifact(actor, secondRun.okouToken, {
        filename: "page-other-thread.txt",
        contentType: "text/plain",
        size: 16,
      });

      const collected: string[] = [];
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
        const page = await accept(
          catalogApi(actor).list({
            headers,
            query: {
              limit: 1,
              chatThreadId: firstRun.threadId,
              kind: "file",
              ...(cursor === undefined ? {} : { cursor }),
            },
          }),
          [200],
        );
        expect(page.body.artifacts.length).toBeLessThanOrEqual(1);
        for (const item of page.body.artifacts) {
          collected.push(item.title);
        }
        if (page.body.nextCursor === null) {
          break;
        }
        cursor = page.body.nextCursor;
      }

      expect(collected).toStrictEqual([
        "page-three.txt",
        "page-two.txt",
        "page-one.txt",
      ]);
    },
  );
});
