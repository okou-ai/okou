import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  DeleteObjectsCommand,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import type AdmZip from "adm-zip";
import { afterEach, describe, expect, it } from "vitest";
import type {
  GenerationTemplateRequest,
  UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@okouai/core";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { testCronCleanupSandboxesStateContract } from "@okouai/api-contracts/contracts/test-cron-cleanup-sandboxes-state";
import { env } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { testCronCleanupSandboxesStateRoutes } from "../test-cron-cleanup-sandboxes-state";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createOpsLogsApi } from "./helpers/api-bdd-ops-logs";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { commitMemoryVersion } from "./helpers/memory";
import { createFixtureTracker } from "./helpers/route-test";
import { createEmailOutboxStateApi } from "./helpers/email-outbox-state";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  installUserExportStorage,
  readExportChatRows,
  readExportJsonLines,
  readExportText as zipText,
  readUserExportZip,
} from "./helpers/user-export-storage";
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

/**
 * Durable admission is the registry default, so these scenarios state the
 * owner opt-out that keeps a new export on the legacy streaming exporter and
 * install the uploads that exporter performs.
 */
async function installLegacyUserExport(actor: ApiTestUser): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Legacy user export scenarios require an organization");
  }
  await updateFeatureSwitchesForUser(
    context,
    { ...actor, orgId: actor.orgId },
    { [FeatureSwitchKey.DurableUserExport]: false },
  );
  installUserExportStorage(context);
}

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
  return readUserExportZip(context, exportKey);
}

function zipEntryNames(zip: AdmZip): string[] {
  return zip.getEntries().map((entry) => {
    return entry.entryName;
  });
}

