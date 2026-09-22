import { PutObjectCommand } from "@aws-sdk/client-s3";
import { testUserExportWorkContract } from "@okouai/api-contracts/contracts/test-user-export-work";
import { onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow, nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { testUserExportWorkRoutes } from "../test-user-export-work";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createOpsLogsApi } from "./helpers/api-bdd-ops-logs";
import { installDurableUserExportStorage } from "./helpers/durable-user-export-storage";
import { createEmailOutboxStateApi } from "./helpers/email-outbox-state";

const context = testContext();
type WorkAction = "run" | "inspect" | "cleanup" | "make-cleanup-due" | "delete";

async function work(
  user: ApiTestUser,
  jobId: string,
  action: WorkAction,
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

function createActor() {
  const user = createBddApi(context).user();
  if (!user.orgId) {
    throw new Error("Export cleanup tests require an organization");
  }
  return { ...user, orgId: user.orgId };
}

function registerCleanup(user: ApiTestUser, jobId: string) {
  onTestFinished(async () => {
    clearMockNow();
    await work(user, jobId, "delete");
    const outbox = createEmailOutboxStateApi(context);
    const emails = await outbox.findItems({
      toAddress: user.email,
      subject: "Your data export is ready",
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

async function completedExport(user: ApiTestUser) {
  const api = createOpsLogsApi(context);
  const started = await api.requestPostUserExport(user, [202]);
  registerCleanup(user, started.body.jobId);
  await flushWaitUntilForTest();
  await work(user, started.body.jobId, "run", 200);
  const completed = await api.requestGetUserExport(user, [200]);
  expect(completed.body.job).toMatchObject({
    id: started.body.jobId,
    status: "completed",
  });
  if (!completed.body.job?.downloadUrl) {
    throw new Error("Expected the export download");
  }
  return {
    jobId: started.body.jobId,
    downloadUrl: completed.body.job.downloadUrl,
  };
}

test("cleans staging in bounded pages, retaining the result download until its expiry", async () => {
  const user = createActor();
  const storage = installDurableUserExportStorage(context);
  const result = await completedExport(user);
  const original = storage.download(result.downloadUrl);
  const prefix = `exports/${user.userId}/${result.jobId}/staging/`;
  const unrelated = `exports/${user.userId}/another-job/staging/keep`;
  storage.seedObject(unrelated, Buffer.from("unrelated source"));
  for (let index = 0; index < 1001; index += 1) {
    storage.seedObject(
      `${prefix}extra-${String(index).padStart(4, "0")}`,
      Buffer.from("staged"),
    );
  }
  const before = storage.objectKeys(prefix).length;
  await work(user, result.jobId, "make-cleanup-due");
  await expect(work(user, result.jobId, "cleanup")).resolves.toMatchObject({
    processed: 1,
  });
  expect(storage.objectKeys(prefix)).toHaveLength(before - 1000);
  await expect(work(user, result.jobId, "inspect")).resolves.toMatchObject({
    state: { status: "completed" },
  });

  await work(user, result.jobId, "make-cleanup-due");
  await work(user, result.jobId, "cleanup");
  expect(storage.objectKeys(prefix)).toHaveLength(0);
  expect(storage.hasObject(unrelated)).toBeTruthy();
  expect(storage.download(result.downloadUrl)).toStrictEqual(original);
  await expect(work(user, result.jobId, "inspect")).resolves.toMatchObject({
    state: null,
  });
  const status = await createOpsLogsApi(context).requestGetUserExport(
    user,
    [200],
  );
  expect(status.body.job).toMatchObject({
    id: result.jobId,
    status: "completed",
    downloadUrl: expect.any(String),
  });
});

test("reclaims an expired completed export and its durable inventory", async () => {
  const user = createActor();
  const storage = installDurableUserExportStorage(context);
  const result = await completedExport(user);
  const api = createOpsLogsApi(context);
  const before = await api.requestGetUserExport(user, [200]);
  if (!before.body.job?.expiresAt) {
    throw new Error("Expected a completed export expiry");
  }
  mockNow(new Date(before.body.job.expiresAt));
  await work(user, result.jobId, "cleanup");
  expect(
    storage.hasObject(`exports/${user.userId}/${result.jobId}.zip`),
  ).toBeFalsy();
  expect(
    storage.objectKeys(`exports/${user.userId}/${result.jobId}/staging/`),
  ).toHaveLength(0);
  await expect(work(user, result.jobId, "inspect")).resolves.toMatchObject({
    state: null,
  });
  const expired = await api.requestGetUserExport(user, [200]);
  expect(expired.body.job).toMatchObject({
    id: result.jobId,
    status: "completed",
    downloadUrl: null,
  });
});

test("reclaims unrecorded multipart uploads only after their provider-side grace period", async () => {
  const user = createActor();
  const storage = installDurableUserExportStorage(context);
  const result = await completedExport(user);
  const current = nowDate();
  const key = `exports/${user.userId}/${result.jobId}.zip`;
  const oldUpload = storage.seedMultipartUpload(
    key,
    new Date(current.getTime() - 10 * 60_000),
  );
  const youngUpload = storage.seedMultipartUpload(key, current);

  await work(user, result.jobId, "make-cleanup-due");
  await work(user, result.jobId, "cleanup");
  expect(storage.hasMultipartUpload(oldUpload)).toBeFalsy();
  expect(storage.hasMultipartUpload(youngUpload)).toBeTruthy();
  expect(storage.hasObject(key)).toBeTruthy();
  await expect(work(user, result.jobId, "inspect")).resolves.toMatchObject({
    state: { status: "completed" },
  });

  mockNow(new Date(current.getTime() + 4 * 60_000));
  await work(user, result.jobId, "make-cleanup-due");
  await work(user, result.jobId, "cleanup");
  expect(storage.hasMultipartUpload(youngUpload)).toBeFalsy();
  expect(storage.hasObject(key)).toBeTruthy();
  await expect(work(user, result.jobId, "inspect")).resolves.toMatchObject({
    state: null,
  });
});

test("does not delete staged data or abort uploads while an export worker still owns its job", async () => {
  const user = createActor();
  const entered = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  let held = false;
  const storage = installDurableUserExportStorage(context, {
    afterWrite: async (command) => {
      if (command instanceof PutObjectCommand && !held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
    },
  });
  onTestFinished(async () => {
    if (!release.settled()) {
      release.resolve();
    }
    await flushWaitUntilForTest();
  });
  const started = await createOpsLogsApi(context).requestPostUserExport(
    user,
    [202],
  );
  registerCleanup(user, started.body.jobId);
  await entered.promise;
  const key = `exports/${user.userId}/${started.body.jobId}.zip`;
  const upload = storage.seedMultipartUpload(
    key,
    new Date(nowDate().getTime() - 10 * 60_000),
  );
  const prefix = `exports/${user.userId}/${started.body.jobId}/staging/`;
  const before = storage.objectKeys(prefix);

  await work(user, started.body.jobId, "make-cleanup-due");
  await expect(
    work(user, started.body.jobId, "cleanup"),
  ).resolves.toMatchObject({ processed: 0 });
  expect(storage.objectKeys(prefix)).toStrictEqual(before);
  expect(storage.hasMultipartUpload(upload)).toBeTruthy();
  release.resolve();
  await flushWaitUntilForTest();
});
