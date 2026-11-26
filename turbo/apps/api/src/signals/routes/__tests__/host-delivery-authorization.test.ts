import { createHash, randomUUID } from "node:crypto";

import { hostContract } from "@okouai/api-contracts/contracts/host";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { hostRoutes } from "../host";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createHostBddApi } from "./helpers/api-bdd-host";

const context = testContext();
const bdd = createBddApi(context);
const host = createHostBddApi(context);

type Storage = ReturnType<typeof host.captureHostedSitesS3>;

function htmlFile(content: string) {
  return {
    path: "/index.html",
    size: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
    contentType: "text/html; charset=utf-8",
  };
}

/** The last delivery pointer the Worker would read for a deployment. */
function deliveryPointer(storage: Storage, deploymentId: string) {
  let found:
    { prefix: string; manifestKey: string; publicSlug: string } | undefined;
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
      found = {
        prefix: parsed.prefix,
        manifestKey: parsed.manifestKey,
        publicSlug: parsed.publicSlug,
      };
    }
  }
  if (!found) {
    throw new Error(`Expected a delivery pointer for ${deploymentId}`);
  }
  return found;
}

/** The current site pointer stored for an alias. */
function sitePointerDeployment(storage: Storage, publicSlug: string) {
  let current: unknown;
  for (const [key, body] of storage.objects) {
    if (key.endsWith(".json") && key.includes(publicSlug)) {
      const parsed: unknown = JSON.parse(body);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "deploymentId" in parsed
      ) {
        current = parsed.deploymentId;
      }
    }
  }
  return current;
}

interface Delivery {
  readonly siteId: string;
  readonly deploymentId: string;
  readonly alias: string;
  readonly publicSlug: string;
  readonly publicBrand: "okou" | "vm0";
  readonly prefix: string;
  readonly manifestKey: string;
}

async function decide(delivery: Delivery) {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  const response = await accept(
    setupApp({ context, routes: hostRoutes })(
      hostContract,
    ).deliveryAuthorization({
      headers: {},
      params: { siteId: delivery.siteId, deploymentId: delivery.deploymentId },
      query: {
        alias: delivery.alias,
        publicSlug: delivery.publicSlug,
        publicBrand: delivery.publicBrand,
        prefix: delivery.prefix,
        manifestKey: delivery.manifestKey,
      },
    }),
    [200],
  );
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return response.body.decision;
}

async function prepare(owner: ApiTestUser, site: string, content: string) {
  return await host.prepareHostedSite(owner, {
    site,
    title: "Delivery site",
    visibility: "public",
    artifactKind: "hosted-site",
    spaFallback: false,
    files: [htmlFile(content)],
  });
}

/**
 * A member's prepared public site and another user's published site. The
 * Worker addresses the unfinished first version with the same layout as a
 * ready one, relocated from the other user's published pointer.
 */
async function deliveryScenario() {
  const storage = host.captureHostedSitesS3();
  const owner = bdd.user();
  const other = bdd.user();
  const site = `site-${randomUUID().slice(0, 8)}`;
  const first = await prepare(owner, site, "<h1>First</h1>");
  const otherSite = await prepare(
    other,
    `site-${randomUUID().slice(0, 8)}`,
    "<h1>Other</h1>",
  );
  await host.completeHostedSite(other, otherSite.deploymentId);
  const otherPointer = deliveryPointer(storage, otherSite.deploymentId);
  const relocate = (value: string) => {
    return value
      .replaceAll(otherSite.siteId, first.siteId)
      .replaceAll(otherSite.deploymentId, first.deploymentId)
      .replaceAll(otherSite.publicSlug, first.publicSlug);
  };
  const pending: Delivery = {
    siteId: first.siteId,
    deploymentId: first.deploymentId,
    alias: first.publicSlug,
    publicSlug: relocate(otherPointer.publicSlug),
    publicBrand: "okou",
    prefix: relocate(otherPointer.prefix),
    manifestKey: relocate(otherPointer.manifestKey),
  };
  return { storage, owner, site, first, otherSite, otherPointer, pending };
}

type DeliveryScenario = Awaited<ReturnType<typeof deliveryScenario>>;

