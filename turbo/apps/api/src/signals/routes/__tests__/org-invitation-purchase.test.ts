import { randomUUID } from "node:crypto";

import { billingUsagePackCreditsContract } from "@okouai/api-contracts/contracts/billing";
import {
  orgInviteContract,
  orgMembersContract,
} from "@okouai/api-contracts/contracts/org-member-routes";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { number, object, record, string } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { orgInviteRoutes } from "../org-invite";
import { orgReadRoutes } from "../org-read";
import { purchaseUsagePacks } from "./helpers/public-usage-pack-checkout";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const AUTH_HEADERS = Object.freeze({ authorization: "Bearer clerk-session" });
const PRICE_PLAN_PRO = "price_public_usage_plan";
const PRICE_20 = "price_public_usage_20";

const app = setupApp({
  context,
  routes: [
    ...orgInviteRoutes,
    ...orgReadRoutes,
    ...billingUsagePackCreditsRoutes,
  ],
});
const inviteClient = app(orgInviteContract);
const membersClient = app(orgMembersContract);
const creditsClient = app(billingUsagePackCreditsContract);

const previewParamsSchema = object({
  subscription_details: object({
    proration_date: number(),
  }),
});

const invoiceMetadataSchema = object({
  metadata: record(string(), string()).optional(),
});

interface AdminActor {
  readonly userId: string;
  readonly orgId: string;
}

function createAdmin(): AdminActor {
  mockEnv("ENV", "development");
  return { userId: `user_${randomUUID()}`, orgId: `org_${randomUUID()}` };
}

function signIn(actor: AdminActor): void {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    "org:admin",
  );
}

async function setupPaidInvitationWorkspace() {
  const startMs = Date.parse("2035-05-01T00:00:00.000Z");
  mockNow(startMs);
  const owner = createAdmin();
  const paid = await purchaseUsagePacks(
    context,
    owner,
    [{ userId: owner.userId, usd: 20 }],
    { tier: "pro" },
  );
  const firstLine = paid.data.object.lines.data[0];
  if (!firstLine) {
    throw new Error("Expected initial usage pack invoice line");
  }
  const period = firstLine.period;
  const customerId = paid.data.object.customer;
  const subscriptionId =
    paid.data.object.parent.subscription_details.subscription;

  const subscription = {
    id: subscriptionId,
    customer: customerId,
    status: "active",
    cancel_at: null,
    cancel_at_period_end: false,
    schedule: null,
    discounts: [],
    trial_end: null,
    default_payment_method: "pm_saved_card",
    metadata: paid.data.object.metadata,
    items: {
      data: [
        {
          id: "si_plan",
          price: {
            id: PRICE_PLAN_PRO,
            recurring: { interval: "month", interval_count: 1 },
          },
          quantity: 1,
          current_period_start: period.start,
          current_period_end: period.end,
        },
        {
          id: `si_${PRICE_20}`,
          price: { id: PRICE_20 },
          quantity: 1,
          current_period_start: period.start,
          current_period_end: period.end,
        },
      ],
    },
  };
  context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
  context.mocks.stripe.invoices.createPreview.mockImplementation(
    (input: unknown) => {
      const params = previewParamsSchema.parse(input);
      const prorationDate = params.subscription_details.proration_date;
      return Promise.resolve({
        id: `upcoming_${randomUUID()}`,
        currency: "usd",
        automatic_tax: { enabled: false },
        lines: {
          has_more: false,
          data: [
            {
              id: `il_${randomUUID()}`,
              amount: 2000,
              subtotal: 2000,
              discount_amounts: [],
              taxes: [],
              quantity: 1,
              price: { id: PRICE_20 },
              period: { start: prorationDate, end: period.end },
              parent: {
                type: "subscription_item_details",
                subscription_item_details: { proration: true },
              },
            },
          ],
        },
      });
    },
  );

  const invoiceId = `in_${randomUUID()}`;
  const paymentIntentId = `pi_${randomUUID()}`;
  const invoiceMetadata: Record<string, string> = {};
  const makeInvoice = (status: string) => {
    return {
      id: invoiceId,
      status,
      currency: "usd",
      customer: customerId,
      metadata: invoiceMetadata,
    };
  };
  context.mocks.stripe.invoices.create.mockImplementation((input: unknown) => {
    Object.assign(invoiceMetadata, invoiceMetadataSchema.parse(input).metadata);
    return Promise.resolve(makeInvoice("draft"));
  });
  context.mocks.stripe.invoiceItems.create.mockResolvedValue({
    id: `ii_${randomUUID()}`,
  });
  context.mocks.stripe.invoices.finalizeInvoice.mockResolvedValue(
    makeInvoice("open"),
  );
  context.mocks.stripe.invoices.pay.mockResolvedValue(makeInvoice("paid"));
  context.mocks.stripe.invoices.retrieve.mockResolvedValue({
    ...makeInvoice("paid"),
    amount_due: 2000,
    amount_paid: 2000,
    payments: {
      data: [
        {
          status: "paid",
          amount_paid: 2000,
          payment: {
            type: "payment_intent",
            payment_intent: paymentIntentId,
          },
        },
      ],
    },
  });

  const invitationId = `orginv_${randomUUID()}`;
  const inviteeEmail = "invited-member@example.test";
  const invitationCreatedAt = now();
  const createdInvitations: {
    readonly id: string;
    readonly emailAddress: string;
    readonly role: string;
    readonly status: string;
    readonly createdAt: number;
  }[] = [];

  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [
      {
        id: owner.userId,
        firstName: "Admin",
        lastName: "Owner",
        imageUrl: "https://img.example.test/admin.png",
        primaryEmailAddressId: "email_admin",
        emailAddresses: [
          { id: "email_admin", emailAddress: "admin@example.test" },
        ],
      },
    ],
    totalCount: 1,
  });
  context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
    {
      data: [],
      totalCount: 0,
    },
  );
  context.mocks.clerk.organizations.createOrganizationInvitation.mockImplementation(
    () => {
      const invitation = {
        id: invitationId,
        emailAddress: inviteeEmail,
        role: "org:member",
        status: "pending",
        createdAt: invitationCreatedAt,
      };
      createdInvitations.push(invitation);
      context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
        {
          data: [...createdInvitations],
          totalCount: createdInvitations.length,
        },
      );
      return Promise.resolve(invitation);
    },
  );
  server.use(
    http.get(
      "https://api.clerk.com/v1/organizations/:orgId/membership_requests",
      () => {
        return HttpResponse.json({ data: [], total_count: 0 });
      },
    ),
  );

  return {
    owner,
    inviteeEmail,
    invitationId,
    invitationCreatedAt,
  };
}

