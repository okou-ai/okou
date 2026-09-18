import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  artifactReferencesContract,
  parseArtifactReference,
} from "@okouai/api-contracts/contracts/artifact-references";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { setupApp } from "../../../__tests__/test-helpers";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { webFileUrlRoutes } from "../web-file-url";
import { artifactReferenceRoutes } from "../artifact-references";
import { createHash, randomUUID } from "node:crypto";
import { createStore } from "ccstate";

import { HttpResponse, http } from "msw";
import type { ArtifactSummary } from "@okouai/api-contracts/contracts/artifact-catalog";
import { describe, expect, it } from "vitest";

import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { accept, testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createHostMapsBddApi } from "./helpers/api-bdd-host-maps";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { readRunUploadedFileSources } from "./helpers/runtime-state";
import { seedRun$ } from "./helpers/usage-state";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const host = createHostMapsBddApi(context);
const webhooks = createWebhookCallbackApi(context);
const CLOUDFLARE_SNAPSHOT_URL =
  "https://api.cloudflare.com/client/v4/accounts/test-account/browser-rendering/snapshot";
const CLOUDFLARE_MEDIA_FRAME_URL =
  /^https:\/\/cdn\.vm7\.io\/cdn-cgi\/media\/mode=frame,time=1s,width=640,format=jpg\//;
const ARTIFACT_PREVIEW_WAF_SECRET = "test-artifact-preview-waf-secret-value";
type RunnerClaim = Awaited<ReturnType<typeof api.claimRunnerJob>>;
type ChatObjectStorage = ReturnType<
  typeof chatCallbacks.acceptChatObjectStorage
>;

interface ArtifactActor {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly objectStore: ChatObjectStorage;
}

async function resolvePrivatePreviewReference(url: string) {
  const reference = parseArtifactReference(url);
  if (!reference) {
    throw new Error("Expected a private preview reference");
  }
  const resolved = await accept(
    setupApp({ context, routes: artifactReferenceRoutes })(
      artifactReferencesContract,
    ).resolve({
      headers: { authorization: "Bearer clerk-session" },
      params: { reference: `${reference.hash}${reference.extension}` },
    }),
    [200],
  );
  expect(reference.hash).toMatch(/^[a-z0-9]{10}$/u);
  expect(resolved.body.target.kind).toBe("file");
  return resolved.body.target;
}

interface SnapshotRequest {
  readonly authorization: string | null;
  readonly url: string;
  readonly body: unknown;
}

interface SnapshotFixture {
  readonly beforeResponse?: () => Promise<void>;
  readonly content?: string;
  readonly error?: {
    readonly code: number;
    readonly detail?: string;
    readonly message: string;
    readonly status: number;
  };
  readonly headers?: Record<string, string>;
  readonly screenshot?: string;
  readonly status?: number;
  readonly title?: string;
}

interface MediaFrameRequest {
  readonly url: string;
}

function mockCloudflareSnapshot(
  fixtures: readonly SnapshotFixture[] = [{}],
): SnapshotRequest[] {
  const requests: SnapshotRequest[] = [];
  server.use(
    http.post(CLOUDFLARE_SNAPSHOT_URL, async ({ request }) => {
      requests.push({
        authorization: request.headers.get("authorization"),
        url: request.url,
        body: await request.json(),
      });
      const fixture = fixtures[requests.length - 1];
      if (!fixture) {
        throw new Error("Missing Cloudflare snapshot fixture");
      }
      await fixture.beforeResponse?.();
      if (fixture.error) {
        return HttpResponse.json(
          {
            success: false,
            errors: [
              {
                code: fixture.error.code,
                message: fixture.error.message,
                detail: fixture.error.detail,
              },
            ],
            messages: [],
            result: null,
          },
          {
            status: fixture.error.status,
            ...(fixture.headers === undefined
              ? {}
              : { headers: fixture.headers }),
          },
        );
      }
      return HttpResponse.json({
        meta: {
          status: fixture.status ?? 200,
          title: fixture.title ?? "Artifact",
        },
        success: true,
        errors: [],
        result: {
          content:
            fixture.content ??
            "<!doctype html><html><body>artifact</body></html>",
          screenshot: fixture.screenshot ?? "UklGRg==",
        },
      });
    }),
  );
  return requests;
}

/**
 * Cloudflare's client API throttle response: HTTP 429 with generic code `971`
 * and no `detail`, optionally stating the wait it will honour.
 */
function rateLimitedSnapshot(retryAfterSeconds?: string): SnapshotFixture {
  return {
    error: {
      code: 971,
      message: "Please wait and consider throttling your request speed",
      status: 429,
    },
    ...(retryAfterSeconds === undefined
      ? {}
      : { headers: { "retry-after": retryAfterSeconds } }),
  };
}

/**
 * The action-stage timeout: HTTP 422 with `6002` and a `detail` that, unlike
 * the navigation and selector timers, names no stage at all.
 */
function actionTimedOutSnapshot(): SnapshotFixture {
  return {
    error: {
      code: 6002,
      message:
        "A timeout was reached. Check gotoOptions/waitForSelector/waitForTimeout/actionTimeout options.",
      detail: "Request timed out",
      status: 422,
    },
  };
}

function mockCloudflareVideoFrame(
  userId: string,
  status = 200,
): MediaFrameRequest[] {
  const requests: MediaFrameRequest[] = [];
  server.use(
    http.get(CLOUDFLARE_MEDIA_FRAME_URL, ({ request }) => {
      if (!request.url.includes(`/artifacts/${userId}/`)) {
        return new HttpResponse("foreign test artifact", { status: 415 });
      }
      requests.push({ url: request.url });
      if (status !== 200) {
        return new HttpResponse("unsupported video", { status });
      }
      return new HttpResponse(new Uint8Array([0xff, 0xd8, 0xff]), {
        headers: { "Content-Type": "image/jpeg" },
      });
    }),
  );
  return requests;
}

async function artifactActor(
  displayName: string,
  actor: ApiTestUser = bdd.user(),
): Promise<ArtifactActor> {
  const objectStore = chatCallbacks.acceptChatObjectStorage();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  chatCallbacks.disableVapid();
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName,
    visibility: "private",
  });
  return { actor, agentId: agent.agentId, runnerGroup, objectStore };
}

