import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { setupApp } from "../../../__tests__/test-helpers";
import { createRouteMocks } from "./helpers/route-test";
import { createHash, randomUUID } from "node:crypto";

import { hostContract } from "@okouai/api-contracts/contracts/host";
import { describe, expect, it } from "vitest";

import { testContext, accept } from "../../../__tests__/test-context";
import { hostRoutes } from "../host";
import { createHostBddApi } from "./helpers/api-bdd-host";

const context = testContext();
const bdd = createBddApi(context);
const host = createHostBddApi(context);

function hostApi() {
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

function htmlFile(path: string, content: string) {
  return {
    path,
    size: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
    contentType: "text/html; charset=utf-8",
  };
}

/** The delivery pointer the Worker reads from hosted-sites storage. */
function deliveryPointer(
  storage: { readonly puts: readonly { key: string; body: string }[] },
  deploymentId: string,
) {
  for (const put of storage.puts) {
    if (!put.key.endsWith(".json")) {
      continue;
    }
    const parsed: unknown = JSON.parse(put.body);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "deploymentId" in parsed &&
      parsed.deploymentId === deploymentId &&
      "prefix" in parsed &&
      typeof parsed.prefix === "string" &&
      "manifestKey" in parsed &&
      typeof parsed.manifestKey === "string" &&
      "publicSlug" in parsed &&
      typeof parsed.publicSlug === "string"
    ) {
      return {
        prefix: parsed.prefix,
        manifestKey: parsed.manifestKey,
        publicSlug: parsed.publicSlug,
      };
    }
  }
  throw new Error(`Expected a delivery pointer for ${deploymentId}`);
}

describe("artifact paywall", () => {
  it("artifact-paywall-001 keeps the banner, address and downloads behind an upgrade on a free plan", async () => {
    const storage = host.captureHostedSitesS3();
    const owner = bdd.user();
    const prepared = await host.prepareHostedSite(owner, {
      site: `site-${randomUUID().slice(0, 8)}`,
      title: "Free site",
      visibility: "public",
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [
        htmlFile("/index.html", "<h1>Home</h1>"),
        htmlFile("/about.html", "<h1>About</h1>"),
      ],
    });
    await host.completeHostedSite(owner, prepared.deploymentId);
    const siteId = prepared.siteId;

    const banner = await accept(
      hostApi().siteBanner({ headers: signIn(owner), params: { siteId } }),
      [200],
    );
    expect(banner.body).toStrictEqual({
      siteId,
      showBanner: true,
      revision: null,
    });

    const pointer = deliveryPointer(storage, prepared.deploymentId);
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const delivery = await accept(
      hostApi().deliveryAuthorization({
        headers: {},
        params: { siteId, deploymentId: prepared.deploymentId },
        query: {
          alias: prepared.publicSlug,
          publicSlug: pointer.publicSlug,
          publicBrand: "okou",
          prefix: pointer.prefix,
          manifestKey: pointer.manifestKey,
          presentation: "banner",
        },
      }),
      [200],
    );
    expect(delivery.body).toMatchObject({
      allowed: true,
      decision: "allow",
      presentation: { showBanner: true, downloadAllowed: false },
    });

    const headers = signIn(owner);
    const [hidden, renamed] = await Promise.all([
      accept(
        hostApi().updateSiteBanner({
          headers,
          params: { siteId },
          body: { showBanner: false, expectedRevision: null },
        }),
        [402],
      ),
      accept(
        hostApi().updateSiteUrl({
          headers,
          params: { siteId },
          body: {
            publicSlug: `renamed-${randomUUID().slice(0, 8)}`,
            expectedPublicSlug: prepared.publicSlug,
          },
        }),
        [402],
      ),
      accept(
        hostApi().files({
          headers,
          params: { publicSlug: prepared.publicSlug },
          query: {},
        }),
        [402],
      ),
    ]);
    expect(hidden.body.error.code).toBe("PRO_REQUIRED");
    expect(renamed.body.error.code).toBe("PRO_REQUIRED");
  });
});
