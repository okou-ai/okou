import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import {
  CompleteMultipartUploadCommand,
  GetObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { emailSubscriptionContract } from "@okouai/api-contracts/contracts/email-subscription";
import { testUserExportWorkContract } from "@okouai/api-contracts/contracts/test-user-export-work";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import AdmZip from "adm-zip";
import { onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { tarArchive, tarEntry } from "../../../test-fixtures/tar-archive";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { emailSubscriptionRoutes } from "../email-subscription";
import { testUserExportWorkRoutes } from "../test-user-export-work";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createOpsLogsApi } from "./helpers/api-bdd-ops-logs";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
import { installDurableUserExportStorage } from "./helpers/durable-user-export-storage";
import { createEmailOutboxStateApi } from "./helpers/email-outbox-state";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { commitMemoryVersion } from "./helpers/memory";
import { readExportText } from "./helpers/user-export-storage";

const context = testContext();
const readySubject = "Your data export is ready";

async function actor() {
  const user = createBddApi(context).user();
  if (!user.orgId) {
    throw new Error("Durable export tests require an organization");
  }
  const current = { ...user, orgId: user.orgId };
  await updateFeatureSwitchesForUser(context, current, {
    [FeatureSwitchKey.DurableUserExport]: true,
  });
  return current;
}

async function work(
  user: ApiTestUser,
  jobId: string,
  action: "run" | "inspect" | "make-due" | "expire-lease" | "delete",
  maxSteps?: number,
) {
  const response = await accept(
    setupApp({ context, routes: testUserExportWorkRoutes })(
      testUserExportWorkContract,
    ).action({ body: { userId: user.userId, jobId, action, maxSteps } }),
    [200],
  );
  return response.body;
}

function cleanup(user: ApiTestUser, jobId: string): void {
  onTestFinished(async () => {
    await work(user, jobId, "delete");
    const outbox = createEmailOutboxStateApi(context);
    const emails = await outbox.findItems({
      toAddress: user.email,
      subject: readySubject,
    });
    if (emails.length > 0) {
      await outbox.deleteItems(
        emails.map((email) => {
          return email.id;
        }),
      );
    }
  });
}

async function completedZip(
  user: ApiTestUser,
  jobId: string,
  storage: ReturnType<typeof installDurableUserExportStorage>,
) {
  const status = await createOpsLogsApi(context).requestGetUserExport(
    user,
    [200],
  );
  expect(status.body.job).toMatchObject({
    id: jobId,
    status: "completed",
    error: null,
  });
  const downloadUrl = status.body.job?.downloadUrl;
  if (!downloadUrl) {
    throw new Error("Expected a downloadable completed export");
  }
  const zip = new AdmZip(storage.download(downloadUrl));
  const names = zip.getEntries().map((entry) => {
    return entry.entryName;
  });
  expect(new Set(names).size).toBe(names.length);
  expect(JSON.parse(readExportText(zip, "export-manifest.json"))).toMatchObject(
    { formatVersion: 4 },
  );
  for (const name of names.filter((path) => {
    return path.startsWith("manifest/files-");
  })) {
    for (const line of readExportText(zip, name).trim().split("\n")) {
      const record = JSON.parse(line) as {
        path: string;
        size: number;
        sha256: string;
      };
      const bytes = zip.getEntry(record.path)?.getData();
      expect(bytes).toHaveLength(record.size);
      if (!bytes) {
        throw new Error("Manifest references a missing export file");
      }
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        record.sha256,
      );
    }
  }
  const emails = await createEmailOutboxStateApi(context).findItems({
    toAddress: user.email,
    subject: readySubject,
  });
  expect(emails).toHaveLength(1);
  return zip;
}