async function sendChatRun(
  actor: ApiTestUser,
  body: {
    readonly agentId: string;
    readonly prompt: string;
    readonly threadId?: string;
  },
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const sent = await chat.requestSendEvent(actor, body, [201]);
  if (sent.status !== 201 || sent.body.runId === null) {
    throw new Error("Expected chat send to create a run");
  }
  return { runId: sent.body.runId, threadId: sent.body.threadId };
}

async function claimChatRun(
  runnerGroup: string,
  runId: string,
): Promise<{
  readonly claim: RunnerClaim;
  readonly sandboxHeaders: { readonly authorization: string };
}> {
  await api.heartbeatRunner(runnerGroup);
  const claim = await api.claimRunnerJob(runId);
  return {
    claim,
    sandboxHeaders: { authorization: `Bearer ${claim.sandboxToken}` },
  };
}

function okouTokenFromClaim(claim: RunnerClaim): string {
  const token = claim.platformEnvironment.OKOU_TOKEN;
  if (!token || !token.startsWith("vm0_sandbox_")) {
    throw new Error(
      "Expected the claim platform environment to carry an OKOU_TOKEN",
    );
  }
  return token;
}

function fileWriteToken(owner: ArtifactActor, runId: string): string {
  if (!owner.actor.orgId) {
    throw new Error("Expected artifact test actor to have an org");
  }
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "okou",
    userId: owner.actor.userId,
    orgId: owner.actor.orgId,
    runId,
    capabilities: ["file:write"],
    iat: seconds,
    exp: seconds + 60,
  });
}

async function completeChatRunOk(
  runId: string,
  sandboxHeaders: { readonly authorization: string },
): Promise<void> {
  const historyHash = createHash("sha256")
    .update(`bdd artifacts history ${runId}`)
    .digest("hex");
  await webhooks.requestAgentComplete(
    {
      runId,
      exitCode: 0,
      checkpoint: {
        cliAgentType: "claude-code",
        cliAgentSessionId: `bdd-cli-${runId}`,
        cliAgentSessionHistoryHash: historyHash,
      },
    },
    sandboxHeaders,
    [200],
  );
}

async function createHostedArtifact(args: {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly objectStore: ChatObjectStorage;
  readonly site: string;
  readonly artifactKind?: "hosted-site" | "presentation-html";
}): Promise<{
  readonly threadId: string;
  readonly url: string;
  readonly aliasUrl: string;
  readonly deploymentId: string;
  readonly bearer: string;
}> {
  const run = await sendChatRun(args.actor, {
    agentId: args.agentId,
    prompt: `create ${args.site}`,
  });
  const { claim, sandboxHeaders } = await claimChatRun(
    args.runnerGroup,
    run.runId,
  );
  const bearer = `Bearer ${okouTokenFromClaim(claim)}`;
  const content = `<main>${args.site}</main>`;
  const prepared = await chat.prepareHostedSiteWithBearer(bearer, {
    site: args.site,
    artifactKind: args.artifactKind ?? "hosted-site",
    spaFallback: false,
    files: [hostedTextFile("/index.html", content)],
  });
  if (!prepared.artifactUrl) {
    throw new Error("Expected a versioned hosted artifact URL");
  }
  if (parseArtifactReference(prepared.artifactUrl)) {
    args.objectStore.addObject({
      bucket: "test-hosted-sites",
      key: `private-sites/okou/${prepared.deploymentId}/index.html`,
      body: Buffer.from(content),
      size: Buffer.byteLength(content),
      contentType: "text/html",
    });
  }
  await chat.completeHostedSiteWithBearer(bearer, prepared.deploymentId);
  await completeChatRunOk(run.runId, sandboxHeaders);
  return {
    threadId: run.threadId,
    url: prepared.artifactUrl,
    aliasUrl: prepared.url,
    deploymentId: prepared.deploymentId,
    bearer,
  };
}

async function createRunUploadedFile(args: {
  readonly owner: ArtifactActor;
  readonly prompt: string;
  readonly filename: string;
  readonly contentType: string;
  readonly privateUpload?: boolean;
  readonly size?: number;
}): Promise<{ readonly url: string; readonly threadId: string }> {
  const run = await sendChatRun(args.owner.actor, {
    agentId: args.owner.agentId,
    prompt: args.prompt,
  });
  const { claim, sandboxHeaders } = await claimChatRun(
    args.owner.runnerGroup,
    run.runId,
  );
  const bearer = `Bearer ${okouTokenFromClaim(claim)}`;
  const fileId = args.privateUpload
    ? (
        await chat.prepareUpload(args.owner.actor, {
          filename: args.filename,
          contentType: args.contentType,
          size: args.size ?? 1024,
        })
      ).id
    : randomUUID();
  args.owner.objectStore.addObject({
    bucket: args.privateUpload
      ? "test-private-artifacts"
      : "test-user-artifacts",
    key: args.privateUpload
      ? `private-artifacts/${fileId}/${args.filename}`
      : `artifacts/${args.owner.actor.userId}/${fileId}/${args.filename}`,
    contentType: args.contentType,
    size: args.size ?? 1024,
  });
  const completed = await chat.completeUploadWithBearer(
    bearer,
    { id: fileId, contentType: args.contentType },
    [200],
  );
  if (completed.status !== 200) {
    throw new Error("Expected run upload completion to succeed");
  }
  await completeChatRunOk(run.runId, sandboxHeaders);
  return { url: completed.body.url, threadId: run.threadId };
}

async function findCatalogArtifact(
  actor: ApiTestUser,
  title: string,
): Promise<ArtifactSummary | undefined> {
  const catalog = await chat.listArtifactCatalog(actor);
  return catalog.artifacts.find((artifact) => {
    return artifact.title === title;
  });
}

