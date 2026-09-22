import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import AdmZip from "adm-zip";
import { testUserExportWorkContract } from "@okouai/api-contracts/contracts/test-user-export-work";
import { afterEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow } from "../../../lib/time";
import {
  readUserExportJobFixture,
  seedLegacyUserExportJobFixture,
} from "../../../test-fixtures/user-export";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { testUserExportWorkRoutes } from "../test-user-export-work";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createOpsLogsApi } from "./helpers/api-bdd-ops-logs";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
import { installDurableUserExportStorage } from "./helpers/durable-user-export-storage";
import { commitMemoryVersion } from "./helpers/memory";
import {
  readExportJsonLines,
  readExportText,
} from "./helpers/user-export-storage";

const HOUR_MS = 60 * 60_000;
const TAR_BLOCK_SIZE = 512;
const context = testContext();

afterEach(() => {
  clearMockNow();
});

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

async function runExportWork(user: ApiTestUser, jobId: string): Promise<void> {
  await accept(
    setupApp({ context, routes: testUserExportWorkRoutes })(
      testUserExportWorkContract,
    ).action({
      body: {
        action: "run",
        userId: user.userId,
        jobId,
        maxSteps: 200,
      },
    }),
    [200],
  );
}

async function completedExport(
  actor: ApiTestUser,
  storage: ReturnType<typeof installDurableUserExportStorage>,
) {
  const api = createOpsLogsApi(context);
  const started = await api.requestPostUserExport(actor, [202]);
  await flushWaitUntilForTest();
  await runExportWork(actor, started.body.jobId);
  const status = await api.requestGetUserExport(actor, [200]);
  expect(status.body.job).toMatchObject({
    id: started.body.jobId,
    status: "completed",
    downloadUrl: expect.any(String),
    error: null,
  });
  const downloadUrl = status.body.job?.downloadUrl;
  if (!downloadUrl) {
    throw new Error("Expected a downloadable completed export");
  }
  return {
    api,
    jobId: started.body.jobId,
    status: status.body,
    zip: new AdmZip(storage.download(downloadUrl)),
  };
}

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
): { readonly archive: Buffer; readonly manifest: Buffer } {
  const manifestFiles = files.map((file) => {
    return {
      path: file.path,
      hash: createHash("sha256").update(file.content).digest("hex"),
      size: Buffer.byteLength(file.content),
    };
  });
  const manifest = Buffer.from(
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
  const archive = createTarGz(files);
  misc.putS3Object(`${s3Key}/manifest.json`, manifest);
  misc.putS3Object(`${s3Key}/archive.tar.gz`, archive);
  return { archive, manifest };
}

function exportFileRecords(zip: AdmZip) {
  return zip
    .getEntries()
    .filter((entry) => {
      return entry.entryName.startsWith("manifest/files-");
    })
    .flatMap((entry) => {
      return readExportJsonLines(zip, entry.entryName);
    })
    .map((record) => {
      const { path, size, sha256 } = record;
      if (
        typeof path !== "string" ||
        typeof size !== "number" ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        typeof sha256 !== "string"
      ) {
        throw new Error("Expected a valid export file manifest record");
      }
      return { path, size, sha256 };
    });
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

  it("exports durably with active, cooldown, expiry, and latest-job visibility", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    const actor = bdd.user();
    const storage = installDurableUserExportStorage(context);
    const exportStartAt = Date.UTC(2026, 4, 12, 5);

    mockNow(exportStartAt);
    await expect(api.requestGetUserExport(actor, [200])).resolves.toMatchObject(
      {
        body: { job: null, canExport: true, nextExportAt: null },
      },
    );

    const started = await api.requestPostUserExport(actor, [202]);
    expect(started.body.status).toBe("pending");
    const exportKey = `exports/${actor.userId}/${started.body.jobId}.zip`;

    const reposted = await api.requestPostUserExport(actor, [202]);
    expect(reposted.body.jobId).toBe(started.body.jobId);
    expect(["pending", "running"]).toContain(reposted.body.status);

    const active = await api.requestGetUserExport(actor, [200]);
    expect(active.body.job?.id).toBe(started.body.jobId);
    expect(["pending", "running"]).toContain(active.body.job?.status);
    expect(active.body.job?.downloadUrl).toBeNull();
    expect(active.body.canExport).toBeFalsy();

    await flushWaitUntilForTest();
    await runExportWork(actor, started.body.jobId);
    const completed = await api.requestGetUserExport(actor, [200]);
    expect(completed.body).toStrictEqual({
      job: {
        id: started.body.jobId,
        status: "completed",
        createdAt: new Date(exportStartAt).toISOString(),
        completedAt: new Date(exportStartAt).toISOString(),
        expiresAt: new Date(exportStartAt + 48 * HOUR_MS).toISOString(),
        downloadUrl: expect.any(String),
        error: null,
      },
      canExport: false,
      nextExportAt: new Date(exportStartAt + 24 * HOUR_MS).toISOString(),
    });
    const downloadUrl = completed.body.job?.downloadUrl;
    if (!downloadUrl) {
      throw new Error("Expected the completed export download");
    }
    expect(
      JSON.parse(
        readExportText(
          new AdmZip(storage.download(downloadUrl)),
          "export-manifest.json",
        ),
      ),
    ).toMatchObject({ formatVersion: 4 });
    expect(exportDownloadDispositions(exportKey)).not.toHaveLength(0);
    expect(exportDownloadDispositions(exportKey)).toStrictEqual(
      expect.arrayContaining(['attachment; filename="okou-data-export.zip"']),
    );

    const limited = await api.requestPostUserExport(actor, [429]);
    expect(limited.body.error.code).toBe("RATE_LIMITED");

    const expiredReadAt = exportStartAt + 49 * HOUR_MS;
    mockNow(expiredReadAt);
    const expired = await api.requestGetUserExport(actor, [200]);
    expect(expired.body.job).toMatchObject({
      id: started.body.jobId,
      downloadUrl: null,
    });
    expect(expired.body.canExport).toBeTruthy();
    expect(expired.body.nextExportAt).toBeNull();

    const restarted = await api.requestPostUserExport(actor, [202]);
    expect(restarted.body.jobId).not.toBe(started.body.jobId);
    await flushWaitUntilForTest();
    await runExportWork(actor, restarted.body.jobId);
    const latest = await api.requestGetUserExport(actor, [200]);
    expect(latest.body.job).toMatchObject({
      id: restarted.body.jobId,
      status: "completed",
      createdAt: new Date(expiredReadAt).toISOString(),
      completedAt: new Date(expiredReadAt).toISOString(),
      expiresAt: new Date(expiredReadAt + 48 * HOUR_MS).toISOString(),
      downloadUrl: expect.any(String),
      error: null,
    });

    const peer = bdd.user();
    await expect(api.requestGetUserExport(peer, [200])).resolves.toMatchObject({
      body: { job: null, canExport: true, nextExportAt: null },
    });
  });

  it("downloads a historical export with the Okou filename without rewriting its row", async () => {
    const actor = createBddApi(context).user();
    const storage = installDurableUserExportStorage(context);
    const { api, jobId } = await completedExport(actor, storage);
    const exportKey = `exports/${actor.userId}/${jobId}.zip`;

    const historicalJob = await seedLegacyUserExportJobFixture(
      actor.userId,
      jobId,
    );
    const downloaded = await api.requestGetUserExport(actor, [200]);
    expect(downloaded.body.job).toMatchObject({
      id: jobId,
      status: "completed",
      downloadUrl: expect.any(String),
    });
    expect(exportDownloadDispositions(exportKey)).toStrictEqual(
      expect.arrayContaining(['attachment; filename="okou-data-export.zip"']),
    );
    await expect(
      readUserExportJobFixture(actor.userId, jobId),
    ).resolves.toStrictEqual(historicalJob);
  });

  it("exports owned threads, instructions, workflows, and current memory in format v4", async () => {
    const bdd = createBddApi(context);
    bdd.acceptAgentStorageWrites();
    const chat = createChatFilesBddApi(context);
    const misc = createMiscRoutesApi(context);
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected an organization for the export actor");
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
      { content: "Use the exported workflow instructions." },
      [201],
    );
    if (!("id" in workflow.body)) {
      throw new Error("Expected workflow creation to return an id");
    }
    const thread = await chat.createThread(actor, {
      agentId: agent.agentId,
      title: "An empty thread worth keeping",
    });
    await chat.pinThread(actor, thread.id, { pinOrder: "a0" });

    const peer = bdd.user({ orgId: actor.orgId });
    const peerAgent = await bdd.createAgent(peer, { visibility: "private" });
    const peerThread = await chat.createThread(peer, {
      agentId: peerAgent.agentId,
      title: "Another user's private thread",
    });

    createStoragesBddApi(context).mockStoragePresignedUrls();
    const oldFiles = [{ path: "removed.md", content: "An old memory version" }];
    const oldMemory = await commitMemoryVersion(
      context,
      actor,
      oldFiles,
      createTarGz(oldFiles).length,
    );
    putMemoryArchive(misc, oldMemory.s3Key, oldFiles);
    const memoryFiles = [
      { path: "MEMORY.md", content: "# Exported memory" },
      {
        path: "notes/data.bin",
        content: Buffer.from([0, 255, 254, 128, 10, 13, 0, 1, 2]),
      },
    ];
    const memory = await commitMemoryVersion(
      context,
      actor,
      memoryFiles,
      createTarGz(memoryFiles).length,
    );
    const currentMemory = putMemoryArchive(misc, memory.s3Key, memoryFiles);
    const peerFiles = [
      { path: "peer-secret.md", content: "Another user's memory" },
    ];
    const peerMemory = await commitMemoryVersion(
      context,
      peer,
      peerFiles,
      createTarGz(peerFiles).length,
    );
    putMemoryArchive(misc, peerMemory.s3Key, peerFiles);

    const storage = installDurableUserExportStorage(context);
    const { zip } = await completedExport(actor, storage);
    expect(
      JSON.parse(readExportText(zip, "export-manifest.json")),
    ).toMatchObject({ formatVersion: 4 });
    expect(
      JSON.parse(readExportText(zip, `chat-threads/${thread.id}.json`)),
    ).toMatchObject({
      id: thread.id,
      title: thread.title,
      agentId: agent.agentId,
      orgId: actor.orgId,
      pinOrder: "a0",
    });
    expect(
      zip.getEntries().some((entry) => {
        return entry.entryName.startsWith(`chat-messages/${thread.id}/`);
      }),
    ).toBeFalsy();
    expect(zip.getEntry(`chat-threads/${peerThread.id}.json`)).toBeNull();
    expect(
      JSON.parse(readExportText(zip, `agents/${agent.agentId}.json`)),
    ).toMatchObject({
      id: agent.agentId,
      instructions: "Use the exported agent instructions.",
    });
    expect(zip.getEntry(`agents/${peerAgent.agentId}.json`)).toBeNull();
    expect(
      JSON.parse(readExportText(zip, `workflows/${workflow.body.id}.json`)),
    ).toMatchObject({
      id: workflow.body.id,
      instruction: "Use the exported workflow instructions.",
    });

    const memoryPrefix = `memory/${actor.orgId}/${memory.storageId}`;
    expect(
      zip.getEntry(`${memoryPrefix}/archive.tar.gz`)?.getData(),
    ).toStrictEqual(currentMemory.archive);
    expect(
      zip.getEntry(`${memoryPrefix}/manifest.json`)?.getData(),
    ).toStrictEqual(currentMemory.manifest);
    expect(
      zip.getEntries().some((entry) => {
        return entry.entryName.startsWith(
          `memory/${peer.orgId}/${peerMemory.storageId}/`,
        );
      }),
    ).toBeFalsy();

    for (const record of exportFileRecords(zip)) {
      const bytes = zip.getEntry(record.path)?.getData();
      if (!bytes) {
        throw new Error(`Manifest references a missing file: ${record.path}`);
      }
      expect(bytes).toHaveLength(record.size);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        record.sha256,
      );
    }
    expect(
      JSON.stringify(
        zip.getEntries().map((entry) => {
          return entry.entryName;
        }),
      ),
    ).not.toContain(oldMemory.s3Key);
  });
});