/** Completes the first version and returns its delivery as the Worker reads it. */
async function completeFirst(scenario: DeliveryScenario): Promise<Delivery> {
  await host.completeHostedSite(scenario.owner, scenario.first.deploymentId);
  const pointer = deliveryPointer(
    scenario.storage,
    scenario.first.deploymentId,
  );
  return { ...scenario.pending, ...pointer };
}

async function publishNewer(scenario: DeliveryScenario) {
  const newer = await prepare(scenario.owner, scenario.site, "<h1>Newer</h1>");
  await host.completeHostedSite(scenario.owner, newer.deploymentId);
}

describe("host delivery authorization", () => {
  it("host-delivery-authorization-004 (1/5) denies the first version before completion", async () => {
    const { pending } = await deliveryScenario();

    await expect(decide(pending)).resolves.toBe("deny");
  });

  it("host-delivery-authorization-004 (2/5) allows the completed version, also with upper-cased IDs, and points the site at it", async () => {
    const scenario = await deliveryScenario();
    const { storage, first, pending } = scenario;
    await decide(pending);

    await host.completeHostedSite(scenario.owner, first.deploymentId);

    expect(deliveryPointer(storage, first.deploymentId)).toStrictEqual({
      publicSlug: pending.publicSlug,
      prefix: pending.prefix,
      manifestKey: pending.manifestKey,
    });
    expect(sitePointerDeployment(storage, first.publicSlug)).toBe(
      first.deploymentId,
    );
    await expect(
      Promise.all([
        decide(pending),
        decide({
          ...pending,
          siteId: pending.siteId.toUpperCase(),
          deploymentId: pending.deploymentId.toUpperCase(),
        }),
      ]),
    ).resolves.toStrictEqual(["allow", "allow"]);
  });

  it("host-delivery-authorization-004 (3/5) denies each mismatched field and the other user's site or deployment", async () => {
    const scenario = await deliveryScenario();
    const { otherSite, otherPointer } = scenario;
    const ready = await completeFirst(scenario);

    await expect(
      Promise.all([
        decide({ ...ready, publicBrand: "vm0" }),
        decide({ ...ready, publicSlug: otherPointer.publicSlug }),
        decide({ ...ready, prefix: otherPointer.prefix }),
        decide({ ...ready, manifestKey: otherPointer.manifestKey }),
        decide({ ...ready, alias: otherSite.publicSlug }),
        decide({ ...ready, deploymentId: otherSite.deploymentId }),
        decide({ ...ready, siteId: otherSite.siteId }),
      ]),
    ).resolves.toStrictEqual([
      "deny",
      "deny",
      "deny",
      "deny",
      "deny",
      "deny",
      "deny",
    ]);
  });

  it("host-delivery-authorization-004 (4/5) keeps the old version only under its dpl- alias after a newer one", async () => {
    const scenario = await deliveryScenario();
    const ready = await completeFirst(scenario);

    await publishNewer(scenario);

    await expect(
      Promise.all([
        decide(ready),
        decide({ ...ready, alias: `dpl-${scenario.first.deploymentId}` }),
      ]),
    ).resolves.toStrictEqual(["deny", "allow"]);
  });

  it("host-delivery-authorization-004 (5/5) denies deleted history and allows the replacement under its own prefix", async () => {
    const scenario = await deliveryScenario();
    const { storage, owner, site, first } = scenario;
    const ready = await completeFirst(scenario);
    await publishNewer(scenario);
    const immutable = { ...ready, alias: `dpl-${first.deploymentId}` };

    await host.deleteHostedSite(owner, first.publicSlug);
    await expect(decide(immutable)).resolves.toBe("deny");
    const replacement = await prepare(owner, site, "<h1>Replacement</h1>");
    await host.completeHostedSite(owner, replacement.deploymentId);
    const replacementPointer = deliveryPointer(
      storage,
      replacement.deploymentId,
    );
    expect(replacementPointer.prefix).not.toBe(ready.prefix);
    await expect(
      Promise.all([
        decide({
          siteId: replacement.siteId,
          deploymentId: replacement.deploymentId,
          alias: replacement.publicSlug,
          publicSlug: replacementPointer.publicSlug,
          publicBrand: "okou",
          prefix: replacementPointer.prefix,
          manifestKey: replacementPointer.manifestKey,
        }),
        decide(immutable),
      ]),
    ).resolves.toStrictEqual(["allow", "deny"]);
  });
});