describe("video Artifact previews", () => {
  it.each([false, true])(
    "generates an owner-only private video poster (rollback during rendering=%s)",
    async (rollback) => {
      const owner = await artifactActor("Private video preview");
      if (!owner.actor.orgId) {
        throw new Error("Expected organization");
      }
      const actor = { ...owner.actor, orgId: owner.actor.orgId };
      mockEnv("APP_URL", "https://app.okou.ai");
      await updateFeatureSwitchesForUser(context, actor, {
        [FeatureSwitchKey.PrivateArtifacts]: true,
      });
      const requests: string[] = [];
      server.use(
        http.post(
          "https://files.okou.app/__artifact-video-poster",
          async ({ request }) => {
            requests.push(request.headers.get("Authorization") ?? "");
            expect(request.headers.get("Referer")).toBe("https://app.okou.ai/");
            await expect(request.text()).resolves.toBe("");
            if (rollback) {
              await updateFeatureSwitchesForUser(context, actor, {
                [FeatureSwitchKey.PrivateArtifacts]: false,
              });
            }
            return new HttpResponse(new Uint8Array([0xff, 0xd8, 0xff]), {
              headers: { "Content-Type": "image/jpeg" },
            });
          },
        ),
      );
      const file = await createRunUploadedFile({
        owner,
        prompt: "Private video",
        filename: "private-video.mp4",
        contentType: "video/mp4",
        privateUpload: true,
      });
      await flushWaitUntilForTest();
      expect(requests).toStrictEqual([
        expect.stringMatching(/^Bearer [a-f0-9]{48}$/u),
      ]);
      const artifact = await findCatalogArtifact(actor, "private-video.mp4");
      const reference = await resolvePrivatePreviewReference(
        artifact?.thumbnail?.url ?? "",
      );
      expect(
        owner.objectStore.puts.filter((put) => {
          return put.contentType === "image/jpeg";
        }),
      ).toStrictEqual([
        expect.objectContaining({
          bucket: "test-private-artifacts",
          key: `private-artifacts/${reference.id}/poster-v2.jpg`,
          ifNoneMatch: "*",
        }),
      ]);
      expect(owner.objectStore.deletedKeys).toContain(
        `private-video-previews/${requests[0]!.slice(7)}.json`,
      );
      const thread = await chat.listThreadArtifacts(actor, file.threadId);
      expect(thread.runs[0]?.files).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            url: file.url,
            previewImageUrl: artifact?.thumbnail?.url,
          }),
        ]),
      );
      expect((await chat.listArtifactCatalog(actor)).artifacts).toHaveLength(1);
      expect(JSON.stringify(thread)).not.toContain(requests[0]!.slice(7));
      owner.objectStore.addObject({
        bucket: "test-private-artifacts",
        key: `private-artifacts/${reference.id}/poster-v2.jpg`,
        size: 3,
      });
      await updateFeatureSwitchesForUser(context, actor, {
        [FeatureSwitchKey.PrivateArtifacts]: false,
      });
      const client = setupApp({ context, routes: webFileUrlRoutes })(
        webFilesContract,
      );
      const preview = await accept(
        client.fileUrl({
          headers: { authorization: "Bearer clerk-session" },
          query: { file_id: reference.id },
        }),
        [200],
      );
      expect(preview.body.publicUrl).toBeNull();
      await bdd.completeOnboarding(bdd.user());
      await accept(
        client.fileUrl({
          headers: { authorization: "Bearer clerk-session" },
          query: { file_id: reference.id },
        }),
        [404],
      );
    },
    180_000,
  );

  it("keeps the video usable and removes its temporary grant when private extraction fails", async () => {
    const owner = await artifactActor("Private video failure");
    if (!owner.actor.orgId) {
      throw new Error("Expected organization");
    }
    const actor = { ...owner.actor, orgId: owner.actor.orgId };
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.PrivateArtifacts]: true,
    });
    server.use(
      http.post("https://files.okou.app/__artifact-video-poster", () => {
        return new HttpResponse("unavailable", { status: 503 });
      }),
    );
    await createRunUploadedFile({
      owner,
      prompt: "Private video",
      filename: "failed-poster.mp4",
      contentType: "video/mp4",
      privateUpload: true,
    });
    await flushWaitUntilForTest();
    const artifact = await findCatalogArtifact(actor, "failed-poster.mp4");
    expect(artifact?.thumbnail).toBeNull();
    expect(
      owner.objectStore.puts.some((put) => {
        return put.contentType === "image/jpeg";
      }),
    ).toBeFalsy();
    expect(
      owner.objectStore.deletedKeys.some((key) => {
        return key.startsWith("private-video-previews/");
      }),
    ).toBeTruthy();
  }, 180_000);

  it("generates a poster immediately for an ordinary video upload", async () => {
    const owner = await artifactActor("Artifacts API video preview agent");
    if (!owner.actor.orgId) {
      throw new Error("Expected video preview test actor to have an org");
    }
    const frameRequests = mockCloudflareVideoFrame(owner.actor.userId);

    const videoArtifact = await createRunUploadedFile({
      owner,
      prompt: "upload reference footage",
      filename: "reference-footage.mp4",
      contentType: "video/mp4",
    });
    await flushWaitUntilForTest();

    expect(frameRequests).toHaveLength(1);
    expect(frameRequests[0]?.url).toBe(
      `https://cdn.vm7.io/cdn-cgi/media/mode=frame,time=1s,width=640,format=jpg/${videoArtifact.url}`,
    );
    const posterPuts = owner.objectStore.puts.filter((put) => {
      return /^artifacts\/[0-9a-z]{10}\.jpg$/u.test(put.key);
    });
    expect(posterPuts).toHaveLength(1);
    expect(posterPuts[0]).toMatchObject({
      bucket: "test-user-artifacts",
      cacheControl: "public, max-age=31536000, immutable",
      contentType: "image/jpeg",
      ifNoneMatch: "*",
    });

    const previewedArtifact = await findCatalogArtifact(
      owner.actor,
      "reference-footage.mp4",
    );
    expect(previewedArtifact?.thumbnail?.url).toMatch(
      /\/artifacts\/[0-9a-z]{10}\.jpg$/u,
    );
  }, 180_000);

  it("stores new posters for historical public videos in private storage", async () => {
    const owner = await artifactActor("Private video poster");
    if (!owner.actor.orgId) {
      throw new Error("Expected organization");
    }
    const actor = { ...owner.actor, orgId: owner.actor.orgId };
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.PrivateArtifacts]: true,
    });
    mockCloudflareVideoFrame(actor.userId);
    await createRunUploadedFile({
      owner,
      prompt: "Preview an older video",
      filename: "old-video.mp4",
      contentType: "video/mp4",
    });
    await flushWaitUntilForTest();
    const artifact = await findCatalogArtifact(actor, "old-video.mp4");
    const reference = await resolvePrivatePreviewReference(
      artifact?.thumbnail?.url ?? "",
    );
    expect(
      owner.objectStore.puts.filter((put) => {
        return put.contentType === "image/jpeg";
      }),
    ).toStrictEqual([
      expect.objectContaining({
        bucket: "test-private-artifacts",
        key: `private-artifacts/${reference.id}/poster-v2.jpg`,
      }),
    ]);
    const catalog = await chat.listArtifactCatalog(actor);
    expect(
      catalog.artifacts.map((entry) => {
        return entry.title;
      }),
    ).toStrictEqual(["old-video.mp4"]);
    owner.objectStore.addObject({
      bucket: "test-private-artifacts",
      key: `private-artifacts/${reference.id}/poster-v2.jpg`,
      size: 3,
    });
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.PrivateArtifacts]: false,
    });
    const preview = await accept(
      setupApp({ context, routes: webFileUrlRoutes })(webFilesContract).fileUrl(
        {
          headers: { authorization: "Bearer clerk-session" },
          query: { file_id: reference.id },
        },
      ),
      [200],
    );
    expect(preview.body.publicUrl).toBeNull();
  }, 180_000);

  it("skips the poster request for a container the transformer cannot decode", async () => {
    const owner = await artifactActor("Artifacts API webm preview agent");
    if (!owner.actor.orgId) {
      throw new Error("Expected webm preview test actor to have an org");
    }
    const frameRequests = mockCloudflareVideoFrame(owner.actor.userId);

    await createRunUploadedFile({
      owner,
      prompt: "upload a webm recording",
      filename: "session-recording.webm",
      contentType: "video/webm",
    });
    await flushWaitUntilForTest();

    expect(frameRequests).toHaveLength(0);
    const previewedArtifact = await findCatalogArtifact(
      owner.actor,
      "session-recording.webm",
    );
    expect(previewedArtifact?.thumbnail).toBeNull();
  }, 180_000);

  it.each([104_857_600, 104_857_601])(
    "skips the poster request for a %i-byte input the transformer rejects",
    async (size) => {
      const owner = await artifactActor(
        `Artifacts API oversized ${size} preview agent`,
      );
      const frameRequests = mockCloudflareVideoFrame(owner.actor.userId);

      await createRunUploadedFile({
        owner,
        prompt: "upload oversized footage",
        filename: `oversized-${size}.mp4`,
        contentType: "video/mp4",
        size,
      });
      await flushWaitUntilForTest();

      expect(frameRequests).toHaveLength(0);
      const previewedArtifact = await findCatalogArtifact(
        owner.actor,
        `oversized-${size}.mp4`,
      );
      expect(previewedArtifact?.thumbnail).toBeNull();
    },
    180_000,
  );

  it("reuses an existing write-once poster after a concurrent upload", async () => {
    const owner = await artifactActor(
      "Artifacts API concurrent video preview agent",
    );
    mockCloudflareVideoFrame(owner.actor.userId);
    owner.objectStore.rejectNextImmutablePutAsExisting("image/jpeg");

    await createRunUploadedFile({
      owner,
      prompt: "upload video with concurrent poster generation",
      filename: "concurrent-poster.mp4",
      contentType: "video/mp4",
    });
    await flushWaitUntilForTest();

    const previewedArtifact = await findCatalogArtifact(
      owner.actor,
      "concurrent-poster.mp4",
    );
    expect(owner.objectStore.rejectedPuts).toStrictEqual([
      expect.objectContaining({
        bucket: "test-user-artifacts",
        contentType: "image/jpeg",
        key: expect.stringMatching(/^artifacts\/[0-9a-z]{10}\.jpg$/u),
      }),
    ]);
    expect(previewedArtifact?.thumbnail?.url).toMatch(
      /\/artifacts\/[0-9a-z]{10}\.jpg$/u,
    );
  }, 180_000);

  it("leaves video preview empty when media frame extraction fails", async () => {
    const owner = await artifactActor("Artifacts API video preview fail agent");
    const frameRequests = mockCloudflareVideoFrame(owner.actor.userId, 415);

    await createRunUploadedFile({
      owner,
      prompt: "create unsupported video artifact",
      filename: "unsupported-video.mp4",
      contentType: "video/mp4",
    });
    await flushWaitUntilForTest();

    expect(frameRequests).toHaveLength(1);
    expect(
      owner.objectStore.puts.some((put) => {
        return put.key.endsWith("/poster-v2.jpg");
      }),
    ).toBeFalsy();

    const failedArtifact = await findCatalogArtifact(
      owner.actor,
      "unsupported-video.mp4",
    );
    expect(failedArtifact).toMatchObject({ kind: "file" });
    expect(failedArtifact?.thumbnail).toBeNull();
  }, 180_000);
});

