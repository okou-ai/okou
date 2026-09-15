import { createRouteMocks } from "./helpers/route-test";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import AdmZip from "adm-zip";
import {
  ZipWriter,
  Uint8ArrayWriter,
  Uint8ArrayReader,
} from "@zip.js/zip.js/index-native.js";
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type GetObjectCommandInput,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import {
  introVideoRenderRequestSchema,
  introVideoRenderResponseSchema,
  type IntroVideoRenderRequest,
} from "@okouai/api-contracts/contracts/intro-video-render";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { apiTestS3PresignedUrl } from "../../../__tests__/mocks";
import { testContext } from "../../../__tests__/test-context";
import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv } from "../../../lib/env";
import { now, nowDate, withMockNowForTest } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createUsagePricingFixture } from "../../../test-fixtures/system-config-seeds";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { billingStatusRoutes } from "../billing-status";
import { introVideoRenderRoutes } from "../intro-video-render";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { webhooksBuiltInGenerationRoutes } from "../webhooks-built-in-generations";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";

const context = testContext();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);
const CREATE = "https://api.heygen.com/v3/hyperframes/renders";
const VIDEO_URL = "https://files.heygen.test/cloud.mp4";
const VIDEO_BYTES = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from("ftypisom"),
  Buffer.alloc(20),
]);
const pricingKey = Object.freeze({
  kind: "video",
  provider: "heygen-hyperframes-render",
  category: "output_video_seconds",
});

async function fixture(enabled = true, priced = true) {
  const pricing = await createUsagePricingFixture({
    configured: priced ? [{ ...pricingKey, unitPrice: 10, unitSize: 1 }] : [],
    missing: [pricingKey],
  });
  onTestFinished(pricing.cleanup);
  const identity = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  const actor = bdd.user(identity);
  runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor, { tier: "team" });
  await runs.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Cloud render acceptance",
    visibility: "private",
  });
  const sent = await chat.requestSendEvent(
    actor,
    { agentId: agent.agentId, prompt: "Render the preserved presentation." },
    [201],
  );
  if (sent.status !== 201 || !sent.body.runId) {
    throw new Error("Expected the chat API to create a render owner's run");
  }
  const runId = sent.body.runId;
  onTestFinished(async () => {
    await runs.requestCancelRun(actor, runId, [200]);
  });
  mocks.clerk.session(identity.userId, identity.orgId);
  await updateFeatureSwitchesForUser(context, identity, {
    [FeatureSwitchKey.IntroVideo]: enabled,
  });
  const seconds = Math.floor(now() / 1000);
  const token = signSandboxJwtForTests({
    scope: "okou",
    ...identity,
    runId,
    capabilities: ["file:write"],
    iat: seconds,
    exp: seconds + 48 * 60 * 60,
  });
  return { ...identity, runId, token, pricing: pricing.resolution };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function app(f: Fixture, signal = context.signal) {
  return createAppWithRoutes({
    signal,
    usagePricingResolution: f.pricing,
    routes: [
      ...introVideoRenderRoutes,
      ...uploadsPrepareRoutes,
      ...uploadsCompleteRoutes,
      ...webhooksBuiltInGenerationRoutes,
      ...billingStatusRoutes,
    ],
  });
}
function headers(f: Fixture) {
  return {
    authorization: `Bearer ${f.token}`,
    "content-type": "application/json",
  };
}
async function getRender(f: Fixture, id: string) {
  const response = await app(f).request(`/api/intro-video/renders/${id}`, {
    headers: headers(f),
  });
  expect(response.status).toBe(200);
  return introVideoRenderResponseSchema.parse(await response.json());
}
function submit(f: Fixture, input: IntroVideoRenderRequest) {
  return app(f).request("/api/intro-video/renders", {
    method: "POST",
    headers: headers(f),
    body: JSON.stringify(input),
  });
}
async function balance(f: Fixture) {
  mocks.clerk.session(f.userId, f.orgId);
  const response = await app(f).request("/api/billing/status", {
    headers: { authorization: "Bearer clerk-session" },
  });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    !body ||
    !("credits" in body) ||
    typeof body.credits !== "number"
  ) {
    throw new Error("Expected credit balance");
  }
  return body.credits;
}

