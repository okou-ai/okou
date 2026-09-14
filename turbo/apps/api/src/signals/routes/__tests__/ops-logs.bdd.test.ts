import { createHash, createHmac, randomUUID } from "node:crypto";
import { gzipSync, zstdCompressSync } from "node:zlib";
import AdmZip from "adm-zip";
import { afterEach, describe, expect, it } from "vitest";
import type {
  GenerationTemplateRequest,
  UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { agentInstructionsContract } from "@okouai/api-contracts/contracts/agents";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@okouai/core";
import { env } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import { testContext, accept } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createOpsLogsApi } from "./helpers/api-bdd-ops-logs";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { commitMemoryVersion } from "./helpers/memory";
import { createFixtureTracker } from "./helpers/route-test";
import { agentInstructionsRoutes } from "../agent-instructions";
import { seedPiMemoryPhase2ExportJobFixture } from "../../../test-fixtures/pi-memory-stage1-candidates";
import {
  readUserExportJobFixture,
  seedLegacyUserExportJobFixture,
} from "../../../test-fixtures/user-export";

/* OPS-01 user export. */

const HOUR_MS = 60 * 60_000;

interface DeferredS3Put {
  readonly resolve: () => void;
}

const context = testContext();
const trackDeferredS3Put = createFixtureTracker<DeferredS3Put>((pendingPut) => {
  pendingPut.resolve();
  return Promise.resolve();
});

afterEach(() => {
  clearMockNow();
});

async function entitledRunActor(): Promise<{
  readonly actor: ApiTestUser;
  readonly agentId: string;
}> {
  const bdd = createBddApi(context);
  const api = createRunsApi(context);
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  createMiscRoutesApi(context);
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "BDD ops-logs agent",
    description: "Exercises user export flows.",
    visibility: "private",
  });
  return { actor, agentId: agent.agentId };
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

function exportDownloadDispositions(exportKey: string): string[] {
  return context.mocks.s3.getSignedUrl.mock.calls
    .map(([, command]) => {
      return commandInput(command);
    })
    .filter((input) => {
      return input.Key === exportKey;
    })
    .map((input) => {
      return input.ResponseContentDisposition;
    })
    .filter((disposition): disposition is string => {
      return typeof disposition === "string";
    });
}

function exportZip(exportKey: string): AdmZip {
  const putInput = context.mocks.s3.send.mock.calls
    .map(([command]) => {
      return commandInput(command);
    })
    .find((input) => {
      return input.Key === exportKey;
    });

  const body = putInput?.Body;
  if (!Buffer.isBuffer(body)) {
    throw new Error(`Expected export ZIP upload for ${exportKey}`);
  }
  return new AdmZip(body);
}

function zipEntryNames(zip: AdmZip): string[] {
  return zip.getEntries().map((entry) => {
    return entry.entryName;
  });
}

function zipText(zip: AdmZip, name: string): string {
  const entry = zip.getEntry(name);
  if (!entry) {
    throw new Error(`Expected ZIP entry ${name}`);
  }
  return entry.getData().toString("utf8");
}

function zipBytes(zip: AdmZip, name: string): Buffer {
  const entry = zip.getEntry(name);
  if (!entry) {
    throw new Error(`Expected ZIP entry ${name}`);
  }
  return entry.getData();
}

function singleZipEntry(
  names: readonly string[],
  predicate: (name: string) => boolean,
): string {
  const matches = names.filter(predicate);
  expect(matches).toHaveLength(1);
  const [match] = matches;
  if (!match) {
    throw new Error("Expected one ZIP entry match");
  }
  return match;
}

const TAR_BLOCK_SIZE = 512;

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

function createTarEntry(filename: string, content: Buffer): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  header.write(filename, 0, 100, "utf8");
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(octal(content.length, 12), 124);
  header.write(octal(0, 12), 136);
  header.write("        ", 148);
  header.write("0", 156);

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);

  const padding = content.length % TAR_BLOCK_SIZE;
  const data =
    padding === 0
      ? content
      : Buffer.concat([content, Buffer.alloc(TAR_BLOCK_SIZE - padding)]);
  return Buffer.concat([header, data]);
}

function createTarGz(
  files: readonly { readonly path: string; readonly content: string }[],
): Buffer {
  return gzipSync(
    Buffer.concat([
      ...files.map((file) => {
        return createTarEntry(file.path, Buffer.from(file.content, "utf8"));
      }),
      Buffer.alloc(TAR_BLOCK_SIZE * 2),
    ]),
  );
}

