import { onTestFinished, type Mock } from "vitest";
import type { TestContext } from "../../../../__tests__/test-context";
import { now, withMockNowForTest } from "../../../../lib/time";
import { env, mockEnv } from "../../../../lib/env";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { settleIncludingAbort } from "../../../utils";
import { createBddApi } from "./api-bdd";
import { captureConnectorExternalState } from "./public-connector-actor";
import { createFixtureOperationOwner } from "./fixture-operation-owner";
import { deletePublicWorkspace } from "./public-workspace-cleanup";
import type { BillingOrgFixture } from "./billing-checkout-fixture";

/** Keep the same provider response cursor when an accepted request outlives afterEach. */
export function retainBillingSequence<Result>(
  mock: Mock<(...args: unknown[]) => Result>,
  stages: readonly ((...args: unknown[]) => Result)[],
  fallback = mock.getMockImplementation(),
): void {
  let cursor = 0;
  mock.mockImplementation((...args: unknown[]) => {
    const phase = cursor < stages.length ? stages[cursor++] : fallback;
    return phase?.(...args) as Result;
  });
}

function captureBillingState(context: TestContext) {
  const base = captureConnectorExternalState(context, [
    "STRIPE_SECRET_KEY",
    "OKOU_PREVIEW_JOB_REF",
    "OKOU_SEO_DATAFORSEO_LOGIN",
    "OKOU_SEO_DATAFORSEO_PASSWORD",
    "OKOU_PRICE_CUSTOM_CREDIT_UNIT",
  ]);
  const prices = (
    [
      "OKOU_PRICE_USAGE_PACK_PLAN_PRO",
      "OKOU_PRICE_USAGE_PACK_PLAN_TEAM",
      "OKOU_PRICE_USAGE_PACK_20",
      "OKOU_PRICE_USAGE_PACK_50",
      "OKOU_PRICE_USAGE_PACK_100",
      "OKOU_PRICE_USAGE_PACK_200",
      "OKOU_PRICE_CUSTOM",
    ] as const
  ).map((name) => {
    return [name, env(name)] as const;
  });
  const environment = env("ENV");
  function retain<T extends (...args: never[]) => unknown>(mock: Mock<T>) {
    const implementation = mock.getMockImplementation();
    return () => {
      mock.mockReset();
      if (implementation) {
        mock.mockImplementation(implementation);
      }
    };
  }
  const stripe = context.mocks.stripe;
  const clerk = context.mocks.clerk;
  const restore = [
    retain(stripe.customers.create),
    retain(stripe.customers.update),
    retain(stripe.prices.retrieve),
    retain(stripe.paymentMethods.list),
    retain(stripe.paymentMethods.retrieve),
    retain(stripe.checkout.sessions.create),
    retain(stripe.checkout.sessions.retrieve),
    retain(stripe.checkout.sessions.expire),
    retain(stripe.subscriptions.create),
    retain(stripe.subscriptions.update),
    retain(stripe.subscriptions.cancel),
    retain(stripe.subscriptionSchedules.create),
    retain(stripe.subscriptionSchedules.retrieve),
    retain(stripe.subscriptionSchedules.update),
    retain(stripe.subscriptionSchedules.release),
    retain(stripe.invoices.createPreview),
    retain(stripe.invoices.create),
    retain(stripe.invoices.finalizeInvoice),
    retain(stripe.invoices.pay),
    retain(stripe.invoices.retrieve),
    retain(stripe.invoices.listLineItems),
    retain(stripe.invoices.voidInvoice),
    retain(stripe.invoiceItems.create),
    retain(stripe.refunds.list),
    retain(stripe.refunds.create),
    retain(stripe.refunds.retrieve),
    retain(stripe.creditNotes.preview),
    retain(stripe.creditNotes.create),
    retain(stripe.creditNotes.list),
    retain(stripe.creditNotes.retrieve),
    retain(clerk.organizations.getOrganizationInvitationList),
    retain(clerk.organizations.createOrganizationInvitation),
    retain(clerk.organizations.revokeOrganizationInvitation),
    retain(clerk.organizations.deleteOrganizationMembership),
    retain(context.mocks.signalTimers.delay),
  ];
  return () => {
    base();
    mockEnv("ENV", environment);
    for (const [name, value] of prices) {
      mockEnv(name, value?.join(","));
    }
    for (const apply of restore) {
      apply();
    }
  };
}

