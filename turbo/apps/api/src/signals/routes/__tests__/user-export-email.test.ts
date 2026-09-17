import { randomUUID } from "node:crypto";

import { authContract } from "@okouai/api-contracts/contracts/auth";
import { userExportContract } from "@okouai/api-contracts/contracts/user-export";
import { onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { authMeRoutes } from "../auth-me";
import { userExportRoutes } from "../user-export";
import { createEmailOutboxStateApi } from "./helpers/email-outbox-state";
import {
  ClerkUserNotFoundTestError,
  mockClerkUsers,
} from "./helpers/clerk-users";
import { createRouteMocks } from "./helpers/route-test";

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
  context.mocks.s3.send.mockResolvedValue({});
  context.mocks.resend.send.mockResolvedValue({
    data: { id: `resend_${randomUUID()}` },
    error: null,
  });
  // Provider pacing is independent of export recipient resolution.
  mockOptionalEnv("EMAIL_OUTBOX_DRAIN_DELAY_MS", "0");
  const downloadUrl = `https://r2.example.com/${randomUUID()}/export.zip`;
  context.mocks.s3.getSignedUrl.mockResolvedValue(downloadUrl);
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
  return { userId, email, downloadUrl, outbox };
}

async function exportData(downloadUrl: string) {
  const started = await accept(client().post({ headers }), [202]);
  await flushWaitUntilForTest();
  const status = await accept(client().get({ headers }), [200]);
  expect(status.body.job).toMatchObject({
    id: started.body.jobId,
    status: "completed",
    downloadUrl,
    error: null,
  });
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
    await exportData(current.downloadUrl);
    const item = await current.outbox.findItem({
      toAddress: current.email,
      subject,
    });
    await current.outbox.drainItems([item.id]);
    expect(context.mocks.resend.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        to: current.email,
        subject,
        html: expect.stringContaining(current.downloadUrl),
      }),
      expect.anything(),
    );
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

test.each([
  ["missing user", new ClerkUserNotFoundTestError()],
  ["provider failure", new Error("Clerk export recipient unavailable")],
])(
  "keeps the export downloadable after a %s email lookup",
  async (_label, error) => {
    const current = actor();
    context.mocks.clerk.users.getUser.mockRejectedValue(error);
    await exportData(current.downloadUrl);
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
