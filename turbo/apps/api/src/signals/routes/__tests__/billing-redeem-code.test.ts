import { setupApp } from "../../../__tests__/test-helpers";
import { createRouteMocks } from "./helpers/route-test";
import { createHash, randomUUID } from "node:crypto";
import {
  billingRedeemCodeContract,
  billingStatusContract,
} from "@okouai/api-contracts/contracts/billing";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { apiTestEnvironment } from "../../../__tests__/test-environment";
import { testContext, accept } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import { billingRedeemCodeRoutes } from "../billing-redeem-code";
import { billingStatusRoutes } from "../billing-status";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClerkUsers } from "./helpers/clerk-users";
import { publicPlanLifecycle } from "./helpers/public-plan-lifecycle";

const context = testContext();

const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const ATOM_CONSUME_URL = new URL(
  "/api/redeem-codes/consume",
  apiTestEnvironment.ATOM_URL,
).toString();
const MACHINE_SECRET = apiTestEnvironment.OKOU_MACHINE_SECRET_KEY;

interface AtomReceipt {
  readonly authorization: string | null;
  readonly body: unknown;
  readonly raw: string;
}

function redeemCodeApi() {
  return setupApp({ context, routes: billingRedeemCodeRoutes })(
    billingRedeemCodeContract,
  );
}

function billingStatusApi() {
  return setupApp({ context, routes: billingStatusRoutes })(
    billingStatusContract,
  );
}

function signIn(actor: ApiTestUser): void {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
}

/** Clerk issues an M2M token for the redeem service. */
function clerkIssuesM2mToken(): string {
  const token = `m2m_${randomUUID()}`;
  context.mocks.clerk.m2m.createToken.mockResolvedValue({ token });
  return token;
}

/** Atom's consume endpoint answers with `respond` and records every receipt. */
function atomConsume(respond: () => Response): AtomReceipt[] {
  const receipts: AtomReceipt[] = [];
  server.use(
    http.post(ATOM_CONSUME_URL, async ({ request }) => {
      const raw = await request.text();
      receipts.push({
        authorization: request.headers.get("authorization"),
        body: JSON.parse(raw),
        raw: `${JSON.stringify([...request.headers.entries()])}${raw}`,
      });
      return respond();
    }),
  );
  return receipts;
}

/** A signed-in admin of a provisioned Free workspace. */
async function freeWorkspaceAdmin(): Promise<ApiTestUser> {
  const api = createBddApi(context);
  const admin = api.user();
  await api.provisionWorkspace(admin);
  signIn(admin);
  return admin;
}

async function redeem(
  code: string,
  statuses: readonly (200 | 400 | 403 | 503)[],
) {
  return await accept(
    redeemCodeApi().create({ headers, body: { code } }),
    statuses,
  );
}

async function rejection(status: 400 | 403 | 503) {
  const response = await redeem("YUMA-123", [status]);
  if (!("error" in response.body)) {
    throw new Error("expected an error response");
  }
  return response.body.error;
}

