import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import type { RouteEntry } from "../../route-entry";
import { artifactCatalogRoutes } from "../artifact-catalog";
import { hostRoutes } from "../host";
import { sharedThreadRoutes } from "../shared-threads";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createHostMapsBddApi } from "./helpers/api-bdd-host-maps";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { insertLegacyArtifactCatalogFile } from "./helpers/runtime-state";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const host = createHostMapsBddApi(context);
const webhooks = createWebhookCallbackApi(context);
const routeMocks = createRouteMocks(context);
const sharedThreadTestRoutes: readonly RouteEntry[] = [
  ...artifactCatalogRoutes,
  ...sharedThreadRoutes,
];
type RunnerClaim = Awaited<ReturnType<typeof api.claimRunnerJob>>;
interface CatalogActor {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
}

/**
 * Stage an uploadable object. The object-storage mock is global, so the store
 * is re-accepted per upload to keep tests with more than one actor working.
 */
function stageUploadObject(key: string, size: number): void {
  chatCallbacks
    .acceptChatObjectStorage()
    .addObject({ bucket: "test-user-artifacts", key, size });
}

async function catalogActor(
  displayName: string,
  actor: ApiTestUser = bdd.user(),
  options: { readonly bootstrapOrg?: boolean } = {},
): Promise<CatalogActor> {
  chatCallbacks.acceptChatObjectStorage();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  chatCallbacks.disableVapid();
  const runnerGroup = api.configureRunnerGroup();
  if (options.bootstrapOrg !== false) {
    await api.grantProEntitlement(actor);
    await api.ensureOrgModelProvider(actor);
  }
  if (!actor.orgId) {
    throw new Error("Expected artifact catalog test actor to have an org");
  }
  const agent = await bdd.createAgent(actor, {
    displayName,
    visibility: "private",
  });
  return { actor, agentId: agent.agentId, runnerGroup };
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

async function completeChatRunOk(
  runId: string,
  sandboxHeaders: { readonly authorization: string },
  lastEventSequence?: number,
): Promise<void> {
  const historyHash = createHash("sha256")
    .update(`bdd artifact catalog history ${runId}`)
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
}): Promise<{
  readonly fileId: string;
  readonly url: string;
  readonly threadId: string;
}> {
  const run = await sendChatRun(args.owner.actor, {
    agentId: args.owner.agentId,
    prompt: args.prompt,
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

async function insertLegacyCatalogFile(args: {
  readonly owner: CatalogActor;
  readonly filename: string;
  readonly url: string;
}): Promise<string> {
  if (!args.owner.actor.orgId) {
    throw new Error("Expected artifact catalog actor to have an org");
  }

  // The previous API version cannot be invoked through the current route
  // boundary. The guarded test route reproduces its schema-compatible insert
  // so the public catalog endpoint proves migration-trigger reconciliation.
  return await insertLegacyArtifactCatalogFile(context, {
    userId: args.owner.actor.userId,
    orgId: args.owner.actor.orgId,
    filename: args.filename,
    url: args.url,
  });
}

async function publishHostedSite(args: {
  readonly owner: CatalogActor;
  readonly site: string;
  readonly artifactKind?: "hosted-site" | "presentation-html";
  readonly threadId?: string;
  readonly claimRun?: boolean;
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
  const claimed =
    args.claimRun === false
      ? null
      : await claimChatRun(args.owner.runnerGroup, run.runId);
  const bearer =
    claimed === null
      ? `Bearer ${scopedOkouToken(args.owner, run.runId, ["host:write"])}`
      : `Bearer ${okouTokenFromClaim(claimed.claim)}`;
  const body = {
    site: args.site,
    artifactKind: args.artifactKind ?? ("hosted-site" as const),
    spaFallback: false,
    files: [hostedTextFile("/index.html", `<main>${args.site}</main>`)],
  };

  const prepared = await chat.prepareHostedSiteWithBearer(bearer, body);
  await chat.completeHostedSiteWithBearer(bearer, prepared.deploymentId);
  if (claimed !== null) {
    await completeChatRunOk(run.runId, claimed.sandboxHeaders);
  }
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

async function publishHostedSiteFromDirectRun(args: {
  readonly owner: CatalogActor;
  readonly site: string;
  readonly artifactKind?: "hosted-site" | "presentation-html";
  readonly runId?: string;
}): Promise<{
  readonly url: string;
  readonly siteId: string;
  readonly publicSlug: string;
  readonly runId: string;
}> {
  const runId =
    args.runId ??
    (
      await api.createDirectRun(args.owner.actor, {
        agentId: args.owner.agentId,
        prompt: `publish ${args.site}`,
        modelProviderType: "anthropic-api-key",
        triggerSource: "automation-schedule",
        vars: { OKOU_AGENT_ID: args.owner.agentId },
        secrets: { OKOU_TOKEN: "bdd-artifact-catalog-token" },
      })
    ).runId;
  const bearer = `Bearer ${scopedOkouToken(args.owner, runId, ["host:write"])}`;
  const prepared = await chat.prepareHostedSiteWithBearer(bearer, {
    site: args.site,
    artifactKind: args.artifactKind ?? "hosted-site",
    spaFallback: false,
    files: [hostedTextFile("/index.html", `<main>${args.site}</main>`)],
  });
  await chat.completeHostedSiteWithBearer(bearer, prepared.deploymentId);
  return {
    url: prepared.url,
    siteId: prepared.siteId,
    publicSlug: prepared.publicSlug,
    runId,
  };
}

function scopedOkouToken(
  owner: CatalogActor,
  runId: string,
  capabilities: readonly ("file:write" | "host:read" | "host:write")[],
): string {
  if (!owner.actor.orgId) {
    throw new Error("Expected artifact catalog actor to have an org");
  }
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "okou",
    userId: owner.actor.userId,
    orgId: owner.actor.orgId,
    runId,
    capabilities,
    iat: seconds,
    exp: seconds + 60,
  });
}

describe("GET /api/artifacts/catalog", () => {
  it.each(["hosted-site", "presentation-html"] as const)(
    "keeps private %s catalog and thread references authenticated",
    async (artifactKind) => {
      const owner = await catalogActor("Private HTML catalog owner");
      mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
      await createBillingMediaApi(context).updateFeatureSwitches(owner.actor, {
        [FeatureSwitchKey.PrivateArtifacts]: true,
      });
      const capture = host.captureHostedSitesS3();
      const site = `private-catalog-${randomUUID().slice(0, 8)}`;
      const hosted = await publishHostedSite({
        owner,
        site,
        artifactKind,
        claimRun: false,
      });
      const canonical = hosted.url;
      expect(canonical).toMatch(
        /^http:\/\/localhost:3002\/artifacts\/[a-z0-9]{10}\.html$/u,
      );
      const list = await chat.listArtifactCatalog(owner.actor);
      const entry = list.artifacts.find((item) => {
        return item.title === site;
      });
      if (!entry) {
        throw new Error("Expected private HTML catalog entry");
      }
      const detail = await chat.getArtifactCatalogEntry(owner.actor, entry.id);
      expect(detail).toMatchObject({
        kind:
          artifactKind === "presentation-html" ? "presentation" : "hosted-site",
        thumbnail: null,
        site: { url: canonical, deploymentVersion: 1 },
      });
      const thread = await chat.listThreadArtifacts(
        owner.actor,
        hosted.threadId,
      );
      const file = thread.runs
        .flatMap((run) => {
          return run.files;
        })
        .find((file) => {
          return file.url === canonical;
        });
      expect(file).toMatchObject({ artifactKind, contentType: "text/html" });
      expect(file?.aliasUrl).toBeUndefined();
      expect(file?.previewImageUrl).toBeUndefined();
      expect(
        capture.puts.filter(({ key }) => {
          return (
            !key.startsWith("private-sites/") &&
            !key.startsWith("agent") &&
            !key.startsWith("artifact-references/")
          );
        }),
      ).toStrictEqual([]);
      const colleague = bdd.user({ orgId: owner.actor.orgId });
      await chat.requestArtifactCatalogEntry(colleague, entry.id, [404]);
      await createBillingMediaApi(context).updateFeatureSwitches(owner.actor, {
        [FeatureSwitchKey.PrivateArtifacts]: false,
      });
      await expect(
        chat.getArtifactCatalogEntry(owner.actor, entry.id),
      ).resolves.toMatchObject({ site: { url: canonical } });
    },
  );

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

  it("lists the source URL for a video without a poster", async () => {
    const owner = await catalogActor("Artifact catalog video source owner");
    const run = await api.createDirectRun(owner.actor, {
      agentId: owner.agentId,
      prompt: "upload a video",
      modelProviderType: "anthropic-api-key",
      triggerSource: "automation-schedule",
      vars: { OKOU_AGENT_ID: owner.agentId },
      secrets: { OKOU_TOKEN: "bdd-artifact-video-source-token" },
    });
    const fileId = randomUUID();
    stageUploadObject(
      `artifacts/${owner.actor.userId}/${fileId}/source-fallback.webm`,
      1024,
    );
    const completed = await chat.completeUploadWithBearer(
      `Bearer ${scopedOkouToken(owner, run.runId, ["file:write"])}`,
      { id: fileId, contentType: "video/webm" },
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
        title: "source-fallback.webm",
      }),
    ]);
  }, 180_000);

  it("reconciles a file written by the previous API after migration", async () => {
    const owner = await catalogActor("Artifact catalog promotion owner");
    const url = `https://files.okou.test/${randomUUID()}/legacy-output.zip`;
    const fileId = await insertLegacyCatalogFile({
      owner,
      filename: "legacy-output.zip",
      url,
    });

    const catalog = await chat.listArtifactCatalog(owner.actor);
    expect(catalog.artifacts).toStrictEqual([
      expect.objectContaining({
        kind: "file",
        title: "legacy-output.zip",
      }),
    ]);

    const artifactId = catalog.artifacts[0]?.id;
    if (!artifactId) {
      throw new Error("Expected the reconciled artifact to be listed");
    }
    const detail = await chat.getArtifactCatalogEntry(owner.actor, artifactId);
    if (detail.kind !== "file") {
      throw new Error("Expected the reconciled artifact to be a file");
    }
    expect(detail.file).toMatchObject({ id: fileId, url });
  }, 180_000);

  it("removes catalog rows when deleting the backing agent", async () => {
    const owner = await catalogActor("Artifact catalog deletion owner");
    await uploadFile({
      owner,
      prompt: "upload a disposable report",
      filename: "disposable-report.txt",
      contentType: "text/plain",
    });
    expect(
      (await chat.listArtifactCatalog(owner.actor)).artifacts,
    ).toHaveLength(1);

    await flushWaitUntilForTest();
    await bdd.deleteAgent(owner.actor, owner.agentId);

    await expect(chat.listArtifactCatalog(owner.actor)).resolves.toStrictEqual({
      artifacts: [],
      nextCursor: null,
    });
  }, 180_000);

  it("lists repeated same-name hosted-site publications as separate artifacts", async () => {
    const owner = await catalogActor(
      "Artifact catalog hosted owner",
      bdd.user(),
    );
    const site = `catalog-site-${randomUUID().slice(0, 8)}`;
    const hosted = await publishHostedSite({ owner, site });
    const second = await publishHostedSite({
      owner,
      site,
      threadId: hosted.threadId,
      claimRun: false,
    });
    expect(second.siteId).not.toBe(hosted.siteId);
    expect(second.deploymentId).not.toBe(hosted.deploymentId);
    expect(second.publicSlug).toMatch(new RegExp(`^${site}-[a-z0-9]{4}$`, "u"));

    const catalog = await chat.listArtifactCatalog(owner.actor);

    expect(catalog.artifacts).toHaveLength(2);
    expect(catalog.artifacts).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "hosted-site", title: site }),
        expect.objectContaining({
          kind: "hosted-site",
          title: second.publicSlug,
        }),
      ]),
    );

    const artifactId = catalog.artifacts.find((artifact) => {
      return artifact.title === site;
    })?.id;
    if (!artifactId) {
      throw new Error("Expected the catalog to list the hosted site");
    }
    const detail = await chat.getArtifactCatalogEntry(owner.actor, artifactId);
    if (detail.kind !== "hosted-site") {
      throw new Error("Expected a hosted site to be catalogued as hosted-site");
    }
    expect(detail.site).toMatchObject({
      id: hosted.siteId,
      slug: site,
      deploymentVersion: 1,
      entrypoint: "/index.html",
      spaFallback: false,
    });
  }, 180_000);

  it("isolates same-name hosted sites by chat thread", async () => {
    const owner = await catalogActor(
      "Artifact catalog chat-scoped hosted owner",
      bdd.user(),
    );
    host.captureHostedSitesS3();
    const site = `catalog-chat-scope-${randomUUID().slice(0, 8)}`;

    const first = await publishHostedSite({ owner, site });
    const secondChat = await publishHostedSite({
      owner,
      site,
      claimRun: false,
    });

    expect(secondChat).toMatchObject({ deploymentVersion: 1 });
    expect(secondChat.siteId).not.toBe(first.siteId);
    expect(secondChat.publicSlug).not.toBe(first.publicSlug);
    expect(secondChat.url).not.toBe(first.url);
    expect(secondChat.threadId).not.toBe(first.threadId);

    const firstHistory = await chat.readHostedSiteDeploymentsWithBearer(
      `Bearer ${scopedOkouToken(owner, first.runId, ["host:read"])}`,
      first.publicSlug,
    );
    const secondHistory = await chat.readHostedSiteDeploymentsWithBearer(
      `Bearer ${scopedOkouToken(owner, secondChat.runId, ["host:read"])}`,
      secondChat.publicSlug,
    );
    expect(firstHistory).toMatchObject({
      siteId: first.siteId,
      publicSlug: first.publicSlug,
    });
    expect(firstHistory.deployments).toHaveLength(1);
    expect(secondHistory).toMatchObject({
      siteId: secondChat.siteId,
      publicSlug: secondChat.publicSlug,
    });
    expect(secondHistory.deployments).toHaveLength(1);

    const crossChatComplete = await chat.requestCompleteHostedSiteWithBearer(
      `Bearer ${scopedOkouToken(owner, secondChat.runId, ["host:write"])}`,
      first.deploymentId,
      [409],
    );
    expectApiError(crossChatComplete.body);
    expect(crossChatComplete.body.error).toStrictEqual({
      code: "CONFLICT",
      message: "Hosted deployment belongs to a different chat",
    });

    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/hosted-sites/download?sig=bdd",
    );
    const firstActive = await host.readHostedSiteFiles(
      owner.actor,
      first.publicSlug,
    );
    const secondActive = await host.readHostedSiteFiles(
      owner.actor,
      secondChat.publicSlug,
    );
    expect(firstActive).toMatchObject({
      siteId: first.siteId,
      deploymentId: first.deploymentId,
      deploymentVersion: 1,
    });
    expect(secondActive).toMatchObject({
      siteId: secondChat.siteId,
      deploymentId: secondChat.deploymentId,
      deploymentVersion: 1,
    });

    const catalog = await chat.listArtifactCatalog(owner.actor);
    const entries = catalog.artifacts.filter((artifact) => {
      return [first.publicSlug, secondChat.publicSlug].includes(artifact.title);
    });
    expect(entries).toHaveLength(2);
    const details = await Promise.all(
      entries.map(async (entry) => {
        return await chat.getArtifactCatalogEntry(owner.actor, entry.id);
      }),
    );
    expect(
      details.map((detail) => {
        if (detail.kind !== "hosted-site") {
          throw new Error("Expected a chat-scoped hosted-site catalog entry");
        }
        return detail.site.id;
      }),
    ).toStrictEqual(expect.arrayContaining([first.siteId, secondChat.siteId]));
  }, 180_000);

  it("allocates new sites for a name already used by an organization-scoped site", async () => {
    const owner = await catalogActor(
      "Artifact catalog mixed-scope hosted owner",
      bdd.user(),
    );
    host.captureHostedSitesS3();
    const site = `catalog-mixed-scope-${randomUUID().slice(0, 8)}`;

    const organizationSite = await publishHostedSiteFromDirectRun({
      owner,
      site,
    });
    const chatSite = await publishHostedSite({
      owner,
      site,
      claimRun: false,
    });
    const secondOrganizationSite = await publishHostedSiteFromDirectRun({
      owner,
      site,
      runId: organizationSite.runId,
    });
    expect(
      new Set([
        organizationSite.siteId,
        chatSite.siteId,
        secondOrganizationSite.siteId,
      ]).size,
    ).toBe(3);
    expect(chatSite.publicSlug).toMatch(
      new RegExp(`^${site}-[a-z0-9]{4}$`, "u"),
    );
    expect(secondOrganizationSite.publicSlug).toMatch(
      new RegExp(`^${site}-[a-z0-9]{4}$`, "u"),
    );
    expect(secondOrganizationSite.publicSlug).not.toBe(chatSite.publicSlug);

    const originalHistory = await chat.readHostedSiteDeploymentsWithBearer(
      `Bearer ${scopedOkouToken(owner, organizationSite.runId, ["host:read"])}`,
      organizationSite.publicSlug,
    );
    expect(originalHistory).toMatchObject({
      siteId: organizationSite.siteId,
      publicSlug: organizationSite.publicSlug,
      activeDeploymentVersion: 1,
    });
    expect(originalHistory.deployments).toHaveLength(1);
    await accept(
      setupApp({ context, routes: hostRoutes })(hostContract).deployments({
        headers: {
          authorization: `Bearer ${scopedOkouToken(owner, chatSite.runId, ["host:read"])}`,
        },
        params: { site: organizationSite.publicSlug },
      }),
      [404],
    );

    const catalog = await chat.listArtifactCatalog(owner.actor);
    expect(catalog.artifacts).toHaveLength(3);
    expect(catalog.artifacts).toStrictEqual(
      expect.arrayContaining(
        [organizationSite, chatSite, secondOrganizationSite].map(
          (published) => {
            return expect.objectContaining({
              kind: "hosted-site",
              title: published.publicSlug,
            });
          },
        ),
      ),
    );
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

  it("keeps the original site when publishing an updated presentation", async () => {
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
      claimRun: false,
    });

    expect(presentation.siteId).not.toBe(hosted.siteId);
    const catalog = await chat.listArtifactCatalog(owner.actor);
    expect(catalog.artifacts).toHaveLength(2);
    expect(catalog.artifacts).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "hosted-site", title: site }),
        expect.objectContaining({
          kind: "presentation",
          title: presentation.publicSlug,
        }),
      ]),
    );
  }, 180_000);

  it("keeps hosted artifacts with their original owner when a colleague publishes", async () => {
    const orgId = `org_${randomUUID()}`;
    const firstOwner = await catalogActor(
      "Artifact catalog first org member",
      bdd.user({ orgId, orgRole: "org:admin" }),
    );
    const secondOwner = await catalogActor(
      "Artifact catalog second org member",
      bdd.user({ orgId, orgRole: "org:member" }),
      { bootstrapOrg: false },
    );
    const site = `catalog-shared-${randomUUID().slice(0, 8)}`;
    const firstDeployment = await publishHostedSiteFromDirectRun({
      owner: firstOwner,
      site,
    });
    const secondDeployment = await publishHostedSiteFromDirectRun({
      owner: secondOwner,
      site,
    });
    expect(secondDeployment.siteId).not.toBe(firstDeployment.siteId);
    expect(secondDeployment.publicSlug).toMatch(
      new RegExp(`^${site}-[a-z0-9]{4}$`, "u"),
    );
    const firstCatalog = await chat.listArtifactCatalog(firstOwner.actor);
    expect(firstCatalog.artifacts).toStrictEqual([
      expect.objectContaining({ kind: "hosted-site", title: site }),
    ]);
    const secondCatalog = await chat.listArtifactCatalog(secondOwner.actor);
    expect(secondCatalog.artifacts).toStrictEqual([
      expect.objectContaining({
        kind: "hosted-site",
        title: secondDeployment.publicSlug,
      }),
    ]);
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

  it("walks the whole catalog through the cursor without repeats or gaps", async () => {
    const owner = await catalogActor("Artifact catalog paging owner");
    const created: string[] = [];
    for (const label of ["one", "two", "three"]) {
      const uploaded = await uploadFile({
        owner,
        prompt: `upload ${label}`,
        filename: `page-${label}.txt`,
        contentType: "text/plain",
      });
      created.push(uploaded.fileId);
    }

    const collected: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await chat.listArtifactCatalog(owner.actor, {
        limit: 1,
        cursor,
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

  it("keeps a workflow run artifact under the owning Okou user", async () => {
    const owner = await catalogActor("Artifact catalog workflow owner");
    const run = await api.createDirectRun(owner.actor, {
      agentId: owner.agentId,
      prompt: "create a workflow artifact",
      modelProviderType: "anthropic-api-key",
      triggerSource: "automation-schedule",
      vars: { OKOU_AGENT_ID: owner.agentId },
      secrets: { OKOU_TOKEN: "bdd-artifact-catalog-token" },
    });
    const fileId = randomUUID();
    stageUploadObject(
      `artifacts/${owner.actor.userId}/${fileId}/workflow-output.txt`,
      128,
    );
    await chat.completeUploadWithBearer(
      `Bearer ${scopedOkouToken(owner, run.runId, ["file:write"])}`,
      { id: fileId, contentType: "text/plain" },
      [200],
    );

    const catalog = await chat.listArtifactCatalog(owner.actor);

    expect(catalog.artifacts).toStrictEqual([
      expect.objectContaining({
        kind: "file",
        title: "workflow-output.txt",
      }),
    ]);
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
    await expect
      .poll(async () => {
        events = await listSharedThreadEventRefs(owner.actor, run.threadId);
        return events.some((event) => {
          return (
            event.eventType === "run.completed" && event.runId === run.runId
          );
        });
      })
      .toBe(true);
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
    chatCallbacks.mockOpenRouterCompletions((body) => {
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
    expect(second.id).not.toBe(first.id);
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
      publicBrand: "okou",
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
      publicBrand: "okou",
    });
    expect(metadata.headers.get("cache-control")).toBe(
      "public, max-age=31536000, s-maxage=31536000, immutable",
    );

    const secondSnapshot = await readSharedThreadSnapshot(second.id);
    expect(secondSnapshot.body).toMatchObject({ publicBrand: "okou" });

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
    expect(afterOrgDeletionResponse.status).toBe(404);
    const afterOrgDeletion = asRecord(await afterOrgDeletionResponse.json());
    expect(asRecord(afterOrgDeletion.error).code).toBe("NOT_FOUND");
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
    chatCallbacks.mockOpenRouterCompletions(() => {
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