test("continues the same export across bounded requests after a staged write loses its response", async () => {
  const user = await actor();
  const bdd = createBddApi(context);
  const misc = createMiscRoutesApi(context);
  const agent = await bdd.createAgent(user, {
    displayName: "Resumable agent",
    visibility: "private",
  });
  await bdd.updateAgentInstructions(
    user,
    agent.agentId,
    "Keep this user's instructions intact.",
  );
  await createRunsApi(context).ensureOrgModelProvider(user);
  const chat = createChatFilesBddApi(context);
  const thread = await chat.createThread(user, {
    agentId: agent.agentId,
    title: "Pinned empty conversation",
  });
  await chat.pinThread(user, thread.id, { pinOrder: "a0" });
  const workflow = await misc.createWorkflow(
    user,
    agent.agentId,
    "resume-export",
    {
      content: "Preserve the workflow instruction.",
    },
    [201],
  );
  if (!("id" in workflow.body)) {
    throw new Error("Expected an installed workflow");
  }
  let failWrite = true;
  const storage = installDurableUserExportStorage(context, {
    afterWrite: (command) => {
      if (command instanceof PutObjectCommand && failWrite) {
        failWrite = false;
        return Promise.reject(
          new Error("Object persisted; response connection closed"),
        );
      }
      return Promise.resolve();
    },
  });
  const exportStorage = context.mocks.s3.send.getMockImplementation();
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (
      command instanceof GetObjectCommand &&
      command.input.Key?.endsWith("/archive.tar.gz")
    ) {
      return Promise.reject(
        new Error("Ready indexed instructions must not download their archive"),
      );
    }
    return exportStorage?.(command) ?? Promise.resolve({});
  });
  const api = createOpsLogsApi(context);
  const [started, concurrent] = await Promise.all([
    api.requestPostUserExport(user, [202]),
    api.requestPostUserExport(user, [202]),
  ]);
  expect(concurrent.body.jobId).toBe(started.body.jobId);
  cleanup(user, started.body.jobId);
  await flushWaitUntilForTest();
  const interrupted = await api.requestGetUserExport(user, [200]);
  expect(interrupted.body.job).toMatchObject({
    id: started.body.jobId,
    downloadUrl: null,
  });
  expect(["pending", "running"]).toContain(interrupted.body.job?.status);
  await expect(
    createEmailOutboxStateApi(context).findItems({
      toAddress: user.email,
      subject: readySubject,
    }),
  ).resolves.toHaveLength(0);
  const repeated = await api.requestPostUserExport(user, [202]);
  expect(repeated.body.jobId).toBe(started.body.jobId);
  await flushWaitUntilForTest();

  // Disabling admission does not abandon work already durably accepted.
  await updateFeatureSwitchesForUser(context, user, {
    [FeatureSwitchKey.DurableUserExport]: false,
  });
  await work(user, started.body.jobId, "make-due");
  await work(user, started.body.jobId, "run", 1);
  expect(
    (await api.requestGetUserExport(user, [200])).body.job?.downloadUrl,
  ).toBeNull();
  await work(user, started.body.jobId, "run", 200);
  const zip = await completedZip(user, started.body.jobId, storage);
  expect(
    JSON.parse(readExportText(zip, `chat-threads/${thread.id}.json`)),
  ).toMatchObject({
    id: thread.id,
    title: thread.title,
    pinOrder: "a0",
  });
  // An empty thread contributes exactly one entry: no snapshot, no tail, and
  // no per-thread index file. Its bound lives on the thread's manifest record.
  expect(
    zip
      .getEntries()
      .map((entry) => {
        return entry.entryName;
      })
      .filter((path) => {
        return path.startsWith(`chat-messages/${thread.id}/`);
      }),
  ).toStrictEqual([]);
  expect(
    JSON.parse(readExportText(zip, `agents/${agent.agentId}.json`)),
  ).toMatchObject({
    instructions: "Keep this user's instructions intact.",
  });
  expect(
    JSON.parse(readExportText(zip, `workflows/${workflow.body.id}.json`)),
  ).toMatchObject({
    instruction: "Preserve the workflow instruction.",
  });
});

