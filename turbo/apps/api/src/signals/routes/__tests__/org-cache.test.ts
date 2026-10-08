import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import {
  createAuthOrgAgentsBddApi,
  type ApiTestUser,
} from "./helpers/api-bdd-auth-org";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const api = createAuthOrgAgentsBddApi(context);
const webhooks = createWebhookCallbackApi(context);

function organization(actor: ApiTestUser, name: string) {
  return {
    id: actor.orgId,
    name,
    slug: null,
    createdBy: actor.userId,
    createdAt: now(),
    imageUrl: "",
    hasImage: false,
  };
}

async function createdWebhook(data: unknown): Promise<void> {
  webhooks.configureClerkWebhookSecret();
  api.acceptAgentStorageWrites();
  webhooks.verifyNextClerkWebhook({ type: "organization.created", data });
  const response = await webhooks.requestClerkWebhook("{}", {}, [200]);
  expect(response.body).toBe("OK");
  await flushWaitUntilForTest();
}

async function bootstrapWithoutIdentity(): Promise<ApiTestUser> {
  const actor = api.user();
  api.mockClerkOrg(actor, { name: "Original workspace" });
  // A partial creation event still bootstraps membership and tier, but cannot
  // supply a complete organization identity. No direct database setup is used.
  await createdWebhook({
    id: actor.orgId,
    created_by: actor.userId,
    created_at: now(),
  });
  expect(
    context.mocks.clerk.organizations.getOrganization,
  ).not.toHaveBeenCalled();
  return actor;
}

