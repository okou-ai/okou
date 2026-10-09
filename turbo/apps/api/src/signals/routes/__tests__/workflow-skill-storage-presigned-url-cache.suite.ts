import { mockEnv } from "../../../lib/env";
import { randomUUID } from "node:crypto";
import {
  getCustomConnectorSkillStorageName,
  getCustomSkillStorageName,
} from "@okouai/core/storage-names";
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
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
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

  async function createWorkflowSkillRunFixture(): Promise<{
    readonly actor: ApiTestUser;
    readonly agentId: string;
    readonly runnerGroup: string;
    readonly workflowId: string;
    readonly workflowName: string;
    readonly storageName: string;
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
    return {
      actor,
      agentId,
      runnerGroup,
      workflowId,
      workflowName,
      storageName,
    };
  }

  async function createRunAndClaimStorageSkill(args: {
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
    const { sendChatRun, claimChatRun, cancelChatRun } =
      createChatEventsFixture(context);
    const run = await sendChatRun(args.actor, {
      agentId: args.agentId,
      prompt: args.prompt,
    });
    const { claim, sandboxHeaders } = await claimChatRun(
      args.runnerGroup,
      run.runId,
    );
    const entry = expectCanonicalStorageManifest(
      claim.storageManifest,
    )?.storageMounts.find((storage) => {
      return storage.name === args.storageName;
    });
    if (!entry?.archiveUrl) {
      throw new Error(
        `Missing storage skill manifest entry ${args.storageName}`,
      );
    }
    await cancelChatRun(args.actor, run.runId, sandboxHeaders);
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

  it("issues and reuses two-day URLs for ordinary read-only Storage mounts", async () => {
    const { actor, agentId, runnerGroup } = await entitledWorkflowActor();
    if (!actor.orgId) {
      throw new Error("Expected readonly cache test actor to have an org");
    }
    const api = createRunsApi(context);
    const storages = createStoragesBddApi(context);
    storages.mockStorageObjectsExist(2048);
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

  it("reuses cached workflow skill storage URLs", async () => {
    const fixture = await createWorkflowSkillRunFixture();
    mockUniquePresignedUrls();
    const first = await createRunAndClaimStorageSkill({
      ...fixture,
      prompt: "warm the workflow skill URL cache",
    });

    const second = await createRunAndClaimStorageSkill({
      ...fixture,
      prompt: "reuse the workflow skill URL cache",
    });
    expect(second.archiveUrl).toBe(first.archiveUrl);
  });
});
