import { expect } from "vitest";
import type { TestContext } from "../../../../__tests__/test-context";
import type { ApiTestUser } from "./api-bdd";
import { createBillingMediaApi } from "./api-bdd-billing-media";

/** Settle only the owned organization, then read its complete public reports. */
export async function observePublicUsage(
  context: TestContext,
  actor: ApiTestUser,
) {
  const billing = createBillingMediaApi(context);
  await billing.processOrgUsageEvents(actor);
  const record = (await billing.readUsageRecord(actor, "7d")).body;
  // Never mistake the first page for the complete owned population.
  expect(record.pagination.total).toBe(record.rows.length);
  const members = (
    await billing.readUsageMembers(actor, { range: "7d", tz: "UTC" })
  ).body.members;
  const credits = (await billing.readBillingStatus(actor)).credits;
  return { record, members, credits };
}
