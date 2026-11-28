import { randomUUID } from "node:crypto";
import { emailSubscriptionContract } from "@okouai/api-contracts/contracts/email-subscription";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { emailSubscriptionRoutes } from "../email-subscription";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { ClerkUserNotFoundTestError } from "./helpers/clerk-users";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const webhooks = createWebhookCallbackApi(context);

interface Member {
  readonly userId: string;
  readonly orgId: string;
  readonly email: string;
}

interface ClerkProfile {
  readonly id: string;
  readonly emailAddresses: readonly {
    readonly id: string;
    readonly emailAddress: string;
  }[];
  readonly primaryEmailAddressId: string;
}

function member(): Member {
  const userId = `user_${randomUUID()}`;
  return {
    userId,
    orgId: `org_${randomUUID()}`,
    email: `${userId}@example.test`,
  };
}

function profile(user: Member): ClerkProfile {
  return {
    id: user.userId,
    emailAddresses: [{ id: `email_${user.userId}`, emailAddress: user.email }],
    primaryEmailAddressId: `email_${user.userId}`,
  };
}

/** Clerk's user directory: lookups by ID and by email address. */
function clerkDirectory(profiles: readonly ClerkProfile[]): void {
  context.mocks.clerk.users.getUser.mockImplementation((userId: unknown) => {
    const found = profiles.find((candidate) => {
      return candidate.id === userId;
    });
    return found
      ? Promise.resolve(found)
      : Promise.reject(new ClerkUserNotFoundTestError());
  });
  context.mocks.clerk.users.getUserList.mockImplementation(
    (params: unknown) => {
      const wanted =
        typeof params === "object" &&
        params !== null &&
        "emailAddress" in params &&
        Array.isArray(params.emailAddress)
          ? params.emailAddress.map((address) => {
              return String(address).toLowerCase();
            })
          : [];
      return Promise.resolve({
        data: profiles.filter((candidate) => {
          return candidate.emailAddresses.some((entry) => {
            return wanted.includes(entry.emailAddress.toLowerCase());
          });
        }),
      });
    },
  );
}

function providerLookups(userId: string): number {
  return context.mocks.clerk.users.getUser.mock.calls.filter((call) => {
    return call[0] === userId;
  }).length;
}

function preferences(user: Member, orgId = user.orgId) {
  createRouteMocks(context).clerk.session(user.userId, orgId);
  return setupApp({ context, routes: emailSubscriptionRoutes })(
    emailSubscriptionContract,
  );
}

async function readPreference(user: Member, orgId = user.orgId) {
  const response = await accept(
    preferences(user, orgId).get({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
  return response.body;
}

async function updatePreference(user: Member, subscribed: boolean) {
  const response = await accept(
    preferences(user).update({
      headers: { authorization: "Bearer clerk-session" },
      body: { subscribed },
    }),
    [200],
  );
  return response.body;
}

async function deliverResendEvent(
  type: "email.bounced" | "email.complained",
  to: string,
) {
  webhooks.configureResendWebhookSecret();
  const event = {
    type,
    created_at: new Date(now()).toISOString(),
    data: { email_id: randomUUID(), to: [to] },
  };
  return await webhooks.requestResendInboundWebhook(
    event,
    webhooks.signedResendWebhookHeaders(event),
    [200],
  );
}

describe("email subscription preferences", () => {
  it("email-subscription-001 keeps the member's choice across workspaces without affecting other users", async () => {
    const owner = member();
    const other = member();
    clerkDirectory([profile(owner), profile(other)]);

    await expect(readPreference(owner)).resolves.toStrictEqual({
      subscribed: true,
      email: owner.email,
      deliveryStatus: "available",
    });
    await updatePreference(owner, false);
    await expect(
      readPreference(owner, `org_${randomUUID()}`),
    ).resolves.toMatchObject({ subscribed: false });
    await expect(readPreference(other)).resolves.toMatchObject({
      subscribed: true,
      email: other.email,
    });
    await updatePreference(owner, true);
    await expect(readPreference(owner)).resolves.toMatchObject({
      subscribed: true,
    });
  });

  it("email-subscription-003 keeps a bounced address suppressed after the member resubscribes", async () => {
    const owner = member();
    clerkDirectory([profile(owner)]);

    await deliverResendEvent("email.bounced", owner.email.toUpperCase());
    await updatePreference(owner, true);

    await expect(readPreference(owner)).resolves.toMatchObject({
      subscribed: true,
      deliveryStatus: "suppressed",
    });
  });

  it("email-subscription-006 unsubscribes a complaining recipient found through the identity provider only", async () => {
    const owner = member();
    const other = member();
    clerkDirectory([profile(owner), profile(other)]);

    const delivered = await deliverResendEvent("email.complained", owner.email);

    expect(delivered.body).toStrictEqual({ received: true });
    await expect(readPreference(owner)).resolves.toStrictEqual({
      subscribed: false,
      email: owner.email,
      deliveryStatus: "suppressed",
    });
    await expect(readPreference(other)).resolves.toStrictEqual({
      subscribed: true,
      email: other.email,
      deliveryStatus: "available",
    });
  });

  it("email-subscription-007 reports no email for a member the identity provider cannot find", async () => {
    const owner = member();
    clerkDirectory([]);

    await expect(readPreference(owner)).resolves.toStrictEqual({
      subscribed: true,
      email: null,
      deliveryStatus: "no-email",
    });
    expect(providerLookups(owner.userId)).toBe(1);
  });

  it("email-subscription-008 falls back to the remaining address when the primary one was deleted", async () => {
    const owner = member();
    const remaining = `remaining-${randomUUID()}@example.test`;
    clerkDirectory([
      {
        id: owner.userId,
        emailAddresses: [
          { id: `email_${randomUUID()}`, emailAddress: remaining },
        ],
        primaryEmailAddressId: `email_${randomUUID()}`,
      },
    ]);

    await expect(readPreference(owner)).resolves.toStrictEqual({
      subscribed: true,
      email: remaining,
      deliveryStatus: "available",
    });
    expect(providerLookups(owner.userId)).toBe(1);
  });
});
