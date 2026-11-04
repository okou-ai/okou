import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";
import { mockEnv } from "../../../lib/env";
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
    mockUniquePresignedUrls();
  });

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

  it("signs each claim's complete Workflow bundle independently of the Storage URL cache", async () => {
    const { actor, agentId, runnerGroup } = await entitledWorkflowActor();
    const misc = createMiscRoutesApi(context);
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
    const { sendChatRun, claimChatRun, cancelChatRun } =
      createChatEventsFixture(context);
    const claimWorkflow = async () => {
      const run = await sendChatRun(actor, {
        agentId,
        prompt: "Read the immutable Workflow attachment",
      });
      const { claim, sandboxHeaders } = await claimChatRun(
        runnerGroup,
        run.runId,
      );
      const bundle = claim.contentBundles.skills[0];
      if (!bundle) {
        throw new Error("Expected a Workflow content bundle");
      }
      await cancelChatRun(actor, run.runId, sandboxHeaders);
      return bundle;
    };
    const first = await claimWorkflow();
    const second = await claimWorkflow();
    expect(second.sha256).toBe(first.sha256);
    expect(new URL(second.downloadUrl).pathname).toBe(
      new URL(first.downloadUrl).pathname,
    );
    expect(second.downloadUrl).not.toBe(first.downloadUrl);
  });
});