function mockStorage() {
  const objects = new Map<
    string,
    {
      bytes: Buffer;
      contentType: string;
      metadata: Record<string, string>;
    }
  >();
  const uploads = new Map<string, PutObjectCommandInput>();
  const downloads = new Map<string, GetObjectCommandInput>();
  context.mocks.s3.getSignedUrl.mockImplementation((_client, command) => {
    const url = new URL(apiTestS3PresignedUrl(command));
    if (command instanceof GetObjectCommand) {
      url.searchParams.set("signed-at", nowDate().toISOString());
      downloads.set(url.toString(), command.input);
    }
    if (command instanceof PutObjectCommand) {
      uploads.set(url.toString(), command.input);
    }
    return Promise.resolve(url.toString());
  });
  server.use(
    http.get("https://r2.example.com/storage/archive.tar.gz", ({ request }) => {
      const download = downloads.get(request.url);
      if (!download) {
        return new HttpResponse(null, { status: 403 });
      }
      const object = objects.get(`${download.Bucket}/${download.Key}`);
      if (!object) {
        return new HttpResponse(null, { status: 404 });
      }
      return new HttpResponse(new Uint8Array(object.bytes), {
        headers: {
          "content-type": object.contentType,
          ...(download.ResponseCacheControl
            ? { "cache-control": download.ResponseCacheControl }
            : {}),
        },
      });
    }),
    http.put("*", async ({ request }) => {
      const upload = uploads.get(request.url);
      if (!upload) {
        return HttpResponse.json({ error: "Unknown upload" }, { status: 404 });
      }
      objects.set(`${upload.Bucket}/${upload.Key}`, {
        bytes: Buffer.from(await request.arrayBuffer()),
        contentType: upload.ContentType ?? "application/octet-stream",
        metadata: upload.Metadata ?? {},
      });
      return new HttpResponse(null, { status: 200 });
    }),
  );
  context.mocks.s3.send.mockImplementation((command) => {
    if (command instanceof ListObjectsV2Command) {
      const prefix = `${command.input.Bucket}/${command.input.Prefix ?? ""}`;
      return Promise.resolve({
        Contents: [...objects]
          .filter(([key]) => {
            return key.startsWith(prefix);
          })
          .map(([key, value]) => {
            return {
              Key: key.slice(`${command.input.Bucket}/`.length),
              Size: value.bytes.length,
              LastModified: nowDate(),
            };
          }),
        IsTruncated: false,
      });
    }
    if (command instanceof PutObjectCommand) {
      const body = command.input.Body;
      if (!(typeof body === "string" || body instanceof Uint8Array)) {
        throw new Error("Expected bounded storage bytes");
      }
      const key = `${command.input.Bucket}/${command.input.Key}`;
      if (!command.input.IfNoneMatch || !objects.has(key)) {
        objects.set(key, {
          bytes: Buffer.from(body),
          contentType: command.input.ContentType ?? "application/octet-stream",
          metadata: command.input.Metadata ?? {},
        });
      }
      return Promise.resolve({});
    }
    if (
      command instanceof HeadObjectCommand ||
      command instanceof GetObjectCommand
    ) {
      const object = objects.get(
        `${command.input.Bucket}/${command.input.Key}`,
      );
      if (!object) {
        return Promise.reject(
          Object.assign(new Error("Not found"), {
            name: "NotFound",
            $metadata: { httpStatusCode: 404 },
          }),
        );
      }
      return Promise.resolve({
        ContentType: object.contentType,
        ContentLength: object.bytes.length,
        Metadata: object.metadata,
        LastModified: nowDate(),
        ETag: '"test-etag"',
        ...(command instanceof GetObjectCommand
          ? { Body: Readable.from([object.bytes]) }
          : {}),
      });
    }
    return Promise.resolve({});
  });
}

async function upload(f: Fixture, bytes?: Buffer) {
  const archive = new AdmZip();
  archive.addFile(
    "index.html",
    Buffer.from(
      '<html><div data-width="1920" data-height="1080">Original slides</div></html>',
    ),
  );
  const content = bytes ?? archive.toBuffer();
  const prepared = await app(f).request("/api/uploads/prepare", {
    method: "POST",
    headers: headers(f),
    body: JSON.stringify({
      filename: "project.zip",
      contentType: "application/zip",
      size: content.length,
    }),
  });
  expect(prepared.status).toBe(200);
  const value = (await prepared.json()) as {
    id: string;
    uploadUrl: string;
    uploadHeaders: Record<string, string>;
  };
  const put = await fetch(value.uploadUrl, {
    method: "PUT",
    headers: value.uploadHeaders,
    body: new Uint8Array(content),
  });
  expect(put.status).toBe(200);
  const completed = await app(f).request("/api/uploads/complete", {
    method: "POST",
    headers: headers(f),
    body: JSON.stringify({ id: value.id }),
  });
  expect(completed.status).toBe(200);
  return introVideoRenderRequestSchema.parse({
    requestId: randomUUID(),
    projectFileId: value.id,
    output: {
      format: "mp4",
      resolution: "1080p",
      fps: 30,
      quality: "standard",
      aspectRatio: "16:9",
    },
  });
}