describe("artifact upload provenance", () => {
  it.each([
    "automation-schedule",
    "automation-event",
    "automation-schedule",
    "automation-event",
    "goal",
  ] as const)(
    "attributes run uploads to the %s source",
    async (triggerSource) => {
      const owner = await artifactActor(
        `Artifacts API ${triggerSource} source agent`,
      );
      if (!owner.actor.orgId) {
        throw new Error("Artifact provenance requires an org-scoped actor");
      }
      // An in-flight legacy Goal may still upload its result after retirement.
      const run =
        triggerSource === "goal"
          ? await createStore().set(
              seedRun$,
              {
                orgId: owner.actor.orgId,
                userId: owner.actor.userId,
                composeId: owner.agentId,
                triggerSource,
                status: "running",
                startedAt: new Date(now()),
              },
              context.signal,
            )
          : await api.createDirectRun(owner.actor, {
              agentId: owner.agentId,
              prompt: `create ${triggerSource} artifact`,
              modelProviderType: "anthropic-api-key",
              triggerSource,
              vars: { OKOU_AGENT_ID: owner.agentId },
              secrets: { OKOU_TOKEN: "bdd-artifact-okou-token" },
            });
      const fileId = randomUUID();
      owner.objectStore.addObject({
        bucket: "test-user-artifacts",
        key: `artifacts/${owner.actor.userId}/${fileId}/workflow-output.txt`,
        size: 128,
      });

      await chat.completeUploadWithBearer(
        `Bearer ${fileWriteToken(owner, run.runId)}`,
        { id: fileId, contentType: "text/plain" },
        [200],
      );

      await expect(
        readRunUploadedFileSources(context, run.runId),
      ).resolves.toStrictEqual([triggerSource]);
    },
  );
});