describe("trusted organization identity cache", () => {
  it.each(["absent", "present"])(
    "reuses the provider update response when the cache is %s",
    async (cacheState) => {
      const actor = await bootstrapWithoutIdentity();
      if (cacheState === "present") {
        await expect(api.readOrg(actor)).resolves.toMatchObject({
          name: "Original workspace",
        });
      }

      context.mocks.clerk.organizations.getOrganization.mockClear();
      context.mocks.clerk.organizations.updateOrganization.mockResolvedValue(
        organization(actor, "Provider-normalized workspace"),
      );
      const updated = await api.requestUpdateOrg(
        actor,
        { name: "Requested workspace" },
        [200],
      );

      expect(updated.body).toStrictEqual({
        id: actor.orgId,
        name: "Provider-normalized workspace",
        tier: "limited-free-1",
      });
      expect(
        context.mocks.clerk.organizations.updateOrganization,
      ).toHaveBeenCalledExactlyOnceWith(actor.orgId, {
        name: "Requested workspace",
      });
      await expect(api.readOrg(actor)).resolves.toStrictEqual({
        id: actor.orgId,
        name: "Provider-normalized workspace",
        createdBy: actor.userId,
        role: "admin",
        tier: "limited-free-1",
      });
      expect(
        context.mocks.clerk.organizations.getOrganization,
      ).not.toHaveBeenCalled();
    },
  );

  it.each(["snake", "camel"])(
    "prefills identity from a verified %s-case creation event",
    async (fieldCase) => {
      const actor = api.user();
      api.mockClerkOrg(actor, { name: "Unneeded provider read" });
      await createdWebhook({
        id: actor.orgId,
        name: "Created workspace",
        ...(fieldCase === "snake"
          ? { created_by: actor.userId, created_at: now() }
          : { createdBy: actor.userId, createdAt: now() }),
      });

      await expect(api.readOrg(actor)).resolves.toStrictEqual({
        id: actor.orgId,
        name: "Created workspace",
        createdBy: actor.userId,
        role: "admin",
        tier: "limited-free-1",
      });
      expect(
        context.mocks.clerk.organizations.getOrganization,
      ).not.toHaveBeenCalled();
    },
  );

  it("keeps a profile update when a duplicate creation event arrives later", async () => {
    const actor = api.user();
    api.mockClerkOrg(actor);
    const creation = {
      id: actor.orgId,
      name: "Created workspace",
      created_by: actor.userId,
      created_at: now(),
    };
    await createdWebhook(creation);
    context.mocks.clerk.organizations.updateOrganization.mockResolvedValue(
      organization(actor, "Renamed workspace"),
    );
    await api.requestUpdateOrg(actor, { name: "Renamed workspace" }, [200]);

    await createdWebhook(creation);

    await expect(api.readOrg(actor)).resolves.toMatchObject({
      name: "Renamed workspace",
      role: "admin",
      tier: "limited-free-1",
    });
    expect(
      context.mocks.clerk.organizations.getOrganization,
    ).not.toHaveBeenCalled();
  });

  it("returns the winning identity when an older cold read finishes after an update", async () => {
    const actor = await bootstrapWithoutIdentity();
    const started = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    context.mocks.clerk.organizations.getOrganization.mockImplementationOnce(
      async () => {
        started.resolve();
        await release.promise;
        return organization(actor, "Older provider snapshot");
      },
    );
    const reading = Promise.allSettled([api.readOrg(actor)]);
    await started.promise;
    context.mocks.clerk.organizations.updateOrganization.mockResolvedValue(
      organization(actor, "Renamed workspace"),
    );
    const updating = await Promise.allSettled([
      api.requestUpdateOrg(actor, { name: "Renamed workspace" }, [200]),
    ]);
    release.resolve();

    await expect(reading).resolves.toMatchObject([
      { status: "fulfilled", value: { name: "Renamed workspace" } },
    ]);
    expect(updating).toMatchObject([{ status: "fulfilled" }]);
    await expect(api.readOrg(actor)).resolves.toMatchObject({
      name: "Renamed workspace",
    });
    expect(
      context.mocks.clerk.organizations.getOrganization,
    ).toHaveBeenCalledOnce();
  });

  it.each([undefined, 42, "   "])(
    "keeps bootstrap and read-through when the creation name is %s",
    async (name) => {
      const actor = api.user();
      api.mockClerkOrg(actor, { name: "Read-through workspace" });
      await createdWebhook({
        id: actor.orgId,
        name,
        created_by: actor.userId,
        created_at: now(),
      });

      await expect(api.readOrg(actor)).resolves.toMatchObject({
        name: "Read-through workspace",
        createdBy: actor.userId,
        role: "admin",
        tier: "limited-free-1",
      });
      expect(
        context.mocks.clerk.organizations.getOrganization,
      ).toHaveBeenCalledExactlyOnceWith({ organizationId: actor.orgId });
    },
  );

  it("does not prefill identity when the creation event lacks its creator", async () => {
    const actor = api.user();
    api.mockClerkOrg(actor, { name: "Read-through workspace" });
    await createdWebhook({
      id: actor.orgId,
      name: "Incomplete event workspace",
      created_at: now(),
    });

    await expect(api.readOrg(actor)).resolves.toMatchObject({
      name: "Read-through workspace",
      createdBy: actor.userId,
    });
    expect(
      context.mocks.clerk.organizations.getOrganization,
    ).toHaveBeenCalledOnce();
  });

  it("rejects an invalid signature without caching the request's identity", async () => {
    const actor = api.user();
    api.mockClerkOrg(actor, { name: "Verified provider workspace" });
    webhooks.configureClerkWebhookSecret();
    webhooks.rejectNextClerkWebhookVerification();
    const response = await webhooks.requestClerkWebhook(
      JSON.stringify({
        type: "organization.created",
        data: {
          id: actor.orgId,
          name: "Unverified workspace",
          created_by: actor.userId,
          created_at: now(),
        },
      }),
      { "svix-signature": "v1,invalid" },
      [401],
    );

    expect(response.body).toStrictEqual({ error: "Invalid webhook signature" });
    await expect(api.readOrg(actor)).resolves.toMatchObject({
      name: "Verified provider workspace",
    });
    expect(
      context.mocks.clerk.organizations.getOrganization,
    ).toHaveBeenCalledOnce();
  });

  it("preserves the cached identity when Clerk rejects a profile update", async () => {
    const actor = await bootstrapWithoutIdentity();
    await api.readOrg(actor);
    context.mocks.clerk.organizations.getOrganization.mockClear();
    context.mocks.clerk.organizations.updateOrganization.mockRejectedValue(
      new Error("Provider update failed"),
    );

    await api.requestUpdateOrg(actor, { name: "Rejected workspace" }, [500]);

    await expect(api.readOrg(actor)).resolves.toMatchObject({
      name: "Original workspace",
    });
    expect(
      context.mocks.clerk.organizations.getOrganization,
    ).not.toHaveBeenCalled();
  });
});