function putMemoryArchive(
  misc: ReturnType<typeof createMiscRoutesApi>,
  s3Key: string,
  files: readonly { readonly path: string; readonly content: string }[],
): void {
  const manifestFiles = files.map((file) => {
    return {
      path: file.path,
      hash: `bdd-${file.path}`,
      size: Buffer.byteLength(file.content, "utf8"),
    };
  });
  misc.putS3Object(
    `${s3Key}/manifest.json`,
    JSON.stringify({
      version: "bdd-memory",
      createdAt: new Date(0).toISOString(),
      files: manifestFiles,
      totalSize: manifestFiles.reduce((sum, file) => {
        return sum + file.size;
      }, 0),
      fileCount: manifestFiles.length,
    }),
  );
  misc.putS3Object(`${s3Key}/archive.tar.gz`, createTarGz(files));
}

function unsubscribeToken(userId: string): string {
  const signature = createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(`unsubscribe:${userId}`)
    .digest("hex")
    .slice(0, 32);
  return `${userId}.${signature}`;
}

async function waitForUserExportJobStatus(
  api: ReturnType<typeof createOpsLogsApi>,
  actor: ApiTestUser,
  jobId: string,
  status: "completed" | "failed",
) {
  await flushWaitUntilForTest();
  const response = await api.requestGetUserExport(actor, [200]);
  if (!("job" in response.body)) {
    throw new Error(`Expected user export job ${jobId} to become ${status}`);
  }
  expect(response.body.job).toMatchObject({ id: jobId, status });
  return response.body;
}

