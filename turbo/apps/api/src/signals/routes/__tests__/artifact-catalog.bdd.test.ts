import { randomUUID } from "node:crypto";

import { hostContract } from "@okouai/api-contracts/contracts/host";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { setupApp } from "../../../__tests__/test-helpers";
import { hostRoutes } from "../host";

import { accept, testContext } from "../../../__tests__/test-context";
import { createAppWithRoutes } from "../../../app-factory-core";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import type { RouteEntry } from "../../route-entry";
import { artifactCatalogRoutes } from "../artifact-catalog";
import { sharedThreadRoutes } from "../shared-threads";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  hostedTextFile,
  installHostedUploadTransport,
  uploadHostedTextFiles,
} from "./helpers/api-bdd-host-files";
import { createHostBddApi } from "./helpers/api-bdd-host";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const host = createHostBddApi(context);
const webhooks = createWebhookCallbackApi(context);
const routeMocks = createRouteMocks(context);
const sharedThreadTestRoutes: readonly RouteEntry[] = [
  ...artifactCatalogRoutes,
  ...sharedThreadRoutes,
];
function createCatalogStorage() {
  let storage:
    ReturnType<typeof chatCallbacks.acceptChatObjectStorage> | undefined;
  beforeEach(() => {
    storage = undefined;
  });
  return () => {
    storage ??= chatCallbacks.acceptChatObjectStorage();
    return storage;
  };
}
const catalogStorage = createCatalogStorage();
type RunnerClaim = Awaited<ReturnType<typeof api.claimRunnerJob>>;
interface CatalogActor {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly storage: ReturnType<typeof chatCallbacks.acceptChatObjectStorage>;
}

/**
 * Stage uploaded bytes at the external object-storage boundary. Callers that
 * observe several uploads together supply one store so earlier bytes survive.
 */
function stageUploadObject(
  key: string,
  size: number,
  storage = catalogStorage(),
): void {
  storage.addObject({ bucket: "test-user-artifacts", key, size });
}

async function catalogActor(
  displayName: string,
  actor: ApiTestUser = bdd.user(),
  options: { readonly bootstrapOrg?: boolean } = {},
): Promise<CatalogActor> {
  const storage = catalogStorage();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  chatCallbacks.disableVapid();
  const runnerGroup = api.configureRunnerGroup();
  if (options.bootstrapOrg !== false) {
    await api.grantProEntitlement(actor);
    // Catalog fixtures complete claimed native Runner runs, so the owner
    // selects Fable, whose personal subscription route never uses Pi.
    await api.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    });
  }
  if (!actor.orgId) {
    throw new Error("Expected artifact catalog test actor to have an org");
  }
  const agent = await bdd.createAgent(actor, {
    displayName,
    visibility: "private",
  });
  return { actor, agentId: agent.agentId, runnerGroup, storage };
}