async function queueRender(f: Fixture) {
  const input = await upload(f);
  for (let index = 0; index < 3; index++) {
    expect(
      (await submit(f, { ...input, requestId: randomUUID() })).status,
    ).toBe(202);
  }
  expect((await submit(f, input)).status).toBe(202);
  expect((await getRender(f, input.requestId)).phase).toBe("preparing");
  return input;
}

function providerProjectUrl(body: Record<string, unknown> | undefined): URL {
  const project = body?.project;
  if (
    typeof project !== "object" ||
    !project ||
    !("url" in project) ||
    typeof project.url !== "string"
  ) {
    throw new Error("Expected a provider project URL");
  }
  return new URL(project.url);
}

function provider() {
  const state = {
    status: "queued",
    reject: false,
    loseResponse: false,
    downloadsFail: false,
    rejectMessage: "Missing project asset",
    beforeResponse: undefined as (() => Promise<void>) | undefined,
    requests: [] as { key: string | null; body: Record<string, unknown> }[],
    callbackUrl: "",
    callbackId: "",
  };
  server.use(
    http.post(CREATE, async ({ request }) => {
      expect(request.headers.get("x-api-key")).toBe("test-heygen-key");
      const body = (await request.json()) as Record<string, unknown>;
      state.requests.push({
        key: request.headers.get("idempotency-key"),
        body,
      });
      state.callbackId = String(body.callback_id);
      state.callbackUrl = String(body.callback_url);
      await state.beforeResponse?.();
      if (state.reject) {
        return HttpResponse.json(
          {
            error: {
              code: "hyperframes_project_invalid",
              message: state.rejectMessage,
            },
          },
          { status: 400 },
        );
      }
      if (state.loseResponse) {
        return HttpResponse.json(
          {
            error: {
              code: "request_in_progress",
              message: "Submission in progress",
            },
          },
          { status: 409 },
        );
      }
      return HttpResponse.json(
        { data: { render_id: "hfr_test" } },
        { status: 202 },
      );
    }),
    http.get(`${CREATE}/hfr_test`, () => {
      return HttpResponse.json({
        data: {
          render_id: "hfr_test",
          callback_id: state.callbackId,
          status: state.status,
          ...(state.status === "completed"
            ? {
                video_url: VIDEO_URL,
                duration: 10.1,
                width: 1920,
                height: 1080,
                fps: 30,
              }
            : {}),
          ...(state.status === "failed"
            ? { failure_message: "An image could not be decoded" }
            : {}),
        },
      });
    }),
    http.get(VIDEO_URL, () => {
      return state.downloadsFail
        ? new HttpResponse(null, { status: 503 })
        : new HttpResponse(VIDEO_BYTES, {
            headers: { "content-type": "video/mp4" },
          });
    }),
  );
  return state;
}