describe("GET /api/chat-threads/:threadId/artifacts", () => {
  it("keeps each hosted-site publication as a separate immutable artifact", async () => {
    const actor = bdd.user();
    const owner = await artifactActor(
      "Artifacts API hosted publications agent",
      actor,
    );
    const run = await sendChatRun(actor, {
      agentId: owner.agentId,
      prompt: "publish two hosted sites",
    });
    const { claim } = await claimChatRun(owner.runnerGroup, run.runId);
    const bearer = `Bearer ${okouTokenFromClaim(claim)}`;
    host.captureHostedSitesS3();

    const site = `artifact-versions-${randomUUID().slice(0, 8)}`;
    const body = {
      site,
      artifactKind: "hosted-site" as const,
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<main>versioned artifact</main>")],
    };
    const first = await chat.prepareHostedSiteWithBearer(bearer, body);
    await chat.completeHostedSiteWithBearer(bearer, first.deploymentId);
    const second = await chat.prepareHostedSiteWithBearer(bearer, body);
    await chat.completeHostedSiteWithBearer(bearer, second.deploymentId);

    expect(first).toMatchObject({
      publicSlug: site,
      deploymentVersion: 1,
      aliasUrl: first.url,
    });
    expect(second).toMatchObject({
      deploymentVersion: 1,
      aliasUrl: second.url,
    });
    expect(second.publicSlug).toMatch(new RegExp(`^${site}-[a-z0-9]{4}$`, "u"));
    expect(second.siteId).not.toBe(first.siteId);
    expect(second.deploymentId).not.toBe(first.deploymentId);
    expect(second.artifactUrl).not.toBe(first.artifactUrl);

    const threadArtifacts = await chat.listThreadArtifacts(actor, run.threadId);
    expect(threadArtifacts.runs).toHaveLength(1);
    expect(threadArtifacts.runs[0]?.files).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: first.artifactUrl,
          aliasUrl: first.url,
        }),
        expect.objectContaining({
          url: second.artifactUrl,
          aliasUrl: second.url,
        }),
      ]),
    );
  }, 120_000);
});

