import { mockEnv } from "../../../lib/env";
import { randomUUID } from "node:crypto";
import type {
  TestWorkflowSkillStoragePresignedUrlCacheStateActionBody,
  TestWorkflowSkillStoragePresignedUrlCacheStateActionResponse,
} from "@okouai/api-contracts/contracts/test-workflow-skill-storage-presigned-url-cache-state";
import {
  getCustomSkillStorageName,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { beforeEach, describe, expect, it } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { testContext } from "../../../__tests__/test-context";
import { readStorageS3PrefixFixture } from "../../../test-fixtures/storage";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import {
  createRunsApi,
  expectCanonicalStorageManifest,
} from "./helpers/api-bdd-runs";
import { storageTextFile } from "./helpers/api-bdd-storage-files";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
import { testWorkflowSkillStoragePresignedUrlCacheStateRoutes } from "../test-workflow-skill-storage-presigned-url-cache-state";

const context = testContext();
const BUCKET = "test-user-storages";

interface CacheRow {
  readonly cache_key: string;
  readonly bucket: string;
  readonly object_key: string;
  readonly storage_version_id: string;
  readonly resolved_org_id: string;
  readonly public_endpoint: boolean;
  readonly ttl_seconds: number;
  readonly presigned_url: string;
  readonly expires_at: string;
  readonly refresh_after: string;
  readonly last_requested_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stateRequest(
  body: TestWorkflowSkillStoragePresignedUrlCacheStateActionBody,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testWorkflowSkillStoragePresignedUrlCacheStateRoutes,
  });
  return Promise.resolve(
    app.request(
      "/api/test/workflow-skill-storage-presigned-url-cache-state/action",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  );
}

async function stateAction(
  body: TestWorkflowSkillStoragePresignedUrlCacheStateActionBody,
): Promise<TestWorkflowSkillStoragePresignedUrlCacheStateActionResponse> {
  const response = await stateRequest(body);
  if (!response.ok) {
    throw new Error(`Workflow cache state action ${body.action} failed`);
  }
  return (await response.json()) as TestWorkflowSkillStoragePresignedUrlCacheStateActionResponse;
}

type CacheScope = "workflow_skill_storage" | "readonly_storage";

async function cleanupCacheState(
  objectKeyPrefix: string,
  scope?: CacheScope,
): Promise<void> {
  await stateAction({
    action: "cleanup",
    object_key_prefix: objectKeyPrefix,
    ...(scope ? { scope } : {}),
  });
}

async function withCacheCleanup(
  objectKeyPrefix: string,
  run: () => Promise<void>,
  scope?: CacheScope,
): Promise<void> {
  await cleanupCacheState(objectKeyPrefix, scope);
  await run().then(
    async () => {
      await cleanupCacheState(objectKeyPrefix, scope);
    },
    async (error: unknown) => {
      await cleanupCacheState(objectKeyPrefix, scope);
      throw error;
    },
  );
}

async function readCacheRowsByObjectKeyPrefix(
  objectKeyPrefix: string,
  scope?: CacheScope,
): Promise<readonly CacheRow[]> {
  const response = await stateAction({
    action: "read-cache-by-object-key-prefix",
    object_key_prefix: objectKeyPrefix,
    ...(scope ? { scope } : {}),
  });
  return response.rows ?? [];
}

function mockUniquePresignedUrls(): void {
  let count = 0;
  context.mocks.s3.getSignedUrl.mockImplementation(
    (_client: unknown, command: unknown, options: unknown) => {
      if (!isRecord(options) || typeof options.expiresIn !== "number") {
        throw new Error("Expected a presigned URL expiration");
      }
      count += 1;
      const input = (command as { readonly input?: { readonly Key?: string } })
        .input;
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
  await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Workflow skill storage cache agent",
    visibility: "private",
  });
  return { actor, agentId: agent.agentId, runnerGroup };
}

async function createWorkflowSkillRunFixture(): Promise<{
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly workflowId: string;
  readonly workflowName: string;
  readonly storageName: string;
  readonly objectKeyPrefix: string;
}> {
  const { actor, agentId, runnerGroup } = await entitledWorkflowActor();
  const workflowName = `cache-${randomUUID().slice(0, 8)}`;
  const misc = createMiscRoutesApi(context);
  const workflow = await misc.createWorkflow(
    actor,
    agentId,
    workflowName,
    {
      content: "# Cache test workflow\nUse this workflow for cache tests.",
    },
    [201],
  );
  if (workflow.status !== 201) {
    throw new Error("Expected workflow creation to succeed");
  }
  const workflowId = workflow.body.id;
  const storageName = getCustomSkillStorageName(workflowId);
  if (!actor.orgId) {
    throw new Error("Expected workflow cache test actor to have an org");
  }
  const objectKeyPrefix = await readStorageS3PrefixFixture({
    orgId: actor.orgId,
    userId: VOLUME_ORG_USER_ID,
    name: storageName,
  });
  return {
    actor,
    agentId,
    runnerGroup,
    workflowId,
    workflowName,
    storageName,
    objectKeyPrefix,
  };
}

async function createRunAndClaimWorkflowSkill(args: {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly storageName: string;
  readonly prompt: string;
}): Promise<{
  readonly runId: string;
  readonly archiveUrl: string;
  readonly versionId: string;
}> {
  const api = createRunsApi(context);
  const run = await api.createRun(args.actor, {
    agentId: args.agentId,
    prompt: args.prompt,
    modelProvider: "anthropic-api-key",
  });
  await api.heartbeatRunner(args.runnerGroup);
  const claim = await api.claimRunnerJob(run.runId);
  const entry = expectCanonicalStorageManifest(
    claim.storageManifest,
  )?.storageMounts.find((storage) => {
    return storage.name === args.storageName;
  });
  if (!entry?.archiveUrl) {
    throw new Error(
      `Missing workflow skill manifest entry ${args.storageName}`,
    );
  }
  return {
    runId: run.runId,
    archiveUrl: entry.archiveUrl,
    versionId: entry.versionId,
  };
}

beforeEach(() => {
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
  mockUniquePresignedUrls();
});

describe("workflow skill storage presigned URL cache", () => {
  it("issues and reuses two-day URLs for ordinary read-only Storage mounts", async () => {
    const { actor, runnerGroup } = await entitledWorkflowActor();
    if (!actor.orgId) {
      throw new Error("Expected readonly cache test actor to have an org");
    }
    const api = createRunsApi(context);
    const storages = createStoragesBddApi(context);
    storages.mockStorageObjectsExist(2048);
    const volumeName = `readonly-cache-${randomUUID().slice(0, 8)}`;
    const file = storageTextFile("payload.txt", "readonly cache payload");
    const prepared = await storages.prepareStorage(actor, {
      storageName: volumeName,
      storageOwner: "organization",
      files: [file],
    });
    await storages.commitStorage(actor, {
      storageName: volumeName,
      storageOwner: "organization",
      versionId: prepared.versionId,
      files: [file],
    });
    const compose = await api.createDirectAgent(actor, {
      version: "1",
      agents: {
        cache: {
          framework: "claude-code",
          environment: { ANTHROPIC_API_KEY: "readonly-cache-key" },
          volumes: ["data:/data"],
        },
      },
      volumes: { data: { name: volumeName, version: prepared.versionId } },
    });
    const objectKeyPrefix = await readStorageS3PrefixFixture({
      orgId: actor.orgId,
      userId: VOLUME_ORG_USER_ID,
      name: volumeName,
    });

    await withCacheCleanup(
      objectKeyPrefix,
      async () => {
        mockUniquePresignedUrls();
        const createAndClaim = async (prompt: string) => {
          const run = await api.createDirectRun(actor, {
            agentId: compose.agentId,
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
          return { runId: run.runId, archiveUrl: mount.archiveUrl };
        };

        const first = await createAndClaim("warm ordinary readonly DB cache");
        expect(
          new URL(first.archiveUrl).searchParams.get("X-Amz-Expires"),
        ).toBe("172800");
        const rows = await readCacheRowsByObjectKeyPrefix(
          objectKeyPrefix,
          "readonly_storage",
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          resolved_org_id: actor.orgId,
          storage_version_id: prepared.versionId,
          ttl_seconds: 2 * 24 * 60 * 60,
          presigned_url: first.archiveUrl,
        });
        await api.requestCancelRun(actor, first.runId, [200]);

        const second = await createAndClaim("reuse ordinary readonly DB cache");
        expect(second.archiveUrl).toBe(first.archiveUrl);
        await api.requestCancelRun(actor, second.runId, [200]);
      },
      "readonly_storage",
    );
  });

  it("reuses cached workflow skill storage URLs", async () => {
    const fixture = await createWorkflowSkillRunFixture();
    await withCacheCleanup(fixture.objectKeyPrefix, async () => {
      mockUniquePresignedUrls();
      const first = await createRunAndClaimWorkflowSkill({
        ...fixture,
        prompt: "warm the workflow skill URL cache",
      });

      const rowsAfterFirst = await readCacheRowsByObjectKeyPrefix(
        fixture.objectKeyPrefix,
      );
      expect(rowsAfterFirst).toHaveLength(1);
      const rowAfterFirst = rowsAfterFirst[0];
      if (!rowAfterFirst) {
        throw new Error("Expected workflow skill cache row");
      }
      expect(rowAfterFirst).toMatchObject({
        bucket: BUCKET,
        resolved_org_id: fixture.actor.orgId,
        storage_version_id: first.versionId,
        presigned_url: first.archiveUrl,
      });

      const api = createRunsApi(context);
      await api.requestCancelRun(fixture.actor, first.runId, [200]);

      const second = await createRunAndClaimWorkflowSkill({
        ...fixture,
        prompt: "reuse the workflow skill URL cache",
      });
      expect(second.archiveUrl).toBe(first.archiveUrl);
      await api.requestCancelRun(fixture.actor, second.runId, [200]);
    });
  });
});
