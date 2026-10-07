import { randomUUID } from "node:crypto";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { cronConnectorCatalogContract } from "@okouai/api-contracts/contracts/cron";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { runnersBuiltinFirewallsResolveContract } from "@okouai/api-contracts/contracts/runners";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../lib/env";
import {
  previewCatalogBundledSkill,
  previewCatalogExtraSlug,
  previewConnectorCatalogFixture,
} from "../../../test-fixtures/preview-connector-catalog";
import { createPublicConnectorCatalog } from "./helpers/public-connector-catalog";
import { createRouteMocks } from "./helpers/route-test";
import { cronConnectorCatalogRoutes } from "../cron-connector-catalog";
import { connectorCatalogRoutes } from "../connector-catalog";
import { runnersRoutes } from "../runners";

const context = testContext();

const mocks = createRouteMocks(context);
const OFFICIAL_RUNNER_AUTHORIZATION =
  "Bearer vm0_official_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
// Beyond the onboarding/Runner subset and across several 100-row entry insert
// batches, including a partial final batch. Completeness does not depend on
// matching the ~4,600-entry official publication size.
const MULTI_BATCH_EXTRA_COUNT = 250;

async function seedClient() {
  const app = await setupApp({
    context,
    routes: cronConnectorCatalogRoutes,
    isolatePg: true,
  });
  return app(cronConnectorCatalogContract);
}

async function seed() {
  return (await seedClient()).seedPreview({
    headers: { authorization: `Bearer ${env("CRON_SECRET")}` },
  });
}

function catalogClient() {
  mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
  return setupApp({ context, routes: connectorCatalogRoutes })(
    connectorCatalogContract,
  );
}