describe("hosted Artifact previews", () => {
  it.each([false, true])(
    "renders a private site through an authorized origin and keeps its screenshot private (rollback=%s)",
    async (rollback) => {
      const owner = await artifactActor("Private site screenshot");
      if (!owner.actor.orgId) {
        throw new Error("Expected organization");
      }
      const actor = { ...owner.actor, orgId: owner.actor.orgId };
      await updateFeatureSwitchesForUser(context, actor, {
        [FeatureSwitchKey.PrivateArtifacts]: true,
      });
      mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", "preview-token");
      mockEnv("ARTIFACT_PREVIEW_WAF_SECRET", ARTIFACT_PREVIEW_WAF_SECRET);
      const snapshots = mockCloudflareSnapshot([
        {
          beforeResponse: async () => {
            if (rollback) {
              await updateFeatureSwitchesForUser(context, actor, {
                [FeatureSwitchKey.PrivateArtifacts]: false,
              });
            }
          },
        },
      ]);
      const site = `private-preview-${randomUUID().slice(0, 8)}`;
      const artifact = await createHostedArtifact({
        actor,
        agentId: owner.agentId,
        runnerGroup: owner.runnerGroup,
        objectStore: owner.objectStore,
        site,
      });
      await flushWaitUntilForTest();
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.body).toMatchObject({
        url: expect.stringMatching(/^https:\/\/pv-[a-f0-9]{48}\.okou\.app\/$/u),
      });
      const catalogArtifact = await findCatalogArtifact(actor, site);
      const reference = await resolvePrivatePreviewReference(
        catalogArtifact?.thumbnail?.url ?? "",
      );
      const filename = `preview-v3-${artifact.deploymentId}.webp`;
      expect(
        owner.objectStore.puts.filter((put) => {
          return put.contentType === "image/webp";
        }),
      ).toStrictEqual([
        expect.objectContaining({
          bucket: "test-private-artifacts",
          key: `private-artifacts/${reference.id}/${filename}`,
          ifNoneMatch: "*",
        }),
      ]);
      const thread = await chat.listThreadArtifacts(actor, artifact.threadId);
      expect(thread.runs[0]?.files).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            url: artifact.url,
            previewImageUrl: catalogArtifact?.thumbnail?.url,
          }),
        ]),
      );
      const catalog = await chat.listArtifactCatalog(actor);
      expect(catalog.artifacts).toHaveLength(1);
      owner.objectStore.addObject({
        bucket: "test-private-artifacts",
        key: `private-artifacts/${reference.id}/${filename}`,
        size: 3,
      });
      await updateFeatureSwitchesForUser(context, actor, {
        [FeatureSwitchKey.PrivateArtifacts]: false,
      });
      const preview = await accept(
        setupApp({ context, routes: webFileUrlRoutes })(
          webFilesContract,
        ).fileUrl({
          headers: { authorization: "Bearer clerk-session" },
          query: { file_id: reference.id },
        }),
        [200],
      );
      expect(new URL(preview.body.url).searchParams.get("object")).toBe(
        `test-private-artifacts/private-artifacts/${reference.id}/${filename}`,
      );
      await chat.listArtifactCatalog(bdd.user());
      await accept(
        setupApp({ context, routes: webFileUrlRoutes })(
          webFilesContract,
        ).fileUrl({
          headers: { authorization: "Bearer clerk-session" },
          query: { file_id: reference.id },
        }),
        [404],
      );
    },
    120_000,
  );

  it("renders Okou deployments from their branded hosted-site domain", async () => {
    const owner = await artifactActor("Artifacts API Okou preview image agent");
    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", "preview-token");
    mockEnv("ARTIFACT_PREVIEW_WAF_SECRET", ARTIFACT_PREVIEW_WAF_SECRET);
    mockEnv("OKOU_PUBLIC_HOST_DOMAIN", "okou.app");
    mockEnv("OKOU_HOST_SCHEME", "https");
    const snapshotRequests = mockCloudflareSnapshot();
    const site = `okou-preview-${randomUUID().slice(0, 8)}`;

    const artifact = await createHostedArtifact({
      actor: owner.actor,
      agentId: owner.agentId,
      runnerGroup: owner.runnerGroup,
      objectStore: owner.objectStore,
      site,
    });
    await flushWaitUntilForTest();

    expect(artifact.aliasUrl).toBe(`https://${site}.okou.app`);
    expect(artifact.url).toBe(`https://dpl-${artifact.deploymentId}.okou.app`);
    expect(snapshotRequests).toHaveLength(1);
    expect(snapshotRequests[0]).toMatchObject({
      body: {
        url: artifact.url,
        cookies: [
          expect.objectContaining({
            url: new URL(artifact.url).origin,
          }),
        ],
      },
    });
    const previewedArtifact = await findCatalogArtifact(owner.actor, site);
    expect(previewedArtifact?.thumbnail?.url).toMatch(
      /^https:\/\/a\.okou\.io\/[0-9a-z]{10}\.webp$/u,
    );
    expect(owner.objectStore.puts).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bucket: "test-user-artifacts",
          contentType: "image/webp",
          metadata: expect.objectContaining({ "public-brand": "okou" }),
        }),
      ]),
    );
  }, 120_000);

  it("generates deploy-time preview images once per deployment", async () => {
    const owner = await artifactActor("Artifacts API preview image agent");
    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", "preview-token");
    mockEnv("ARTIFACT_PREVIEW_WAF_SECRET", ARTIFACT_PREVIEW_WAF_SECRET);
    const snapshotRequests = mockCloudflareSnapshot();
    const site = `preview-artifact-${randomUUID().slice(0, 8)}`;

    const artifact = await createHostedArtifact({
      actor: owner.actor,
      agentId: owner.agentId,
      runnerGroup: owner.runnerGroup,
      objectStore: owner.objectStore,
      site,
    });
    await flushWaitUntilForTest();

    const firstArtifact = await findCatalogArtifact(owner.actor, site);
    expect(firstArtifact?.thumbnail?.url).toMatch(
      /^https:\/\/a\.okou\.io\/[0-9a-z]{10}\.webp$/u,
    );
    const threadArtifacts = await chat.listThreadArtifacts(
      owner.actor,
      artifact.threadId,
    );
    expect(threadArtifacts.runs[0]?.files).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: artifact.url,
          aliasUrl: artifact.aliasUrl,
          previewImageUrl: firstArtifact?.thumbnail?.url,
        }),
      ]),
    );
    expect(snapshotRequests).toHaveLength(1);
    expect(snapshotRequests[0]).toMatchObject({
      authorization: "Bearer preview-token",
      url: `${CLOUDFLARE_SNAPSHOT_URL}?cacheTTL=0`,
      body: {
        url: artifact.url,
        cookies: [
          {
            name: "vm0_artifact_preview",
            value: ARTIFACT_PREVIEW_WAF_SECRET,
            url: new URL(artifact.url).origin,
            httpOnly: true,
            secure: true,
            sameSite: "Strict",
          },
        ],
        formats: ["content", "screenshot"],
        viewport: {
          width: 1280,
          height: 800,
          deviceScaleFactor: 0.5,
        },
        gotoOptions: { waitUntil: "networkidle2", timeout: 20_000 },
        actionTimeout: 120_000,
        screenshotOptions: { type: "webp", quality: 80 },
      },
    });
    expect(
      owner.objectStore.puts.find((put) => {
        return /^artifacts\/[0-9a-z]{10}\.webp$/u.test(put.key);
      }),
    ).toMatchObject({
      bucket: "test-user-artifacts",
      cacheControl: "public, max-age=31536000, immutable",
      contentType: "image/webp",
      ifNoneMatch: "*",
    });

    await chat.completeHostedSiteWithBearer(
      artifact.bearer,
      artifact.deploymentId,
    );
    await flushWaitUntilForTest();

    const retriedArtifact = await findCatalogArtifact(owner.actor, site);
    expect(retriedArtifact?.thumbnail?.url).toBe(firstArtifact?.thumbnail?.url);
    expect(snapshotRequests).toHaveLength(1);
  }, 120_000);

  it("retries navigation timeouts once with a shape-independent settle wait", async () => {
    const owner = await artifactActor("Artifacts API navigation retry agent");
    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", "preview-token");
    mockEnv("ARTIFACT_PREVIEW_WAF_SECRET", ARTIFACT_PREVIEW_WAF_SECRET);
    const snapshotRequests = mockCloudflareSnapshot([
      {
        error: {
          code: 6002,
          message:
            "A timeout was reached. Check gotoOptions/waitForSelector/waitForTimeout/actionTimeout options.",
          detail: "Navigation timeout of 20000 ms exceeded",
          status: 422,
        },
      },
      {},
    ]);
    const site = `navigation-retry-${randomUUID().slice(0, 8)}`;

    await createHostedArtifact({
      actor: owner.actor,
      agentId: owner.agentId,
      runnerGroup: owner.runnerGroup,
      objectStore: owner.objectStore,
      site,
    });
    await flushWaitUntilForTest();

    expect(snapshotRequests).toHaveLength(2);
    expect(snapshotRequests[0]?.body).toMatchObject({
      gotoOptions: { waitUntil: "networkidle2", timeout: 20_000 },
      actionTimeout: 120_000,
    });
    expect(snapshotRequests[1]?.body).toMatchObject({
      gotoOptions: { waitUntil: "domcontentloaded", timeout: 15_000 },
      waitForTimeout: 3000,
      actionTimeout: 120_000,
    });
    // Readiness must not depend on which node the document opens its body with:
    // a leading hidden sprite or script can never satisfy a visibility probe.
    expect(snapshotRequests[1]?.body).not.toHaveProperty("waitForSelector");
    const previewedArtifact = await findCatalogArtifact(owner.actor, site);
    expect(previewedArtifact?.thumbnail?.url).toMatch(
      /^https:\/\/a\.okou\.io\/[0-9a-z]{10}\.webp$/u,
    );
  }, 120_000);

  it("does not retry non-navigation browser rendering timeouts", async () => {
    const owner = await artifactActor("Artifacts API screenshot timeout agent");
    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", "preview-token");
    mockEnv("ARTIFACT_PREVIEW_WAF_SECRET", ARTIFACT_PREVIEW_WAF_SECRET);
    const snapshotRequests = mockCloudflareSnapshot([
      {
        error: {
          code: 6002,
          message:
            "A timeout was reached. Check gotoOptions/waitForSelector/waitForTimeout/actionTimeout options.",
          detail: "Screenshot timed out after 30000 ms",
          status: 422,
        },
      },
    ]);
    const site = `screenshot-timeout-${randomUUID().slice(0, 8)}`;

    const artifact = await createHostedArtifact({
      actor: owner.actor,
      agentId: owner.agentId,
      runnerGroup: owner.runnerGroup,
      objectStore: owner.objectStore,
      site,
    });
    await flushWaitUntilForTest();

    expect(snapshotRequests).toHaveLength(1);
    const unpreviewedArtifact = await findCatalogArtifact(owner.actor, site);
    expect(unpreviewedArtifact?.thumbnail).toBeNull();
    expect(
      owner.objectStore.puts.some((put) => {
        return put.key.endsWith(`/preview-v3-${artifact.deploymentId}.webp`);
      }),
    ).toBeFalsy();
  }, 120_000);

  it("retries an action timeout once under a shortened budget", async () => {
    const owner = await artifactActor("Artifacts API action retry agent");
    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", "preview-token");
    mockEnv("ARTIFACT_PREVIEW_WAF_SECRET", ARTIFACT_PREVIEW_WAF_SECRET);
    const snapshotRequests = mockCloudflareSnapshot([
      actionTimedOutSnapshot(),
      {},
    ]);
    const site = `action-retry-${randomUUID().slice(0, 8)}`;

    await createHostedArtifact({
      actor: owner.actor,
      agentId: owner.agentId,
      runnerGroup: owner.runnerGroup,
      objectStore: owner.objectStore,
      site,
    });
    await flushWaitUntilForTest();

    expect(snapshotRequests).toHaveLength(2);
    // The retry keeps whichever navigation profile the render had reached —
    // here the primary one — and only shortens the action budget, because a
    // second full budget cannot fit in the function.
    expect(snapshotRequests[1]?.body).toMatchObject({
      gotoOptions: { waitUntil: "networkidle2", timeout: 20_000 },
      actionTimeout: 20_000,
    });
    const previewedArtifact = await findCatalogArtifact(owner.actor, site);
    expect(previewedArtifact?.thumbnail?.url).toMatch(
      /^https:\/\/a\.okou\.io\/[0-9a-z]{10}\.webp$/u,
    );
  }, 120_000);

  it("stops after one action-timeout retry even with budget left", async () => {
    const owner = await artifactActor("Artifacts API action retry once agent");
    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", "preview-token");
    mockEnv("ARTIFACT_PREVIEW_WAF_SECRET", ARTIFACT_PREVIEW_WAF_SECRET);
    const snapshotRequests = mockCloudflareSnapshot([
      actionTimedOutSnapshot(),
      actionTimedOutSnapshot(),
    ]);
    const site = `action-retry-once-${randomUUID().slice(0, 8)}`;

    const artifact = await createHostedArtifact({
      actor: owner.actor,
      agentId: owner.agentId,
      runnerGroup: owner.runnerGroup,
      objectStore: owner.objectStore,
      site,
    });
    await flushWaitUntilForTest();

    // The shared budget allows a third request; the action retry's own
    // allowance does not, so a repeat that times out again stops here.
    expect(snapshotRequests).toHaveLength(2);
    const unpreviewedArtifact = await findCatalogArtifact(owner.actor, site);
    expect(unpreviewedArtifact?.thumbnail).toBeNull();
    expect(
      owner.objectStore.puts.some((put) => {
        return put.key.endsWith(`/preview-v3-${artifact.deploymentId}.webp`);
      }),
    ).toBeFalsy();
  }, 120_000);

  it("keeps the navigation fallback profile when the action then times out", async () => {
    const owner = await artifactActor("Artifacts API action after nav agent");
    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", "preview-token");
    mockEnv("ARTIFACT_PREVIEW_WAF_SECRET", ARTIFACT_PREVIEW_WAF_SECRET);
    const snapshotRequests = mockCloudflareSnapshot([
      {
        error: {
          code: 6002,
          message:
            "A timeout was reached. Check gotoOptions/waitForSelector/waitForTimeout/actionTimeout options.",
          detail: "Navigation timeout of 20000 ms exceeded",
          status: 422,
        },
      },
      actionTimedOutSnapshot(),
      actionTimedOutSnapshot(),
    ]);
    const site = `action-after-nav-${randomUUID().slice(0, 8)}`;

    await createHostedArtifact({
      actor: owner.actor,
      agentId: owner.agentId,
      runnerGroup: owner.runnerGroup,
      objectStore: owner.objectStore,
      site,
    });
    await flushWaitUntilForTest();

    expect(snapshotRequests).toHaveLength(3);
    // Navigation had already fallen back before the action stage was reached,
    // so the action retry shortens the budget without resetting that profile.
    expect(snapshotRequests[2]?.body).toMatchObject({
      gotoOptions: { waitUntil: "domcontentloaded", timeout: 15_000 },
      waitForTimeout: 3000,
      actionTimeout: 20_000,
    });
    const unpreviewedArtifact = await findCatalogArtifact(owner.actor, site);
    expect(unpreviewedArtifact?.thumbnail).toBeNull();
  }, 120_000);

  it("retries a rate-limited snapshot after the stated wait", async () => {
    const owner = await artifactActor("Artifacts API rate limit retry agent");
    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", "preview-token");
    mockEnv("ARTIFACT_PREVIEW_WAF_SECRET", ARTIFACT_PREVIEW_WAF_SECRET);
    const snapshotRequests = mockCloudflareSnapshot([
      rateLimitedSnapshot("1"),
      {},
    ]);
    const site = `rate-limit-retry-${randomUUID().slice(0, 8)}`;

    await createHostedArtifact({
      actor: owner.actor,
      agentId: owner.agentId,
      runnerGroup: owner.runnerGroup,
      objectStore: owner.objectStore,
      site,
    });
    await flushWaitUntilForTest();

    expect(snapshotRequests).toHaveLength(2);
    // An admission rejection happens before any render, so the retry repeats
    // the primary profile rather than falling back to the navigation one.
    expect(snapshotRequests[1]?.body).toMatchObject({
      gotoOptions: { waitUntil: "networkidle2", timeout: 20_000 },
    });
    const previewedArtifact = await findCatalogArtifact(owner.actor, site);
    expect(previewedArtifact?.thumbnail?.url).toMatch(
      /^https:\/\/a\.okou\.io\/[0-9a-z]{10}\.webp$/u,
    );
  }, 120_000);

  it("retries a rate-limited snapshot that states no wait", async () => {
    const owner = await artifactActor("Artifacts API rate limit backoff agent");
    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", "preview-token");
    mockEnv("ARTIFACT_PREVIEW_WAF_SECRET", ARTIFACT_PREVIEW_WAF_SECRET);
    const snapshotRequests = mockCloudflareSnapshot([
      rateLimitedSnapshot(),
      {},
    ]);
    const site = `rate-limit-backoff-${randomUUID().slice(0, 8)}`;

    await createHostedArtifact({
      actor: owner.actor,
      agentId: owner.agentId,
      runnerGroup: owner.runnerGroup,
      objectStore: owner.objectStore,
      site,
    });
    await flushWaitUntilForTest();

    expect(snapshotRequests).toHaveLength(2);
    const previewedArtifact = await findCatalogArtifact(owner.actor, site);
    expect(previewedArtifact?.thumbnail?.url).toMatch(
      /^https:\/\/a\.okou\.io\/[0-9a-z]{10}\.webp$/u,
    );
  }, 120_000);

  it("stops rate-limit retries at the shared request budget", async () => {
    const owner = await artifactActor("Artifacts API rate limit budget agent");
    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", "preview-token");
    mockEnv("ARTIFACT_PREVIEW_WAF_SECRET", ARTIFACT_PREVIEW_WAF_SECRET);
    const snapshotRequests = mockCloudflareSnapshot([
      rateLimitedSnapshot("1"),
      rateLimitedSnapshot("1"),
      rateLimitedSnapshot("1"),
    ]);
    const site = `rate-limit-budget-${randomUUID().slice(0, 8)}`;

    const artifact = await createHostedArtifact({
      actor: owner.actor,
      agentId: owner.agentId,
      runnerGroup: owner.runnerGroup,
      objectStore: owner.objectStore,
      site,
    });
    await flushWaitUntilForTest();

    expect(snapshotRequests).toHaveLength(3);
    const unpreviewedArtifact = await findCatalogArtifact(owner.actor, site);
    expect(unpreviewedArtifact?.thumbnail).toBeNull();
    expect(
      owner.objectStore.puts.some((put) => {
        return put.key.endsWith(`/preview-v3-${artifact.deploymentId}.webp`);
      }),
    ).toBeFalsy();
  }, 120_000);

  it("counts navigation and rate-limit retries against one budget", async () => {
    const owner = await artifactActor("Artifacts API retry sharing agent");
    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", "preview-token");
    mockEnv("ARTIFACT_PREVIEW_WAF_SECRET", ARTIFACT_PREVIEW_WAF_SECRET);
    // A third fixture is deliberately the last one: a rate-limit retry holding
    // its own counter would ask for a fourth snapshot, which the handler has no
    // fixture for. Only one shared budget stops here.
    const snapshotRequests = mockCloudflareSnapshot([
      {
        error: {
          code: 6002,
          message:
            "A timeout was reached. Check gotoOptions/waitForSelector/waitForTimeout/actionTimeout options.",
          detail: "Navigation timeout of 20000 ms exceeded",
          status: 422,
        },
      },
      rateLimitedSnapshot("1"),
      rateLimitedSnapshot("1"),
    ]);
    const site = `retry-sharing-${randomUUID().slice(0, 8)}`;

    await createHostedArtifact({
      actor: owner.actor,
      agentId: owner.agentId,
      runnerGroup: owner.runnerGroup,
      objectStore: owner.objectStore,
      site,
    });
    await flushWaitUntilForTest();

    expect(snapshotRequests).toHaveLength(3);
    // The rate-limit retry repeats whichever profile the render had reached,
    // so it must not reset the navigation fallback back to the primary one.
    expect(snapshotRequests[2]?.body).toMatchObject({
      gotoOptions: { waitUntil: "domcontentloaded", timeout: 15_000 },
      waitForTimeout: 3000,
    });
    const unpreviewedArtifact = await findCatalogArtifact(owner.actor, site);
    expect(unpreviewedArtifact?.thumbnail).toBeNull();
  }, 120_000);

  it("gives up when the stated wait outlives the render budget", async () => {
    const owner = await artifactActor("Artifacts API rate limit ceiling agent");
    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", "preview-token");
    mockEnv("ARTIFACT_PREVIEW_WAF_SECRET", ARTIFACT_PREVIEW_WAF_SECRET);
    const snapshotRequests = mockCloudflareSnapshot([
      rateLimitedSnapshot("600"),
    ]);
    const site = `rate-limit-ceiling-${randomUUID().slice(0, 8)}`;

    await createHostedArtifact({
      actor: owner.actor,
      agentId: owner.agentId,
      runnerGroup: owner.runnerGroup,
      objectStore: owner.objectStore,
      site,
    });
    await flushWaitUntilForTest();

    expect(snapshotRequests).toHaveLength(1);
    const unpreviewedArtifact = await findCatalogArtifact(owner.actor, site);
    expect(unpreviewedArtifact?.thumbnail).toBeNull();
  }, 120_000);

  it("rejects page errors and Cloudflare challenges instead of saving them as previews", async () => {
    const owner = await artifactActor("Artifacts API challenge preview agent");
    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", "preview-token");
    mockEnv("ARTIFACT_PREVIEW_WAF_SECRET", ARTIFACT_PREVIEW_WAF_SECRET);
    const pageErrorRequests = mockCloudflareSnapshot([
      {
        status: 403,
        title: "Forbidden",
        content: "<!doctype html><html><body>forbidden</body></html>",
      },
    ]);
    const pageErrorSite = `error-preview-${randomUUID().slice(0, 8)}`;

    const pageErrorArtifact = await createHostedArtifact({
      actor: owner.actor,
      agentId: owner.agentId,
      runnerGroup: owner.runnerGroup,
      objectStore: owner.objectStore,
      site: pageErrorSite,
    });
    await flushWaitUntilForTest();

    const challengeRequests = mockCloudflareSnapshot([
      {
        title: "Just a moment...",
        content:
          "<!doctype html><html><body><h1>Performing security verification</h1><p>Incompatible browser extension or network configuration</p><script>window.__cf_chl_opt={}</script></body></html>",
      },
    ]);
    const challengeSite = `challenge-preview-${randomUUID().slice(0, 8)}`;

    const challengeArtifact = await createHostedArtifact({
      actor: owner.actor,
      agentId: owner.agentId,
      runnerGroup: owner.runnerGroup,
      objectStore: owner.objectStore,
      site: challengeSite,
    });
    await flushWaitUntilForTest();

    for (const rejected of [
      {
        site: pageErrorSite,
        deploymentId: pageErrorArtifact.deploymentId,
      },
      {
        site: challengeSite,
        deploymentId: challengeArtifact.deploymentId,
      },
    ]) {
      const rejectedArtifact = await findCatalogArtifact(
        owner.actor,
        rejected.site,
      );
      expect(rejectedArtifact).toMatchObject({ kind: "hosted-site" });
      expect(rejectedArtifact?.thumbnail).toBeNull();
      expect(
        owner.objectStore.puts.some((put) => {
          return put.key.endsWith(`/preview-v3-${rejected.deploymentId}.webp`);
        }),
      ).toBeFalsy();
    }
    expect(pageErrorRequests).toHaveLength(1);
    expect(challengeRequests).toHaveLength(1);
  }, 180_000);
});