interface ExportManifest {
  readonly formatVersion: number;
  readonly counts: {
    readonly chatThreads: number;
    readonly chatMessages: number;
    readonly agents: number;
    readonly workflows: number;
    readonly memoryFiles: number;
  };
  readonly files: readonly {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
}

function readManifest(zip: AdmZip): ExportManifest {
  return JSON.parse(zipText(zip, "export-manifest.json")) as ExportManifest;
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
  files: readonly {
    readonly path: string;
    readonly content: string | Buffer;
  }[],
): Buffer {
  return gzipSync(
    Buffer.concat([
      ...files.map((file) => {
        return createTarEntry(
          file.path,
          typeof file.content === "string"
            ? Buffer.from(file.content, "utf8")
            : file.content,
        );
      }),
      Buffer.alloc(TAR_BLOCK_SIZE * 2),
    ]),
  );
}

function putMemoryArchive(
  misc: ReturnType<typeof createMiscRoutesApi>,
  s3Key: string,
  files: readonly {
    readonly path: string;
    readonly content: string | Buffer;
  }[],
): void {
  const manifestFiles = files.map((file) => {
    return {
      path: file.path,
      hash: createHash("sha256").update(file.content).digest("hex"),
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
    await installLegacyUserExport(actor);
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
    expect(readManifest(exportZip(exportKey)).formatVersion).toBe(2);

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
    installUserExportStorage(context);
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
    await installLegacyUserExport(actor);

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

  it("preserves thread metadata, empty threads, and canonical message identity and payloads", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    const chat = createChatFilesBddApi(context);
    const { actor, agentId } = await entitledRunActor();
    const emptyThread = await chat.createThread(actor, {
      agentId,
      title: "An empty thread worth keeping",
    });
    await chat.pinThread(actor, emptyThread.id, { pinOrder: "a0" });
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
    const messageId = randomUUID();
    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId,
        clientEventId: messageId,
        prompt: "stale export content",
        userMessage,
      },
      [201],
    );
    if (sent.status !== 201) {
      throw new Error("Expected the structured message send to succeed");
    }
    const recalledMessageId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: sent.body.threadId,
        prompt: "A queued message that was recalled",
        clientEventId: recalledMessageId,
      },
      [201],
    );
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: sent.body.threadId,
        revokesEventId: recalledMessageId,
        clientEventId: randomUUID(),
      },
      [201],
    );
    await flushWaitUntilForTest();
    const expectedRows = await chat.listThreadEventRows(
      actor,
      sent.body.threadId,
    );

    const peer = bdd.user({ orgId: actor.orgId });
    const peerAgent = await bdd.createAgent(peer, { visibility: "private" });
    const peerThread = await chat.createThread(peer, {
      agentId: peerAgent.agentId,
      title: "Another user's private thread",
    });

    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/bdd-structured-export.zip?sig=test",
    );
    await installLegacyUserExport(actor);
    const started = await api.requestPostUserExport(actor, [202]);
    const exportKey = `exports/${actor.userId}/${started.body.jobId}.zip`;
    await waitForUserExportJobStatus(
      api,
      actor,
      started.body.jobId,
      "completed",
    );

    const zip = exportZip(exportKey);
    const threads = readExportJsonLines(zip, "chat-threads.jsonl");
    expect(threads).toHaveLength(2);
    expect(threads).toContainEqual(
      expect.objectContaining({
        id: emptyThread.id,
        title: emptyThread.title,
        agentId,
        orgId: actor.orgId,
        createdAt: expect.any(String),
        pinnedAt: expect.any(String),
        pinOrder: "a0",
      }),
    );
    expect(threads).toContainEqual(
      expect.objectContaining({ id: sent.body.threadId, agentId }),
    );
    expect(zipText(zip, `chat-messages/${emptyThread.id}.jsonl`)).toBe("");
    expect(zipEntryNames(zip)).not.toContain(
      `chat-messages/${peerThread.id}.jsonl`,
    );
    const messages = readExportChatRows(zip, sent.body.threadId);
    expect(messages).toStrictEqual(expectedRows);
    expect(messages).toContainEqual(
      expect.objectContaining({
        id: messageId,
        chatThreadId: sent.body.threadId,
        seqId: expect.any(Number),
        eventType: "input.prompt",
        payload: expect.objectContaining({ userMessage }),
        createdAt: expect.any(String),
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        eventType: "control.revoke",
        revokesEventId: recalledMessageId,
      }),
    );
    expect(JSON.stringify(messages)).not.toContain("stale export content");
    expect(readManifest(zip).counts).toMatchObject({
      chatThreads: 2,
      chatMessages: expectedRows.length,
    });
  });

  it("exports the exporter's own instructions across current organizations without leaking other members' or former-organization resources", async () => {
    const bdd = createBddApi(context);
    const misc = createMiscRoutesApi(context);
    const actor = bdd.user({ orgRole: "org:member" });
    if (!actor.orgId) {
      throw new Error("Expected export actor organization");
    }
    const teammate = bdd.user({ orgId: actor.orgId, orgRole: "org:admin" });
    const otherOrg = bdd.user();
    if (!otherOrg.orgId) {
      throw new Error("Expected secondary organization");
    }
    // Same person, second current organization, and a third they have left.
    const actorElsewhere = bdd.user({
      userId: actor.userId,
      orgId: otherOrg.orgId,
    });
    const formerOrg = bdd.user({ userId: actor.userId });
    const ownedAgentIds: string[] = [];
    const ownedWorkflowIds: string[] = [];
    for (const [index, owner] of [actor, actorElsewhere].entries()) {
      const agent = await bdd.createAgent(owner, {
        displayName: `Own agent ${index.toString()}`,
        visibility: "private",
      });
      await bdd.updateAgentInstructions(
        owner,
        agent.agentId,
        `Own agent instructions ${index.toString()}`,
      );
      ownedAgentIds.push(agent.agentId);
      const workflow = await misc.createWorkflow(
        owner,
        agent.agentId,
        `own-workflow-${index.toString()}`,
        {
          content: `Own workflow instruction ${index.toString()}`,
          visibility: "private",
        },
        [201],
      );
      if (!("id" in workflow.body)) {
        throw new Error("Expected own workflow id");
      }
      ownedWorkflowIds.push(workflow.body.id);
    }
    // A teammate's public agent is readable in the product but is their record,
    // not this subject's data. Same for a public workflow they own on it.
    const sharedAgent = await bdd.createAgent(teammate, {
      displayName: "Shared teammate agent",
      visibility: "public",
    });
    await bdd.updateAgentInstructions(
      teammate,
      sharedAgent.agentId,
      "Teammate authored these instructions",
    );
    await misc.createWorkflow(
      teammate,
      sharedAgent.agentId,
      "public-workflow-owned-by-teammate",
      { content: "Teammate workflow instruction", visibility: "public" },
      [201],
    );
    for (const owner of [teammate, formerOrg]) {
      const agent = await bdd.createAgent(owner, { visibility: "private" });
      await bdd.updateAgentInstructions(owner, agent.agentId, "Hidden agent");
      await misc.createWorkflow(
        owner,
        agent.agentId,
        "workflow-on-unreadable-agent",
        { content: "Hidden workflow", visibility: "public" },
        [201],
      );
    }
    const api = createOpsLogsApi(context, {
      organizationIds: [actor.orgId, otherOrg.orgId],
    });
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/bdd-accessible-export.zip?sig=test",
    );
    await installLegacyUserExport(actor);
    const started = await api.requestPostUserExport(actor, [202]);
    await waitForUserExportJobStatus(
      api,
      actor,
      started.body.jobId,
      "completed",
    );
    const zip = exportZip(`exports/${actor.userId}/${started.body.jobId}.zip`);
    const agents = readExportJsonLines(zip, "agents.jsonl");
    const workflows = readExportJsonLines(zip, "workflows.jsonl");
    expect(
      agents
        .map((agent) => {
          return agent.id;
        })
        .sort(),
    ).toStrictEqual(ownedAgentIds.sort());
    expect(
      workflows
        .map((workflow) => {
          return workflow.id;
        })
        .sort(),
    ).toStrictEqual(ownedWorkflowIds.sort());
    for (const [index, owner] of [actor, actorElsewhere].entries()) {
      expect(agents).toContainEqual(
        expect.objectContaining({
          orgId: owner.orgId,
          instructions: `Own agent instructions ${index.toString()}`,
        }),
      );
      expect(workflows).toContainEqual(
        expect.objectContaining({
          orgId: owner.orgId,
          instruction: `Own workflow instruction ${index.toString()}`,
        }),
      );
    }
    expect(JSON.stringify([...agents, ...workflows])).not.toContain(
      "Teammate authored these instructions",
    );
    expect(readManifest(zip).counts).toMatchObject({ agents: 2, workflows: 2 });
  });

  it.each(["manifest entry", "archive file"])(
    "fails when a required agent instruction %s is missing",
    async (missing) => {
      const api = createOpsLogsApi(context);
      const bdd = createBddApi(context);
      const misc = createMiscRoutesApi(context);
      const actor = bdd.user();
      const agent = await bdd.createAgent(actor, { visibility: "private" });
      await bdd.updateAgentInstructions(
        actor,
        agent.agentId,
        "Required instructions",
      );
      const manifestPut = context.mocks.s3.send.mock.calls
        .map(([command]) => {
          return command;
        })
        .filter((command): command is PutObjectCommand => {
          return (
            command instanceof PutObjectCommand &&
            command.input.Key?.endsWith("/manifest.json") === true
          );
        })
        .at(-1);
      const manifestKey = manifestPut?.input.Key;
      if (!manifestKey) {
        throw new Error("Expected the instruction manifest upload");
      }
      // S3 is an external dependency: either its canonical manifest entry or
      // its archived file can be lost after an otherwise successful write.
      if (missing === "manifest entry") {
        misc.putS3Object(
          manifestKey,
          JSON.stringify({
            version: "corrupt-instructions",
            createdAt: new Date(0).toISOString(),
            files: [],
            totalSize: 0,
            fileCount: 0,
          }),
        );
      } else {
        misc.putS3Object(
          manifestKey.replace(/manifest\.json$/, "archive.tar.gz"),
          createTarGz([]),
        );
      }
      await installLegacyUserExport(actor);
      const started = await api.requestPostUserExport(actor, [202]);
      const status = await waitForUserExportJobStatus(
        api,
        actor,
        started.body.jobId,
        "failed",
      );
      expect(status.job).toMatchObject({
        status: "failed",
        error: expect.any(String),
        downloadUrl: null,
      });
      expect(status.canExport).toBeTruthy();
    },
  );

  it("preserves intentionally empty agent instructions", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    createMiscRoutesApi(context);
    const actor = bdd.user();
    const agent = await bdd.createAgent(actor, { visibility: "private" });
    await bdd.updateAgentInstructions(actor, agent.agentId, "");
    await installLegacyUserExport(actor);
    const started = await api.requestPostUserExport(actor, [202]);
    await waitForUserExportJobStatus(
      api,
      actor,
      started.body.jobId,
      "completed",
    );
    const zip = exportZip(`exports/${actor.userId}/${started.body.jobId}.zip`);
    expect(readExportJsonLines(zip, "agents.jsonl")).toContainEqual(
      expect.objectContaining({ id: agent.agentId, instructions: "" }),
    );
  });

  it("exports current own memory and instruction bodies with a verifiable content manifest", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    const misc = createMiscRoutesApi(context);
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected export test actor to have an org");
    }
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD Export Agent",
      visibility: "private",
    });
    await bdd.updateAgentInstructions(
      actor,
      agent.agentId,
      "Use the exported agent instructions.",
    );
    const workflow = await misc.createWorkflow(
      actor,
      agent.agentId,
      "bdd-export-workflow",
      {
        content: "Use the exported workflow instructions.",
        files: [
          { path: "notes/checklist.md", content: "Excluded support file" },
        ],
      },
      [201],
    );
    if (!("id" in workflow.body)) {
      throw new Error("Expected workflow creation to return a workflow id");
    }
    // Incompressible content crosses the multipart boundary after compression.
    const memoryNote = randomBytes(6 * 1024 * 1024).toString("base64");
    const binaryMemory = Buffer.from([0, 255, 254, 128, 10, 13, 0, 1, 2]);
    const memoryFiles = [
      { path: "MEMORY.md", content: "# Exported memory" },
      { path: "notes/profile.md", content: memoryNote },
      { path: "notes/data.bin", content: binaryMemory },
    ];
    createStoragesBddApi(context).mockStoragePresignedUrls();
    const oldFiles = [{ path: "removed.md", content: "An old memory version" }];
    const oldMemory = await commitMemoryVersion(context, actor, oldFiles);
    putMemoryArchive(misc, oldMemory.s3Key, oldFiles);
    const memory = await commitMemoryVersion(context, actor, memoryFiles);
    putMemoryArchive(misc, memory.s3Key, memoryFiles);
    const peer = bdd.user({ orgId: actor.orgId });
    const peerFiles = [
      { path: "peer-secret.md", content: "Another user's memory" },
    ];
    const peerMemory = await commitMemoryVersion(context, peer, peerFiles);
    putMemoryArchive(misc, peerMemory.s3Key, peerFiles);

    await installLegacyUserExport(actor);
    const started = await api.requestPostUserExport(actor, [202]);
    await waitForUserExportJobStatus(
      api,
      actor,
      started.body.jobId,
      "completed",
    );
    const zip = exportZip(`exports/${actor.userId}/${started.body.jobId}.zip`);
    const names = zipEntryNames(zip);
    expect(readExportJsonLines(zip, "agents.jsonl")).toStrictEqual([
      expect.objectContaining({
        id: agent.agentId,
        instructions: "Use the exported agent instructions.",
      }),
    ]);
    expect(readExportJsonLines(zip, "workflows.jsonl")).toStrictEqual([
      expect.objectContaining({
        id: workflow.body.id,
        instruction: "Use the exported workflow instructions.",
      }),
    ]);
    expect(zipText(zip, `memory/${actor.orgId}/MEMORY.md`)).toBe(
      "# Exported memory",
    );
    expect(zipText(zip, `memory/${actor.orgId}/notes/profile.md`)).toBe(
      memoryNote,
    );
    expect(
      zip.getEntry(`memory/${actor.orgId}/notes/data.bin`)?.getData(),
    ).toStrictEqual(binaryMemory);
    const exportParts = context.mocks.s3.send.mock.calls.filter(([command]) => {
      return command instanceof UploadPartCommand;
    });
    expect(exportParts.length).toBeGreaterThan(1);
    expect(names.sort()).toStrictEqual(
      [
        "agents.jsonl",
        "chat-threads.jsonl",
        "export-manifest.json",
        `memory/${actor.orgId}/MEMORY.md`,
        `memory/${actor.orgId}/notes/data.bin`,
        `memory/${actor.orgId}/notes/profile.md`,
        "workflows.jsonl",
      ].sort(),
    );
    const manifest = readManifest(zip);
    expect(manifest.formatVersion).toBe(2);
    expect(manifest.counts).toStrictEqual({
      chatThreads: 0,
      chatMessages: 0,
      agents: 1,
      workflows: 1,
      memoryFiles: 3,
    });
    expect(
      manifest.files
        .map((file) => {
          return file.path;
        })
        .sort(),
    ).toStrictEqual(
      names
        .filter((name) => {
          return name !== "export-manifest.json";
        })
        .sort(),
    );
    for (const file of manifest.files) {
      const bytes = zip.getEntry(file.path)?.getData();
      if (!bytes) {
        throw new Error(`Expected manifest file ${file.path}`);
      }
      expect(file.bytes).toBe(bytes.length);
      expect(file.sha256).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
    }
  });

  it.each(["unavailable", "corrupted with the same size"])(
    "fails instead of publishing incomplete data when current memory is %s",
    async (failure) => {
      const api = createOpsLogsApi(context);
      const bdd = createBddApi(context);
      const misc = createMiscRoutesApi(context);
      const actor = bdd.user();
      createStoragesBddApi(context).mockStoragePresignedUrls();
      const files = [{ path: "MEMORY.md", content: "Original memory" }];
      const memory = await commitMemoryVersion(context, actor, files);
      // Object loss or corruption after a committed upload is an external
      // storage failure, constructed at the mocked object-storage boundary.
      if (failure !== "unavailable") {
        putMemoryArchive(misc, memory.s3Key, files);
        misc.putS3Object(
          `${memory.s3Key}/archive.tar.gz`,
          createTarGz([{ path: "MEMORY.md", content: "Tampered memory" }]),
        );
      }
      await installLegacyUserExport(actor);
      const started = await api.requestPostUserExport(actor, [202]);
      const status = await waitForUserExportJobStatus(
        api,
        actor,
        started.body.jobId,
        "failed",
      );
      expect(status.job).toMatchObject({
        status: "failed",
        error: expect.any(String),
        downloadUrl: null,
      });
      expect(status.canExport).toBeTruthy();
      const key = `exports/${actor.userId}/${started.body.jobId}.zip`;
      expect(
        context.mocks.s3.send.mock.calls.some(([command]) => {
          return (
            command instanceof CompleteMultipartUploadCommand &&
            command.input.Key === key
          );
        }),
      ).toBeFalsy();
    },
  );

  it("completes the core-content export when old session history blobs are unavailable", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    createMiscRoutesApi(context);
    const runs = createRunsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const actor = bdd.user();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, { visibility: "private" });
    const run = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "checkpoint with later-expired session history",
      modelProvider: "anthropic-api-key",
    });
    const claim = await runs.claimRunnerJob(run.runId);
    const headers = { authorization: `Bearer ${claim.sandboxToken}` };
    const history = `{"type":"init"}\n{"type":"human","text":"old history"}\n`;
    const historyHash = createHash("sha256").update(history).digest("hex");
    await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId: run.runId,
        hash: historyHash,
        rawSize: Buffer.byteLength(history, "utf8"),
        encodedSize: gzipSync(history).length,
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
          cliAgentSessionId: `unavailable-history-${run.runId}`,
          cliAgentSessionHistoryHash: historyHash,
        },
      },
      headers,
      [200],
    );
    // The object store contains no session blob. Export still preserves the
    // user's instruction data without depending on runner resume artifacts.
    const visibleAgents = await bdd.listAgents(actor);
    await installLegacyUserExport(actor);
    const started = await api.requestPostUserExport(actor, [202]);
    await waitForUserExportJobStatus(
      api,
      actor,
      started.body.jobId,
      "completed",
    );
    const zip = exportZip(`exports/${actor.userId}/${started.body.jobId}.zip`);
    expect(zipEntryNames(zip).sort()).toStrictEqual([
      "agents.jsonl",
      "chat-threads.jsonl",
      "export-manifest.json",
      "workflows.jsonl",
    ]);
    const exportedAgents = readExportJsonLines(zip, "agents.jsonl");
    expect(exportedAgents).toContainEqual(
      expect.objectContaining({ id: agent.agentId }),
    );
    expect(
      exportedAgents
        .map((exported) => {
          return exported.id;
        })
        .sort(),
    ).toStrictEqual(
      visibleAgents
        .map((visible) => {
          return visible.agentId;
        })
        .sort(),
    );
    expect(readManifest(zip).counts).toStrictEqual({
      chatThreads: 0,
      chatMessages: 0,
      agents: visibleAgents.length,
      workflows: 0,
      memoryFiles: 0,
    });
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
    await installLegacyUserExport(actor);
    const storage = context.mocks.s3.send.getMockImplementation();
    if (!storage) {
      throw new Error("Expected export object storage mock");
    }
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      return command instanceof UploadPartCommand
        ? Promise.reject(new Error("S3 upload failed"))
        : storage(command);
    });

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
    const failedKey = `exports/${actor.userId}/${failedStart.body.jobId}.zip`;
    expect(
      context.mocks.s3.send.mock.calls.some(([command]) => {
        return (
          command instanceof AbortMultipartUploadCommand &&
          command.input.Key === failedKey
        );
      }),
    ).toBeTruthy();
    expect(
      context.mocks.s3.send.mock.calls.some(([command]) => {
        return (
          command instanceof CompleteMultipartUploadCommand &&
          command.input.Key === failedKey
        );
      }),
    ).toBeFalsy();

    mockNow(failedStartAt + 60_000);
    installUserExportStorage(context);
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

  it("keeps a timed-out job failed and deletes a late upload without emailing it", async () => {
    const api = createOpsLogsApi(context);
    const actor = createBddApi(context).user();
    createMiscRoutesApi(context);
    await installLegacyUserExport(actor);
    const storage = context.mocks.s3.send.getMockImplementation();
    if (!storage) {
      throw new Error("Expected export object storage mock");
    }
    const completing = createDeferredPromise<void>(context.signal);
    const deleted = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    const pending = await trackDeferredS3Put(
      Promise.resolve({
        resolve: () => {
          if (!release.settled()) {
            release.resolve(undefined);
          }
        },
      }),
    );
    context.mocks.s3.send.mockImplementation(async (command: unknown) => {
      if (command instanceof CompleteMultipartUploadCommand) {
        completing.resolve(undefined);
        await release.promise;
      }
      const result = await storage(command);
      if (
        command instanceof DeleteObjectsCommand &&
        command.input.Delete?.Objects?.some((object) => {
          return object.Key?.startsWith(`exports/${actor.userId}/`);
        })
      ) {
        deleted.resolve(undefined);
      }
      return result;
    });
    const startedAt = Date.UTC(2026, 4, 20, 9);
    mockNow(startedAt);
    const started = await api.requestPostUserExport(actor, [202]);
    await completing.promise;
    const running = await api.requestGetUserExport(actor, [200]);
    expect(running.body.job).toMatchObject({
      id: started.body.jobId,
      status: "running",
    });

    mockNow(startedAt + 11 * 60_000);
    const cleanup = await accept(
      setupApp({ context, routes: testCronCleanupSandboxesStateRoutes })(
        testCronCleanupSandboxesStateContract,
      ).cleanup({
        body: {
          chatThreadIds: [],
          runIds: [],
          orgIds: [],
          exportJobIds: [started.body.jobId],
        },
      }),
      [200],
    );
    expect(cleanup.body.exportJobsStuck).toBe(1);
    pending.resolve();
    await deleted.promise;
    const status = await waitForUserExportJobStatus(
      api,
      actor,
      started.body.jobId,
      "failed",
    );
    expect(status.job).toMatchObject({
      status: "failed",
      error: "Export job timed out",
      downloadUrl: null,
    });
    expect(status.canExport).toBeTruthy();
    const key = `exports/${actor.userId}/${started.body.jobId}.zip`;
    expect(
      context.mocks.s3.send.mock.calls.some(([command]) => {
        return (
          command instanceof DeleteObjectsCommand &&
          command.input.Delete?.Objects?.some((object) => {
            return object.Key === key;
          })
        );
      }),
    ).toBeTruthy();
    await expect(
      createEmailOutboxStateApi(context).findItems({
        toAddress: actor.email,
        subject: "Your data export is ready",
      }),
    ).resolves.toStrictEqual([]);
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
    await installLegacyUserExport(actor);
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