function runnerFirewalls(names: readonly string[]) {
  return setupApp({ context, routes: runnersRoutes })(
    runnersBuiltinFirewallsResolveContract,
  ).resolve({
    headers: { authorization: OFFICIAL_RUNNER_AUTHORIZATION },
    body: { names: [...names] },
  });
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function sortedSlugs(connectors: readonly { readonly slug: string }[]) {
  return connectors
    .map((entry) => {
      return entry.slug;
    })
    .sort();
}

test("a multi-batch official catalog is installed completely and served by public discovery and the Runner firewall", async () => {
  const publication = createPublicConnectorCatalog(context);
  const artifact = previewConnectorCatalogFixture(MULTI_BATCH_EXTRA_COUNT);
  const published = publication.stage(artifact);
  mockEnv("ENV", "preview");
  const seeded = await accept(seed(), [200]);
  expect(seeded.body).toStrictEqual({
    ...published,
    connectorSlugs: sortedSlugs(artifact.connectors),
  });

  const client = catalogClient();
  const list = await accept(client.list({ headers: authHeaders() }), [200]);
  expect(sortedSlugs(list.body.connectors)).toStrictEqual(
    expect.arrayContaining([
      "github",
      previewCatalogExtraSlug(0),
      previewCatalogExtraSlug(MULTI_BATCH_EXTRA_COUNT - 1),
    ]),
  );
  const lastSlug = previewCatalogExtraSlug(MULTI_BATCH_EXTRA_COUNT - 1);
  const last = await accept(
    client.get({ headers: authHeaders(), params: { connectorSlug: lastSlug } }),
    [200],
  );
  expect(last.body.connector.label).toBe(
    `Preview Catalog ${MULTI_BATCH_EXTRA_COUNT - 1}`,
  );
  const discovered = await accept(
    client.discovery({ headers: authHeaders(), query: { keyword: lastSlug } }),
    [200],
  );
  expect(sortedSlugs(discovered.body.connectors)).toContain(lastSlug);

  const firewalls = await accept(
    runnerFirewalls([previewCatalogExtraSlug(0), lastSlug]),
    [200],
  );
  expect(Object.keys(firewalls.body.firewalls).sort()).toStrictEqual(
    [previewCatalogExtraSlug(0), lastSlug].sort(),
  );

  // The post-deploy call reuses the complete generation.
  const repeated = await accept(seed(), [200]);
  expect(repeated.body).toStrictEqual(seeded.body);
});

test("bundled skills are registered for every entry before the catalog switches", async () => {
  const publication = createPublicConnectorCatalog(context);
  const artifact = previewConnectorCatalogFixture(2);
  publication.stage(artifact);
  mockEnv("ENV", "preview");
  await accept(seed(), [200]);

  // Reusing the first entry's registered version under another storage name
  // must be rejected by the existing registration, not silently skipped.
  const [registered, reusing] = [
    previewCatalogExtraSlug(0),
    previewCatalogExtraSlug(1),
  ];
  publication.stage({
    ...artifact,
    connectors: artifact.connectors.flatMap((entry) => {
      if (entry.slug === registered) {
        return [];
      }
      return entry.slug === reusing
        ? [
            {
              ...entry,
              label: "Conflicting skill",
              skill: previewCatalogBundledSkill(reusing, registered),
            },
          ]
        : [entry];
    }),
  });
  await accept(seed(), [500]);

  const client = catalogClient();
  const retained = await accept(
    client.get({
      headers: authHeaders(),
      params: { connectorSlug: registered },
    }),
    [200],
  );
  expect(retained.body.connector.slug).toBe(registered);
  const unchanged = await accept(
    client.get({ headers: authHeaders(), params: { connectorSlug: reusing } }),
    [200],
  );
  expect(unchanged.body.connector.label).toBe("Preview Catalog 1");
});

test("a replacement publication serves its own payloads at its official digest", async () => {
  const publication = createPublicConnectorCatalog(context);
  const artifact = previewConnectorCatalogFixture();
  publication.stage(artifact);
  mockEnv("ENV", "preview");
  const first = await accept(seed(), [200]);
  const github = artifact.connectors.find((entry) => {
    return entry.slug === "github";
  });
  if (!github) {
    throw new Error("Missing GitHub publisher fixture");
  }
  github.label = "Updated GitHub";
  const published = publication.stage(artifact);
  const replacement = await accept(seed(), [200]);
  expect(replacement.body.catalogDigest).toBe(published.catalogDigest);
  expect(replacement.body.catalogDigest).not.toBe(first.body.catalogDigest);
  expect(replacement.body.connectorSlugs).toStrictEqual(
    first.body.connectorSlugs,
  );
  const visible = await accept(
    catalogClient().get({
      headers: authHeaders(),
      params: { connectorSlug: "github" },
    }),
    [200],
  );
  expect(visible.body.connector.label).toBe("Updated GitHub");
});

test.each(["production", "development"] as const)(
  "preview seed is unavailable in %s even with the cron secret",
  async (environment) => {
    mockEnv("ENV", environment);
    const response = await accept(seed(), [404]);
    expect(response.status).toBe(404);
  },
);

test("preview seed requires the cron secret", async () => {
  mockEnv("ENV", "preview");
  const response = await accept(
    (await seedClient()).seedPreview({
      headers: { authorization: "Bearer wrong-secret" },
    }),
    [401],
  );
  expect(response.status).toBe(401);
});

test("preview seed retains official byte-digest validation", async () => {
  const publication = createPublicConnectorCatalog(context);
  publication.stage(previewConnectorCatalogFixture());
  const previous = context.mocks.s3.send.getMockImplementation();
  if (!previous) {
    throw new Error("Missing external publisher fixture");
  }
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (
      command instanceof GetObjectCommand &&
      command.input.Key?.endsWith("/catalog.json")
    ) {
      const bytes = Buffer.from("{}");
      return Promise.resolve({
        ContentLength: bytes.length,
        Body: {
          async *[Symbol.asyncIterator]() {
            yield bytes;
          },
        },
      });
    }
    return previous(command);
  });
  mockEnv("ENV", "preview");
  const rejected = await accept(seed(), [500]);
  expect(rejected.status).toBe(500);
});