async function sendChatRun(
  actor: ApiTestUser,
  body: {
    readonly agentId: string;
    readonly prompt: string;
    readonly threadId?: string;
  },
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const sent = await chat.sendAndLaunch(actor, body);
  return { runId: sent.runId, threadId: sent.threadId };
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

async function completeChatRunOk(
  runId: string,
  sandboxHeaders: { readonly authorization: string },
  lastEventSequence?: number,
): Promise<void> {
  await webhooks.requestAgentComplete(
    {
      runId,
      exitCode: 0,
      completion: {
        cliAgentType: "claude-code",
        cliAgentSessionId: `bdd-cli-${runId}`,
        cliAgentSessionHistoryDisposition: "native_only",
      },
      ...(lastEventSequence === undefined ? {} : { lastEventSequence }),
    },
    sandboxHeaders,
    [200],
  );
}

interface CreatedSharedThreadResult {
  readonly id: string;
  readonly headers: Headers;
}

interface ReadSharedThreadResult {
  readonly body: unknown;
  readonly headers: Headers;
}

function authenticateSharedThread(actor: ApiTestUser) {
  routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

function sharedThreadTestApp() {
  return createAppWithRoutes({
    signal: context.signal,
    routes: sharedThreadTestRoutes,
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a JSON object response");
  }
  return value as Record<string, unknown>;
}

interface SharedThreadEventRef {
  readonly id: string;
  readonly eventType: string;
  readonly runId?: string;
}

async function listSharedThreadEventRefs(
  actor: ApiTestUser,
  threadId: string,
): Promise<readonly SharedThreadEventRef[]> {
  const page: unknown = await chat.listThreadEvents(actor, threadId);
  const events = asRecord(page).events;
  if (!Array.isArray(events)) {
    throw new Error("Expected chat thread events");
  }
  return events.map((value) => {
    const event = asRecord(value);
    if (typeof event.id !== "string" || typeof event.eventType !== "string") {
      throw new Error("Expected a chat event reference");
    }
    return {
      id: event.id,
      eventType: event.eventType,
      ...(typeof event.runId === "string" ? { runId: event.runId } : {}),
    };
  });
}

async function createSharedThreadSnapshot(
  actor: ApiTestUser,
  threadId: string,
  eventIds: readonly string[],
  origin?: string,
): Promise<CreatedSharedThreadResult> {
  const response = await sharedThreadTestApp().request(
    `/api/chat-threads/${threadId}/shared-threads`,
    {
      method: "POST",
      headers: {
        ...authenticateSharedThread(actor),
        "content-type": "application/json",
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify({ eventIds }),
    },
  );
  expect(response.status).toBe(201);
  const body = asRecord(await response.json());
  if (typeof body.id !== "string") {
    throw new Error("Expected shared-thread creation to return an ID");
  }
  return { id: body.id, headers: response.headers };
}

async function readSharedThreadSnapshot(
  id: string,
): Promise<ReadSharedThreadResult> {
  const response = await sharedThreadTestApp().request(
    `/api/shared-threads/${id}`,
  );
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  return { body, headers: response.headers };
}

async function readSharedThreadMeta(
  id: string,
): Promise<ReadSharedThreadResult> {
  const response = await sharedThreadTestApp().request(
    `/api/shared-threads/${id}/meta`,
  );
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  return { body, headers: response.headers };
}

async function completeChatRunWithMessage(
  owner: CatalogActor,
  runId: string,
  assistantText: string,
): Promise<void> {
  const { sandboxHeaders } = await claimChatRun(owner.runnerGroup, runId);
  chatCallbacks.mockChatOutputEvents([
    {
      eventType: "assistant",
      sequenceNumber: 0,
      eventData: {
        message: { content: [{ type: "text", text: assistantText }] },
      },
    },
  ]);
  const outputEvents = chatCallbacks.consumeMockChatOutputEvents();
  await webhooks.requestAgentEvents(
    { runId, events: outputEvents },
    sandboxHeaders,
    [200],
  );
  await completeChatRunOk(runId, sandboxHeaders, 0);
}

async function uploadFile(args: {
  readonly owner: CatalogActor;
  readonly prompt: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes?: number;
  readonly fileId?: string;
  readonly threadId?: string;
  readonly objectStorage?: ReturnType<
    typeof chatCallbacks.acceptChatObjectStorage
  >;
}): Promise<{
  readonly fileId: string;
  readonly url: string;
  readonly threadId: string;
}> {
  const run = await sendChatRun(args.owner.actor, {
    agentId: args.owner.agentId,
    prompt: args.prompt,
    ...(args.threadId === undefined ? {} : { threadId: args.threadId }),
  });
  const { claim, sandboxHeaders } = await claimChatRun(
    args.owner.runnerGroup,
    run.runId,
  );
  const bearer = `Bearer ${okouTokenFromClaim(claim)}`;
  const fileId = args.fileId ?? randomUUID();
  stageUploadObject(
    `artifacts/${args.owner.actor.userId}/${fileId}/${args.filename}`,
    args.sizeBytes ?? 1024,
    args.objectStorage,
  );
  const completed = await chat.completeUploadWithBearer(
    bearer,
    { id: fileId, contentType: args.contentType },
    [200],
  );
  if (completed.status !== 200) {
    throw new Error("Expected run upload completion to succeed");
  }
  await completeChatRunOk(run.runId, sandboxHeaders);
  return { fileId, url: completed.body.url, threadId: run.threadId };
}

async function publishHostedSite(args: {
  readonly owner: CatalogActor;
  readonly site: string;
  readonly title?: string;
  readonly artifactKind?: "hosted-site" | "presentation-html";
  readonly threadId?: string;
}): Promise<{
  readonly url: string;
  readonly siteId: string;
  readonly publicSlug: string;
  readonly deploymentId: string;
  readonly deploymentVersion?: number;
  readonly runId: string;
  readonly threadId: string;
}> {
  const run = await sendChatRun(args.owner.actor, {
    agentId: args.owner.agentId,
    prompt: `publish ${args.site}`,
    ...(args.threadId === undefined ? {} : { threadId: args.threadId }),
  });
  const claimed = await claimChatRun(args.owner.runnerGroup, run.runId);
  const bearer = `Bearer ${okouTokenFromClaim(claimed.claim)}`;
  const body = {
    site: args.site,
    title: args.title,
    artifactKind: args.artifactKind ?? ("hosted-site" as const),
    spaFallback: false,
    files: [hostedTextFile("/index.html", `<main>${args.site}</main>`)],
  };

  installHostedUploadTransport(context, args.owner.storage);
  const prepared = await chat.prepareHostedSiteWithBearer(bearer, body);
  await uploadHostedTextFiles(prepared, {
    "/index.html": `<main>${args.site}</main>`,
  });
  await chat.completeHostedSiteWithBearer(bearer, prepared.deploymentId);
  await completeChatRunOk(run.runId, claimed.sandboxHeaders);
  return {
    url: prepared.url,
    siteId: prepared.siteId,
    publicSlug: prepared.publicSlug,
    deploymentId: prepared.deploymentId,
    ...(prepared.deploymentVersion === undefined
      ? {}
      : { deploymentVersion: prepared.deploymentVersion }),
    runId: run.runId,
    threadId: run.threadId,
  };
}

describe("GET /api/artifacts/catalog", () => {
  it("shares the explicit site title across Chat and Artifacts and retains renames on redeploy", async () => {
    const owner = await catalogActor("Site title owner");
    const site = `title-${randomUUID().slice(0, 8)}`;
    const published = await publishHostedSite({
      owner,
      site,
      title: "Quarterly sales report",
    });
    const catalog = await chat.listArtifactCatalog(owner.actor);
    const entry = catalog.artifacts.find((artifact) => {
      return artifact.kind === "hosted-site";
    });
    expect(entry).toMatchObject({ title: "Quarterly sales report" });
    const headers = { authorization: "Bearer clerk-session" };
    routeMocks.clerk.session(
      owner.actor.userId,
      owner.actor.orgId,
      owner.actor.orgRole,
    );
    const renamed = await accept(
      setupApp({ context, routes: hostRoutes })(hostContract).updateSiteTitle({
        headers,
        params: { publicSlug: published.publicSlug },
        body: { title: "  季度销售报告  " },
      }),
      [200],
    );
    expect(renamed.body).toStrictEqual({
      siteId: published.siteId,
      publicSlug: published.publicSlug,
      title: "季度销售报告",
    });
    await expect(
      chat.getArtifactCatalogEntry(owner.actor, entry!.id),
    ).resolves.toMatchObject({
      title: "季度销售报告",
      site: { url: published.url, publicSlug: published.publicSlug },
    });
    const redeployed = await publishHostedSite({
      owner,
      site,
      title: "Quarterly sales report",
      threadId: published.threadId,
    });
    expect(redeployed.siteId).toBe(published.siteId);
    const afterRedeploy = await chat.listArtifactCatalog(owner.actor);
    expect(afterRedeploy.artifacts).toStrictEqual([
      expect.objectContaining({ id: entry!.id, title: "季度销售报告" }),
    ]);
    const threadArtifacts = await chat.listThreadArtifacts(
      owner.actor,
      published.threadId,
    );
    const files = threadArtifacts.runs.flatMap((run) => {
      return run.files;
    });
    expect(files).toHaveLength(2);
    expect(files).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "季度销售报告",
          aliasUrl: published.url,
        }),
        expect.objectContaining({
          title: "季度销售报告",
          aliasUrl: redeployed.url,
        }),
      ]),
    );
  });

  it("retains a renamed catalog identity when a hosted site becomes a presentation", async () => {
    const owner = await catalogActor("Renamed presentation owner");
    const site = `renamed-deck-${randomUUID().slice(0, 8)}`;
    const published = await publishHostedSite({
      owner,
      site,
      title: "Original site",
    });
    const before = await chat.listArtifactCatalog(owner.actor);
    expect(before.artifacts).toHaveLength(1);
    const entry = before.artifacts[0]!;
    routeMocks.clerk.session(
      owner.actor.userId,
      owner.actor.orgId,
      owner.actor.orgRole,
    );
    await accept(
      setupApp({ context, routes: hostRoutes })(hostContract).updateSiteTitle({
        headers: { authorization: "Bearer clerk-session" },
        params: { publicSlug: published.publicSlug },
        body: { title: "保留的报告标题" },
      }),
      [200],
    );
    const deck = await publishHostedSite({
      owner,
      site,
      title: "Incoming deck title",
      artifactKind: "presentation-html",
      threadId: published.threadId,
    });
    expect(deck.siteId).toBe(published.siteId);
    const after = await chat.listArtifactCatalog(owner.actor);
    expect(after.artifacts).toStrictEqual([
      expect.objectContaining({
        id: entry.id,
        kind: "presentation",
        title: "保留的报告标题",
      }),
    ]);
    await expect(
      chat.getArtifactCatalogEntry(owner.actor, entry.id),
    ).resolves.toMatchObject({
      id: entry.id,
      kind: "presentation",
      title: "保留的报告标题",
      site: {
        id: published.siteId,
        publicSlug: published.publicSlug,
        url: deck.url,
      },
    });
  });

  it("denies other owners site title edits without changing the title", async () => {
    const owner = await catalogActor("Site title access owner");
    const published = await publishHostedSite({
      owner,
      site: `title-access-${randomUUID().slice(0, 8)}`,
      title: "Original report",
    });
    const headers = { authorization: "Bearer clerk-session" };
    const rename = {
      headers,
      params: { publicSlug: published.publicSlug },
      body: { title: "Renamed report" },
    };
    for (const actor of [bdd.user({ orgId: owner.actor.orgId }), bdd.user()]) {
      routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
      await accept(
        setupApp({ context, routes: hostRoutes })(hostContract).updateSiteTitle(
          rename,
        ),
        [404],
      );
    }
    expect(
      (await chat.listArtifactCatalog(owner.actor)).artifacts,
    ).toStrictEqual([expect.objectContaining({ title: "Original report" })]);
  });

  it("lists an uploaded file as one artifact and hides other callers", async () => {
    const owner = await catalogActor("Artifact catalog owner");
    const outsider = await catalogActor("Artifact catalog outsider");
    const uploaded = await uploadFile({
      owner,
      prompt: "upload a report",
      filename: "quarterly-report.txt",
      contentType: "text/plain",
      sizeBytes: 256,
    });
    await uploadFile({
      owner: outsider,
      prompt: "upload another report",
      filename: "outsider-report.txt",
      contentType: "text/plain",
    });

    const catalog = await chat.listArtifactCatalog(owner.actor);

    expect(catalog.nextCursor).toBeNull();
    expect(catalog.artifacts).toStrictEqual([
      {
        id: expect.any(String),
        kind: "file",
        title: "quarterly-report.txt",
        sourceUrl: uploaded.url,
        thumbnail: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    ]);

    const artifactId = catalog.artifacts[0]?.id;
    if (!artifactId) {
      throw new Error("Expected the catalog to list the uploaded artifact");
    }
    const detail = await chat.getArtifactCatalogEntry(owner.actor, artifactId);
    if (detail.kind !== "file") {
      throw new Error("Expected an uploaded file to be catalogued as a file");
    }
    expect(detail.file).toStrictEqual({
      id: expect.any(String),
      filename: "quarterly-report.txt",
      contentType: "text/plain",
      size: 256,
      url: uploaded.url,
      previewImageUrl: null,
    });
  }, 180_000);

  it("keeps completed file lists and catalog filters scoped to their owning thread", async () => {
    const owner = await catalogActor("File association owner");
    const outsider = await catalogActor("File association outsider");
    const first = await uploadFile({
      owner,
      prompt: "Publish the first report",
      filename: "first-thread-report.txt",
      contentType: "text/plain",
    });
    const second = await uploadFile({
      owner,
      prompt: "Publish the second report",
      filename: "second-thread-report.txt",
      contentType: "text/plain",
    });

    const files = await chat.listThreadArtifacts(owner.actor, first.threadId);
    expect(
      files.runs.flatMap((run) => {
        return run.files.map((file) => {
          return file.filename;
        });
      }),
    ).toStrictEqual(["first-thread-report.txt"]);
    const firstCatalog = await chat.listArtifactCatalog(owner.actor, {
      chatThreadId: first.threadId,
    });
    expect(firstCatalog.artifacts).toStrictEqual([
      expect.objectContaining({ title: "first-thread-report.txt" }),
    ]);
    const secondCatalog = await chat.listArtifactCatalog(owner.actor, {
      chatThreadId: second.threadId,
    });
    expect(secondCatalog.artifacts).toStrictEqual([
      expect.objectContaining({ title: "second-thread-report.txt" }),
    ]);
    const outsiderFiles = await chat.requestListThreadArtifacts(
      outsider.actor,
      first.threadId,
      [404],
    );
    expectApiError(outsiderFiles.body);
    const outsiderCatalog = await chat.listArtifactCatalog(outsider.actor, {
      chatThreadId: first.threadId,
    });
    expect(outsiderCatalog.artifacts).toStrictEqual([]);
    // Check each ownership dimension independently, not only a caller whose
    // user and organization both differ.
    for (const caller of [
      bdd.user({ orgId: owner.actor.orgId }),
      bdd.user({ userId: owner.actor.userId }),
    ]) {
      await expect(
        chat.listArtifactCatalog(caller, { chatThreadId: first.threadId }),
      ).resolves.toStrictEqual({ artifacts: [], nextCursor: null });
    }
  });

  it("catalogues an artifact upload but never a chat attachment", async () => {
    const owner = await catalogActor("Artifact catalog attachment owner");
    const storage = chatCallbacks.acceptChatObjectStorage();
    const stagePrivateObject = (id: string, filename: string, size: number) => {
      storage.addObject({
        bucket: "test-private-artifacts",
        key: `private-artifacts/${id}/${filename}`,
        size,
      });
    };

    // The composer uploads before the user sends, so the attachment exists as
    // an owned file with no run and no declared purpose.
    const attachment = await chat.prepareUpload(owner.actor, {
      filename: "meeting-notes.png",
      contentType: "image/png",
      size: 2048,
    });
    stagePrivateObject(attachment.id, "meeting-notes.png", 2048);
    await chat.completeUpload(owner.actor, { id: attachment.id });

    const declaredArtifact = await chat.prepareUpload(owner.actor, {
      filename: "quarterly-summary.html",
      contentType: "text/html",
      size: 4096,
      purpose: "artifact",
    });
    stagePrivateObject(declaredArtifact.id, "quarterly-summary.html", 4096);
    await chat.completeUpload(owner.actor, { id: declaredArtifact.id });

    const beforeSend = await chat.listArtifactCatalog(owner.actor);
    expect(beforeSend.artifacts).toStrictEqual([
      expect.objectContaining({
        kind: "file",
        title: "quarterly-summary.html",
      }),
    ]);

    // Sending marks the upload as chat input; that must not register it either.
    await chat.requestSendEvent(
      owner.actor,
      {
        agentId: owner.agentId,
        prompt: "Review these notes",
        userMessage: {
          version: 1,
          parts: [
            {
              type: "file",
              fileId: attachment.id,
              filenameSnapshot: "meeting-notes.png",
              contentType: "image/png",
            },
            { type: "text", text: "Review these notes" },
          ],
        },
      },
      [201],
    );

    const afterSend = await chat.listArtifactCatalog(owner.actor);
    expect(afterSend.artifacts).toStrictEqual([
      expect.objectContaining({
        kind: "file",
        title: "quarterly-summary.html",
      }),
    ]);
  }, 180_000);

  it("keeps repeated projections of one file URL as one artifact", async () => {
    const owner = await catalogActor("Artifact catalog repeated URL owner");
    const fileId = randomUUID();

    await uploadFile({
      owner,
      prompt: "upload a report for the first run",
      filename: "repeatable-report.txt",
      contentType: "text/plain",
      fileId,
    });
    await uploadFile({
      owner,
      prompt: "upload the same report for a later run",
      filename: "repeatable-report.txt",
      contentType: "text/plain",
      fileId,
    });

    const catalog = await chat.listArtifactCatalog(owner.actor);

    expect(catalog.artifacts).toStrictEqual([
      expect.objectContaining({
        kind: "file",
        title: "repeatable-report.txt",
      }),
    ]);
  }, 180_000);

  it.each(["mp4", "webm"])(
    "lists the source URL for a %s video without a poster",
    async (container) => {
      const owner = await catalogActor("Artifact catalog video source owner");
      const run = await sendChatRun(owner.actor, {
        agentId: owner.agentId,
        prompt: "Upload an artifact through the Runner protocol",
      });
      const { claim } = await claimChatRun(owner.runnerGroup, run.runId);
      const fileId = randomUUID();
      stageUploadObject(
        `artifacts/${owner.actor.userId}/${fileId}/source-fallback.${container}`,
        1024,
      );
      const completed = await chat.completeUploadWithBearer(
        `Bearer ${okouTokenFromClaim(claim)}`,
        { id: fileId, contentType: `video/${container}` },
        [200],
      );
      if (completed.status !== 200) {
        throw new Error("Expected video upload completion to succeed");
      }

      const catalog = await chat.listArtifactCatalog(owner.actor);

      expect(catalog.artifacts).toStrictEqual([
        expect.objectContaining({
          kind: "file",
          videoSourceUrl: completed.body.url,
          thumbnail: null,
          title: `source-fallback.${container}`,
        }),
      ]);
    },
    180_000,
  );

  it("keeps owned files and catalog identity after deleting the backing agent", async () => {
    const owner = await catalogActor("Artifact catalog deletion owner");
    const uploaded = await uploadFile({
      owner,
      prompt: "upload an independently owned report",
      filename: "retained-report.txt",
      contentType: "text/plain",
    });
    const catalog = await chat.listArtifactCatalog(owner.actor);
    expect(catalog.artifacts).toHaveLength(1);
    const artifactId = catalog.artifacts[0]?.id;
    if (!artifactId) {
      throw new Error("Expected the report artifact");
    }
    const detail = await chat.getArtifactCatalogEntry(owner.actor, artifactId);

    await flushWaitUntilForTest();
    await bdd.deleteAgent(owner.actor, owner.agentId);

    await expect(chat.listArtifactCatalog(owner.actor)).resolves.toStrictEqual(
      catalog,
    );
    await expect(
      chat.getArtifactCatalogEntry(owner.actor, artifactId),
    ).resolves.toStrictEqual(detail);
    const file = await chat.resolveWebFileUrl(owner.actor, uploaded.fileId);
    expect(file.publicUrl).toBe(uploaded.url);
    await chat.requestWebFileUrl(bdd.user(), uploaded.fileId, [404]);
  }, 180_000);

  it.each(["user", "organization"] as const)(
    "preserves unrelated files after %s deletion of an artifact owner",
    async (kind) => {
      const owner = await catalogActor("Independent artifact retention owner");
      const outsider = await catalogActor(
        "Independent artifact retention outsider",
      );
      const objectStorage = chatCallbacks.acceptChatObjectStorage();
      const uploaded = await uploadFile({
        owner,
        prompt: "publish a report before the Clerk deletion event",
        filename: "account-report.txt",
        contentType: "text/plain",
        objectStorage,
      });
      const unrelated = await uploadFile({
        owner: outsider,
        prompt: "publish an unrelated report",
        filename: "unrelated-report.txt",
        contentType: "text/plain",
        objectStorage,
      });
      await bdd.deleteAgent(owner.actor, owner.agentId);
      const catalog = await chat.listArtifactCatalog(owner.actor);
      const artifactId = catalog.artifacts[0]?.id;
      if (!artifactId) {
        throw new Error("Expected a retained artifact after Agent deletion");
      }
      await expect(
        chat.resolveWebFileUrl(owner.actor, uploaded.fileId),
      ).resolves.toMatchObject({ publicUrl: uploaded.url });
      await expect(
        chat.getArtifactCatalogEntry(owner.actor, artifactId),
      ).resolves.toMatchObject({ id: artifactId });
      webhooks.configureClerkWebhookSecret();
      webhooks.verifyNextClerkWebhook({
        type: kind === "user" ? "user.deleted" : "organization.deleted",
        data: { id: kind === "user" ? owner.actor.userId : owner.actor.orgId },
      });
      await webhooks.requestClerkWebhook("{}", {}, [200]);
      await flushWaitUntilForTest();
      const unrelatedFile = await chat.resolveWebFileUrl(
        outsider.actor,
        unrelated.fileId,
      );
      expect(unrelatedFile.publicUrl).toBe(unrelated.url);
      expect(
        (await chat.listArtifactCatalog(outsider.actor)).artifacts,
      ).toContainEqual(
        expect.objectContaining({ title: "unrelated-report.txt" }),
      );
    },
    180_000,
  );

  it("keeps original thread ownership and current projection across redeploy and thread deletion", async () => {
    const owner = await catalogActor(
      "Artifact catalog hosted owner",
      bdd.user(),
    );
    const site = `catalog-site-${randomUUID().slice(0, 8)}`;
    const hosted = await publishHostedSite({ owner, site });
    const initialCatalog = await chat.listArtifactCatalog(owner.actor, {
      chatThreadId: hosted.threadId,
    });
    const initialArtifact = initialCatalog.artifacts[0];
    if (!initialArtifact) {
      throw new Error(
        "Expected the original thread to own the hosted artifact",
      );
    }
    const second = await publishHostedSite({
      owner,
      site,
    });
    expect(second.threadId).not.toBe(hosted.threadId);
    // Redeploying keeps one site; each publication stays its own artifact.
    expect(second.siteId).toBe(hosted.siteId);
    expect(second.publicSlug).toBe(site);
    expect(second.deploymentId).not.toBe(hosted.deploymentId);

    const catalog = await chat.listArtifactCatalog(owner.actor);

    // The catalog is keyed by site, so a redeploy updates one entry.
    expect(
      catalog.artifacts.map((artifact) => {
        return { kind: artifact.kind, title: artifact.title };
      }),
    ).toStrictEqual([{ kind: "hosted-site", title: site }]);

    const entry = catalog.artifacts[0];
    if (!entry) {
      throw new Error("Expected the catalog to list the hosted site");
    }
    const detail = await chat.getArtifactCatalogEntry(owner.actor, entry.id);
    if (detail.kind !== "hosted-site") {
      throw new Error("Expected a hosted site to be catalogued as hosted-site");
    }
    expect(entry.id).toBe(initialArtifact.id);
    // The entry follows the site's newest publication.
    expect(detail.site).toMatchObject({
      id: hosted.siteId,
      slug: site,
      deploymentVersion: 2,
      entrypoint: "/index.html",
      spaFallback: false,
    });
    await expect(
      chat.listArtifactCatalog(owner.actor, { chatThreadId: hosted.threadId }),
    ).resolves.toStrictEqual(catalog);
    // The latest projection belongs to the second run, but the logical
    // artifact must not follow that file into the second thread.
    await expect(
      chat.listArtifactCatalog(owner.actor, { chatThreadId: second.threadId }),
    ).resolves.toStrictEqual({ artifacts: [], nextCursor: null });

    await chat.deleteThread(owner.actor, hosted.threadId);

    await expect(
      chat.listArtifactCatalog(owner.actor, { chatThreadId: hosted.threadId }),
    ).resolves.toStrictEqual({ artifacts: [], nextCursor: null });
    await expect(
      chat.listArtifactCatalog(owner.actor, { chatThreadId: second.threadId }),
    ).resolves.toStrictEqual({ artifacts: [], nextCursor: null });
    await expect(chat.listArtifactCatalog(owner.actor)).resolves.toStrictEqual(
      catalog,
    );
    await expect(
      chat.getArtifactCatalogEntry(owner.actor, entry.id),
    ).resolves.toStrictEqual(detail);

    // A real later publication must not reattach the artifact after deletion
    // cleared its original thread, even when the projection stays in B.
    const third = await publishHostedSite({
      owner,
      site,
      threadId: second.threadId,
    });
    expect(third.threadId).toBe(second.threadId);
    expect(third.siteId).toBe(hosted.siteId);
    expect(third.deploymentId).not.toBe(second.deploymentId);
    expect(third.deploymentVersion).toBe(3);

    const republishedCatalog = await chat.listArtifactCatalog(owner.actor);
    expect(republishedCatalog.nextCursor).toBeNull();
    expect(republishedCatalog.artifacts).toStrictEqual([
      expect.objectContaining({
        id: initialArtifact.id,
        kind: "hosted-site",
        title: site,
      }),
    ]);
    const republishedDetail = await chat.getArtifactCatalogEntry(
      owner.actor,
      entry.id,
    );
    if (republishedDetail.kind !== "hosted-site") {
      throw new Error(
        "Expected the republished artifact to remain hosted-site",
      );
    }
    expect(republishedDetail.site).toMatchObject({
      id: hosted.siteId,
      slug: site,
      deploymentVersion: 3,
      entrypoint: "/index.html",
      spaFallback: false,
    });
    for (const threadId of [hosted.threadId, second.threadId]) {
      await expect(
        chat.listArtifactCatalog(owner.actor, { chatThreadId: threadId }),
      ).resolves.toStrictEqual({ artifacts: [], nextCursor: null });
    }
  }, 180_000);

  it("queries and republishes one hosted site across chats and Clerk sessions", async () => {
    const actor = bdd.user();
    host.captureHostedSitesS3();
    const site = `catalog-cross-chat-${randomUUID().slice(0, 8)}`;
    const body = {
      site,
      artifactKind: "hosted-site" as const,
      spaFallback: false,
      visibility: "public" as const,
      files: [hostedTextFile("/index.html", "<main>first</main>")],
    };
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const app = setupApp({ context, routes: hostRoutes });
    const firstResponse = await accept(
      app(hostContract).prepare({
        headers: { authorization: "Bearer clerk-session" },
        body,
      }),
      [200],
    );
    const first = firstResponse.body;
    const owner = await catalogActor("Thread-independent hosted owner", actor);
    host.captureHostedSitesS3();
    const activeRuns = new Set<string>();
    onTestFinished(async () => {
      for (const runId of activeRuns) {
        await api.requestCancelRun(actor, runId, [200]);
      }
      await flushWaitUntilForTest();
    });

    const firstChat = await sendChatRun(actor, {
      agentId: owner.agentId,
      prompt: "update the existing website",
    });
    activeRuns.add(firstChat.runId);
    const firstClaim = await claimChatRun(owner.runnerGroup, firstChat.runId);
    const firstBearer = { bearerToken: okouTokenFromClaim(firstClaim.claim) };
    const firstHistory = await host.readHostedSiteDeployments(
      firstBearer,
      site,
    );
    expect(firstHistory).toMatchObject({ siteId: first.siteId });
    expect(firstHistory.deployments).toHaveLength(1);
    const second = await host.prepareHostedSite(firstBearer, {
      ...body,
      files: [hostedTextFile("/index.html", "<main>second</main>")],
    });
    expect(second).toMatchObject({
      siteId: first.siteId,
      publicSlug: first.publicSlug,
      url: first.url,
      deploymentVersion: 2,
    });
    await completeChatRunOk(firstChat.runId, firstClaim.sandboxHeaders);
    activeRuns.delete(firstChat.runId);

    const secondChat = await sendChatRun(actor, {
      agentId: owner.agentId,
      prompt: "publish and inspect the same website from another chat",
    });
    activeRuns.add(secondChat.runId);
    expect(secondChat.threadId).not.toBe(firstChat.threadId);
    const secondClaim = await claimChatRun(owner.runnerGroup, secondChat.runId);
    const secondBearer = { bearerToken: okouTokenFromClaim(secondClaim.claim) };
    await host.completeHostedSite(secondBearer, first.deploymentId);
    await host.completeHostedSite(secondBearer, second.deploymentId);
    const third = await host.prepareHostedSite(secondBearer, {
      ...body,
      files: [hostedTextFile("/index.html", "<main>third</main>")],
    });
    expect(third).toMatchObject({
      siteId: first.siteId,
      publicSlug: first.publicSlug,
      url: first.url,
      deploymentVersion: 3,
    });
    expect(
      new Set([first.deploymentId, second.deploymentId, third.deploymentId])
        .size,
    ).toBe(3);
    await host.completeHostedSite(actor, third.deploymentId);
    await expect(
      host.completeHostedSite(secondBearer, first.deploymentId),
    ).resolves.toMatchObject({
      isActive: false,
      activeDeploymentVersion: 3,
    });
    for (const caller of [actor, secondBearer]) {
      const history = await host.readHostedSiteDeployments(caller, site);
      expect(history).toMatchObject({
        siteId: first.siteId,
        activeDeploymentId: third.deploymentId,
      });
      expect(history.deployments).toHaveLength(3);
      await expect(
        host.readHostedSiteFiles(caller, site),
      ).resolves.toMatchObject({
        siteId: first.siteId,
        deploymentId: third.deploymentId,
        deploymentVersion: 3,
      });
      await expect(
        host.readHostedSiteFiles(caller, site, 1),
      ).resolves.toMatchObject({
        deploymentId: first.deploymentId,
        files: body.files,
      });
    }

    const member = bdd.user({ orgId: actor.orgId });
    const otherOrg = bdd.user({ userId: actor.userId });
    for (const unauthorized of [member, otherOrg]) {
      await host.requestHostedSiteDeployments(unauthorized, site, [404]);
      // Published website files are public; management and completion are not.
      await expect(
        host.readHostedSiteFiles(unauthorized, site),
      ).resolves.toMatchObject({ deploymentId: third.deploymentId });
      await host.requestCompleteHostedSite(
        unauthorized,
        third.deploymentId,
        [404],
      );
    }
    const denied = await host.requestPrepareHostedSite(member, body, [409]);
    expectApiError(denied.body);
    expect(denied.body.error.message).toContain("belongs to another owner");

    const catalog = await chat.listArtifactCatalog(actor);
    expect(catalog.artifacts).toHaveLength(1);
    const entry = catalog.artifacts[0];
    if (!entry) {
      throw new Error("Expected one hosted site catalog entry");
    }
    const detail = await chat.getArtifactCatalogEntry(actor, entry.id);
    if (detail.kind !== "hosted-site") {
      throw new Error("Expected a hosted site catalog entry");
    }
    expect(detail.site).toMatchObject({
      id: first.siteId,
      deploymentVersion: 3,
    });
    await completeChatRunOk(secondChat.runId, secondClaim.sandboxHeaders);
    activeRuns.delete(secondChat.runId);
  }, 180_000);

  it("catalogues a published deck as a presentation", async () => {
    const owner = await catalogActor("Artifact catalog deck owner");
    const site = `catalog-deck-${randomUUID().slice(0, 8)}`;
    await publishHostedSite({
      owner,
      site,
      artifactKind: "presentation-html",
    });

    const catalog = await chat.listArtifactCatalog(owner.actor, {
      kind: "presentation",
    });

    expect(catalog.artifacts).toHaveLength(1);
    expect(catalog.artifacts[0]).toMatchObject({
      kind: "presentation",
      title: site,
    });
  }, 180_000);

  it("moves a catalog entry to presentation when a deck redeploys the site", async () => {
    const owner = await catalogActor(
      "Artifact catalog hosted transition owner",
      bdd.user(),
    );
    const site = `catalog-transition-${randomUUID().slice(0, 8)}`;
    const hosted = await publishHostedSite({
      owner,
      site,
      artifactKind: "hosted-site",
    });
    const presentation = await publishHostedSite({
      owner,
      site,
      artifactKind: "presentation-html",
      threadId: hosted.threadId,
    });

    // One name is one site, and its single catalog entry follows the newest
    // publication's artifact kind.
    expect(presentation.siteId).toBe(hosted.siteId);
    expect(presentation.publicSlug).toBe(site);
    const catalog = await chat.listArtifactCatalog(owner.actor);
    expect(
      catalog.artifacts.map((artifact) => {
        return { kind: artifact.kind, title: artifact.title };
      }),
    ).toStrictEqual([{ kind: "presentation", title: site }]);
  }, 180_000);

  it("filters by kind without leaking other kinds", async () => {
    const owner = await catalogActor("Artifact catalog filter owner");
    await uploadFile({
      owner,
      prompt: "upload notes",
      filename: "notes.txt",
      contentType: "text/plain",
    });
    const site = `catalog-filter-${randomUUID().slice(0, 8)}`;
    await publishHostedSite({ owner, site });

    const files = await chat.listArtifactCatalog(owner.actor, { kind: "file" });
    const sites = await chat.listArtifactCatalog(owner.actor, {
      kind: "hosted-site",
    });
    for (const kind of ["avatar", "video", "shared-thread"] as const) {
      await expect(
        chat.listArtifactCatalog(owner.actor, { kind }),
      ).resolves.toStrictEqual({ artifacts: [], nextCursor: null });
    }

    expect(
      files.artifacts.map((artifact) => {
        return artifact.kind;
      }),
    ).toStrictEqual(["file"]);
    expect(
      sites.artifacts.map((artifact) => {
        return artifact.title;
      }),
    ).toStrictEqual([site]);
  }, 180_000);

  it("searches artifact titles literally before applying the page limit", async () => {
    const owner = await catalogActor("Artifact catalog search owner");
    await uploadFile({
      owner,
      prompt: "upload launch brief",
      filename: "Launch-Brief.txt",
      contentType: "text/plain",
    });
    await uploadFile({
      owner,
      prompt: "upload budget",
      filename: "budget.txt",
      contentType: "text/plain",
    });

    const result = await chat.listArtifactCatalog(owner.actor, {
      keyword: "launch",
      limit: 1,
    });

    expect(result).toStrictEqual({
      artifacts: [
        expect.objectContaining({
          kind: "file",
          title: "Launch-Brief.txt",
        }),
      ],
      nextCursor: null,
    });

    await expect(
      chat.listArtifactCatalog(owner.actor, { keyword: "%" }),
    ).resolves.toStrictEqual({ artifacts: [], nextCursor: null });
  }, 180_000);

  it("paginates a thread and kind filtered catalog without repeats or foreign-thread entries", async () => {
    const owner = await catalogActor("Artifact catalog paging owner");
    const created: string[] = [];
    let threadId: string | undefined;
    for (const label of ["one", "two", "three"]) {
      const uploaded = await uploadFile({
        owner,
        prompt: `upload ${label}`,
        filename: `page-${label}.txt`,
        contentType: "text/plain",
        threadId,
      });
      threadId = uploaded.threadId;
      created.push(uploaded.fileId);
    }
    if (!threadId) {
      throw new Error("Expected a thread for paginated artifacts");
    }
    await uploadFile({
      owner,
      prompt: "Publish outside the paginated thread",
      filename: "page-other-thread.txt",
      contentType: "text/plain",
    });

    const collected: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await chat.listArtifactCatalog(owner.actor, {
        limit: 1,
        cursor,
        chatThreadId: threadId,
        kind: "file",
      });
      expect(page.artifacts.length).toBeLessThanOrEqual(1);
      collected.push(
        ...page.artifacts.map((artifact) => {
          return artifact.title;
        }),
      );
      cursor = page.nextCursor ?? undefined;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(10);
    } while (cursor);

    expect(collected).toStrictEqual([
      "page-three.txt",
      "page-two.txt",
      "page-one.txt",
    ]);
    expect(new Set(collected).size).toBe(created.length);
  }, 180_000);

  it("keeps a Runner output associated with its owning prompt when the run is interrupted", async () => {
    const owner = await catalogActor("Artifact catalog workflow owner");
    const run = await sendChatRun(owner.actor, {
      agentId: owner.agentId,
      prompt: "Upload an artifact through the Runner protocol",
    });
    const { claim, sandboxHeaders } = await claimChatRun(
      owner.runnerGroup,
      run.runId,
    );
    const fileId = randomUUID();
    stageUploadObject(
      `artifacts/${owner.actor.userId}/${fileId}/workflow-output.txt`,
      128,
    );
    await chat.completeUploadWithBearer(
      `Bearer ${okouTokenFromClaim(claim)}`,
      { id: fileId, contentType: "text/plain" },
      [200],
    );

    const interruptId = randomUUID();
    await chat.requestSendEvent(
      owner.actor,
      {
        agentId: owner.agentId,
        threadId: run.threadId,
        interruptsRunId: run.runId,
        clientEventId: interruptId,
      },
      [201],
    );
    await flushWaitUntilForTest();
    await webhooks.requestAgentComplete(
      { runId: run.runId, exitCode: 1 },
      sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
    const { events } = await chat.listThreadEvents(owner.actor, run.threadId);
    expect(events).toContainEqual(
      expect.objectContaining({ eventType: "input.prompt", runId: run.runId }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        id: interruptId,
        eventType: "control.interrupt",
        interruptsRunId: run.runId,
      }),
    );
    const threadArtifacts = await chat.listThreadArtifacts(
      owner.actor,
      run.threadId,
    );
    expect(threadArtifacts.runs).toStrictEqual([
      {
        runId: run.runId,
        files: [expect.objectContaining({ filename: "workflow-output.txt" })],
      },
    ]);
    const catalog = await chat.listArtifactCatalog(owner.actor, {
      chatThreadId: run.threadId,
    });
    expect(catalog.artifacts).toStrictEqual([
      expect.objectContaining({
        kind: "file",
        title: "workflow-output.txt",
      }),
    ]);
    await expect(chat.listArtifactCatalog(owner.actor)).resolves.toStrictEqual(
      catalog,
    );
  }, 180_000);

  it("hides an artifact owned by another caller behind a 404", async () => {
    const owner = await catalogActor("Artifact catalog private owner");
    const outsider = await catalogActor("Artifact catalog prying outsider");
    await uploadFile({
      owner,
      prompt: "upload a private file",
      filename: "private.txt",
      contentType: "text/plain",
    });
    const catalog = await chat.listArtifactCatalog(owner.actor);
    const artifactId = catalog.artifacts[0]?.id;
    if (!artifactId) {
      throw new Error("Expected the owner to see their artifact");
    }

    const denied = await chat.requestArtifactCatalogEntry(
      outsider.actor,
      artifactId,
      [404],
    );

    if (denied.status !== 404) {
      throw new Error("Expected a foreign artifact request to 404");
    }
    expect(denied.body.error.code).toBe("NOT_FOUND");
  }, 180_000);

  it("scopes the catalog to one chat thread when chatThreadId is set", async () => {
    const owner = await catalogActor("Artifact catalog thread owner");
    const first = await uploadFile({
      owner,
      prompt: "upload into the first thread",
      filename: "first-thread.txt",
      contentType: "text/plain",
    });
    await uploadFile({
      owner,
      prompt: "upload into the second thread",
      filename: "second-thread.txt",
      contentType: "text/plain",
    });

    const filtered = await chat.listArtifactCatalog(owner.actor, {
      chatThreadId: first.threadId,
    });

    expect(filtered.nextCursor).toBeNull();
    expect(filtered.artifacts).toStrictEqual([
      expect.objectContaining({ kind: "file", title: "first-thread.txt" }),
    ]);
  }, 180_000);
});

