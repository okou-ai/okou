import { randomUUID } from "node:crypto";
import { billingPortalContract } from "@okouai/api-contracts/contracts/billing";
import { expect, test } from "vitest";

import { accept, testContext } from "../../__tests__/test-context";
import { setupApp } from "../../__tests__/test-helpers";
import { createRouteMocks } from "../../signals/routes/__tests__/helpers/route-test";
import { billingPortalRoutes } from "../../signals/routes/billing-portal";
import { mockEnv } from "../env";
import { now } from "../time";

const context = testContext();

const PREVIEW_APP_URL = "https://app.vm7.ai:8443";
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

/** A preview deployment whose app origin is PREVIEW_APP_URL; an org admin opens billing. */
function previewAdmin() {
  mockEnv("ENV", "preview");
  mockEnv("APP_URL", PREVIEW_APP_URL);
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  createRouteMocks(context).clerk.session(userId, orgId, "org:admin");
  context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
    id: orgId,
    slug: `redirect-${orgId.slice(-8)}`,
    name: "Billing Redirect Org",
    createdBy: userId,
    createdAt: now(),
  });
  return setupApp({ context, routes: billingPortalRoutes })(
    billingPortalContract,
  );
}

test("billing-redirect-002 preview billing refuses a return to a non-App origin", async () => {
  const portal = previewAdmin();

  const response = await accept(
    portal.create({
      headers,
      body: { returnUrl: "https://example.com/onboarding?billing=success" },
    }),
    [400],
  );

  expect(response.body.error.message).toBe(
    "returnUrl must match the platform origin",
  );
  expect(
    context.mocks.stripe.billingPortal.sessions.create,
  ).not.toHaveBeenCalled();
});

test("billing-redirect-001 preview billing accepts a return to the configured app origin", async () => {
  const portal = previewAdmin();
  context.mocks.stripe.customers.create.mockResolvedValue({
    id: `cus_${randomUUID().slice(0, 8)}`,
  });
  context.mocks.stripe.billingPortal.configurations.list.mockResolvedValue({
    data: [],
    has_more: false,
  });
  context.mocks.stripe.billingPortal.configurations.create.mockResolvedValue({
    id: "bpc_payment_methods",
    active: true,
    features: {
      customer_update: { enabled: false },
      invoice_history: { enabled: false },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: false },
      subscription_update: { enabled: false },
    },
    login_page: { enabled: false },
    metadata: { purpose: "payment_method_management" },
  });
  const url = `https://billing.stripe.test/session/${randomUUID()}`;
  context.mocks.stripe.billingPortal.sessions.create.mockResolvedValue({
    id: `bps_${randomUUID()}`,
    url,
  });
  const returnUrl = `${PREVIEW_APP_URL}/onboarding?billing=success`;

  const response = await accept(
    portal.create({ headers, body: { returnUrl } }),
    [200],
  );

  expect(response.body).toStrictEqual({ url });
  expect(
    context.mocks.stripe.billingPortal.sessions.create,
  ).toHaveBeenCalledWith(expect.objectContaining({ return_url: returnUrl }));
});
