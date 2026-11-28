import { createHash, randomUUID } from "node:crypto";
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  chatEventsContract,
  chatThreadByIdContract,
  chatThreadEventsContract,
  type ChatEvent,
  type UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { logsListContract } from "@okouai/api-contracts/contracts/logs";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import {
  runsByIdContract,
  runsCancelContract,
} from "@okouai/api-contracts/contracts/run-routes";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { http, HttpResponse } from "msw";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";
import {
  accept,
  testContext,
  type TestContext,
} from "../../../__tests__/test-context";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { createAppWithRoutes } from "../../../app-factory-core";
import { clearMockedEnv, mockOptionalEnv } from "../../../lib/env";
import { now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { artifactCatalogRoutes } from "../artifact-catalog";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { logsRoutes } from "../logs";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { uploadsMultipartRoutes } from "../uploads-multipart";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { webFileUrlRoutes } from "../web-file-url";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { projectChatEventRows } from "./helpers/chat-event-test-reader";
import { userMessages } from "./helpers/chat-events-fixture";
import { createRouteMocks } from "./helpers/route-test";

const FABLE_MODEL = "claude-fable-5-1";
const MULTIPART_PART_SIZE = 5 * 1024 * 1024;
const MULTIPART_TOTAL_SIZE = MULTIPART_PART_SIZE + 4;
const SAMPLE_PNG_BYTES = Object.freeze([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

interface StoredObjectEntry {
  readonly size: number;
  readonly body?: Buffer;
  readonly contentType: string | undefined;
  readonly metadata: Readonly<Record<string, string>>;
}

interface SignedPutTarget {
  readonly bucket: string;
  readonly key: string;
  readonly contentType: string | undefined;
  readonly metadata: Readonly<Record<string, string>>;
  readonly contentLength: number | undefined;
  readonly uploadId?: string;
  readonly partNumber?: number;
}

interface ActiveMultipartUpload {
  readonly bucket: string;
  readonly key: string;
  readonly contentType: string | undefined;
  readonly metadata: Readonly<Record<string, string>>;
  readonly parts: Map<number, number>;
}

interface StorageState {
  readonly objects: Map<string, StoredObjectEntry>;
  readonly multipartUploads: Map<string, ActiveMultipartUpload>;
  readonly recordedHeadKeys: string[];
  readonly failingHeadKeys: Set<string>;
  nextSequence: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandInput(command: unknown): Record<string, unknown> {
  if (isRecord(command) && isRecord(command.input)) {
    return command.input;
  }
  return {};
}

function stringField(
  input: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = input[field];
  return typeof value === "string" ? value : undefined;
}

function stringMetadata(
  input: Record<string, unknown>,
): Record<string, string> {
  if (!isRecord(input.Metadata)) {
    return {};
  }
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(input.Metadata)) {
    if (typeof value === "string") {
      entries.push([key, value]);
    }
  }
  return Object.fromEntries(entries);
}

function objectKeyId(bucket: string, key: string): string {
  return `${bucket}\0${key}`;
}

function s3NotFoundError(key: string, name: string): Error {
  return Object.assign(new Error(`Missing S3 object: ${key}`), {
    name,
    $metadata: { httpStatusCode: 404 },
  });
}

function bufferFromS3Body(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) {
    return Buffer.from(body);
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  return Buffer.from(String(body ?? ""), "utf8");
}

function byteStream(body: Buffer): {
  transformToString(): Promise<string>;
  [Symbol.asyncIterator](): AsyncGenerator<Uint8Array>;
} {
  return {
    transformToString(): Promise<string> {
      return Promise.resolve(body.toString("utf8"));
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
      yield body;
    },
  };
}

function extractPromptFileIds(prompt: string): readonly string[] {
  const prefix = "   [ID] ";
  const ids: string[] = [];
  for (const line of prompt.split("\n")) {
    if (line.startsWith(prefix)) {
      ids.push(line.slice(prefix.length));
    }
  }
  return ids;
}

function resolvedObjectKeyFromSignedUrl(signedUrl: string): string | null {
  return new URL(signedUrl).searchParams.get("object");
}

function handleMultipartS3Command(
  state: StorageState,
  command: unknown,
  bucket: string,
  key: string,
  input: Record<string, unknown>,
): Promise<unknown> | null {
  if (command instanceof CreateMultipartUploadCommand) {
    const uploadId = `multipart-${state.nextSequence().toString()}`;
    state.multipartUploads.set(uploadId, {
      bucket,
      key,
      contentType: stringField(input, "ContentType"),
      metadata: stringMetadata(input),
      parts: new Map(),
    });
    return Promise.resolve({ UploadId: uploadId });
  }
  if (
    !(command instanceof ListPartsCommand) &&
    !(command instanceof CompleteMultipartUploadCommand)
  ) {
    return null;
  }
  const uploadId = stringField(input, "UploadId") ?? "";
  const upload = state.multipartUploads.get(uploadId);
  if (!upload || upload.bucket !== bucket || upload.key !== key) {
    return Promise.reject(s3NotFoundError(key, "NoSuchUpload"));
  }
  if (command instanceof ListPartsCommand) {
    const parts = [...upload.parts.entries()]
      .sort(([left], [right]) => {
        return left - right;
      })
      .map(([partNumber, size]) => {
        return {
          PartNumber: partNumber,
          ETag: `"part-${partNumber.toString()}"`,
          Size: size,
        };
      });
    return Promise.resolve({ Parts: parts });
  }
  let totalSize = 0;
  for (const partSize of upload.parts.values()) {
    totalSize += partSize;
  }
  state.objects.set(objectKeyId(bucket, key), {
    size: totalSize,
    contentType: upload.contentType,
    metadata: upload.metadata,
  });
  state.multipartUploads.delete(uploadId);
  return Promise.resolve({});
}

function handleReadS3Command(
  state: StorageState,
  command: unknown,
  bucket: string,
  key: string,
  input: Record<string, unknown>,
): Promise<unknown> | null {
  const id = objectKeyId(bucket, key);
  if (command instanceof HeadObjectCommand) {
    state.recordedHeadKeys.push(key);
    if (state.failingHeadKeys.has(key)) {
      return Promise.reject(new Error(`Injected HEAD failure for ${key}`));
    }
    const object = state.objects.get(id);
    if (!object) {
      return Promise.reject(s3NotFoundError(key, "NotFound"));
    }
    return Promise.resolve({
      ContentLength: object.size,
      ContentType: object.contentType,
      Metadata: object.metadata,
      LastModified: nowDate(),
    });
  }
  if (command instanceof GetObjectCommand) {
    const object = state.objects.get(id);
    if (!object) {
      return Promise.reject(s3NotFoundError(key, "NoSuchKey"));
    }
    const body = object.body ?? Buffer.alloc(0);
    return Promise.resolve({
      Body: byteStream(body),
      ContentLength: object.size,
      ContentType: object.contentType,
      ETag: `"${createHash("md5").update(body).digest("hex")}"`,
      Metadata: object.metadata,
      LastModified: nowDate(),
    });
  }
  if (command instanceof ListObjectsV2Command) {
    const prefix = stringField(input, "Prefix") ?? "";
    const contents = [...state.objects.entries()].flatMap(
      ([storedId, object]) => {
        const separator = storedId.indexOf("\0");
        const storedBucket = storedId.slice(0, separator);
        const storedKey = storedId.slice(separator + 1);
        return storedBucket === bucket && storedKey.startsWith(prefix)
          ? [{ Key: storedKey, Size: object.size, LastModified: nowDate() }]
          : [];
      },
    );
    return Promise.resolve({ Contents: contents });
  }
  return null;
}

function handleWriteS3Command(
  state: StorageState,
  command: unknown,
  bucket: string,
  key: string,
  input: Record<string, unknown>,
): Promise<unknown> | null {
  if (command instanceof PutObjectCommand) {
    const id = objectKeyId(bucket, key);
    if (input.IfNoneMatch === "*" && state.objects.has(id)) {
      return Promise.reject(
        Object.assign(new Error("Object already exists"), {
          name: "PreconditionFailed",
          $metadata: { httpStatusCode: 412 },
        }),
      );
    }
    const body = bufferFromS3Body(input.Body);
    state.objects.set(id, {
      size: body.length,
      body,
      contentType: stringField(input, "ContentType"),
      metadata: stringMetadata(input),
    });
    return Promise.resolve({
      ETag: `"${createHash("md5").update(body).digest("hex")}"`,
    });
  }
  if (command instanceof DeleteObjectsCommand) {
    const deletion = isRecord(input.Delete) ? input.Delete : {};
    const items = Array.isArray(deletion.Objects) ? deletion.Objects : [];
    for (const item of items) {
      if (isRecord(item) && typeof item.Key === "string") {
        state.objects.delete(objectKeyId(bucket, item.Key));
      }
    }
    return Promise.resolve({});
  }
  return null;
}

function installPrivateAttachmentStorage(context: TestContext) {
  let sequence = 0;
  const state: StorageState = {
    objects: new Map<string, StoredObjectEntry>(),
    multipartUploads: new Map<string, ActiveMultipartUpload>(),
    recordedHeadKeys: [],
    failingHeadKeys: new Set<string>(),
    nextSequence: () => {
      sequence += 1;
      return sequence;
    },
  };
  const signedPuts = new Map<string, SignedPutTarget>();

  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const input = commandInput(command);
    const bucket = stringField(input, "Bucket") ?? "";
    const key = stringField(input, "Key") ?? "";
    return (
      handleMultipartS3Command(state, command, bucket, key, input) ??
      handleWriteS3Command(state, command, bucket, key, input) ??
      handleReadS3Command(state, command, bucket, key, input) ??
      Promise.resolve({})
    );
  });

  context.mocks.s3.getSignedUrl.mockImplementation(
    (_client: unknown, command: unknown) => {
      const input = commandInput(command);
      const bucket = stringField(input, "Bucket") ?? "";
      const key = stringField(input, "Key") ?? "";
      if (command instanceof GetObjectCommand) {
        const url = new URL("https://r2.example.test/signed/download");
        url.searchParams.set("bucket", bucket);
        url.searchParams.set("object", key);
        return Promise.resolve(url.toString());
      }
      const url = `https://r2.example.test/signed/upload/${state.nextSequence().toString()}`;
      if (
        command instanceof PutObjectCommand ||
        command instanceof UploadPartCommand
      ) {
        signedPuts.set(url, {
          bucket,
          key,
          contentType: stringField(input, "ContentType"),
          metadata: stringMetadata(input),
          contentLength:
            typeof input.ContentLength === "number"
              ? input.ContentLength
              : undefined,
          ...(command instanceof UploadPartCommand
            ? {
                uploadId: stringField(input, "UploadId"),
                partNumber:
                  typeof input.PartNumber === "number"
                    ? input.PartNumber
                    : undefined,
              }
            : {}),
        });
      }
      return Promise.resolve(url);
    },
  );

  server.use(
    http.put("https://r2.example.test/signed/upload/*", async ({ request }) => {
      const target = signedPuts.get(request.url);
      if (!target) {
        return new HttpResponse("SignatureDoesNotMatch", { status: 403 });
      }
      const body = Buffer.from(await request.arrayBuffer());
      if (
        target.contentLength !== undefined &&
        body.length !== target.contentLength
      ) {
        return new HttpResponse("<Code>SignatureDoesNotMatch</Code>", {
          status: 403,
        });
      }
      if (target.uploadId !== undefined) {
        const upload = state.multipartUploads.get(target.uploadId);
        if (!upload || target.partNumber === undefined) {
          return new HttpResponse("<Code>NoSuchUpload</Code>", {
            status: 404,
          });
        }
        upload.parts.set(target.partNumber, body.length);
        return new HttpResponse(null, {
          status: 200,
          headers: { ETag: `"part-${target.partNumber.toString()}"` },
        });
      }
      state.objects.set(objectKeyId(target.bucket, target.key), {
        size: body.length,
        body,
        contentType:
          target.contentType ??
          request.headers.get("content-type") ??
          undefined,
        metadata: target.metadata,
      });
      return new HttpResponse(null, { status: 200 });
    }),
  );

  return {
    clearHeadKeys(): void {
      state.recordedHeadKeys.splice(0, state.recordedHeadKeys.length);
    },
    headKeys(): readonly string[] {
      return [...state.recordedHeadKeys];
    },
    failHeadForKey(key: string): void {
      state.failingHeadKeys.add(key);
    },
  };
}

describe("private attachments through normal chat send", () => {
  const context = testContext();
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const chat = createChatFilesBddApi(context);
  const chatCallbacks = createChatCallbacksApi(context);
  const webhooks = createWebhookCallbackApi(context);
  const routeMocks = createRouteMocks(context);

  const uploadsClient = setupAppWithRoutes({
    context,
    routes: [
      ...uploadsPrepareRoutes,
      ...uploadsCompleteRoutes,
      ...uploadsMultipartRoutes,
    ],
  })(uploadsContract);

  const artifactCatalogClient = setupAppWithRoutes({
    context,
    routes: artifactCatalogRoutes,
  })(artifactCatalogContract);

  const webFilesClient = setupAppWithRoutes({
    context,
    routes: webFileUrlRoutes,
  })(webFilesContract);

  const onboardingClient = setupAppWithRoutes({
    context,
    routes: onboardingCompleteRoutes,
  })(onboardingCompleteContract);

  const personalProvidersClient = setupAppWithRoutes({
    context,
    routes: meModelProvidersUpsertRoutes,
  })(personalModelProvidersMainContract);

  const modelPreferenceClient = setupAppWithRoutes({
    context,
    routes: userModelPreferenceRoutes,
  })(userModelPreferenceContract);

  const runsByIdClient = setupAppWithRoutes({
    context,
    routes: runsRoutes,
  })(runsByIdContract);

  const runsCancelClient = setupAppWithRoutes({
    context,
    routes: runsCancelRoutes,
  })(runsCancelContract);

  const logsListClient = setupAppWithRoutes({
    context,
    routes: logsRoutes,
  })(logsListContract);

  const threadByIdClient = setupAppWithRoutes({
    context,
    routes: chatThreadRoutes,
  })(chatThreadByIdContract);

  const chatEventsClient = setupAppWithRoutes({
    context,
    routes: chatEventsRoutes,
  })(chatEventsContract);

  const chatThreadEventsClient = setupAppWithRoutes({
    context,
    routes: chatThreadRoutes,
  })(chatThreadEventsContract);

  const webhookClerkClient = setupAppWithRoutes({
    context,
    routes: webhooksClerkRoutes,
  })(webhookClerkContract);

  beforeAll(async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    webhooks.configureClerkWebhookSecret();
    context.mocks.clerk.verifyWebhook.mockRejectedValueOnce(
      new Error("warmup"),
    );

    const warmupId = randomUUID();
    const warmupRawSend = createAppWithRoutes({
      signal: context.signal,
      routes: chatEventsRoutes,
    }).request("/api/chat/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "warmup" }),
    });
    await Promise.all([
      accept(webhookClerkClient.post({ body: "{}" }), [401]),
      accept(onboardingClient.complete({ headers: {}, body: {} }), [401]),
      accept(
        personalProvidersClient.upsert({
          headers: {},
          body: {
            type: "claude-code-oauth-token",
            secret: "warmup-token",
          },
        }),
        [401],
      ),
      accept(
        modelPreferenceClient.update({
          headers: {},
          body: { selectedModel: FABLE_MODEL, serviceTier: null },
        }),
        [401],
      ),
      accept(
        uploadsClient.prepare({
          headers: {},
          body: {
            filename: "warmup.png",
            contentType: "image/png",
            size: 8,
          },
        }),
        [401],
      ),
      accept(
        uploadsClient.complete({
          headers: {},
          body: { id: warmupId },
        }),
        [401],
      ),
      accept(
        uploadsClient.completeMultipart({
          headers: {},
          body: {
            id: warmupId,
            filename: "warmup.bin",
            uploadId: "warmup-upload",
            partCount: 1,
          },
        }),
        [401],
      ),
      warmupRawSend,
      accept(
        chatEventsClient.send({
          headers: {},
          body: {
            prompt: "warmup",
            hasTextContent: true,
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: "warmup" }],
            },
          },
        }),
        [401],
      ),
      chat.requestCreateThread(null, { model: null }, [401]),
      accept(
        threadByIdClient.get({ headers: {}, params: { id: warmupId } }),
        [401],
      ),
      accept(
        chatThreadEventsClient.rows({
          headers: {},
          params: { threadId: warmupId },
          query: { sinceSeqId: 0, limit: 1 },
        }),
        [401],
      ),
      accept(
        webFilesClient.fileUrl({
          headers: {},
          query: { file_id: warmupId },
        }),
        [401],
      ),
      accept(
        artifactCatalogClient.list({
          headers: {},
          query: {},
        }),
        [401],
      ),
      accept(
        artifactCatalogClient.delete({
          headers: {},
          params: { artifactId: warmupId },
        }),
        [401],
      ),
      accept(
        runsByIdClient.getById({ headers: {}, params: { id: warmupId } }),
        [401],
      ),
      accept(
        runsCancelClient.cancel({ headers: {}, params: { id: warmupId } }),
        [401],
      ),
      runs.requestHeartbeatRunner(false, [401]),
      accept(logsListClient.list({ headers: {}, query: { limit: 1 } }), [401]),
    ]);
    clearMockedEnv();
  });

  function sessionHeaders(actor: ApiTestUser): {
    readonly authorization: string;
  } {
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    return { authorization: "Bearer clerk-session" };
  }

  function registerIdempotentRunCleanup(
    actor: ApiTestUser,
    runId: string,
  ): void {
    onTestFinished(async () => {
      const current = await accept(
        runsByIdClient.getById({
          headers: sessionHeaders(actor),
          params: { id: runId },
        }),
        [200, 404],
      );
      if (
        current.status === 200 &&
        ["queued", "pending", "running"].includes(current.body.status)
      ) {
        await accept(
          runsCancelClient.cancel({
            headers: sessionHeaders(actor),
            params: { id: runId },
          }),
          [200],
        );
      }
    });
  }

  function initWorkspaceMocks() {
    const actor = bdd.user();
    const storage = installPrivateAttachmentStorage(context);
    runs.acceptTelemetryIngest();
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    chatCallbacks.disableVapid();
    sessionHeaders(actor);
    return { actor, storage };
  }

  async function configurePersonalFableModel(
    actor: ApiTestUser,
  ): Promise<void> {
    mockClaudeCodeTokenEndpoint();
    const headers = sessionHeaders(actor);
    await accept(
      personalProvidersClient.upsert({
        headers,
        body: {
          type: "claude-code-oauth-token",
          secret: "bdd-personal-claude-token",
        },
      }),
      [200, 201],
    );
    await accept(
      modelPreferenceClient.update({
        headers,
        body: { selectedModel: FABLE_MODEL, serviceTier: null },
      }),
      [200],
    );
  }

  async function completeOnboardingFast(actor: ApiTestUser): Promise<void> {
    await accept(
      onboardingClient.complete({
        headers: sessionHeaders(actor),
        body: {},
      }),
      [200],
    );
  }

  async function deliverOrgCreatedFast(actor: ApiTestUser): Promise<void> {
    if (!actor.orgId) {
      throw new Error("Expected a workspace actor with an orgId");
    }
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_bdd_clerk");
    context.mocks.clerk.verifyWebhook.mockResolvedValueOnce({
      type: "organization.created",
      data: { id: actor.orgId, created_by: actor.userId, created_at: now() },
    });
    await accept(webhookClerkClient.post({ body: "{}" }), [200]);
  }

  async function sendAndLaunchFast(
    actor: ApiTestUser,
    body: {
      readonly model: string | null;
      readonly prompt: string;
      readonly userMessage: UserMessageInputDocument;
    },
  ): Promise<{
    readonly runId: string;
    readonly threadId: string;
    readonly events: readonly ChatEvent[];
  }> {
    const clientEventId = randomUUID();
    const sent = await accept(
      chatEventsClient.send({
        headers: sessionHeaders(actor),
        body: {
          ...body,
          clientEventId,
          hasTextContent: true,
        },
      }),
      [201],
    );
    await flushWaitUntilForTest();
    const rowsResponse = await accept(
      chatThreadEventsClient.rows({
        headers: sessionHeaders(actor),
        params: { threadId: sent.body.threadId },
        query: { sinceSeqId: 0, limit: 50 },
      }),
      [200],
    );
    const events = projectChatEventRows(rowsResponse.body.rows);
    const launched = events.find((event) => {
      return (
        event.eventType === "input.prompt" &&
        event.revokesEventId === clientEventId &&
        event.runId !== undefined
      );
    });
    if (launched?.runId === undefined) {
      throw new Error("Expected the chat send to launch a run");
    }
    return {
      runId: launched.runId,
      threadId: sent.body.threadId,
      events,
    };
  }

  async function provisionMemberWorkspace(options?: {
    readonly withRunner?: boolean;
    readonly withFableModel?: boolean;
  }) {
    const { actor, storage } = initWorkspaceMocks();
    const tasks: Promise<unknown>[] = [deliverOrgCreatedFast(actor)];
    if (options?.withRunner) {
      tasks.push(runs.configureRunnerGroup());
    }
    if (options?.withFableModel) {
      tasks.push(configurePersonalFableModel(actor));
    }
    await Promise.all(tasks);
    return { actor, storage };
  }

  async function uploadSingleFile(
    actor: ApiTestUser,
    options: {
      readonly filename: string;
      readonly contentType: string;
      readonly bytes: Uint8Array;
      readonly purpose?: "artifact";
      readonly put?: boolean;
      readonly complete?: boolean;
    },
  ) {
    const prepared = await accept(
      uploadsClient.prepare({
        headers: sessionHeaders(actor),
        body: {
          filename: options.filename,
          contentType: options.contentType,
          size: options.bytes.byteLength,
          ...(options.purpose === undefined
            ? {}
            : { purpose: options.purpose }),
        },
      }),
      [200],
    );
    if (!("uploadUrl" in prepared.body)) {
      throw new Error("Expected single-part presigned upload URL");
    }
    if (options.put !== false) {
      const uploaded = await fetch(prepared.body.uploadUrl, {
        method: "PUT",
        headers: {
          "content-type": options.contentType,
          ...prepared.body.uploadHeaders,
        },
        body: Buffer.from(options.bytes),
      });
      expect(uploaded.status).toBe(200);
    }
    if (options.complete !== false) {
      await accept(
        uploadsClient.complete({
          headers: sessionHeaders(actor),
          body: { id: prepared.body.id },
        }),
        [200],
      );
    }
    return {
      id: prepared.body.id,
      filename: prepared.body.filename,
      contentType: prepared.body.contentType,
    };
  }

  async function resolveWebFileUrl(actor: ApiTestUser, fileId: string) {
    const response = await accept(
      webFilesClient.fileUrl({
        headers: sessionHeaders(actor),
        query: { file_id: fileId },
      }),
      [200],
    );
    return response.body;
  }

  async function readRun(actor: ApiTestUser, runId: string) {
    const response = await accept(
      runsByIdClient.getById({
        headers: sessionHeaders(actor),
        params: { id: runId },
      }),
      [200],
    );
    return response.body;
  }

  async function sendChatEventRaw(
    actor: ApiTestUser,
    body: Record<string, unknown>,
  ): Promise<{ readonly status: number; readonly body: unknown }> {
    const headers = sessionHeaders(actor);
    const app = createAppWithRoutes({
      signal: context.signal,
      routes: chatEventsRoutes,
    });
    const response = await app.request("/api/chat/events", {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const parsed: unknown = await response.json();
    return { status: response.status, body: parsed };
  }

  function findRunPromptEvent(
    events: readonly ChatEvent[],
    runId: string,
  ): Extract<ChatEvent, { readonly eventType: "input.prompt" }> {
    const found = events.find(
      (
        event,
      ): event is Extract<
        ChatEvent,
        { readonly eventType: "input.prompt" }
      > => {
        return event.eventType === "input.prompt" && event.runId === runId;
      },
    );
    if (!found) {
      throw new Error(`Expected input.prompt event for run ${runId}`);
    }
    return found;
  }

  it("chat-events-private-attachments-014 rejects a set containing a missing object without publishing its input", async () => {
    const { actor } = await provisionMemberWorkspace();
    const [completed, missing] = await Promise.all([
      uploadSingleFile(actor, {
        filename: "completed.png",
        contentType: "image/png",
        bytes: Uint8Array.from(SAMPLE_PNG_BYTES),
      }),
      uploadSingleFile(actor, {
        filename: "missing.png",
        contentType: "image/png",
        bytes: Uint8Array.from(SAMPLE_PNG_BYTES),
        put: false,
        complete: false,
      }),
      bdd.completeOnboarding(actor),
    ]);

    const clientThreadId = randomUUID();
    const promptText = `Missing object check ${randomUUID()}`;
    const userMessage: UserMessageInputDocument = {
      version: 1,
      parts: [
        {
          type: "file",
          fileId: completed.id,
          filenameSnapshot: completed.filename,
          contentType: completed.contentType,
        },
        {
          type: "file",
          fileId: missing.id,
          filenameSnapshot: missing.filename,
          contentType: missing.contentType,
        },
        { type: "text", text: promptText },
      ],
    };

    const rejected = await sendChatEventRaw(actor, {
      clientThreadId,
      model: FABLE_MODEL,
      prompt: promptText,
      userMessage,
      hasTextContent: true,
    });
    expect(rejected).toStrictEqual({
      status: 500,
      body: { error: "Internal server error" },
    });

    const [threadRead, logsRead, fileUrl] = await Promise.all([
      accept(
        threadByIdClient.get({
          headers: sessionHeaders(actor),
          params: { id: clientThreadId },
        }),
        [404],
      ),
      accept(
        logsListClient.list({
          headers: sessionHeaders(actor),
          query: { limit: 100 },
        }),
        [200],
      ),
      resolveWebFileUrl(actor, completed.id),
    ]);

    expect(threadRead.status).toBe(404);
    expect(
      logsRead.body.data.some((entry) => {
        return entry.prompt.includes(promptText);
      }),
    ).toBeFalsy();
    expect(resolvedObjectKeyFromSignedUrl(fileUrl.url)).toBe(
      `private-artifacts/${completed.id}/${completed.filename}`,
    );
    expect(fileUrl.publicUrl).toBeNull();
  });

  it("chat-events-private-attachments-015 rejects a set containing a foreign owner without publishing its input", async () => {
    const { actor } = await provisionMemberWorkspace();
    const [owned] = await Promise.all([
      uploadSingleFile(actor, {
        filename: "owned.png",
        contentType: "image/png",
        bytes: Uint8Array.from(SAMPLE_PNG_BYTES),
      }),
      bdd.completeOnboarding(actor),
    ]);

    const foreignActor = bdd.user();
    await bdd.provisionWorkspace(foreignActor);
    const [foreignUpload] = await Promise.all([
      uploadSingleFile(foreignActor, {
        filename: "foreign.png",
        contentType: "image/png",
        bytes: Uint8Array.from(SAMPLE_PNG_BYTES),
        complete: false,
      }),
      bdd.completeOnboarding(foreignActor),
    ]);

    const clientThreadId = randomUUID();
    const promptText = `Foreign owner check ${randomUUID()}`;
    const userMessage: UserMessageInputDocument = {
      version: 1,
      parts: [
        {
          type: "file",
          fileId: owned.id,
          filenameSnapshot: owned.filename,
          contentType: owned.contentType,
        },
        {
          type: "file",
          fileId: foreignUpload.id,
          filenameSnapshot: foreignUpload.filename,
          contentType: foreignUpload.contentType,
        },
        { type: "text", text: promptText },
      ],
    };

    const rejected = await sendChatEventRaw(actor, {
      clientThreadId,
      model: FABLE_MODEL,
      prompt: promptText,
      userMessage,
      hasTextContent: true,
    });
    expect(rejected).toStrictEqual({
      status: 500,
      body: { error: "Internal server error" },
    });

    const [threadRead, logsRead, fileUrl] = await Promise.all([
      accept(
        threadByIdClient.get({
          headers: sessionHeaders(actor),
          params: { id: clientThreadId },
        }),
        [404],
      ),
      accept(
        logsListClient.list({
          headers: sessionHeaders(actor),
          query: { limit: 100 },
        }),
        [200],
      ),
      resolveWebFileUrl(actor, owned.id),
    ]);

    expect(threadRead.status).toBe(404);
    expect(
      logsRead.body.data.some((entry) => {
        return entry.prompt.includes(promptText);
      }),
    ).toBeFalsy();
    expect(resolvedObjectKeyFromSignedUrl(fileUrl.url)).toBe(
      `private-artifacts/${owned.id}/${owned.filename}`,
    );
    expect(fileUrl.publicUrl).toBeNull();
  });

  it("chat-events-private-attachments-012 handles private attachment withdrawal before selection", async () => {
    const { actor } = await provisionMemberWorkspace();
    const [artifactUpload, pendingUpload] = await Promise.all([
      uploadSingleFile(actor, {
        filename: "withdrawn-artifact.png",
        contentType: "image/png",
        bytes: Uint8Array.from(SAMPLE_PNG_BYTES),
        purpose: "artifact",
      }),
      uploadSingleFile(actor, {
        filename: "pending-upload.png",
        contentType: "image/png",
        bytes: Uint8Array.from(SAMPLE_PNG_BYTES),
        complete: false,
      }),
      bdd.completeOnboarding(actor),
    ]);

    const catalog = await accept(
      artifactCatalogClient.list({
        headers: sessionHeaders(actor),
        query: { limit: 50 },
      }),
      [200],
    );
    const artifactEntry = catalog.body.artifacts.find((entry) => {
      return entry.title === artifactUpload.filename;
    });
    expect(artifactEntry).toBeDefined();
    if (!artifactEntry) {
      throw new Error("Expected completed private artifact in catalog");
    }

    const [deleted, thread] = await Promise.all([
      accept(
        artifactCatalogClient.delete({
          headers: sessionHeaders(actor),
          params: { artifactId: artifactEntry.id },
        }),
        [200],
      ),
      chat.createThread(actor, { model: null }),
    ]);
    expect(deleted.body).toStrictEqual({ deleted: true });

    const sent = await sendChatEventRaw(actor, {
      threadId: thread.id,
      prompt: "Send with soft-deleted library artifact and pending upload",
      userMessage: {
        version: 1,
        parts: [
          {
            type: "file",
            fileId: artifactUpload.id,
            filenameSnapshot: artifactUpload.filename,
            contentType: artifactUpload.contentType,
          },
          {
            type: "file",
            fileId: pendingUpload.id,
            filenameSnapshot: pendingUpload.filename,
            contentType: pendingUpload.contentType,
          },
          {
            type: "text",
            text: "Send with soft-deleted library artifact and pending upload",
          },
        ],
      },
      hasTextContent: true,
    });
    expect(sent.status).toBe(201);

    const [afterDeleteCatalog, threadEvents, retainedFileUrl] =
      await Promise.all([
        accept(
          artifactCatalogClient.list({
            headers: sessionHeaders(actor),
            query: { limit: 50 },
          }),
          [200],
        ),
        chat.listThreadEvents(actor, thread.id),
        accept(
          webFilesClient.fileUrl({
            headers: sessionHeaders(actor),
            query: { file_id: artifactUpload.id },
          }),
          [200],
        ),
      ]);
    expect(
      afterDeleteCatalog.body.artifacts.some((entry) => {
        return entry.id === artifactEntry.id;
      }),
    ).toBeFalsy();
    expect(userMessages(threadEvents.events)).toHaveLength(1);
    expect(retainedFileUrl.body.url).toContain(artifactUpload.id);
  });

  it(
    "chat-events-private-attachments-002 preserves one file in the input and run",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, storage } = await provisionMemberWorkspace({
        withRunner: true,
        withFableModel: true,
      });
      const [uploaded] = await Promise.all([
        uploadSingleFile(actor, {
          filename: "file-0.png",
          contentType: "image/png",
          bytes: Uint8Array.from(SAMPLE_PNG_BYTES),
        }),
        completeOnboardingFast(actor),
      ]);

      const filePart = {
        type: "file" as const,
        fileId: uploaded.id,
        filenameSnapshot: uploaded.filename,
        contentType: uploaded.contentType,
      };
      storage.clearHeadKeys();

      const sent = await sendAndLaunchFast(actor, {
        model: FABLE_MODEL,
        prompt: "Read one file",
        userMessage: {
          version: 1,
          parts: [filePart, { type: "text", text: "Read one file" }],
        },
      });
      registerIdempotentRunCleanup(actor, sent.runId);
      const headKeysDuringSend = storage.headKeys();

      const [run, fileUrl] = await Promise.all([
        readRun(actor, sent.runId),
        resolveWebFileUrl(actor, uploaded.id),
      ]);

      expect(headKeysDuringSend).toStrictEqual([]);
      const promptEvent = findRunPromptEvent(sent.events, sent.runId);
      const persistedFileParts = promptEvent.userMessage.parts.filter(
        (part) => {
          return part.type === "file";
        },
      );
      expect(persistedFileParts).toStrictEqual([filePart]);
      expect(extractPromptFileIds(run.prompt)).toStrictEqual([uploaded.id]);
      expect(resolvedObjectKeyFromSignedUrl(fileUrl.url)).toBe(
        `private-artifacts/${uploaded.id}/${uploaded.filename}`,
      );
      expect(fileUrl.publicUrl).toBeNull();
    },
  );

  it(
    "chat-events-private-attachments-004 preserves multiple files in the input and run",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, storage } = await provisionMemberWorkspace({
        withRunner: true,
        withFableModel: true,
      });
      const [first, second, third] = await Promise.all([
        uploadSingleFile(actor, {
          filename: "file-0.png",
          contentType: "image/png",
          bytes: Uint8Array.from(SAMPLE_PNG_BYTES),
        }),
        uploadSingleFile(actor, {
          filename: "file-1.png",
          contentType: "image/png",
          bytes: Uint8Array.from(SAMPLE_PNG_BYTES),
        }),
        uploadSingleFile(actor, {
          filename: "file-2.png",
          contentType: "image/png",
          bytes: Uint8Array.from(SAMPLE_PNG_BYTES),
        }),
        completeOnboardingFast(actor),
      ]);

      const orderedParts = [
        {
          type: "file" as const,
          fileId: third.id,
          filenameSnapshot: third.filename,
          contentType: third.contentType,
        },
        {
          type: "file" as const,
          fileId: first.id,
          filenameSnapshot: first.filename,
          contentType: first.contentType,
        },
        {
          type: "file" as const,
          fileId: second.id,
          filenameSnapshot: second.filename,
          contentType: second.contentType,
        },
      ];
      storage.clearHeadKeys();

      const sent = await sendAndLaunchFast(actor, {
        model: FABLE_MODEL,
        prompt: "Read three files",
        userMessage: {
          version: 1,
          parts: [...orderedParts, { type: "text", text: "Read three files" }],
        },
      });
      registerIdempotentRunCleanup(actor, sent.runId);
      const headKeysDuringSend = storage.headKeys();

      const [run, firstUrl, secondUrl, thirdUrl] = await Promise.all([
        readRun(actor, sent.runId),
        resolveWebFileUrl(actor, first.id),
        resolveWebFileUrl(actor, second.id),
        resolveWebFileUrl(actor, third.id),
      ]);

      expect(headKeysDuringSend).toStrictEqual([]);
      const promptEvent = findRunPromptEvent(sent.events, sent.runId);
      const persistedFileParts = promptEvent.userMessage.parts.filter(
        (part) => {
          return part.type === "file";
        },
      );
      expect(persistedFileParts).toStrictEqual(orderedParts);
      expect(extractPromptFileIds(run.prompt)).toStrictEqual([
        third.id,
        first.id,
        second.id,
      ]);
      expect(resolvedObjectKeyFromSignedUrl(firstUrl.url)).toBe(
        `private-artifacts/${first.id}/${first.filename}`,
      );
      expect(resolvedObjectKeyFromSignedUrl(secondUrl.url)).toBe(
        `private-artifacts/${second.id}/${second.filename}`,
      );
      expect(resolvedObjectKeyFromSignedUrl(thirdUrl.url)).toBe(
        `private-artifacts/${third.id}/${third.filename}`,
      );
      expect([
        firstUrl.publicUrl,
        secondUrl.publicUrl,
        thirdUrl.publicUrl,
      ]).toStrictEqual([null, null, null]);
    },
  );

  it(
    "chat-events-private-attachments-005 preserves repeated file in the input and run",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, storage } = await provisionMemberWorkspace({
        withRunner: true,
        withFableModel: true,
      });
      const [uploaded] = await Promise.all([
        uploadSingleFile(actor, {
          filename: "file-0.png",
          contentType: "image/png",
          bytes: Uint8Array.from(SAMPLE_PNG_BYTES),
        }),
        completeOnboardingFast(actor),
      ]);

      const filePart = {
        type: "file" as const,
        fileId: uploaded.id,
        filenameSnapshot: uploaded.filename,
        contentType: uploaded.contentType,
      };
      storage.clearHeadKeys();

      const sent = await sendAndLaunchFast(actor, {
        model: FABLE_MODEL,
        prompt: "Read repeated file",
        userMessage: {
          version: 1,
          parts: [
            filePart,
            filePart,
            { type: "text", text: "Read repeated file" },
          ],
        },
      });
      registerIdempotentRunCleanup(actor, sent.runId);
      const headKeysDuringSend = storage.headKeys();

      const [run, fileUrl] = await Promise.all([
        readRun(actor, sent.runId),
        resolveWebFileUrl(actor, uploaded.id),
      ]);

      expect(headKeysDuringSend).toStrictEqual([]);
      const promptEvent = findRunPromptEvent(sent.events, sent.runId);
      const persistedFileParts = promptEvent.userMessage.parts.filter(
        (part) => {
          return part.type === "file";
        },
      );
      expect(persistedFileParts).toStrictEqual([filePart, filePart]);
      expect(extractPromptFileIds(run.prompt)).toStrictEqual([
        uploaded.id,
        uploaded.id,
      ]);
      expect(resolvedObjectKeyFromSignedUrl(fileUrl.url)).toBe(
        `private-artifacts/${uploaded.id}/${uploaded.filename}`,
      );
      expect(fileUrl.publicUrl).toBeNull();
    },
  );

  it(
    "chat-events-private-attachments-006 preserves annotated file in the input and run",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, storage } = await provisionMemberWorkspace({
        withRunner: true,
        withFableModel: true,
      });
      const [original, annotated] = await Promise.all([
        uploadSingleFile(actor, {
          filename: "file-0.png",
          contentType: "image/png",
          bytes: Uint8Array.from(SAMPLE_PNG_BYTES),
        }),
        uploadSingleFile(actor, {
          filename: "file-0.annotated.png",
          contentType: "image/png",
          bytes: Uint8Array.from(SAMPLE_PNG_BYTES),
        }),
        completeOnboardingFast(actor),
      ]);

      const annotatedFilePart = {
        type: "file" as const,
        fileId: original.id,
        filenameSnapshot: original.filename,
        contentType: original.contentType,
        annotatedFileId: annotated.id,
        annotations: {
          marks: [
            {
              id: "mark-1",
              ordinal: 1,
              shape: "box" as const,
              rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
              ink: "#FF3B30",
              note: "Inspect this box",
            },
          ],
        },
      };
      storage.clearHeadKeys();

      const sent = await sendAndLaunchFast(actor, {
        model: FABLE_MODEL,
        prompt: "Read annotated file",
        userMessage: {
          version: 1,
          parts: [
            annotatedFilePart,
            { type: "text", text: "Read annotated file" },
          ],
        },
      });
      registerIdempotentRunCleanup(actor, sent.runId);
      const headKeysDuringSend = storage.headKeys();

      const [run, originalUrl, annotatedUrl] = await Promise.all([
        readRun(actor, sent.runId),
        resolveWebFileUrl(actor, original.id),
        resolveWebFileUrl(actor, annotated.id),
      ]);

      expect(headKeysDuringSend).toStrictEqual([]);
      const promptEvent = findRunPromptEvent(sent.events, sent.runId);
      const persistedFileParts = promptEvent.userMessage.parts.filter(
        (part) => {
          return part.type === "file";
        },
      );
      expect(persistedFileParts).toStrictEqual([annotatedFilePart]);
      expect(extractPromptFileIds(run.prompt)).toStrictEqual([annotated.id]);
      expect(resolvedObjectKeyFromSignedUrl(originalUrl.url)).toBe(
        `private-artifacts/${original.id}/${original.filename}`,
      );
      expect(resolvedObjectKeyFromSignedUrl(annotatedUrl.url)).toBe(
        `private-artifacts/${annotated.id}/${annotated.filename}`,
      );
      expect([originalUrl.publicUrl, annotatedUrl.publicUrl]).toStrictEqual([
        null,
        null,
      ]);
    },
  );

  it(
    "chat-events-private-attachments-009 reuses completed multipart metadata after part upload credentials stop writing",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, storage } = await provisionMemberWorkspace({
        withRunner: true,
      });
      const [prepared] = await Promise.all([
        accept(
          uploadsClient.prepare({
            headers: sessionHeaders(actor),
            body: {
              filename: "large.bin",
              contentType: "application/octet-stream",
              size: MULTIPART_TOTAL_SIZE,
              multipart: true,
            },
          }),
          [200],
        ),
        completeOnboardingFast(actor),
      ]);
      if (!("multipart" in prepared.body)) {
        throw new Error("Expected multipart upload preparation response");
      }

      const { uploadId, parts } = prepared.body.multipart;
      const partBodies = [
        Buffer.alloc(MULTIPART_PART_SIZE, 0x61),
        Buffer.from("tail", "utf8"),
      ];
      expect(parts).toHaveLength(2);
      const putResponses = await Promise.all(
        parts.map((part, index) => {
          return fetch(part.uploadUrl, {
            method: "PUT",
            body: partBodies[index],
          });
        }),
      );
      for (const partResponse of putResponses) {
        expect(partResponse.status).toBe(200);
      }

      const completed = await accept(
        uploadsClient.completeMultipart({
          headers: sessionHeaders(actor),
          body: {
            id: prepared.body.id,
            filename: prepared.body.filename,
            uploadId,
            partCount: parts.length,
          },
        }),
        [200],
      );
      expect(completed.body.id).toBe(prepared.body.id);

      const firstPart = parts[0];
      if (!firstPart) {
        throw new Error("Expected first multipart upload part");
      }
      const latePartPut = await fetch(firstPart.uploadUrl, {
        method: "PUT",
        body: Buffer.from("late", "utf8"),
      });
      expect(latePartPut.status).toBe(404);
      await expect(latePartPut.text()).resolves.toContain("NoSuchUpload");

      storage.failHeadForKey(
        `private-artifacts/${prepared.body.id}/${prepared.body.filename}`,
      );

      const sent = await sendAndLaunchFast(actor, {
        model: null,
        prompt: "Inspect multipart file",
        userMessage: {
          version: 1,
          parts: [
            {
              type: "file",
              fileId: prepared.body.id,
              filenameSnapshot: prepared.body.filename,
              contentType: prepared.body.contentType,
            },
            { type: "text", text: "Inspect multipart file" },
          ],
        },
      });
      registerIdempotentRunCleanup(actor, sent.runId);

      const run = await readRun(actor, sent.runId);
      expect(run.prompt).toContain(`[ID] ${prepared.body.id}`);
    },
  );
});