describe("OPS-01: user data export", () => {
  it("rejects unauthenticated and org-less export requests", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    const expectedError = {
      error: { code: "UNAUTHORIZED", message: "Not authenticated" },
    };

    const getUnauthenticated = await api.requestGetUserExport(null, [401]);
    expect(getUnauthenticated.body).toStrictEqual(expectedError);

    const postUnauthenticated = await api.requestPostUserExport(null, [401]);
    expect(postUnauthenticated.body).toStrictEqual(expectedError);

    const orgless = await api.requestPostUserExport(
      bdd.user({ orgId: null }),
      [401],
    );
    expect(orgless.body).toStrictEqual(expectedError);
  });

  it("exports user data end to end with active, cooldown, refresh, and latest-job visibility", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    const actor = bdd.user();
    const exportStartAt = Date.UTC(2026, 4, 12, 5);
    const downloadUrl = "https://r2.example.com/bdd-export.zip?sig=test";

    mockNow(exportStartAt);
    const before = await api.requestGetUserExport(actor, [200]);
    expect(before.body).toStrictEqual({
      job: null,
      canExport: true,
      nextExportAt: null,
    });

    context.mocks.s3.getSignedUrl.mockResolvedValue(downloadUrl);
    const pendingPut = await trackDeferredS3Put(
      Promise.resolve(api.deferS3PutOnce()),
    );

    const started = await api.requestPostUserExport(actor, [202]);
    expect(started.body.status).toBe("pending");
    const jobId = started.body.jobId;
    const exportKey = `exports/${actor.userId}/${jobId}.zip`;

    const reposted = await api.requestPostUserExport(actor, [202]);
    expect(reposted.body.jobId).toBe(jobId);
    expect(["pending", "running"]).toContain(reposted.body.status);

    const active = await api.requestGetUserExport(actor, [200]);
    expect(active.body.job?.id).toBe(jobId);
    expect(["pending", "running"]).toContain(active.body.job?.status);
    expect(active.body.job?.downloadUrl).toBeNull();
    expect(active.body.canExport).toBeFalsy();
    expect(active.body.nextExportAt).toBeNull();

    pendingPut.resolve();

    const completed = await waitForUserExportJobStatus(
      api,
      actor,
      jobId,
      "completed",
    );
    expect(completed).toStrictEqual({
      job: {
        id: jobId,
        status: "completed",
        createdAt: new Date(exportStartAt).toISOString(),
        completedAt: new Date(exportStartAt).toISOString(),
        expiresAt: new Date(exportStartAt + 48 * HOUR_MS).toISOString(),
        downloadUrl,
        error: null,
      },
      canExport: false,
      nextExportAt: new Date(exportStartAt + 24 * HOUR_MS).toISOString(),
    });

    expect(exportDownloadDispositions(exportKey)).toStrictEqual([
      'attachment; filename="okou-data-export.zip"',
      'attachment; filename="okou-data-export.zip"',
    ]);

    const putInput = context.mocks.s3.send.mock.calls
      .map(([command]) => {
        return commandInput(command);
      })
      .find((input) => {
        return input.Key === exportKey;
      });
    expect(putInput).toMatchObject({
      Bucket: "test-user-storages",
      ContentType: "application/zip",
    });
    expect(putInput?.Body).toBeInstanceOf(Buffer);

    const limited = await api.requestPostUserExport(actor, [429]);
    expect(limited.body).toStrictEqual({
      error: {
        code: "RATE_LIMITED",
        message: "Export already completed within the last 24 hours",
      },
    });

    const expiredReadAt = exportStartAt + 49 * HOUR_MS;
    mockNow(expiredReadAt);
    const signedUrlCalls = context.mocks.s3.getSignedUrl.mock.calls.length;
    const expired = await api.requestGetUserExport(actor, [200]);
    expect(expired.body.job?.id).toBe(jobId);
    expect(expired.body.job?.downloadUrl).toBeNull();
    expect(expired.body.canExport).toBeTruthy();
    expect(expired.body.nextExportAt).toBeNull();
    expect(context.mocks.s3.getSignedUrl.mock.calls).toHaveLength(
      signedUrlCalls,
    );

    // auth-me refreshes the user email cache at the mocked time, so the
    // second export execution reads the fresh-cache arm instead of Clerk.
    await bdd.readMe(actor);
    context.mocks.s3.send.mockResolvedValue({});
    const restarted = await api.requestPostUserExport(actor, [202]);
    expect(restarted.body.jobId).not.toBe(jobId);

    const latest = await waitForUserExportJobStatus(
      api,
      actor,
      restarted.body.jobId,
      "completed",
    );
    expect(latest.job).toStrictEqual({
      id: restarted.body.jobId,
      status: "completed",
      createdAt: new Date(expiredReadAt).toISOString(),
      completedAt: new Date(expiredReadAt).toISOString(),
      expiresAt: new Date(expiredReadAt + 48 * HOUR_MS).toISOString(),
      downloadUrl,
      error: null,
    });

    const peer = bdd.user();
    const peerStatus = await api.requestGetUserExport(peer, [200]);
    expect(peerStatus.body).toStrictEqual({
      job: null,
      canExport: true,
      nextExportAt: null,
    });
  });

  it("downloads a historical export with the Okou filename without rewriting its row", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    const actor = bdd.user();
    const downloadUrl = "https://r2.example.com/bdd-okou-export.zip?sig=test";

    context.mocks.s3.getSignedUrl.mockResolvedValue(downloadUrl);
    context.mocks.s3.send.mockResolvedValue({});

    const started = await api.requestPostUserExport(actor, [202]);
    const exportKey = `exports/${actor.userId}/${started.body.jobId}.zip`;
    await waitForUserExportJobStatus(
      api,
      actor,
      started.body.jobId,
      "completed",
    );

    // The public API no longer creates VM0 exports. Seed the completed,
    // test-owned row to exercise a download from before the brand cutover.
    const historicalJob = await seedLegacyUserExportJobFixture(
      actor.userId,
      started.body.jobId,
    );
    const downloaded = await api.requestGetUserExport(actor, [200]);
    expect(downloaded.body.job).toMatchObject({
      id: started.body.jobId,
      status: "completed",
      downloadUrl,
    });
    expect(exportDownloadDispositions(exportKey)).toStrictEqual([
      'attachment; filename="okou-data-export.zip"',
      'attachment; filename="okou-data-export.zip"',
      'attachment; filename="okou-data-export.zip"',
    ]);
    await expect(
      readUserExportJobFixture(actor.userId, started.body.jobId),
    ).resolves.toStrictEqual(historicalJob);
  });

  it("exports the userMessage projection", async () => {
    const api = createOpsLogsApi(context);
    const chat = createChatFilesBddApi(context);
    const { actor, agentId } = await entitledRunActor();
    const style = ILLUSTRATION_TEMPLATE_ITEMS[0];
    if (!style) {
      throw new Error("Expected a registered illustration style");
    }
    const generationTemplate: GenerationTemplateRequest = {
      type: "illustration",
      selection: { illustrationStyleId: style.illustrationStyleId },
    };
    const userMessage: UserMessageInputDocument = {
      version: 1,
      parts: [
        {
          type: "template",
          titleSnapshot: style.title,
          template: generationTemplate,
        },
        { type: "text", text: "Export the structured request" },
      ],
    };
    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt: "stale export content",
        userMessage,
      },
      [201],
    );
    if (sent.status !== 201) {
      throw new Error("Expected the structured message send to succeed");
    }

    const exportStartAt = Date.UTC(2026, 4, 12, 5, 30);
    mockNow(exportStartAt);
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/bdd-structured-export.zip?sig=test",
    );
    const started = await api.requestPostUserExport(actor, [202]);
    const exportKey = `exports/${actor.userId}/${started.body.jobId}.zip`;
    await waitForUserExportJobStatus(
      api,
      actor,
      started.body.jobId,
      "completed",
    );

    const messages = JSON.parse(
      zipText(
        exportZip(exportKey),
        `conversations/chat-thread-${sent.body.threadId}.json`,
      ),
    ) as {
      readonly role: string;
      readonly content: string;
      readonly userMessage?: UserMessageInputDocument;
    }[];
    expect(messages[0]).toMatchObject({
      role: "user",
      // Templates render inline in the text flow rather than as their own block.
      content: `[Template: ${style.title}]Export the structured request`,
      userMessage,
    });
    expect(messages[0]?.content).not.toContain("stale export content");
  });

  it("exports only safe agent, workflow, and memory control-plane data", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    const misc = createMiscRoutesApi(context);
    const actor = bdd.user();
    const exportStartAt = Date.UTC(2026, 4, 12, 5);
    const downloadUrl =
      "https://r2.example.com/bdd-export-content.zip?sig=test";
    if (!actor.orgId) {
      throw new Error("Expected export test actor to have an org");
    }

    const agent = await bdd.createAgent(actor, {
      displayName: "BDD Export Agent",
      visibility: "private",
    });
    await accept(
      setupApp({ context, routes: agentInstructionsRoutes })(
        agentInstructionsContract,
      ).update({
        params: { id: agent.agentId },
        headers: { authorization: "Bearer clerk-session" },
        body: { content: "Use the exported agent instructions." },
      }),
      [200],
    );

    const workflow = await misc.createWorkflow(
      actor,
      agent.agentId,
      "bdd-export-workflow",
      {
        content: "Use the exported workflow instructions.",
        files: [
          {
            path: "notes/checklist.md",
            content: "Workflow supporting file",
          },
        ],
      },
      [201],
    );
    expect("id" in workflow.body).toBeTruthy();
    if (!("id" in workflow.body)) {
      throw new Error("Expected workflow creation to return a workflow id");
    }
    const workflowId = workflow.body.id;
    const memoryFiles = [
      { path: "MEMORY.md", content: "# Exported memory" },
      {
        path: "notes/profile.md",
        content: "Memory supporting note",
      },
    ];
    // Create the memory artifact head version through the product storage
    // upload flow, then place the mocked archive at the S3 key the product
    // assigned to it.
    createStoragesBddApi(context).mockStoragePresignedUrls();
    const memory = await commitMemoryVersion(context, actor, memoryFiles);
    putMemoryArchive(misc, memory.s3Key, memoryFiles);
    const phase2Secrets = await seedPiMemoryPhase2ExportJobFixture({
      memoryStorageId: memory.storageId,
      orgId: actor.orgId,
      userId: actor.userId,
      currentTime: new Date(exportStartAt),
    });

    mockNow(exportStartAt);
    context.mocks.s3.getSignedUrl.mockResolvedValue(downloadUrl);
    const started = await api.requestPostUserExport(actor, [202]);
    const jobId = started.body.jobId;
    const exportKey = `exports/${actor.userId}/${jobId}.zip`;

    await waitForUserExportJobStatus(api, actor, jobId, "completed");
    const zip = exportZip(exportKey);
    const names = zipEntryNames(zip);

    const agentClaude = singleZipEntry(names, (name) => {
      return name.startsWith("agents/") && name.endsWith("/CLAUDE.md");
    });
    const agentCodex = singleZipEntry(names, (name) => {
      return name.startsWith("agents/") && name.endsWith("/AGENTS.md");
    });
    expect(zipText(zip, agentClaude)).toContain(
      "Use the exported agent instructions.",
    );
    expect(zipText(zip, agentCodex)).toContain(
      "Use the exported agent instructions.",
    );

    const workflowPrefix = `workflows/bdd-export-workflow-${workflowId}/`;
    const workflowSkill = singleZipEntry(names, (name) => {
      return name.startsWith(workflowPrefix) && name.endsWith("/SKILL.md");
    });
    const workflowNote = `${workflowPrefix}notes/checklist.md`;
    expect(zipText(zip, workflowSkill)).toContain(
      "Use the exported workflow instructions.",
    );
    expect(zipText(zip, workflowNote)).toBe("Workflow supporting file");
    expect(zipText(zip, `memory/${actor.orgId}/MEMORY.md`)).toBe(
      "# Exported memory",
    );
    expect(zipText(zip, `memory/${actor.orgId}/notes/profile.md`)).toBe(
      "Memory supporting note",
    );
    const phase2JobsText = zipText(zip, "memory/phase2-jobs.json");
    const phase2Jobs = JSON.parse(phase2JobsText) as readonly Record<
      string,
      unknown
    >[];
    expect(phase2Jobs).toStrictEqual([
      {
        memoryStorageId: memory.storageId,
        orgId: actor.orgId,
        userId: actor.userId,
        status: "leased",
        inputRevision: 2,
        completedRevision: 0,
        reconciliationRevision: 0,
        claimedRevision: 1,
        claimedBaseVersionId: memory.versionId,
        leaseExpiresAt: new Date(exportStartAt + 60 * 60 * 1000).toISOString(),
        retryCount: 1,
        retryAt: null,
        lastErrorClass: null,
        lastSucceededAt: new Date(
          exportStartAt - 24 * 60 * 60 * 1000,
        ).toISOString(),
        claimedSelectedCount: 1,
        claimedSelectedUtf8Bytes: 42,
        lastObservedHeadVersionId: memory.versionId,
        conflictCount: 0,
        lastConflictAt: null,
        lastConflictingHeadVersionId: null,
        lastPublishedVersionId: null,
        lastPublishedAt: null,
        createdAt: new Date(exportStartAt - 2 * 60 * 60 * 1000).toISOString(),
        updatedAt: new Date(exportStartAt).toISOString(),
      },
    ]);
    expect(phase2JobsText).not.toContain(phase2Secrets.leaseToken);
    expect(phase2JobsText).not.toContain(phase2Secrets.selectionDigest);
    expect(
      JSON.parse(zipText(zip, "memory/phase2-publication-provenance.json")),
    ).toStrictEqual([
      {
        id: "00000000-0000-4000-8000-000000031258",
        memoryStorageId: memory.storageId,
        orgId: actor.orgId,
        userId: actor.userId,
        claimedRevision: 1,
        inputRevision: 1,
        reconciliationRevision: 0,
        selectionDigest: phase2Secrets.selectionDigest,
        selectedCount: 1,
        selectedUtf8Bytes: 42,
        baseVersionId: memory.versionId,
        preparedVersionId: "b".repeat(64),
        observedHeadVersionId: "c".repeat(64),
        writer: "pi",
        outcome: "conflicted",
        size: 17,
        archiveSize: 23,
        fileCount: 2,
        createdAt: new Date(exportStartAt - 30 * 60 * 1000).toISOString(),
      },
    ]);

    const manifest = JSON.parse(zipText(zip, "export-manifest.json")) as {
      readonly counts: {
        readonly agentInstructionFiles: number;
        readonly workflowFiles: number;
        readonly memoryFiles: number;
        readonly memoryStage1Candidates: number;
        readonly memoryPhase2Jobs: number;
        readonly memoryPhase2PublicationProvenance: number;
        readonly conversationThreads: number;
        readonly sessionHistories: number;
      };
    };
    expect(manifest.counts).toStrictEqual({
      agentInstructionFiles: 2,
      workflowFiles: 2,
      memoryFiles: 2,
      memoryStage1Candidates: 0,
      memoryPhase2Jobs: 1,
      memoryPhase2PublicationProvenance: 1,
      conversationThreads: 0,
      sessionHistories: 0,
    });
    expect(names).not.toContain("artifacts-manifest.json");
    expect(
      names.some((name) => {
        return name.endsWith(".tar.gz") || name.endsWith("-history.jsonl");
      }),
    ).toBeFalsy();
  });

  it("exports successfully when a session intentionally has no history", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    createMiscRoutesApi(context);
    const runs = createRunsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const actor = bdd.user();
    const exportStartAt = Date.UTC(2026, 4, 12, 5, 45);
    const downloadUrl =
      "https://r2.example.com/bdd-export-historyless.zip?sig=test";

    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD Export Historyless Agent",
      visibility: "private",
    });
    const run = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "checkpoint without resumable history",
      modelProvider: "anthropic-api-key",
    });
    const claim = await runs.claimRunnerJob(run.runId);
    const headers = { authorization: `Bearer ${claim.sandboxToken}` };

    await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 0,
        checkpoint: {
          cliAgentType: "claude-code",
          cliAgentSessionId: `bdd-export-historyless-${run.runId}`,
          cliAgentSessionHistoryDisposition: "discarded_oversized",
        },
      },
      headers,
      [200],
    );

    mockNow(exportStartAt);
    context.mocks.s3.getSignedUrl.mockResolvedValue(downloadUrl);
    const started = await api.requestPostUserExport(actor, [202]);
    const exportKey = `exports/${actor.userId}/${started.body.jobId}.zip`;

    await waitForUserExportJobStatus(
      api,
      actor,
      started.body.jobId,
      "completed",
    );
    const zip = exportZip(exportKey);
    const names = zipEntryNames(zip);
    expect(
      names.some((name) => {
        return name.endsWith("-history.jsonl");
      }),
    ).toBeFalsy();

    const manifest = JSON.parse(zipText(zip, "export-manifest.json")) as {
      readonly counts: {
        readonly sessionHistories: number;
      };
    };
    expect(manifest.counts.sessionHistories).toBe(0);
  });

  it("exports gzip-backed session history bytes as a jsonl conversation file", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    const misc = createMiscRoutesApi(context);
    const runs = createRunsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const actor = bdd.user();
    const exportStartAt = Date.UTC(2026, 4, 12, 6);
    const downloadUrl =
      "https://r2.example.com/bdd-export-history.zip?sig=test";

    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD Export History Agent",
      visibility: "private",
    });
    const run = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "checkpoint compressed history",
      modelProvider: "anthropic-api-key",
    });
    const claim = await runs.claimRunnerJob(run.runId);
    const headers = { authorization: `Bearer ${claim.sandboxToken}` };
    const history = Buffer.concat([
      Buffer.from(
        `{"type":"init"}\n{"type":"human","text":"exported-${randomUUID()}"}\n`,
        "utf8",
      ),
      Buffer.from([0xc3, 0x28, 0x0a]),
    ]);
    const historyHash = createHash("sha256").update(history).digest("hex");
    const compressedHistory = gzipSync(history);
    const compressedKey = `blobs/${historyHash}.blob.gz`;

    const prepared = await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId: run.runId,
        hash: historyHash,
        rawSize: history.length,
        encodedSize: compressedHistory.length,
        encoding: "gzip",
      },
      headers,
      [200],
    );
    expect(prepared.body).toMatchObject({
      existing: false,
      encoding: "gzip",
    });
    await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 0,
        checkpoint: {
          cliAgentType: "claude-code",
          cliAgentSessionId: `bdd-export-session-${run.runId}`,
          cliAgentSessionHistoryHash: historyHash,
        },
      },
      headers,
      [200],
    );

    mockNow(exportStartAt);
    context.mocks.s3.getSignedUrl.mockResolvedValue(downloadUrl);
    misc.putS3Object(compressedKey, compressedHistory);

    const started = await api.requestPostUserExport(actor, [202]);
    const jobId = started.body.jobId;
    const exportKey = `exports/${actor.userId}/${jobId}.zip`;

    await waitForUserExportJobStatus(api, actor, jobId, "completed");
    const zip = exportZip(exportKey);
    const names = zipEntryNames(zip);
    const historyEntry = singleZipEntry(names, (name) => {
      return (
        name.startsWith("conversations/") && name.endsWith("-history.jsonl")
      );
    });
    expect(zipBytes(zip, historyEntry)).toStrictEqual(history);

    const manifest = JSON.parse(zipText(zip, "export-manifest.json")) as {
      readonly counts: {
        readonly conversationThreads: number;
        readonly sessionHistories: number;
      };
    };
    expect(manifest.counts.conversationThreads).toBe(0);
    expect(manifest.counts.sessionHistories).toBe(1);
  });

  it("exports zstd-backed session history bytes as a jsonl conversation file", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    const misc = createMiscRoutesApi(context);
    const runs = createRunsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const actor = bdd.user();
    const exportStartAt = Date.UTC(2026, 4, 12, 6, 30);
    const downloadUrl =
      "https://r2.example.com/bdd-export-zstd-history.zip?sig=test";

    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD Export Zstd History Agent",
      visibility: "private",
    });
    const run = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "checkpoint zstd compressed history",
      modelProvider: "anthropic-api-key",
    });
    const claim = await runs.claimRunnerJob(run.runId);
    const headers = { authorization: `Bearer ${claim.sandboxToken}` };
    const history = Buffer.concat([
      Buffer.from(
        `{"type":"init"}\n{"type":"human","text":"zstd-exported-${randomUUID()}"}\n`,
        "utf8",
      ),
      Buffer.from([0xc3, 0x28, 0x0a]),
    ]);
    const historyHash = createHash("sha256").update(history).digest("hex");
    const compressedHistory = zstdCompressSync(history);
    const compressedKey = `blobs/${historyHash}.blob.zst`;

    const prepared = await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId: run.runId,
        hash: historyHash,
        rawSize: history.length,
        encodedSize: compressedHistory.length,
        encoding: "zstd",
      },
      headers,
      [200],
    );
    expect(prepared.body).toMatchObject({
      existing: false,
      encoding: "zstd",
    });
    await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 0,
        checkpoint: {
          cliAgentType: "claude-code",
          cliAgentSessionId: `bdd-export-zstd-session-${run.runId}`,
          cliAgentSessionHistoryHash: historyHash,
        },
      },
      headers,
      [200],
    );

    mockNow(exportStartAt);
    context.mocks.s3.getSignedUrl.mockResolvedValue(downloadUrl);
    misc.putS3Object(compressedKey, compressedHistory);

    const started = await api.requestPostUserExport(actor, [202]);
    const jobId = started.body.jobId;
    const exportKey = `exports/${actor.userId}/${jobId}.zip`;

    await waitForUserExportJobStatus(api, actor, jobId, "completed");
    const zip = exportZip(exportKey);
    const names = zipEntryNames(zip);
    const historyEntry = singleZipEntry(names, (name) => {
      return (
        name.startsWith("conversations/") && name.endsWith("-history.jsonl")
      );
    });
    expect(zipBytes(zip, historyEntry)).toStrictEqual(history);

    const manifest = JSON.parse(zipText(zip, "export-manifest.json")) as {
      readonly counts: {
        readonly conversationThreads: number;
        readonly sessionHistories: number;
      };
    };
    expect(manifest.counts.conversationThreads).toBe(0);
    expect(manifest.counts.sessionHistories).toBe(1);
  });

  it("fails user export when gzip-backed session history does not match its hash", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    const misc = createMiscRoutesApi(context);
    const runs = createRunsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const actor = bdd.user();
    const exportStartAt = Date.UTC(2026, 4, 12, 7);

    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD Export Corrupt History Agent",
      visibility: "private",
    });
    const run = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "checkpoint corrupt compressed history",
      modelProvider: "anthropic-api-key",
    });
    const claim = await runs.claimRunnerJob(run.runId);
    const headers = { authorization: `Bearer ${claim.sandboxToken}` };
    const history = `{"type":"init"}\n{"type":"human","text":"exported-${randomUUID()}"}\n`;
    const tamperedHistory = history.replace("exported-", "tampered-");
    const historyHash = createHash("sha256").update(history).digest("hex");
    const tamperedCompressedHistory = gzipSync(
      Buffer.from(tamperedHistory, "utf8"),
    );
    const compressedKey = `blobs/${historyHash}.blob.gz`;

    await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId: run.runId,
        hash: historyHash,
        rawSize: Buffer.byteLength(history, "utf8"),
        encodedSize: tamperedCompressedHistory.length,
        encoding: "gzip",
      },
      headers,
      [200],
    );
    await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 0,
        checkpoint: {
          cliAgentType: "claude-code",
          cliAgentSessionId: `bdd-export-corrupt-session-${run.runId}`,
          cliAgentSessionHistoryHash: historyHash,
        },
      },
      headers,
      [200],
    );

    mockNow(exportStartAt);
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/bdd-export-corrupt-history.zip?sig=test",
    );
    misc.putS3Object(compressedKey, tamperedCompressedHistory);

    const started = await api.requestPostUserExport(actor, [202]);
    const failedStatus = await waitForUserExportJobStatus(
      api,
      actor,
      started.body.jobId,
      "failed",
    );
    if (!failedStatus.job) {
      throw new Error("Expected failed export job");
    }
    expect(failedStatus.job.error).toContain("session history hash mismatch");
  });

  it("fails user export when zstd-backed session history does not match its hash", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    const misc = createMiscRoutesApi(context);
    const runs = createRunsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const actor = bdd.user();
    const exportStartAt = Date.UTC(2026, 4, 12, 7, 30);

    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD Export Corrupt Zstd History Agent",
      visibility: "private",
    });
    const run = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "checkpoint corrupt zstd compressed history",
      modelProvider: "anthropic-api-key",
    });
    const claim = await runs.claimRunnerJob(run.runId);
    const headers = { authorization: `Bearer ${claim.sandboxToken}` };
    const history = `{"type":"init"}\n{"type":"human","text":"zstd-exported-${randomUUID()}"}\n`;
    const tamperedHistory = history.replace("zstd-exported-", "zstd-tampered-");
    const historyHash = createHash("sha256").update(history).digest("hex");
    const tamperedCompressedHistory = zstdCompressSync(
      Buffer.from(tamperedHistory, "utf8"),
    );
    const compressedKey = `blobs/${historyHash}.blob.zst`;

    await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId: run.runId,
        hash: historyHash,
        rawSize: Buffer.byteLength(history, "utf8"),
        encodedSize: tamperedCompressedHistory.length,
        encoding: "zstd",
      },
      headers,
      [200],
    );
    await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 0,
        checkpoint: {
          cliAgentType: "claude-code",
          cliAgentSessionId: `bdd-export-corrupt-zstd-session-${run.runId}`,
          cliAgentSessionHistoryHash: historyHash,
        },
      },
      headers,
      [200],
    );

    mockNow(exportStartAt);
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/bdd-export-corrupt-zstd-history.zip?sig=test",
    );
    misc.putS3Object(compressedKey, tamperedCompressedHistory);

    const started = await api.requestPostUserExport(actor, [202]);
    const failedStatus = await waitForUserExportJobStatus(
      api,
      actor,
      started.body.jobId,
      "failed",
    );
    if (!failedStatus.job) {
      throw new Error("Expected failed export job");
    }
    expect(failedStatus.job.error).toContain("session history hash mismatch");
  });

  it("fails user export when gzip-backed session history exceeds its encoded size", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    const misc = createMiscRoutesApi(context);
    const runs = createRunsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const actor = bdd.user();
    const exportStartAt = Date.UTC(2026, 4, 12, 8);

    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD Export Oversized History Agent",
      visibility: "private",
    });
    const run = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "checkpoint oversized compressed history",
      modelProvider: "anthropic-api-key",
    });
    const claim = await runs.claimRunnerJob(run.runId);
    const headers = { authorization: `Bearer ${claim.sandboxToken}` };
    const history = `{"type":"init"}\n{"type":"human","text":"exported-${randomUUID()}"}\n`;
    const historyHash = createHash("sha256").update(history).digest("hex");
    const compressedHistory = gzipSync(Buffer.from(history, "utf8"));
    const compressedKey = `blobs/${historyHash}.blob.gz`;

    await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId: run.runId,
        hash: historyHash,
        rawSize: Buffer.byteLength(history, "utf8"),
        encodedSize: compressedHistory.length,
        encoding: "gzip",
      },
      headers,
      [200],
    );
    await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 0,
        checkpoint: {
          cliAgentType: "claude-code",
          cliAgentSessionId: `bdd-export-oversized-session-${run.runId}`,
          cliAgentSessionHistoryHash: historyHash,
        },
      },
      headers,
      [200],
    );

    mockNow(exportStartAt);
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/bdd-export-oversized-history.zip?sig=test",
    );
    misc.putS3Object(
      compressedKey,
      Buffer.concat([compressedHistory, Buffer.from([0])]),
    );

    const started = await api.requestPostUserExport(actor, [202]);
    const failedStatus = await waitForUserExportJobStatus(
      api,
      actor,
      started.body.jobId,
      "failed",
    );
    if (!failedStatus.job) {
      throw new Error("Expected failed export job");
    }
    expect(failedStatus.job.error).toContain("S3 object is too large");
  });

  it("surfaces failed exports and allows an immediate retry", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    const actor = bdd.user();
    const failedStartAt = Date.UTC(2026, 4, 20, 9);

    mockNow(failedStartAt);
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/bdd-retry.zip?sig=test",
    );
    context.mocks.s3.send.mockRejectedValueOnce(new Error("S3 upload failed"));

    const failedStart = await api.requestPostUserExport(actor, [202]);

    const failedStatus = await waitForUserExportJobStatus(
      api,
      actor,
      failedStart.body.jobId,
      "failed",
    );
    expect(failedStatus.job).toMatchObject({
      id: failedStart.body.jobId,
      status: "failed",
      error: "S3 upload failed",
      downloadUrl: null,
    });
    expect(failedStatus.canExport).toBeTruthy();
    expect(failedStatus.nextExportAt).toBeNull();

    mockNow(failedStartAt + 60_000);
    context.mocks.s3.send.mockResolvedValue({});
    const retried = await api.requestPostUserExport(actor, [202]);
    expect(retried.body.jobId).not.toBe(failedStart.body.jobId);

    const retriedStatus = await waitForUserExportJobStatus(
      api,
      actor,
      retried.body.jobId,
      "completed",
    );
    expect(retriedStatus.job?.id).toBe(retried.body.jobId);
    expect(retriedStatus.job?.status).toBe("completed");
    expect(retriedStatus.canExport).toBeFalsy();
  });

  it("completes exports without an email for unsubscribed users", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    const misc = createMiscRoutesApi(context);
    const actor = bdd.user();

    await misc.requestEmailUnsubscribe(unsubscribeToken(actor.userId), [200]);

    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/bdd-unsubscribed.zip?sig=test",
    );
    context.mocks.s3.send.mockResolvedValue({});
    const started = await api.requestPostUserExport(actor, [202]);

    const status = await waitForUserExportJobStatus(
      api,
      actor,
      started.body.jobId,
      "completed",
    );
    expect(status.job?.id).toBe(started.body.jobId);
    expect(status.job?.status).toBe("completed");
  });
});
