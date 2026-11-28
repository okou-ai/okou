import { createHash, randomUUID } from "node:crypto";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { hostRoutes } from "../host";
import { hostedSiteUrlRoutes } from "../hosted-site-url";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createHostBddApi } from "./helpers/api-bdd-host";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import {
  generatedStripeCustomerId,
  generatedStripeSubscriptionId,
  postSubscriptionInvoicePaid,
} from "./helpers/stripe-billing-webhook";

const context = testContext();
const store = createStore();
const bdd = createBddApi(context);
const host = createHostBddApi(context);

function hostApi() {
  return setupApp({ context, routes: hostedSiteUrlRoutes })(hostContract);
}

function deliveryApi() {
  return setupApp({ context, routes: hostRoutes })(hostContract);
}

function signIn(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

async function member(
  orgId: string | undefined,
  role: "admin" | "member",
): Promise<ApiTestUser> {
  const user = bdd.user({
    ...(orgId ? { orgId } : {}),
    orgRole: role === "admin" ? "org:admin" : "org:member",
  });
  await store.set(
    seedOrgMembership$,
    { orgId: user.orgId ?? "", userId: user.userId, role },
    context.signal,
  );
  return user;
}

/** A Pro owner: Stripe records a paid Pro invoice for the owner's workspace. */
async function proOwner(): Promise<ApiTestUser> {
  const owner = await member(undefined, "admin");
  await postSubscriptionInvoicePaid(context.signal, {
    orgId: owner.orgId ?? "",
    userId: owner.userId,
    tier: "pro",
    customerId: generatedStripeCustomerId(),
    subscriptionId: generatedStripeSubscriptionId(),
    currentPeriodEnd: new Date(now() + 30 * 86_400_000),
  });
  return owner;
}

async function publishPublicSite(owner: ApiTestUser, site: string) {
  host.captureHostedSitesS3();
  const html = "<h1>Hosted</h1>";
  const prepared = await host.prepareHostedSite(owner, {
    site,
    title: "Hosted page",
    visibility: "public",
    artifactKind: "hosted-site",
    spaFallback: false,
    files: [
      {
        path: "/index.html",
        size: Buffer.byteLength(html),
        sha256: createHash("sha256").update(html).digest("hex"),
        contentType: "text/html; charset=utf-8",
      },
    ],
  });
  await host.completeHostedSite(owner, prepared.deploymentId);
  return {
    siteId: prepared.siteId,
    publicSlug: prepared.publicSlug,
    deploymentId: prepared.deploymentId,
  };
}

function siteName(): string {
  return `site-${randomUUID().slice(0, 8)}`;
}

describe("hosted site URL", () => {
  it("hosted-site-url-002 validates addresses and hides other owners' websites", async () => {
    const owner = await proOwner();
    const peer = await member(owner.orgId ?? "", "member");
    const site = await publishPublicSite(owner, siteName());

    const reserved = [];
    for (const publicSlug of ["dpl-reserved", "pv-private"]) {
      reserved.push(
        await accept(
          hostApi().updateSiteUrl({
            headers: signIn(owner),
            params: { siteId: site.siteId },
            body: { publicSlug, expectedPublicSlug: site.publicSlug },
          }),
          [400],
        ),
      );
    }
    const peerHeaders = signIn(peer);
    await accept(
      hostApi().updateSiteUrl({
        headers: peerHeaders,
        params: { siteId: site.siteId },
        body: {
          publicSlug: `${site.publicSlug}-peer`,
          expectedPublicSlug: site.publicSlug,
        },
      }),
      [404],
    );
    await accept(
      hostApi().siteUrlAvailability({
        headers: peerHeaders,
        params: { siteId: site.siteId },
        query: { publicSlug: `${site.publicSlug}-peer` },
      }),
      [404],
    );
    await accept(
      hostApi().siteUrl({
        headers: peerHeaders,
        params: { publicSlug: site.publicSlug },
        query: { hostname: `${site.publicSlug}.okou.app` },
      }),
      [404],
    );
    const ownerRead = await accept(
      hostApi().siteUrl({
        headers: signIn(owner),
        params: { publicSlug: site.publicSlug },
        query: { hostname: `${site.publicSlug}.okou.app` },
      }),
      [200],
    );

    expect(
      reserved.map((response) => {
        return response.status;
      }),
    ).toStrictEqual([400, 400]);
    expect(ownerRead.body).toMatchObject({
      siteId: site.siteId,
      publicSlug: site.publicSlug,
      url: `https://${site.publicSlug}.okou.app`,
      isActive: true,
    });
  });

  it("hosted-site-url-003 rejects stale edits and reserves previous published names for their owner", async () => {
    const owner = await proOwner();
    const name = siteName();
    const site = await publishPublicSite(owner, name);
    await accept(
      hostApi().updateSiteUrl({
        headers: signIn(owner),
        params: { siteId: site.siteId },
        body: {
          publicSlug: `${site.publicSlug}-new`,
          expectedPublicSlug: site.publicSlug,
        },
      }),
      [200],
    );
    const other = await proOwner();

    await accept(
      hostApi().updateSiteUrl({
        headers: signIn(owner),
        params: { siteId: site.siteId },
        body: {
          publicSlug: `${site.publicSlug}-other`,
          expectedPublicSlug: site.publicSlug,
        },
      }),
      [409],
    );
    const otherSite = await publishPublicSite(other, site.publicSlug);
    const availability = await accept(
      hostApi().siteUrlAvailability({
        headers: signIn(other),
        params: { siteId: otherSite.siteId },
        query: { publicSlug: site.publicSlug },
      }),
      [200],
    );
    await accept(
      hostApi().updateSiteUrl({
        headers: signIn(other),
        params: { siteId: otherSite.siteId },
        body: {
          publicSlug: site.publicSlug,
          expectedPublicSlug: otherSite.publicSlug,
        },
      }),
      [409],
    );

    expect(otherSite.publicSlug).not.toBe(site.publicSlug);
    expect(availability.body).toMatchObject({ available: false });
  });

  it("hosted-site-url-001 (1/2) renames active address while immutable version reads, aliases, and delivery checks stay consistent", async () => {
    const owner = await proOwner();
    const name = siteName();
    const site = await publishPublicSite(owner, name);
    const renamedSlug = `${site.publicSlug}-new`;
    const dplSlug = `dpl-${site.deploymentId}`;

    const renamed = await accept(
      hostApi().updateSiteUrl({
        headers: signIn(owner),
        params: { siteId: site.siteId },
        body: { publicSlug: renamedSlug, expectedPublicSlug: site.publicSlug },
      }),
      [200],
    );
    const [immutableRead, newAlias, oldAlias] = await Promise.all([
      accept(
        hostApi().siteUrl({
          headers: signIn(owner),
          params: { publicSlug: dplSlug },
          query: { hostname: `${dplSlug}.okou.app` },
        }),
        [200],
      ),
      accept(
        hostApi().resolveAlias({
          params: { publicSlug: renamedSlug },
          query: { publicBrand: "okou" },
        }),
        [200],
      ),
      accept(
        hostApi().resolveAlias({
          params: { publicSlug: site.publicSlug },
          query: { publicBrand: "okou" },
        }),
        [200],
      ),
    ]);
    const pointer = newAlias.body.pointer;
    if (!pointer) {
      throw new Error("Expected resolved pointer for the renamed alias");
    }
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const checkDelivery = (alias: string) => {
      return accept(
        deliveryApi().deliveryAuthorization({
          headers: {},
          params: { siteId: site.siteId, deploymentId: site.deploymentId },
          query: {
            alias,
            publicSlug: pointer.publicSlug,
            publicBrand: "okou",
            prefix: pointer.prefix,
            manifestKey: pointer.manifestKey,
          },
        }),
        [200],
      );
    };
    const [newDelivery, dplDelivery, oldDelivery] = await Promise.all([
      checkDelivery(renamedSlug),
      checkDelivery(dplSlug),
      checkDelivery(site.publicSlug),
    ]);

    expect(renamed.body).toStrictEqual({
      artifactId: expect.any(String) as string,
      siteId: site.siteId,
      publicSlug: renamedSlug,
      url: `https://${renamedSlug}.okou.app`,
      isActive: true,
    });
    expect(immutableRead.body).toStrictEqual(renamed.body);
    expect(pointer).toMatchObject({
      siteId: site.siteId,
      deploymentId: site.deploymentId,
      publicSlug: site.publicSlug,
    });
    expect(oldAlias.body.pointer).toBeNull();
    expect(newDelivery.body.decision).toBe("allow");
    expect(dplDelivery.body.decision).toBe("allow");
    expect(oldDelivery.body.decision).toBe("deny");
  });

  it("hosted-site-url-001 (2/2) preserves CLI site identity across redeploy and resolves the renamed-back address to the new deployment", async () => {
    const owner = await proOwner();
    const name = siteName();
    const site = await publishPublicSite(owner, name);
    const renamedSlug = `${site.publicSlug}-new`;
    await accept(
      hostApi().updateSiteUrl({
        headers: signIn(owner),
        params: { siteId: site.siteId },
        body: { publicSlug: renamedSlug, expectedPublicSlug: site.publicSlug },
      }),
      [200],
    );

    const html = "<h1>Hosted v2</h1>";
    const redeployed = await host.prepareHostedSite(owner, {
      site: name,
      title: "Hosted page v2",
      visibility: "public",
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [
        {
          path: "/index.html",
          size: Buffer.byteLength(html),
          sha256: createHash("sha256").update(html).digest("hex"),
          contentType: "text/html; charset=utf-8",
        },
      ],
    });
    const completed = await host.completeHostedSite(
      owner,
      redeployed.deploymentId,
    );
    await accept(
      hostApi().updateSiteUrl({
        headers: signIn(owner),
        params: { siteId: site.siteId },
        body: { publicSlug: site.publicSlug, expectedPublicSlug: renamedSlug },
      }),
      [200],
    );
    const restoredAlias = await accept(
      hostApi().resolveAlias({
        params: { publicSlug: site.publicSlug },
        query: { publicBrand: "okou" },
      }),
      [200],
    );

    expect(redeployed.siteId).toBe(site.siteId);
    expect(redeployed.publicSlug).toBe(renamedSlug);
    expect(completed.url).toBe(`https://${renamedSlug}.okou.app`);
    expect(restoredAlias.body.pointer).toMatchObject({
      siteId: site.siteId,
      deploymentId: redeployed.deploymentId,
    });
  });
});
