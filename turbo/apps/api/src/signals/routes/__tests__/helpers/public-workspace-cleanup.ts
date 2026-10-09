import type { TestContext } from "../../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import type { ApiTestUser } from "./api-bdd";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";

/** Deliver Clerk's normal deletion event after the workspace's Runs settle. */
export async function deletePublicWorkspace(
  context: TestContext,
  actor: ApiTestUser,
): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Expected an owned workspace to clean up");
  }
  context.mocks.s3.send.mockResolvedValue({ Contents: [], IsTruncated: false });
  context.mocks.stripe.subscriptions.list.mockResolvedValue({
    data: [],
    has_more: false,
  });
  context.mocks.stripe.invoices.list.mockResolvedValue({
    data: [],
    has_more: false,
  });
  const webhooks = createWebhookCallbackApi(context);
  webhooks.configureStripeBillingEnv();
  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "organization.deleted",
    data: { id: actor.orgId },
  });
  await webhooks.requestClerkWebhook("{}", {}, [200]);
  await flushWaitUntilForTest();
  // The deleted identity is not used to authenticate any later observation.
}
