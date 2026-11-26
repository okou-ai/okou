import { randomUUID } from "node:crypto";
import { friendReferralsContract } from "@okouai/api-contracts/contracts/friend-referrals";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { friendReferralRoutes } from "../friend-referrals";
import { purchaseUsagePacks } from "./helpers/public-usage-pack-checkout";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = { authorization: "Bearer clerk-session" };

interface Person {
  readonly userId: string;
  readonly orgId: string;
}

function person(): Person {
  return { userId: `user_${randomUUID()}`, orgId: `org_${randomUUID()}` };
}

/** Clerk reports when each account was created. */
function clerkAccounts(createdAt: ReadonlyMap<string, number>) {
  context.mocks.clerk.users.getUser.mockImplementation((id: unknown) => {
    const userId = String(id);
    return Promise.resolve({
      id: userId,
      banned: false,
      createdAt: createdAt.get(userId),
    });
  });
}

function referrals() {
  return setupApp({ context, routes: friendReferralRoutes })(
    friendReferralsContract,
  );
}

async function readLink(actor: Person) {
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
  const response = await accept(referrals().link({ headers }), [200]);
  return response.body;
}

async function visit(code: string) {
  const response = await accept(referrals().visit({ body: { code } }), [200]);
  return response.body.token;
}

async function register(actor: Person, token: string) {
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
  const response = await accept(
    referrals().register({ headers, body: { token } }),
    [200],
  );
  return response.body;
}

/** A referrer shares a link; the invitee opens it and registers a new account. */
async function referredInvitee(at: Date) {
  const referrer = person();
  const invitee = person();
  mockNow(at);
  clerkAccounts(new Map([[invitee.userId, at.getTime() + 1000]]));
  const { code } = await readLink(referrer);
  const token = await visit(code);
  mockNow(new Date(at.getTime() + 2000));
  await expect(register(invitee, token)).resolves.toStrictEqual({
    status: "registered",
  });
  return { referrer, invitee };
}

describe("friend referrals", () => {
  it("friend-referrals-001 reuses links and attributes only the first eligible registration", async () => {
    const at = new Date("2026-01-31T10:00:00Z");
    mockNow(at);
    const first = person();
    const second = person();
    const invitee = person();
    const oldAccount = person();
    const lateInvitee = person();
    clerkAccounts(
      new Map([
        [invitee.userId, at.getTime() + 1000],
        [lateInvitee.userId, at.getTime() + 1000],
        [first.userId, at.getTime() + 1000],
        [oldAccount.userId, new Date("2025-12-15T00:00:00Z").getTime()],
      ]),
    );

    const firstLink = await readLink(first);
    const repeated = await Promise.all([
      readLink(first),
      readLink(first),
      readLink(first),
      readLink(first),
    ]);
    const secondLink = await readLink(second);
    expect(firstLink.code).toMatch(/^[a-z0-9]{6}$/u);
    expect(
      repeated.map((link) => {
        return link.code;
      }),
    ).toStrictEqual([
      firstLink.code,
      firstLink.code,
      firstLink.code,
      firstLink.code,
    ]);
    expect(secondLink.code).not.toBe(firstLink.code);
    const [firstToken, secondToken] = await Promise.all([
      visit(firstLink.code),
      visit(secondLink.code),
    ]);
    const [linkId, , mac] = firstToken.split(".");
    const backdated = `${linkId}.${new Date("2020-01-01T00:00:00Z").getTime()}.${mac}`;

    mockNow(new Date(at.getTime() + 2000));
    await expect(register(invitee, firstToken)).resolves.toStrictEqual({
      status: "registered",
    });
    await expect(register(invitee, secondToken)).resolves.toStrictEqual({
      status: "registered",
    });
    await expect(register(first, firstToken)).resolves.toStrictEqual({
      status: "ineligible",
    });
    await expect(register(oldAccount, firstToken)).resolves.toStrictEqual({
      status: "ineligible",
    });
    await expect(register(lateInvitee, backdated)).resolves.toStrictEqual({
      status: "ineligible",
    });

    await expect(readLink(first)).resolves.toMatchObject({
      code: firstLink.code,
      registeredCount: 1,
      rewardedCount: 0,
      earnedCredits: 0,
    });
    await expect(readLink(second)).resolves.toMatchObject({
      code: secondLink.code,
      registeredCount: 0,
      rewardedCount: 0,
    });
  });

  it("friend-referrals-004 a zero-dollar usage pack invoice does not reward the referrer", async () => {
    const { referrer, invitee } = await referredInvitee(
      new Date("2026-01-31T10:00:00Z"),
    );

    await purchaseUsagePacks(
      context,
      invitee,
      [{ userId: invitee.userId, usd: 20 }],
      { amountPaid: 0 },
    );

    await expect(readLink(referrer)).resolves.toMatchObject({
      registeredCount: 1,
      rewardedCount: 0,
      earnedCredits: 0,
    });
  });
});