describe("managed Intro Video cloud rendering", () => {
  beforeEach(() => {
    mockEnv("HEYGEN_API_KEY", "test-heygen-key");
    context.mocks.clerk.authenticateRequest.mockReset();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    context.mocks.clerk.users.getUserList.mockResolvedValue({ data: [] });
    context.mocks.s3.send.mockReset();
    context.mocks.s3.send.mockResolvedValue({});
    context.mocks.ably.createTokenRequest.mockResolvedValue({
      keyName: "test",
      timestamp: 1_700_000_000_000,
      capability: "{}",
      clientId: "test",
      nonce: "test",
      mac: "test",
    });
    mockStorage();
  });

  it("rejects new renders when Intro Video is disabled", async () => {
    const f = await fixture(false);
    const input = await upload(f);
    const cloud = provider();
    expect((await submit(f, input)).status).toBe(403);
    expect(cloud.requests).toHaveLength(0);
  });

  it("rejects new renders without dedicated pricing", async () => {
    const unpriced = await fixture(true, false);
    const missingPriceInput = await upload(unpriced);
    const cloud = provider();
    expect((await submit(unpriced, missingPriceInput)).status).toBe(503);
    expect(cloud.requests).toHaveLength(0);
  });

  async function acceptUserStorageRender() {
    const f = await fixture();
    const input = await upload(f);
    mockEnv("R2_PRIVATE_ARTIFACTS_BUCKET_NAME", undefined);
    mockEnv("R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID", undefined);
    mockEnv("R2_PRIVATE_ARTIFACTS_SECRET_ACCESS_KEY", undefined);
    const cloud = provider();
    expect((await submit(f, input)).status).toBe(202);
    expect(cloud.requests).toHaveLength(1);
    const projectUrl = providerProjectUrl(cloud.requests[0]?.body);
    expect(projectUrl.searchParams.get("object")).toMatch(
      new RegExp(
        `^test-user-storages/intro-video-render-inputs/${input.requestId}/[a-f0-9]{64}\\.zip$`,
      ),
    );
    return { f, input, cloud, projectUrl };
  }

  it("keeps render input snapshots private and immutable without private-artifact credentials", async () => {
    const { input, projectUrl } = await acceptUserStorageRender();
    const snapshot = await fetch(projectUrl);
    expect(snapshot.status).toBe(200);
    expect(snapshot.headers.get("cache-control")).toBe("private, no-store");
    const archive = new AdmZip(Buffer.from(await snapshot.arrayBuffer()));
    expect(archive.readAsText("index.html")).toContain("Original slides");
    const write = context.mocks.s3.send.mock.calls
      .map(([command]) => {
        return command;
      })
      .find((command): command is PutObjectCommand => {
        return (
          command instanceof PutObjectCommand &&
          command.input.Key?.startsWith(
            `intro-video-render-inputs/${input.requestId}/`,
          ) === true
        );
      });
    expect(write?.input).toMatchObject({
      Bucket: "test-user-storages",
      CacheControl: "private, no-store",
      IfNoneMatch: "*",
    });
  });

  it("hides provider input URLs while reporting user-storage render completion", async () => {
    const { f, input, cloud, projectUrl } = await acceptUserStorageRender();
    const response = await getRender(f, input.requestId);
    expect(JSON.stringify(response)).not.toContain(projectUrl.toString());
    cloud.status = "completed";
    expect((await getRender(f, input.requestId)).status).toBe("completed");
  });

  it.each([
    "test-user-artifacts",
    "test-hosted-sites",
    "test-private-artifacts",
  ])(
    "rejects render input storage aliased to %s before paid submission",
    async (bucket) => {
      const f = await fixture();
      const input = await upload(f);
      const cloud = provider();
      mockEnv("R2_USER_STORAGES_BUCKET_NAME", bucket);
      const response = await submit(f, input);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "RENDER_NOT_CONFIGURED" },
      });
      expect(cloud.requests).toHaveLength(0);
    },
  );

  it("resumes queued input from its saved bucket after storage configuration changes", async () => {
    const f = await fixture();
    const cloud = provider();
    const input = await queueRender(f);
    expect(cloud.requests).toHaveLength(3);
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", "next-user-storages");
    await withMockNowForTest(new Date(now() + 31 * 60 * 1000), async () => {
      expect((await submit(f, input)).status).toBe(202);
      expect(cloud.requests).toHaveLength(4);
      const projectUrl = providerProjectUrl(cloud.requests[3]?.body);
      expect(projectUrl.searchParams.get("object")).toContain(
        `test-user-storages/intro-video-render-inputs/${input.requestId}/`,
      );
      expect(projectUrl.searchParams.get("signed-at")).toBe(
        nowDate().toISOString(),
      );
      expect((await fetch(projectUrl)).status).toBe(200);
      expect((await getRender(f, input.requestId)).providerRenderId).toBe(
        "hfr_test",
      );
    });
  });

  it("rejects foreign files and invalid projects before creating paid work", async () => {
    const f = await fixture();
    const other = await fixture();
    const input = await upload(f);
    const cloud = provider();
    expect((await submit(other, input)).status).toBe(404);
    expect(
      (
        await submit(f, {
          ...input,
          output: { ...input.output, aspectRatio: "9:16" },
        })
      ).status,
    ).toBe(400);
    const invalid = await upload(f, Buffer.from("not a ZIP"));
    expect((await submit(f, invalid)).status).toBe(400);
    const unsafe = await app(f).request("/api/intro-video/renders", {
      method: "POST",
      headers: headers(f),
      body: JSON.stringify({
        ...input,
        composition: "../index.html",
        apiKey: "personal-key",
      }),
    });
    expect(unsafe.status).toBe(400);
    expect(cloud.requests).toHaveLength(0);
  });

  it("rejects symbolic links and oversized compressed HTML before provider submission", async () => {
    const f = await fixture();
    const cloud = provider();
    const linked = new ZipWriter(new Uint8ArrayWriter(), {
      useWebWorkers: false,
      useCompressionStream: true,
    });
    await linked.add(
      "index.html",
      new Uint8ArrayReader(Buffer.from("<html>Original pages</html>")),
    );
    await linked.add(
      "assets/link",
      new Uint8ArrayReader(Buffer.from("../../outside")),
      { unixMode: 0o12_0777 },
    );
    const linkedInput = await upload(f, Buffer.from(await linked.close()));
    expect((await submit(f, linkedInput)).status).toBe(400);
    const oversized = new ZipWriter(new Uint8ArrayWriter(), {
      useWebWorkers: false,
      useCompressionStream: true,
    });
    await oversized.add(
      "index.html",
      new Uint8ArrayReader(Buffer.alloc(2 * 1024 * 1024, 65)),
    );
    const oversizedInput = await upload(
      f,
      Buffer.from(await oversized.close()),
    );
    expect((await submit(f, oversizedInput)).status).toBe(400);
    expect(cloud.requests).toHaveLength(0);
  });

  it("reuses one render, rejects changed input, and keeps admitted jobs accessible after disabling creation", async () => {
    const f = await fixture();
    const input = await upload(f);
    const cloud = provider();
    expect((await submit(f, input)).status).toBe(202);
    expect((await submit(f, input)).status).toBe(202);
    expect(
      (await submit(f, { ...input, title: "Different input" })).status,
    ).toBe(409);
    expect(cloud.requests).toHaveLength(1);
    await updateFeatureSwitchesForUser(context, f, {
      [FeatureSwitchKey.IntroVideo]: false,
    });
    expect((await getRender(f, input.requestId)).providerRenderId).toBe(
      "hfr_test",
    );
    const other = await fixture();
    expect(
      (
        await app(other).request(
          `/api/intro-video/renders/${input.requestId}`,
          { headers: headers(other) },
        )
      ).status,
    ).toBe(404);
  });

  it("replays an unknown submission with the same key and body while GET remains read-only upstream", async () => {
    const f = await fixture();
    const input = await upload(f);
    const cloud = provider();
    cloud.loseResponse = true;
    expect((await submit(f, input)).status).toBe(202);
    expect((await getRender(f, input.requestId)).recovery.action).toBe(
      "replay_submission",
    );
    expect(cloud.requests).toHaveLength(1);
    cloud.loseResponse = false;
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", "next-user-storages");
    mockEnv("R2_PRIVATE_ARTIFACTS_BUCKET_NAME", undefined);
    await withMockNowForTest(new Date(now() + 10 * 60 * 1000), async () => {
      expect((await submit(f, input)).status).toBe(202);
    });
    expect(cloud.requests[1]).toStrictEqual(cloud.requests[0]);
    expect((await getRender(f, input.requestId)).providerRenderId).toBe(
      "hfr_test",
    );
  });

  it("does not replay beyond the provider idempotency window", async () => {
    const f = await fixture();
    const input = await upload(f);
    const cloud = provider();
    cloud.loseResponse = true;
    await submit(f, input);
    await withMockNowForTest(
      new Date(now() + 24 * 60 * 60 * 1000),
      async () => {
        expect((await getRender(f, input.requestId)).recovery.action).toBe(
          "manual_check",
        );
        await submit(f, input);
        cloud.status = "completed";
        const callback = new URL(cloud.callbackUrl);
        const recovered = await app(f).request(
          `${callback.pathname}${callback.search}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              event_data: {
                video_id: "hfr_test",
                callback_id: input.requestId,
              },
            }),
          },
        );
        expect(recovered.status).toBe(200);
        expect((await getRender(f, input.requestId)).status).toBe("completed");
      },
    );
    expect(cloud.requests).toHaveLength(1);
  });

  it("owns concurrent submissions and an early callback with one provider request and settlement", async () => {
    const f = await fixture();
    const input = await upload(f);
    const cloud = provider();
    const started = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    const before = await balance(f);
    cloud.beforeResponse = async () => {
      started.resolve();
      await release.promise;
    };
    const first = submit(f, input);
    const checked = await settleIncludingAbort(
      (async () => {
        await started.promise;
        const [duplicate, status] = await Promise.all([
          submit(f, input),
          getRender(f, input.requestId),
        ]);
        expect(duplicate.status).toBe(202);
        expect(status.recovery.action).toBe("poll");
        cloud.status = "completed";
        const callback = new URL(cloud.callbackUrl);
        const early = await app(f).request(
          `${callback.pathname}${callback.search}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              event_data: {
                render_id: "hfr_test",
                callback_id: input.requestId,
              },
            }),
          },
        );
        expect(early.status).toBe(503);
        expect((await getRender(f, input.requestId)).providerRenderId).toBe(
          "hfr_test",
        );
      })(),
    );
    release.resolve();
    await first;
    if (!checked.ok) {
      throw checked.error;
    }
    const result = await getRender(f, input.requestId);
    expect(result.status).toBe("completed");
    expect(result.billing.creditsCharged).toBe(before - (await balance(f)));
    expect(result.billing.creditsCharged).toBe(110);
    expect(cloud.requests).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("test-heygen-key");
    expect(JSON.stringify(result)).not.toContain("intro-video-render-inputs/");
  });

  it("releases an interrupted request lease so a later request can resume the original submission", async () => {
    const f = await fixture();
    const input = await upload(f);
    const cloud = provider();
    const owner = new AbortController();
    const started = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    cloud.beforeResponse = async () => {
      started.resolve();
      await release.promise;
    };
    const submitting = settleIncludingAbort(
      Promise.resolve(
        app(f, owner.signal).request("/api/intro-video/renders", {
          method: "POST",
          headers: headers(f),
          body: JSON.stringify(input),
        }),
      ),
    );
    await started.promise;
    owner.abort();
    release.resolve();
    await submitting;
    const interrupted = await getRender(f, input.requestId);
    expect(interrupted.recovery.action).toBe("replay_submission");
    cloud.beforeResponse = undefined;
    await submit(f, input);
    expect((await getRender(f, input.requestId)).providerRenderId).toBe(
      "hfr_test",
    );
    expect(cloud.requests).toHaveLength(2);
    expect(cloud.requests[1]).toStrictEqual(cloud.requests[0]);
  });

  it("recovers transfer failures and settles the actual ledger once across duplicate callbacks", async () => {
    const f = await fixture();
    const input = await upload(f);
    const cloud = provider();
    const before = await balance(f);
    await submit(f, input);
    cloud.status = "completed";
    cloud.downloadsFail = true;
    const pending = await getRender(f, input.requestId);
    expect(pending.phase).toBe("persisting");
    expect(pending.billing.creditsCharged).toBeNull();
    cloud.downloadsFail = false;
    const callback = new URL(cloud.callbackUrl);
    const event = {
      event_data: { render_id: "hfr_test", callback_id: input.requestId },
    };
    for (let count = 0; count < 2; count += 1) {
      const response = await app(f).request(
        `${callback.pathname}${callback.search}`,
        {
          method: "POST",
          body: JSON.stringify(event),
          headers: { "content-type": "application/json" },
        },
      );
      expect(response.status).toBe(200);
    }
    const result = await getRender(f, input.requestId);
    expect(result.status).toBe("completed");
    expect(result.result?.contentType).toBe("video/mp4");
    expect(result.result?.url).not.toBe(VIDEO_URL);
    expect(result.billing.creditsCharged).toBe(before - (await balance(f)));
    expect(result.billing.creditsCharged).toBe(110);
    expect(cloud.requests).toHaveLength(1);
  });

  it("returns an actionable provider failure without a replacement charge", async () => {
    const f = await fixture();
    const input = await upload(f);
    const cloud = provider();
    cloud.reject = true;
    const response = await submit(f, input);
    expect(response.status).toBe(200);
    const result = introVideoRenderResponseSchema.parse(await response.json());
    expect(result.status).toBe("failed");
    expect(result.error?.message).toBe("Missing project asset");
    expect(result.recovery.action).toBe("none");
    await submit(f, input);
    expect(cloud.requests).toHaveLength(1);
  });

  it("redacts platform credentials and provider URLs from failure responses", async () => {
    const f = await fixture();
    const input = await upload(f);
    const cloud = provider();
    cloud.reject = true;
    cloud.rejectMessage =
      "Invalid test-heygen-key loading https://private.example.com/input?token=secret";
    const response = await submit(f, input);
    const result = introVideoRenderResponseSchema.parse(await response.json());
    expect(result.error?.message).toBe(
      "Invalid [redacted] loading [provider URL]",
    );
  });
});
