import { setupApp } from "../../../__tests__/test-helpers";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { createRouteMocks } from "./helpers/route-test";
import { orgContract } from "@okouai/api-contracts/contracts/org-routes";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { describe, expect, it } from "vitest";

import { testContext, accept } from "../../../__tests__/test-context";
import { orgReadRoutes } from "../org-read";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { now } from "../../../lib/time";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

interface Workspace {
  readonly orgId: string;
  readonly adminId: string;
}

/** A Clerk admin of a brand-new workspace. */
async function workspace(): Promise<Workspace> {
  const ws = { orgId: `org_${randomUUID()}`, adminId: `user_${randomUUID()}` };
  await createStore().set(
    seedOrgMembership$,
    { orgId: ws.orgId, userId: ws.adminId, role: "admin" },
    context.signal,
  );
  createRouteMocks(context).clerk.session(ws.adminId, ws.orgId, "org:admin");
  return ws;
}

function webhook() {
  return setupApp({ context, routes: webhooksClerkRoutes })(
    webhookClerkContract,
  );
}

function svixHeaders() {
  return {
    "svix-id": `msg_${randomUUID()}`,
    "svix-timestamp": String(Math.floor(now() / 1000)),
    "svix-signature": "v1,signed-by-clerk",
  };
}

/** Clerk delivers a verified `organization.created` event. */
async function deliverCreated(data: Record<string, unknown>) {
  context.mocks.clerk.verifyWebhook.mockResolvedValue({
    type: "organization.created",
    data,
  });
  const response = await accept(
    webhook().post({
      body: JSON.stringify({ type: "organization.created", data }),
      extraHeaders: svixHeaders(),
    }),
    [200],
  );
  return response.body;
}

function created(ws: Workspace, name?: string) {
  return {
    id: ws.orgId,
    createdBy: ws.adminId,
    createdAt: Date.parse("2026-01-01T00:00:00Z"),
    ...(name === undefined ? {} : { name }),
  };
}

function org() {
  return setupApp({ context, routes: orgReadRoutes })(orgContract);
}

async function readOrg() {
  const response = await accept(org().get({ headers }), [200]);
  return response.body;
}

describe("trusted organization identity cache", () => {
  it("org-cache-003 prefills identity from a verified snake-case creation event", async () => {
    const ws = await workspace();
    await expect(
      deliverCreated({
        id: ws.orgId,
        name: "Created workspace",
        created_by: ws.adminId,
        created_at: Date.parse("2026-01-01T00:00:00Z"),
      }),
    ).resolves.toBe("OK");
    context.mocks.clerk.organizations.getOrganization.mockClear();

    await expect(readOrg()).resolves.toStrictEqual({
      id: ws.orgId,
      name: "Created workspace",
      createdBy: ws.adminId,
      role: "admin",
      tier: "limited-free-1",
    });
    expect(
      context.mocks.clerk.organizations.getOrganization,
    ).not.toHaveBeenCalled();
  });

  it("org-cache-001 reuses the provider update response when the cache is absent", async () => {
    const ws = await workspace();
    await deliverCreated(created(ws));
    context.mocks.clerk.organizations.updateOrganization.mockResolvedValue({
      id: ws.orgId,
      name: "Provider-normalized workspace",
      createdBy: ws.adminId,
    });
    context.mocks.clerk.organizations.getOrganization.mockClear();

    const updated = await accept(
      org().update({ headers, body: { name: "Requested workspace" } }),
      [200],
    );

    expect(updated.body).toStrictEqual({
      id: ws.orgId,
      name: "Provider-normalized workspace",
      tier: "limited-free-1",
    });
    expect(
      context.mocks.clerk.organizations.updateOrganization.mock.calls,
    ).toStrictEqual([[ws.orgId, { name: "Requested workspace" }]]);
    await expect(readOrg()).resolves.toStrictEqual({
      id: ws.orgId,
      name: "Provider-normalized workspace",
      createdBy: ws.adminId,
      role: "admin",
      tier: "limited-free-1",
    });
    expect(
      context.mocks.clerk.organizations.getOrganization,
    ).not.toHaveBeenCalled();
  });

  it("org-cache-005 keeps a profile update when a duplicate creation event arrives later", async () => {
    const ws = await workspace();
    const event = created(ws, "Created workspace");
    await deliverCreated(event);
    context.mocks.clerk.organizations.updateOrganization.mockResolvedValue({
      id: ws.orgId,
      name: "Renamed workspace",
      createdBy: ws.adminId,
    });
    await accept(
      org().update({ headers, body: { name: "Renamed workspace" } }),
      [200],
    );
    context.mocks.clerk.organizations.getOrganization.mockClear();

    await deliverCreated(event);

    await expect(readOrg()).resolves.toMatchObject({
      name: "Renamed workspace",
      role: "admin",
      tier: "limited-free-1",
    });
    expect(
      context.mocks.clerk.organizations.getOrganization,
    ).not.toHaveBeenCalled();
  });

  it("org-cache-009 rejects an invalid signature without caching the request's identity", async () => {
    const ws = await workspace();
    context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
      id: ws.orgId,
      name: "Verified provider workspace",
      createdBy: ws.adminId,
    });
    context.mocks.clerk.organizations.getOrganization.mockClear();
    context.mocks.clerk.verifyWebhook.mockRejectedValue(
      new Error("Invalid Svix signature"),
    );

    const rejected = await accept(
      webhook().post({
        body: JSON.stringify({
          type: "organization.created",
          data: created(ws, "Unverified workspace"),
        }),
        extraHeaders: svixHeaders(),
      }),
      [401],
    );

    expect(rejected.body).toStrictEqual({ error: "Invalid webhook signature" });
    await expect(readOrg()).resolves.toMatchObject({
      name: "Verified provider workspace",
    });
    expect(
      context.mocks.clerk.organizations.getOrganization,
    ).toHaveBeenCalledTimes(1);
  });

  it("org-cache-010 preserves the cached identity when Clerk rejects a profile update", async () => {
    const ws = await workspace();
    await deliverCreated(created(ws));
    context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
      id: ws.orgId,
      name: "Original workspace",
      createdBy: ws.adminId,
    });
    await expect(readOrg()).resolves.toMatchObject({
      name: "Original workspace",
    });
    context.mocks.clerk.organizations.getOrganization.mockClear();
    context.mocks.clerk.organizations.updateOrganization.mockRejectedValue(
      new Error("Clerk rejected the profile update"),
    );

    await accept(
      org().update({ headers, body: { name: "Rejected workspace" } }),
      [500],
    );

    await expect(readOrg()).resolves.toMatchObject({
      name: "Original workspace",
    });
    expect(
      context.mocks.clerk.organizations.getOrganization,
    ).not.toHaveBeenCalled();
  });
});