describe("POST /api/billing/redeem-code", () => {
  it("billing-redeem-code-005 refuses a non-admin member", async () => {
    const member: ApiTestUser = {
      ...createBddApi(context).user(),
      orgRole: "org:member",
    };
    signIn(member);
    clerkIssuesM2mToken();
    const receipts = atomConsume(() => {
      return HttpResponse.json({ ok: true });
    });

    await expect(rejection(403)).resolves.toStrictEqual({
      message: "Only org admins can manage billing",
      code: "FORBIDDEN",
    });

    expect(receipts).toHaveLength(0);
    expect(context.mocks.clerk.m2m.createToken).not.toHaveBeenCalled();
  });

  it("billing-redeem-code-010 reports an invalid code that Atom rejects", async () => {
    await freeWorkspaceAdmin();
    clerkIssuesM2mToken();
    atomConsume(() => {
      return HttpResponse.json({ error: "invalid code" }, { status: 404 });
    });

    await expect(rejection(400)).resolves.toStrictEqual({
      message: "Invalid redeem code",
      code: "BAD_REQUEST",
    });
  });

  it("billing-redeem-code-011 explains that the code was already used", async () => {
    await freeWorkspaceAdmin();
    clerkIssuesM2mToken();
    atomConsume(() => {
      return HttpResponse.json(
        { error: { code: "already_used" } },
        { status: 409 },
      );
    });

    await expect(rejection(400)).resolves.toStrictEqual({
      message: "This redeem code has already been used",
      code: "BAD_REQUEST",
    });
  });

  it("billing-redeem-code-012 explains that the code expired", async () => {
    await freeWorkspaceAdmin();
    clerkIssuesM2mToken();
    atomConsume(() => {
      return HttpResponse.json({ error_code: "code_expired" }, { status: 410 });
    });

    await expect(rejection(400)).resolves.toStrictEqual({
      message: "This redeem code has expired",
      code: "BAD_REQUEST",
    });
  });

  it("billing-redeem-code-013 explains that the code is not eligible for the workspace", async () => {
    await freeWorkspaceAdmin();
    clerkIssuesM2mToken();
    atomConsume(() => {
      return HttpResponse.json({ code: "org_mismatch" }, { status: 403 });
    });

    await expect(rejection(400)).resolves.toStrictEqual({
      message: "This code is not eligible for this workspace",
      code: "BAD_REQUEST",
    });
  });

  it("billing-redeem-code-009 reports the redeem service unavailable when Atom is unreachable", async () => {
    await freeWorkspaceAdmin();
    clerkIssuesM2mToken();
    atomConsume(() => {
      return HttpResponse.error();
    });

    await expect(rejection(503)).resolves.toStrictEqual({
      message: "Redeem service unavailable",
      code: "PROVIDER_UNAVAILABLE",
    });
  });

  it("billing-redeem-code-017 redeems a trimmed code for the admin's primary email", async () => {
    const admin = await freeWorkspaceAdmin();
    const primaryEmail = `primary-${admin.userId}@example.test`;
    mockClerkUsers(context, [
      {
        id: admin.userId,
        emailAddresses: [
          { id: "email_secondary", emailAddress: "secondary@example.test" },
          { id: "email_primary", emailAddress: primaryEmail },
        ],
        primaryEmailAddressId: "email_primary",
      },
    ]);
    const token = clerkIssuesM2mToken();
    const receipts = atomConsume(() => {
      return HttpResponse.json({ ok: true });
    });

    const response = await redeem(" YUMA-123 ", [200]);

    expect(response.body).toStrictEqual({ redeemed: true });
    expect(context.mocks.clerk.users.getUser).toHaveBeenCalledTimes(1);
    expect(context.mocks.clerk.users.getUser.mock.calls[0]?.[0]).toBe(
      admin.userId,
    );
    expect(context.mocks.clerk.m2m.createToken).toHaveBeenCalledWith({
      machineSecretKey: MACHINE_SECRET,
      secondsUntilExpiration: 3600,
      minRemainingTtlSeconds: 300,
    });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.authorization).toBe(`Bearer ${token}`);
    expect(receipts[0]?.body).toStrictEqual({
      code: "YUMA-123",
      email: primaryEmail,
      org_id: admin.orgId,
      user_id: admin.userId,
    });
    const hashed = createHash("sha256").update(MACHINE_SECRET).digest("hex");
    const observed = `${JSON.stringify(response.body)}${receipts[0]?.raw ?? ""}`;
    for (const secret of [
      MACHINE_SECRET,
      hashed,
      JSON.stringify(MACHINE_SECRET),
    ]) {
      expect(observed).not.toContain(secret);
    }
  });

  it("billing-redeem-code-003 redeems for a Free workspace that completed onboarding", async () => {
    const api = createBddApi(context);
    const admin = api.user();
    await api.provisionWorkspace(admin);
    await api.completeOnboarding(admin);
    signIn(admin);
    clerkIssuesM2mToken();
    const receipts = atomConsume(() => {
      return HttpResponse.json({ ok: true });
    });

    const response = await redeem("PRO-CAMPAIGN", [200]);

    expect(response.body).toStrictEqual({ redeemed: true });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.body).toMatchObject({
      code: "PRO-CAMPAIGN",
      org_id: admin.orgId,
      user_id: admin.userId,
    });
  });

  it("billing-redeem-code-001 leaves a Pro plan and the code unchanged", async () => {
    const api = createBddApi(context);
    const admin = api.user();
    await publicPlanLifecycle(context, admin, "pro").update("active");
    signIn(admin);
    clerkIssuesM2mToken();
    const receipts = atomConsume(() => {
      return HttpResponse.json({ ok: true });
    });

    const response = await redeem("PRO-CAMPAIGN", [200]);

    expect(response.body).toStrictEqual({ redeemed: false });
    expect(receipts).toHaveLength(0);
    expect(context.mocks.clerk.m2m.createToken).not.toHaveBeenCalled();
    const status = await accept(billingStatusApi().get({ headers }), [200]);
    expect(status.body).toMatchObject({ tier: "pro", hasSubscription: true });
  });
});