/** Register a case before its first ordinary write; no business-row cleanup. */
export function createPublicBillingScenario(context: TestContext) {
  const workspaces = new Map<string, BillingOrgFixture>();
  const releases: (() => void)[] = [];
  const stripeEvents = new Map<string, { event: object; remaining: number }>();
  const clerkEvents = new Map<string, { event: object; remaining: number }>();
  function registerEvent(
    events: Map<string, { event: object; remaining: number }>,
    event: object,
  ) {
    const body = JSON.stringify(event);
    const prior = events.get(body);
    events.set(body, { event, remaining: (prior?.remaining ?? 0) + 1 });
  }
  function consumeEvent(
    events: Map<string, { event: object; remaining: number }>,
    body: unknown,
  ) {
    const value = typeof body === "string" ? events.get(body) : undefined;
    if (!value || value.remaining === 0) {
      throw new Error(
        "Unexpected billing webhook body or duplicate verification",
      );
    }
    value.remaining -= 1;
    return value.event;
  }
  let accepted = captureBillingState(context);
  let acceptedTime = now();
  let previous: (() => void) | undefined;
  onTestFinished(() => {
    previous?.();
  });
  const owner = createFixtureOperationOwner(
    async () => {
      return await withMockNowForTest(acceptedTime, async () => {
        const errors: unknown[] = [];
        async function settle(operation: () => Promise<unknown>) {
          const result = await settleIncludingAbort(operation);
          if (!result.ok) {
            errors.push(result.error);
          }
        }
        await settle(flushWaitUntilForTest);
        for (const fixture of workspaces.values()) {
          await settle(() => {
            return deletePublicWorkspace(
              context,
              createBddApi(context).user(fixture),
            );
          });
        }
        await settle(flushWaitUntilForTest);
        if (errors.length) {
          throw new AggregateError(errors, "Billing scenario cleanup failed");
        }
      });
    },
    {
      continueAcceptedOperations: true,
      beforeDrain() {
        previous ??= captureBillingState(context);
        accepted();
        for (const release of releases) {
          release();
        }
      },
    },
  );
  return {
    expectStripeEvent(event: object) {
      registerEvent(stripeEvents, event);
      context.mocks.stripe.webhooks.constructEvent.mockImplementation(
        (body) => {
          return consumeEvent(stripeEvents, body);
        },
      );
    },
    expectClerkEvent(event: object) {
      registerEvent(clerkEvents, event);
      context.mocks.clerk.verifyWebhook.mockImplementation(async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("Expected the actual Clerk webhook Request");
        }
        return consumeEvent(clerkEvents, await request.clone().text());
      });
    },
    own<T extends BillingOrgFixture>(fixture: T): T {
      workspaces.set(fixture.orgId, fixture);
      return fixture;
    },
    run<T>(operation: () => Promise<T>): Promise<T> {
      return owner.run(() => {
        const pending = settleIncludingAbort(operation);
        accepted = captureBillingState(context);
        acceptedTime = now();
        return pending.then((result) => {
          if (!result.ok) {
            throw result.error;
          }
          return result.value;
        });
      });
    },
    captureExternalState() {
      accepted = captureBillingState(context);
      acceptedTime = now();
    },
    releaseBeforeDrain(release: () => void) {
      releases.push(release);
    },
  };
}
export type PublicBillingScenario = ReturnType<
  typeof createPublicBillingScenario
>;
