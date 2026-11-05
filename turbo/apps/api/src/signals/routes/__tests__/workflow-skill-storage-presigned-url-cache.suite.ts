import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";
import { mockEnv } from "../../../lib/env";
import { mockNow, now, withMockNowForTest } from "../../../lib/time";
import { createDeferredPromise } from "../../utils";
import { closeS3Clients } from "../../../lib/s3-client";
import { randomUUID } from "node:crypto";
import { getCustomConnectorSkillStorageName } from "@okouai/core/storage-names";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import {
  createRunsApi,
  expectCanonicalStorageManifest,
} from "./helpers/api-bdd-runs";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";

describe("workflow skill storage presigned URL cache", () => {
  const context = testContext();
  const BUCKET = "test-user-storages";

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function mockUniquePresignedUrls(): void {
    let count = 0;
    context.mocks.s3.getSignedUrl.mockImplementation(
      (_client: unknown, command: unknown, options: unknown) => {
        if (!isRecord(options) || typeof options.expiresIn !== "number") {
          throw new Error("Expected a presigned URL expiration");
        }
        count += 1;
        const input = (
          command as { readonly input?: { readonly Key?: string } }
        ).input;
        return Promise.resolve(
          `https://r2.example.com/${encodeURIComponent(input?.Key ?? "unknown")}?sig=${count}&X-Amz-Expires=${options.expiresIn}`,
        );
      },
    );
  }

  async function entitledWorkflowActor(): Promise<{
    readonly actor: ApiTestUser;
    readonly agentId: string;
    readonly runnerGroup: string;
  }> {
    const bdd = createBddApi(context);
    const api = createRunsApi(context);
    createMiscRoutesApi(context);
    const actor = bdd.user();
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    const runnerGroup = api.configureRunnerGroup();
    await api.grantProEntitlement(actor);
    await api.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    });
    const agent = await bdd.createAgent(actor, {
      displayName: "Workflow skill storage cache agent",
      visibility: "private",
    });
    return { actor, agentId: agent.agentId, runnerGroup };
  }

  beforeEach(() => {
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
    // The shared test DB retains disposable global URLs between cases.
    // Give this external signer configuration its own replacement-client lifetime.
    closeS3Clients();
    mockEnv("R2_SECRET_ACCESS_KEY", `bundle-cache-${randomUUID()}`);
    mockUniquePresignedUrls();
  });

  async function workflowCacheFixture() {
    const { actor, agentId, runnerGroup } = await entitledWorkflowActor();
    const misc = createMiscRoutesApi(context);
    const chats = createChatEventsFixture(context);
    installWorkflowVolumeS3Fixture(context);
    const workflow = await misc.createWorkflow(
      actor,
      agentId,
      `cache-${randomUUID().slice(0, 8)}`,
      {
        content: "# Workflow URL test",
        files: [{ path: "reference.md", content: "immutable attachment" }],
      },
      [201],
    );
    if (workflow.status !== 201) {
      throw new Error("Expected a Workflow");
    }
    mockUniquePresignedUrls();
    const claimWorkflow = async () => {
      const run = await chats.sendChatRun(actor, {
        agentId,
        prompt: "Read the immutable Workflow attachment",
      });
      const { claim, sandboxHeaders } = await chats.claimChatRun(
        runnerGroup,
        run.runId,
      );
      await chats.cancelChatRun(actor, run.runId, sandboxHeaders);
      return claim.contentBundles;
    };
    return {
      actor,
      agentId,
      runnerGroup,
      workflow: workflow.body,
      misc,
      chats,
      claimWorkflow,
    };
  }

  it("issues and reuses two-day URLs for ordinary read-only Storage mounts", async () => {
    const { actor, agentId, runnerGroup } = await entitledWorkflowActor();
    if (!actor.orgId) {
      throw new Error("Expected readonly cache test actor to have an org");
    }
    const api = createRunsApi(context);
    context.mocks.s3.send.mockResolvedValue({ ContentLength: 2048 });
    // A custom connector's skill Storage is an ordinary organization-owned
    // read-only mount (readonly_storage scope) of the Agent's runs.
    const connectors = createConnectorBddApi(context);
    const custom = await connectors.createCustomConnector(actor, {
      displayName: "Readonly cache connector",
      prefixTemplates: [
        `https://readonly-cache-${randomUUID().slice(0, 8)}.example.test/api/`,
      ],
      fields: [
        { key: "secret", label: "API token", kind: "secret", required: true },
      ],
      headerInjections: [
        { name: "Authorization", valueTemplate: "Bearer {{secrets.secret}}" },
      ],
      queryInjections: [],
      authMode: "manual",
      skillMarkdown: "Use the readonly cache connector.",
    });
    onTestFinished(async () => {
      await connectors.deleteCustomConnector(actor, custom.id);
    });
    await connectors.updateAgentCustomConnectors(actor, agentId, [custom.id]);
    const volumeName = getCustomConnectorSkillStorageName(custom.id);
    mockUniquePresignedUrls();
    const createAndClaim = async (prompt: string) => {
      const run = await api.createThreadRun(actor, {
        agentId,
        prompt,
      });
      await api.heartbeatRunner(runnerGroup);
      const claim = await api.claimRunnerJob(run.runId);
      const mount = expectCanonicalStorageManifest(
        claim.storageManifest,
      )?.storageMounts.find((entry) => {
        return entry.name === volumeName;
      });
      if (!mount?.archiveUrl) {
        throw new Error("Missing ordinary readonly Storage archive URL");
      }
      expect(mount.mountPath).toBe(
        `/home/user/.claude/skills/custom-${custom.slug.slice(1, 49)}-${custom.id.replaceAll("-", "").slice(0, 8)}`,
      );
      expect(claim.connectorRuntimeTargets).not.toContainEqual(
        expect.objectContaining({
          kind: "custom",
          customConnectorId: custom.id,
        }),
      );
      return { runId: run.runId, archiveUrl: mount.archiveUrl };
    };

    const first = await createAndClaim("request the readonly skill archive");
    expect(new URL(first.archiveUrl).searchParams.get("X-Amz-Expires")).toBe(
      "172800",
    );
    await flushWaitUntilForTest();
    await api.requestCancelRun(actor, first.runId, [200]);
    const second = await createAndClaim("reuse the readonly skill archive");
    expect(second.archiveUrl).toBe(first.archiveUrl);
    await api.requestCancelRun(actor, second.runId, [200]);
  });

  it("reuses complete Content Bundle URLs across claims with unchanged mounts", async () => {
    const { claimWorkflow } = await workflowCacheFixture();
    const first = await claimWorkflow();
    const second = await claimWorkflow();
    expect(second).toStrictEqual(first);
    expect(first.skills).toHaveLength(4);
    expect(first.instructions).toBeDefined();
    for (const bundle of [
      ...first.skills,
      ...(first.instructions ? [first.instructions] : []),
    ]) {
      expect(
        new URL(bundle.downloadUrl).searchParams.get("X-Amz-Expires"),
      ).toBe("172800");
    }
  });

  it.each([44, 49])(
    "refreshes Content Bundle URLs after %i hours without renewing cache hits",
    async (hours) => {
      const startedAt = Math.floor(now() / 1000) * 1000;
      mockNow(startedAt);
      const { claimWorkflow } = await workflowCacheFixture();
      const first = await claimWorkflow();
      mockNow(startedAt + 43 * 60 * 60 * 1000);
      await expect(claimWorkflow()).resolves.toStrictEqual(first);
      mockNow(startedAt + hours * 60 * 60 * 1000 + 1000);
      const fresh = await claimWorkflow();
      expect(
        fresh.skills.map((bundle) => {
          return bundle.sha256;
        }),
      ).toStrictEqual(
        first.skills.map((bundle) => {
          return bundle.sha256;
        }),
      );
      expect(fresh.skills[0]?.downloadUrl).not.toBe(
        first.skills[0]?.downloadUrl,
      );
      expect(fresh.instructions?.downloadUrl).not.toBe(
        first.instructions?.downloadUrl,
      );
    },
  );

  it("uses the replacement signer's credentials and endpoint instead of cached old URLs", async () => {
    const { claimWorkflow } = await workflowCacheFixture();
    const first = await claimWorkflow();
    // Model replacement API instances: configuration is fixed for a client lifetime.
    closeS3Clients();
    mockEnv("R2_SECRET_ACCESS_KEY", "rotated-content-bundle-secret");
    const rotatedCredentials = await claimWorkflow();
    expect(rotatedCredentials.skills[0]?.sha256).toBe(first.skills[0]?.sha256);
    expect(rotatedCredentials.skills[0]?.downloadUrl).not.toBe(
      first.skills[0]?.downloadUrl,
    );
    closeS3Clients();
    mockEnv("S3_ENDPOINT", "https://replacement-r2.example.com");
    const rotatedEndpoint = await claimWorkflow();
    expect(rotatedEndpoint.skills[0]?.sha256).toBe(first.skills[0]?.sha256);
    expect(rotatedEndpoint.skills[0]?.downloadUrl).not.toBe(
      rotatedCredentials.skills[0]?.downloadUrl,
    );
    await expect(claimWorkflow()).resolves.toStrictEqual(rotatedEndpoint);
  });

  it("selects an updated Workflow at claim even when its previous package URL is cached", async () => {
    const {
      actor,
      agentId,
      runnerGroup,
      workflow,
      misc,
      chats,
      claimWorkflow,
    } = await workflowCacheFixture();
    const cached = await claimWorkflow();
    const queued = await chats.sendChatRun(actor, {
      agentId,
      prompt: "use the latest Workflow",
    });
    await misc.updateWorkflow(
      actor,
      workflow.id,
      "# Updated Workflow package",
      [200],
    );
    const { claim, sandboxHeaders } = await chats.claimChatRun(
      runnerGroup,
      queued.runId,
    );
    expect(claim.contentBundles.skills[0]?.mountPath).toBe(
      cached.skills[0]?.mountPath,
    );
    expect(claim.contentBundles.skills[0]?.sha256).not.toBe(
      cached.skills[0]?.sha256,
    );
    expect(claim.contentBundles.skills[0]?.downloadUrl).not.toBe(
      cached.skills[0]?.downloadUrl,
    );
    await chats.cancelChatRun(actor, queued.runId, sandboxHeaders);
    await expect(claimWorkflow()).resolves.toStrictEqual(claim.contentBundles);
  });

  it("preserves signing failure and allows a later successful claim to populate reusable URLs", async () => {
    const { actor, agentId, runnerGroup, chats, claimWorkflow } =
      await workflowCacheFixture();
    const api = createRunsApi(context);
    const run = await chats.sendChatRun(actor, {
      agentId,
      prompt: "a cold signing failure",
    });
    await api.heartbeatRunner(runnerGroup);
    context.mocks.s3.getSignedUrl.mockRejectedValueOnce(
      new Error("Fixture signer unavailable"),
    );
    await api.requestClaimRunnerJob(true, run.runId, [500]);
    expect((await api.readRun(actor, run.runId)).status).toBe("running");
    await api.requestCancelRun(actor, run.runId, [200]);
    const successful = await claimWorkflow();
    await expect(claimWorkflow()).resolves.toStrictEqual(successful);
  });

  it("retains the newer URL when an older cold signer publishes last", async () => {
    const { actor, agentId, runnerGroup, chats, claimWorkflow } =
      await workflowCacheFixture();
    const api = createRunsApi(context);
    const startedAt = Math.floor(now() / 1000) * 1000;
    const oldRun = await chats.sendChatRun(actor, {
      agentId,
      prompt: "older cache publisher",
    });
    await api.heartbeatRunner(runnerGroup);
    const started = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    const sign = context.mocks.s3.getSignedUrl.getMockImplementation();
    if (!sign) {
      throw new Error("Expected the external presigner fixture");
    }
    context.mocks.s3.getSignedUrl.mockImplementationOnce(async (...args) => {
      started.resolve();
      await release.promise;
      return await sign(...args);
    });
    const oldClaim = withMockNowForTest(startedAt, () => {
      return api.claimRunnerJob(oldRun.runId);
    });
    onTestFinished(async () => {
      if (!release.settled()) {
        release.resolve();
      }
      await oldClaim;
    });
    await started.promise;
    const newer = await withMockNowForTest(startedAt + 1000, claimWorkflow);
    release.resolve();
    const older = await oldClaim;
    await chats.cancelChatRun(actor, oldRun.runId, {
      authorization: `Bearer ${older.sandboxToken}`,
    });
    expect(older.contentBundles.instructions?.downloadUrl).not.toBe(
      newer.instructions?.downloadUrl,
    );
    const reused = await withMockNowForTest(startedAt + 2000, claimWorkflow);
    expect(reused.instructions?.downloadUrl).toBe(
      newer.instructions?.downloadUrl,
    );
  });
});
