import { mockClerkUsers } from "./clerk-users";
import { randomUUID } from "node:crypto";

import type { TestEmailOutboxStateItem } from "@okouai/api-contracts/contracts/test-email-outbox-state";
import { userExportContract } from "@okouai/api-contracts/contracts/user-export";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { userExportRoutes } from "../../user-export";
import type { ApiTestUser } from "./api-bdd";
import { createEmailOutboxStateApi } from "./email-outbox-state";
import { createRouteMocks } from "./route-test";

function emailApp(context: TestContext) {
  return setupApp({ context, routes: userExportRoutes });
}

function authenticate(context: TestContext, actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  const emailId = `email_${actor.userId}`;
  mockClerkUsers(context, [
    {
      id: actor.userId,
      emailAddresses: [{ id: emailId, emailAddress: actor.email }],
      primaryEmailAddressId: emailId,
      firstName: "BDD",
      lastName: "Email",
    },
  ]);
  return { authorization: "Bearer clerk-session" };
}

export function createEmailApi(context: TestContext) {
  const outbox = createEmailOutboxStateApi(context);

  return {
    async enqueueDataExportEmail(
      actor: ApiTestUser,
    ): Promise<{ readonly to: string; readonly subject: string }> {
      context.mocks.s3.send.mockResolvedValue({});
      context.mocks.s3.getSignedUrl.mockResolvedValue(
        `https://r2.example.com/${randomUUID()}/data-export.zip`,
      );
      const started = await accept(
        emailApp(context)(userExportContract).post({
          headers: authenticate(context, actor),
        }),
        [202],
      );
      await flushWaitUntilForTest();
      const status = await accept(
        emailApp(context)(userExportContract).get({
          headers: authenticate(context, actor),
        }),
        [200],
      );
      if (
        status.body.job?.id !== started.body.jobId ||
        status.body.job.status !== "completed"
      ) {
        throw new Error("Expected the data export email job to complete");
      }
      const subject = "Your data export is ready";
      return { to: actor.email, subject };
    },

    async findEmailOutboxItems(options: {
      readonly to: string;
      readonly subject: string;
    }): Promise<readonly TestEmailOutboxStateItem[]> {
      return await outbox.findItems({
        toAddress: options.to,
        subject: options.subject,
      });
    },

    async findEmailOutboxItem(options: {
      readonly to: string;
      readonly subject: string;
    }): Promise<TestEmailOutboxStateItem> {
      return await outbox.findItem({
        toAddress: options.to,
        subject: options.subject,
      });
    },

    async drainEmailOutboxItems(itemIds: readonly string[]): Promise<number> {
      return await outbox.drainItems(itemIds);
    },
  };
}
