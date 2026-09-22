import { randomUUID } from "node:crypto";

import { CompleteMultipartUploadCommand } from "@aws-sdk/client-s3";
import { authContract } from "@okouai/api-contracts/contracts/auth";
import { emailSubscriptionContract } from "@okouai/api-contracts/contracts/email-subscription";
import { testUserExportWorkContract } from "@okouai/api-contracts/contracts/test-user-export-work";
import { userExportContract } from "@okouai/api-contracts/contracts/user-export";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { authMeRoutes } from "../auth-me";
import { emailSubscriptionRoutes } from "../email-subscription";
import { testUserExportWorkRoutes } from "../test-user-export-work";
import { userExportRoutes } from "../user-export";
import { createEmailOutboxStateApi } from "./helpers/email-outbox-state";
import {
  ClerkUserNotFoundTestError,
  mockClerkUsers,
} from "./helpers/clerk-users";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import { installDurableUserExportStorage } from "./helpers/durable-user-export-storage";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const subject = "Your data export is ready";

function client() {
  return setupApp({ context, routes: userExportRoutes })(userExportContract);
}

function actor() {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  const email = `${userId}@example.test`;
  createRouteMocks(context).clerk.session(userId, orgId);
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [{ organization: { id: orgId }, role: "org:member" }],
    totalCount: 1,
  });
  mockClerkUsers(context, [
    {
      id: userId,
      primaryEmailAddressId: "primary",
      emailAddresses: [
        { id: "secondary", emailAddress: `secondary-${email}` },
        { id: "primary", emailAddress: email },
      ],
      firstName: "Export",
      lastName: "User",
      imageUrl: "https://images.example.test/export-user.png",
    },
  ]);
  installDurableUserExportStorage(context);
  context.mocks.resend.send.mockResolvedValue({
    data: { id: `resend_${randomUUID()}` },
    error: null,
  });
  // Provider pacing is independent of export recipient resolution.
  mockOptionalEnv("EMAIL_OUTBOX_DRAIN_DELAY_MS", "0");
  const outbox = createEmailOutboxStateApi(context);
  onTestFinished(async () => {
    const items = await outbox.findItems({ toAddress: email, subject });
    if (items.length > 0) {
      await outbox.deleteItems(
        items.map((item) => {
          return item.id;
        }),
      );
    }
  });
  return { userId, orgId, email, outbox };
}

async function exportData(userId: string): Promise<string> {
  const started = await accept(client().post({ headers }), [202]);
  await flushWaitUntilForTest();
  await accept(
    setupApp({ context, routes: testUserExportWorkRoutes })(
      testUserExportWorkContract,
    ).action({
      body: {
        action: "run",
        userId,
        jobId: started.body.jobId,
        maxSteps: 200,
      },
    }),
    [200],
  );
  const status = await accept(client().get({ headers }), [200]);
  expect(status.body.job).toMatchObject({
    id: started.body.jobId,
    status: "completed",
    downloadUrl: expect.any(String),
    error: null,
  });
  if (!status.body.job?.downloadUrl) {
    throw new Error("Expected a downloadable completed export");
  }
  return status.body.job.downloadUrl;
}

test.each(["cold", "warm"])(
  "delivers export email with a %s user cache",
  async (cache) => {
    const current = actor();
    if (cache === "warm") {
      await accept(
        setupApp({ context, routes: authMeRoutes })(authContract).me({
          headers,
        }),
        [200],
      );
      context.mocks.clerk.users.getUser.mockClear();
      context.mocks.clerk.users.getUser.mockRejectedValue(
        new Error("Cache should remain available"),
      );
    }
    const downloadUrl = await exportData(current.userId);
    const item = await current.outbox.findItem({
      toAddress: current.email,
      subject,
    });
    await current.outbox.drainItems([item.id]);
    expect(context.mocks.resend.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        to: current.email,
        subject,
        html: expect.stringContaining(downloadUrl),
        text: expect.stringContaining(downloadUrl),
      }),
      expect.anything(),
    );
    const sent = context.mocks.resend.send.mock.calls[0]?.[0];
    expect(sent).toMatchObject({
      html: expect.stringContaining(
        "Your requested data export has been completed and is ready to download.",
      ),
      text: expect.stringMatching(
        /This download is available until .+ at \d{1,2}:\d{2} [AP]M UTC\./,
      ),
    });
    expect(sent).toMatchObject({
      html: expect.stringContaining("Download data"),
      text: expect.stringContaining(
        "If the link expires, request a new export from your account settings.",
      ),
    });
    expect(sent).not.toHaveProperty("headers.List-Unsubscribe");
    expect(context.mocks.clerk.users.getUser).toHaveBeenCalledTimes(
      cache === "cold" ? 1 : 0,
    );
    if (cache === "cold") {
      expect(context.mocks.clerk.users.getUser).toHaveBeenCalledWith(
        current.userId,
      );
    }
    expect(context.mocks.clerk.users.getUserList).not.toHaveBeenCalled();
  },
);

