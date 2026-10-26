import { randomUUID } from "node:crypto";

import type { ArtifactSummary } from "@okouai/api-contracts/contracts/artifact-catalog";
import { describe, expect, it } from "vitest";

import { mockOptionalEnv } from "../../../lib/env";
import { testContext } from "../../../__tests__/test-context";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createHostBddApi } from "./helpers/api-bdd-host";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const host = createHostBddApi(context);
const webhooks = createWebhookCallbackApi(context);
type RunnerClaim = Awaited<ReturnType<typeof api.claimRunnerJob>>;

interface ArtifactActor {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
}

async function artifactActor(
  displayName: string,
  actor: ApiTestUser = bdd.user(),
  tier: "pro" | "team" = "pro",
): Promise<ArtifactActor> {
  chatCallbacks.acceptChatObjectStorage();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  chatCallbacks.disableVapid();
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor, { tier });
  // Artifact scenarios claim the chat run through the native Runner; Fable
  // stays off Pi while Sonnet 5 would run API-first.
  await api.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
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
    },
    sandboxHeaders,
    [200],
  );
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
    // Redeploying keeps one site and one alias; each publication still owns an
    // immutable artifact URL and its own thread-artifact row.
    expect(second).toMatchObject({
      publicSlug: site,
      deploymentVersion: 2,
      aliasUrl: second.url,
    });
    expect(second.siteId).toBe(first.siteId);
    expect(second.aliasUrl).toBe(first.aliasUrl);
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

describe("hosted artifacts without a supplied cover", () => {
  it("publishes an artifact in the catalog and its chat thread", async () => {
    const owner = await artifactActor("Hosted publication without a cover");
    const run = await sendChatRun(owner.actor, {
      agentId: owner.agentId,
      prompt: "Publish a site without a supplied cover",
    });
    const { claim, sandboxHeaders } = await claimChatRun(
      owner.runnerGroup,
      run.runId,
    );
    const bearer = `Bearer ${okouTokenFromClaim(claim)}`;
    host.captureHostedSitesS3();
    const site = `optional-cover-${randomUUID().slice(0, 8)}`;
    const prepared = await chat.prepareHostedSiteWithBearer(bearer, {
      site,
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<main>Hosted publication</main>")],
    });
    const completed = await chat.completeHostedSiteWithBearer(
      bearer,
      prepared.deploymentId,
    );
    expect(completed).toMatchObject({ status: "ready", isActive: true });
    const artifact = await findCatalogArtifact(owner.actor, site);
    expect(artifact).toMatchObject({ kind: "hosted-site", thumbnail: null });
    const thread = await chat.listThreadArtifacts(owner.actor, run.threadId);
    expect(thread.runs[0]?.files).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: prepared.artifactUrl,
          aliasUrl: prepared.url,
        }),
      ]),
    );
    await completeChatRunOk(run.runId, sandboxHeaders);
  });
});