test("recovers the completion email without repeating the export or requiring an optional-email subscription", async () => {
  const user = await actor();
  await updateFeatureSwitchesForUser(context, user, {
    [FeatureSwitchKey.DurableUserExport]: true,
    [FeatureSwitchKey.MorningBrief]: true,
  });
  const subscriptions = setupApp({ context, routes: emailSubscriptionRoutes })(
    emailSubscriptionContract,
  );
  const headers = { authorization: "Bearer clerk-session" };
  await accept(
    subscriptions.update({ headers, body: { subscribed: false } }),
    [200],
  );
  const storage = installDurableUserExportStorage(context);
  const api = createOpsLogsApi(context);
  const outbox = createEmailOutboxStateApi(context);
  mockOptionalEnv("EMAIL_OUTBOX_DRAIN_DELAY_MS", "0");
  context.mocks.resend.send.mockResolvedValue({
    data: { id: `resend_${user.userId}` },
    error: null,
  });
  context.mocks.clerk.users.getUser.mockRejectedValueOnce(
    new Error("Export recipient is temporarily unavailable"),
  );

  const started = await api.requestPostUserExport(user, [202]);
  cleanup(user, started.body.jobId);
  await flushWaitUntilForTest();
  await work(user, started.body.jobId, "run", 200);
  const completed = await api.requestGetUserExport(user, [200]);
  expect(completed.body.job).toMatchObject({
    id: started.body.jobId,
    status: "completed",
    error: null,
  });
  const downloadUrl = completed.body.job?.downloadUrl;
  if (!downloadUrl) {
    throw new Error("The completed export must remain downloadable");
  }
  const original = storage.download(downloadUrl);
  expect(original.byteLength).toBeGreaterThan(0);
  await expect(
    outbox.findItems({ toAddress: user.email, subject: readySubject }),
  ).resolves.toHaveLength(0);
  expect(context.mocks.resend.send).not.toHaveBeenCalled();

  await work(user, started.body.jobId, "make-due");
  await work(user, started.body.jobId, "run", 200);
  await completedZip(user, started.body.jobId, storage);
  expect(storage.download(downloadUrl)).toStrictEqual(original);
  const item = await outbox.findItem({
    toAddress: user.email,
    subject: readySubject,
  });
  await expect(outbox.drainItems([item.id])).resolves.toBe(1);
  await work(user, started.body.jobId, "run", 200);
  await expect(
    outbox.findItems({ toAddress: user.email, subject: readySubject }),
  ).resolves.toHaveLength(1);
  await expect(outbox.drainItems([item.id])).resolves.toBe(0);
  expect(context.mocks.resend.send).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      to: user.email,
      subject: readySubject,
      html: expect.stringContaining(downloadUrl),
      text: expect.stringContaining(downloadUrl),
    }),
    { idempotencyKey: `okou-email-outbox/v1/${item.id}` },
  );
  const sent = context.mocks.resend.send.mock.calls[0]?.[0];
  expect(sent).toMatchObject({
    html: expect.stringContaining("Download data"),
    text: expect.stringContaining(
      "Your requested data export has been completed and is ready to download.",
    ),
  });
  expect(sent).not.toHaveProperty("headers.List-Unsubscribe");
  expect(
    (await accept(subscriptions.get({ headers }), [200])).body.subscribed,
  ).toBeFalsy();
});

test.each(["part", "completion"] as const)(
  "recovers a persisted multipart %s whose response was lost",
  async (boundary) => {
    const user = await actor();
    let loseResponse = true;
    const storage = installDurableUserExportStorage(context, {
      afterWrite: (command) => {
        const matches =
          boundary === "part"
            ? command instanceof UploadPartCommand
            : command instanceof CompleteMultipartUploadCommand;
        if (matches && loseResponse) {
          loseResponse = false;
          return Promise.reject(new Error("Storage committed; response lost"));
        }
        return Promise.resolve();
      },
    });
    const api = createOpsLogsApi(context);
    const started = await api.requestPostUserExport(user, [202]);
    cleanup(user, started.body.jobId);
    await flushWaitUntilForTest();
    await work(user, started.body.jobId, "run", 200);
    const interrupted = await api.requestGetUserExport(user, [200]);
    expect(interrupted.body.job).toMatchObject({
      id: started.body.jobId,
      status: "running",
      downloadUrl: null,
    });
    await work(user, started.body.jobId, "make-due");
    await work(user, started.body.jobId, "run", 200);
    const zip = await completedZip(user, started.body.jobId, storage);
    expect(readExportText(zip, "README.md")).toContain("restore.py");
    await work(user, started.body.jobId, "run", 200);
    await completedZip(user, started.body.jobId, storage);
  },
);

test("an expired worker cannot publish after a replacement finished the export", async () => {
  const user = await actor();
  const entered = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  onTestFinished(() => {
    if (!release.settled()) {
      release.resolve();
    }
  });
  let holdFirstWrite = true;
  const storage = installDurableUserExportStorage(context, {
    afterWrite: async (command) => {
      if (command instanceof PutObjectCommand && holdFirstWrite) {
        holdFirstWrite = false;
        entered.resolve();
        await release.promise;
      }
    },
  });
  const api = createOpsLogsApi(context);
  const started = await api.requestPostUserExport(user, [202]);
  cleanup(user, started.body.jobId);
  await entered.promise;
  await work(user, started.body.jobId, "expire-lease");
  await work(user, started.body.jobId, "run", 200);
  const before = (
    await completedZip(user, started.body.jobId, storage)
  ).toBuffer();
  release.resolve();
  await flushWaitUntilForTest();
  const after = (
    await completedZip(user, started.body.jobId, storage)
  ).toBuffer();
  expect(after).toStrictEqual(before);
});