describe("paid organization invitation purchase", () => {
  it("org-invitation-purchase-001 (1/3) previews a paid 20 USD invitation with a 2000 cent charge", async () => {
    const { owner, inviteeEmail } = await setupPaidInvitationWorkspace();

    signIn(owner);
    const preview = await accept(
      inviteClient.previewPurchase({
        headers: AUTH_HEADERS,
        body: {
          email: inviteeEmail,
          role: "member",
          usagePackUsd: 20,
        },
      }),
      [200],
    );

    expect(preview.body).toMatchObject({
      usagePackUsd: 20,
      immediateAmountCents: 2000,
      currency: "usd",
    });
    expect(context.mocks.stripe.invoices.create).not.toHaveBeenCalled();
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).not.toHaveBeenCalled();
  });

  it("org-invitation-purchase-001 (2/3) confirms a paid 20 USD invitation and shows it in pending invitations", async () => {
    const { owner, inviteeEmail, invitationId, invitationCreatedAt } =
      await setupPaidInvitationWorkspace();

    signIn(owner);
    const preview = await accept(
      inviteClient.previewPurchase({
        headers: AUTH_HEADERS,
        body: {
          email: inviteeEmail,
          role: "member",
          usagePackUsd: 20,
        },
      }),
      [200],
    );

    signIn(owner);
    const confirmed = await accept(
      inviteClient.confirmPurchase({
        headers: AUTH_HEADERS,
        params: { purchaseId: preview.body.purchaseId },
        body: {},
      }),
      [200],
    );
    expect(confirmed.body).toStrictEqual({
      message: "Invitation purchased and sent",
    });

    signIn(owner);
    const membersAfterConfirm = await accept(
      membersClient.members({ headers: AUTH_HEADERS, query: {} }),
      [200],
    );
    expect(membersAfterConfirm.body.pendingInvitations).toStrictEqual([
      {
        id: invitationId,
        email: inviteeEmail,
        role: "member",
        createdAt: new Date(invitationCreatedAt).toISOString(),
        usagePackUsd: 20,
      },
    ]);
  });

  it("org-invitation-purchase-001 (3/3) preserves the pending invitation and usage-pack credit view when confirmation is replayed", async () => {
    const { owner, inviteeEmail, invitationId, invitationCreatedAt } =
      await setupPaidInvitationWorkspace();

    signIn(owner);
    const preview = await accept(
      inviteClient.previewPurchase({
        headers: AUTH_HEADERS,
        body: {
          email: inviteeEmail,
          role: "member",
          usagePackUsd: 20,
        },
      }),
      [200],
    );

    signIn(owner);
    await accept(
      inviteClient.confirmPurchase({
        headers: AUTH_HEADERS,
        params: { purchaseId: preview.body.purchaseId },
        body: {},
      }),
      [200],
    );

    signIn(owner);
    const creditsBeforeReplay = await accept(
      creditsClient.get({ headers: AUTH_HEADERS }),
      [200],
    );

    context.mocks.stripe.invoices.create.mockRejectedValue(
      new Error("Should not create a second Stripe invoice on replay"),
    );
    context.mocks.clerk.organizations.createOrganizationInvitation.mockRejectedValue(
      new Error("Should not create a second Clerk invitation on replay"),
    );

    signIn(owner);
    const replayed = await accept(
      inviteClient.confirmPurchase({
        headers: AUTH_HEADERS,
        params: { purchaseId: preview.body.purchaseId },
        body: {},
      }),
      [200],
    );
    expect(replayed.body).toStrictEqual({
      message: "Invitation purchased and sent",
    });

    signIn(owner);
    const [membersAfterReplay, creditsAfterReplay] = await Promise.all([
      accept(
        membersClient.members({ headers: AUTH_HEADERS, query: {} }),
        [200],
      ),
      accept(creditsClient.get({ headers: AUTH_HEADERS }), [200]),
    ]);
    expect(membersAfterReplay.body.pendingInvitations).toStrictEqual([
      {
        id: invitationId,
        email: inviteeEmail,
        role: "member",
        createdAt: new Date(invitationCreatedAt).toISOString(),
        usagePackUsd: 20,
      },
    ]);
    expect(creditsAfterReplay.body).toStrictEqual(creditsBeforeReplay.body);
  });
});