test("sends a requested export once after completion even when optional emails are disabled", async () => {
  const current = actor();
  await updateFeatureSwitchesForUser(context, current, {
    [FeatureSwitchKey.MorningBrief]: true,
  });
  const subscriptions = setupApp({ context, routes: emailSubscriptionRoutes })(
    emailSubscriptionContract,
  );
  await accept(
    subscriptions.update({ headers, body: { subscribed: false } }),
    [200],
  );
  const entered = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  let blockCompletion = false;
  onTestFinished(() => {
    if (!release.settled()) {
      release.resolve();
    }
  });
  const storage = context.mocks.s3.send.getMockImplementation();
  context.mocks.s3.send.mockImplementation(async (command: unknown) => {
    if (command instanceof CompleteMultipartUploadCommand && blockCompletion) {
      entered.resolve();
      await release.promise;
    }
    return (await storage?.(command)) ?? {};
  });

  const started = await accept(client().post({ headers }), [202]);
  await flushWaitUntilForTest();
  blockCompletion = true;
  const worker = accept(
    setupApp({ context, routes: testUserExportWorkRoutes })(
      testUserExportWorkContract,
    ).action({
      body: {
        action: "run",
        userId: current.userId,
        jobId: started.body.jobId,
        maxSteps: 200,
      },
    }),
    [200],
  );
  await entered.promise;
  expect(
    (await accept(client().get({ headers }), [200])).body.job,
  ).toMatchObject({
    id: started.body.jobId,
    status: "running",
    downloadUrl: null,
  });
  const repeated = await accept(client().post({ headers }), [202]);
  expect(repeated.body.jobId).toBe(started.body.jobId);
  await expect(
    current.outbox.findItems({ toAddress: current.email, subject }),
  ).resolves.toHaveLength(0);
  expect(context.mocks.resend.send).not.toHaveBeenCalled();

  release.resolve();
  await worker;
  const completed = await accept(client().get({ headers }), [200]);
  expect(completed.body.job).toMatchObject({
    id: started.body.jobId,
    status: "completed",
    downloadUrl: expect.any(String),
  });
  const downloadUrl = completed.body.job?.downloadUrl;
  if (!downloadUrl) {
    throw new Error("Expected a downloadable completed export");
  }
  const item = await current.outbox.findItem({
    toAddress: current.email,
    subject,
  });
  await expect(current.outbox.drainItems([item.id])).resolves.toBe(1);
  await expect(current.outbox.drainItems([item.id])).resolves.toBe(0);
  expect(context.mocks.resend.send).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      to: current.email,
      subject,
      text: expect.stringContaining(downloadUrl),
    }),
    expect.anything(),
  );
  expect(
    (await accept(subscriptions.get({ headers }), [200])).body.subscribed,
  ).toBeFalsy();
});

test.each([
  ["missing user", new ClerkUserNotFoundTestError()],
  ["provider failure", new Error("Clerk export recipient unavailable")],
])(
  "keeps the export downloadable after a %s email lookup",
  async (_label, error) => {
    const current = actor();
    context.mocks.clerk.users.getUser.mockRejectedValue(error);
    await exportData(current.userId);
    const items = await current.outbox.findItems({
      toAddress: current.email,
      subject,
    });
    if (items.length > 0) {
      await current.outbox.drainItems(
        items.map((item) => {
          return item.id;
        }),
      );
    }
    expect(context.mocks.resend.send).not.toHaveBeenCalled();
    expect(context.mocks.clerk.users.getUser).toHaveBeenCalledExactlyOnceWith(
      current.userId,
    );
    expect(context.mocks.clerk.users.getUserList).not.toHaveBeenCalled();
  },
);