test.each([false, true])(
  "retains current binary memory and rejects a truncated source (truncated=%s)",
  async (truncated) => {
    const user = await actor();
    const binary = Buffer.from([0, 255, 254, 128, 13, 10, 0, 1, 2]);
    const path = "notes/profile.bin";
    const archive = gzipSync(
      tarArchive([tarEntry({ path, type: "0", content: binary })]),
    );
    const manifest = Buffer.from(
      JSON.stringify({
        version: "export-memory-fixture",
        files: [
          {
            path,
            hash: createHash("sha256").update(binary).digest("hex"),
            size: binary.length,
          },
        ],
        totalSize: binary.length,
      }),
    );
    createStoragesBddApi(context).mockStoragePresignedUrls();
    const memory = await commitMemoryVersion(
      context,
      user,
      [{ path, content: binary }],
      archive.length,
    );
    const storage = installDurableUserExportStorage(context, {
      prefixes: ["exports/", memory.s3Key],
    });
    storage.seedObject(`${memory.s3Key}/manifest.json`, manifest);
    storage.seedObject(
      `${memory.s3Key}/archive.tar.gz`,
      truncated ? archive.subarray(0, -1) : archive,
    );
    const api = createOpsLogsApi(context);
    const started = await api.requestPostUserExport(user, [202]);
    cleanup(user, started.body.jobId);
    await flushWaitUntilForTest();
    if (truncated) {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await work(user, started.body.jobId, "make-due");
        await work(user, started.body.jobId, "run", 200);
      }
      const failed = await api.requestGetUserExport(user, [200]);
      expect(failed.body.job).toMatchObject({
        id: started.body.jobId,
        status: "failed",
        downloadUrl: null,
      });
      expect(failed.body.canExport).toBeTruthy();
      return;
    }
    await work(user, started.body.jobId, "run", 200);
    const zip = await completedZip(user, started.body.jobId, storage);
    const prefix = `memory/${user.orgId}/${memory.storageId}`;
    expect(zip.getEntry(`${prefix}/archive.tar.gz`)?.getData()).toStrictEqual(
      archive,
    );
    expect(zip.getEntry(`${prefix}/manifest.json`)?.getData()).toStrictEqual(
      manifest,
    );
  },
);

test("excludes agents owned by other members from a subject data export", async () => {
  const user = await actor();
  const bdd = createBddApi(context);
  createMiscRoutesApi(context);
  const owner = bdd.user({ orgId: user.orgId });
  const agent = await bdd.createAgent(owner, {
    displayName: "Shared export source",
    visibility: "public",
  });
  const instructions = "A colleague authored these instructions.";
  await bdd.updateAgentInstructions(owner, agent.agentId, instructions);
  const storage = installDurableUserExportStorage(context);
  const api = createOpsLogsApi(context);
  const started = await api.requestPostUserExport(user, [202]);
  cleanup(user, started.body.jobId);
  await flushWaitUntilForTest();
  await work(user, started.body.jobId, "run", 200);
  const zip = await completedZip(user, started.body.jobId, storage);
  // A public agent stays its author's record. Sharing it grants this user read
  // access in the product; it does not make its text this user's export data.
  expect(zip.getEntry(`agents/${agent.agentId}.json`)).toBeNull();
  for (const entry of zip.getEntries()) {
    expect(entry.getData().toString("utf8")).not.toContain(instructions);
  }
});

test("does not publish an export after one of its agents stops being reachable", async () => {
  const user = await actor();
  const bdd = createBddApi(context);
  createMiscRoutesApi(context);
  const agent = await bdd.createAgent(user, {
    displayName: "Own export source",
    visibility: "private",
  });
  await bdd.updateAgentInstructions(
    user,
    agent.agentId,
    "Instruction access will be revoked during export.",
  );
  installDurableUserExportStorage(context);
  const api = createOpsLogsApi(context);
  const started = await api.requestPostUserExport(user, [202]);
  cleanup(user, started.body.jobId);
  await flushWaitUntilForTest();
  for (let step = 0; step < 100; step += 1) {
    const current = await work(user, started.body.jobId, "inspect");
    if (current.state?.phase === "publish") {
      break;
    }
    await work(user, started.body.jobId, "run", 1);
  }
  const publishing = await work(user, started.body.jobId, "inspect");
  expect(publishing.state?.phase).toBe("publish");
  expect(
    (await api.requestGetUserExport(user, [200])).body.job?.downloadUrl,
  ).toBeNull();
  // Authority can change after the earlier paginated authorization pass.
  await bdd.deleteAgent(user, agent.agentId);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await work(user, started.body.jobId, "make-due");
    await work(user, started.body.jobId, "run", 200);
  }
  const result = await api.requestGetUserExport(user, [200]);
  expect(result.body.job).toMatchObject({
    id: started.body.jobId,
    status: "failed",
    downloadUrl: null,
  });
  await expect(
    createEmailOutboxStateApi(context).findItems({
      toAddress: user.email,
      subject: readySubject,
    }),
  ).resolves.toHaveLength(0);
});