describe("shared thread routes", () => {
  it("creates immutable, redacted snapshots from selected visible messages", async () => {
    const owner = await catalogActor("Shared thread test agent");
    const run = await sendChatRun(owner.actor, {
      agentId: owner.agentId,
      prompt: "Prepare the private launch plan",
    });
    const assistantText = "Here is the **public** launch plan.";
    await completeChatRunWithMessage(owner, run.runId, assistantText);

    let events: readonly SharedThreadEventRef[] | undefined;
    await flushWaitUntilForTest();
    await expect(
      (async () => {
        events = await listSharedThreadEventRefs(owner.actor, run.threadId);
        return events.some((event) => {
          return (
            event.eventType === "run.completed" && event.runId === run.runId
          );
        });
      })(),
    ).resolves.toBeTruthy();
    if (!events) {
      throw new Error("Expected completed shared-thread fixture events");
    }
    const promptEvent = events.find((event) => {
      return event.eventType === "input.prompt" && event.runId === run.runId;
    });
    const assistantEvent = events.find((event) => {
      return event.eventType === "output.message";
    });
    const nonShareableEvent = events.find((event) => {
      return event.eventType === "run.completed";
    });
    const otherRun = await sendChatRun(owner.actor, {
      agentId: owner.agentId,
      prompt: "This other thread must stay private",
    });
    const otherEvents = await listSharedThreadEventRefs(
      owner.actor,
      otherRun.threadId,
    );
    const otherPromptEvent = otherEvents.find((event) => {
      return event.eventType === "input.prompt";
    });
    if (
      !promptEvent ||
      !assistantEvent ||
      !nonShareableEvent ||
      !otherPromptEvent
    ) {
      throw new Error(
        "Expected shareable, non-shareable, and cross-thread events",
      );
    }

    mockOptionalEnv("OPENROUTER_API_KEY", "shared-title-key");
    const titlePrompts: string[] = [];
    chatCallbacks.mockVertexCompletions((body) => {
      const systemContent = body.messages[0]?.content ?? "";
      if (systemContent.includes("for this shared conversation")) {
        titlePrompts.push(body.messages[1]?.content ?? "");
        return "**Private launch plan**";
      }
      return "Generated summary";
    });

    const eventIds = [
      randomUUID(),
      otherPromptEvent.id,
      nonShareableEvent.id,
      assistantEvent.id,
      promptEvent.id,
      assistantEvent.id,
    ];
    const first = await createSharedThreadSnapshot(
      owner.actor,
      run.threadId,
      eventIds,
      "https://app.okou.ai",
    );
    const second = await createSharedThreadSnapshot(
      owner.actor,
      run.threadId,
      eventIds,
    );
    expect(titlePrompts).toHaveLength(2);
    expect(titlePrompts[0]).toContain("Prepare the private launch plan");
    expect(titlePrompts[0]).toContain(assistantText);
    expect(titlePrompts[0]).not.toContain(
      "This other thread must stay private",
    );

    const publicSnapshot = await readSharedThreadSnapshot(first.id);
    expect(publicSnapshot.headers.get("cache-control")).toBe("no-store");
    expect(publicSnapshot.body).toStrictEqual({
      id: first.id,
      title: "Private launch plan",
      messages: [
        {
          messageIndex: 0,
          role: "user",
          content: "Prepare the private launch plan",
          runIndex: 0,
        },
        {
          messageIndex: 1,
          role: "assistant",
          content: assistantText,
          runIndex: 0,
        },
      ],
    });

    const metadata = await readSharedThreadMeta(first.id);
    expect(metadata.body).toStrictEqual({
      title: "Private launch plan",
    });
    expect(metadata.headers.get("cache-control")).toBe(
      "public, max-age=31536000, s-maxage=31536000, immutable",
    );

    const secondSnapshot = await readSharedThreadSnapshot(second.id);
    expect(secondSnapshot.body).toMatchObject({ id: second.id });

    const catalog = await chat.listArtifactCatalog(owner.actor, {
      kind: "shared-thread",
      chatThreadId: run.threadId,
    });
    expect(catalog.artifacts).toHaveLength(2);
    expect(catalog.artifacts).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "shared-thread",
          title: "Private launch plan",
        }),
      ]),
    );
    const artifactId = catalog.artifacts[0]?.id;
    if (!artifactId) {
      throw new Error("Expected a shared-thread artifact");
    }
    const detail = await chat.getArtifactCatalogEntry(owner.actor, artifactId);
    expect(detail.kind).toBe("shared-thread");
    // Neither selected message contains a file. The source-thread association
    // must exist independently of uploaded-file projections.
    const firstPage = await chat.listArtifactCatalog(owner.actor, {
      kind: "shared-thread",
      chatThreadId: run.threadId,
      limit: 1,
    });
    expect(firstPage.artifacts).toHaveLength(1);
    if (!firstPage.nextCursor) {
      throw new Error("Expected a second shared-thread artifact page");
    }
    const secondPage = await chat.listArtifactCatalog(owner.actor, {
      kind: "shared-thread",
      chatThreadId: run.threadId,
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.artifacts).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
    expect([...firstPage.artifacts, ...secondPage.artifacts]).toStrictEqual(
      catalog.artifacts,
    );
    for (const query of [
      { kind: "file" as const, chatThreadId: run.threadId },
      { kind: "shared-thread" as const, chatThreadId: otherRun.threadId },
    ]) {
      await expect(
        chat.listArtifactCatalog(owner.actor, query),
      ).resolves.toStrictEqual({ artifacts: [], nextCursor: null });
    }
    for (const caller of [
      bdd.user({ orgId: owner.actor.orgId }),
      bdd.user({ userId: owner.actor.userId }),
    ]) {
      await expect(
        chat.listArtifactCatalog(caller, {
          kind: "shared-thread",
          chatThreadId: run.threadId,
        }),
      ).resolves.toStrictEqual({ artifacts: [], nextCursor: null });
    }

    const directCatalogResponse = await sharedThreadTestApp().request(
      "/api/artifacts/catalog",
      { headers: authenticateSharedThread(owner.actor) },
    );
    expect(directCatalogResponse.status).toBe(200);
    const directCatalog = asRecord(await directCatalogResponse.json());
    expect(directCatalog.artifacts).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "shared-thread" }),
      ]),
    );
    const directDetailResponse = await sharedThreadTestApp().request(
      `/api/artifacts/catalog/${artifactId}`,
      { headers: authenticateSharedThread(owner.actor) },
    );
    expect(directDetailResponse.status).toBe(200);
    const directDetail = asRecord(await directDetailResponse.json());
    expect(directDetail.kind).toBe("shared-thread");

    await chat.deleteThread(owner.actor, run.threadId);
    const afterSourceDeletion = await readSharedThreadSnapshot(first.id);
    expect(afterSourceDeletion.body).toStrictEqual(publicSnapshot.body);
    await expect(
      chat.listArtifactCatalog(owner.actor, {
        kind: "shared-thread",
        chatThreadId: run.threadId,
      }),
    ).resolves.toStrictEqual({ artifacts: [], nextCursor: null });
    await expect(
      chat.listArtifactCatalog(owner.actor, { kind: "shared-thread" }),
    ).resolves.toStrictEqual(catalog);
    await expect(
      chat.getArtifactCatalogEntry(owner.actor, artifactId),
    ).resolves.toStrictEqual(detail);

    webhooks.configureClerkWebhookSecret();
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    context.mocks.s3.send.mockResolvedValue({ Contents: [] });
    webhooks.verifyNextClerkWebhook({
      type: "organization.deleted",
      data: { id: owner.actor.orgId },
    });
    await webhooks.requestClerkWebhook("{}", {}, [200]);
    await flushWaitUntilForTest();

    const afterOrgDeletionResponse = await sharedThreadTestApp().request(
      `/api/shared-threads/${first.id}`,
    );
    expect(afterOrgDeletionResponse.status).toBe(200);
    const afterOrgDeletion = await afterOrgDeletionResponse.json();
    expect(afterOrgDeletion).toStrictEqual(publicSnapshot.body);
  }, 180_000);

  it("allows API creation while the entry feature switch is disabled", async () => {
    const owner = await catalogActor("Shared thread feature-switch test agent");
    mockOptionalEnv("OPENROUTER_API_KEY", "shared-title-key");
    const run = await sendChatRun(owner.actor, {
      agentId: owner.agentId,
      prompt: "Prepare the private launch plan",
    });
    const events = await listSharedThreadEventRefs(owner.actor, run.threadId);
    const promptEvent = events.find((event) => {
      return event.eventType === "input.prompt" && event.runId === run.runId;
    });
    if (!promptEvent) {
      throw new Error("Expected an associated prompt event");
    }
    chatCallbacks.mockVertexCompletions(() => {
      return "Private launch plan";
    });

    const created = await createSharedThreadSnapshot(
      owner.actor,
      run.threadId,
      [promptEvent.id],
    );

    await expect(readSharedThreadSnapshot(created.id)).resolves.toMatchObject({
      body: { title: "Private launch plan" },
    });
  });
});
