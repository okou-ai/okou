import { randomUUID } from "node:crypto";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { cronConnectorCatalogContract } from "@okouai/api-contracts/contracts/cron";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import {
  ONBOARDING_RECOMMENDATION_CONNECTOR_SLUGS,
  ONBOARDING_WORKFLOW_CONNECTOR_SLUGS,
  onboardingSourcesContract,
  onboardingWorkflowConnectorsContract,
} from "@okouai/api-contracts/contracts/onboarding";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../lib/env";
import { previewOnboardingCatalogFixture } from "../../../test-fixtures/preview-onboarding-catalog";
import { createPublicConnectorCatalog } from "./helpers/public-connector-catalog";
import { createRouteMocks } from "./helpers/route-test";
import { cronConnectorCatalogRoutes } from "../cron-connector-catalog";
import { connectorCatalogRoutes } from "../connector-catalog";
import { onboardingSourcesRoutes } from "../onboarding-sources";
import { onboardingWorkflowConnectorsRoutes } from "../onboarding-workflow-connectors";

const context = testContext();
const mocks = createRouteMocks(context);

function seedClient() {
  return setupApp({ context, routes: cronConnectorCatalogRoutes })(
    cronConnectorCatalogContract,
  );
}

function seed() {
  return seedClient().seedPreview({
    headers: { authorization: `Bearer ${env("CRON_SECRET")}` },
  });
}

function catalogClient() {
  mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
  return setupApp({ context, routes: connectorCatalogRoutes })(
    connectorCatalogContract,
  );
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

test("a large official catalog installs only onboarding and existing Runner E2E entries", async () => {
  const publication = createPublicConnectorCatalog(context);
  const artifact = previewOnboardingCatalogFixture(4000);
  const published = publication.stage(artifact);
  mockEnv("ENV", "preview");
  const seeded = await accept(seed(), [200]);
  const required = [
    ...new Set([
      ...ONBOARDING_RECOMMENDATION_CONNECTOR_SLUGS,
      ...ONBOARDING_WORKFLOW_CONNECTOR_SLUGS,
      "algolia",
      "bentoml",
      "discord-webhook",
      "serpapi",
      "twilio",
      "zendesk",
    ]),
  ].sort();
  expect(seeded.body).toStrictEqual({ ...published, connectorSlugs: required });
  expect(seeded.body.connectorSlugs).toHaveLength(31);

  const client = catalogClient();
  const github = await accept(
    client.get({ headers: authHeaders(), params: { connectorSlug: "github" } }),
    [200],
  );
  expect(github.body.connector.label).toBe("GitHub");
  const omitted = await accept(
    client.get({
      headers: authHeaders(),
      params: { connectorSlug: "preview-unrelated-0" },
    }),
    [404],
  );
  expect(omitted.status).toBe(404);

  // The post-deploy call must remain bounded, rather than activating all entries.
  const repeated = await accept(seed(), [200]);
  expect(repeated.body).toStrictEqual(seeded.body);
  await accept(
    client.get({
      headers: authHeaders(),
      params: { connectorSlug: "preview-unrelated-0" },
    }),
    [404],
  );
});

test("a replacement publication refreshes selected payloads while retaining its official digest", async () => {
  const publication = createPublicConnectorCatalog(context);
  const artifact = previewOnboardingCatalogFixture();
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
    seedClient().seedPreview({
      headers: { authorization: "Bearer wrong-secret" },
    }),
    [401],
  );
  expect(response.status).toBe(401);
});

test("a publication missing required entries does not replace the serving preview catalog", async () => {
  const publication = createPublicConnectorCatalog(context);
  const artifact = previewOnboardingCatalogFixture();
  publication.stage(artifact);
  mockEnv("ENV", "preview");
  await accept(seed(), [200]);
  publication.stage({
    ...artifact,
    connectors: artifact.connectors.filter((entry) => {
      return entry.slug !== "gmail";
    }),
  });
  await accept(seed(), [500]);
  const visible = await accept(
    catalogClient().get({
      headers: authHeaders(),
      params: { connectorSlug: "github" },
    }),
    [200],
  );
  expect(visible.body.connector.label).toBe("GitHub");
});

test("the bounded preview catalog serves both onboarding contracts", async () => {
  const publication = createPublicConnectorCatalog(context);
  publication.stage(previewOnboardingCatalogFixture());
  mockEnv("ENV", "preview");
  await accept(seed(), [200]);
  mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
  const sources = await accept(
    setupApp({ context, routes: onboardingSourcesRoutes })(
      onboardingSourcesContract,
    ).list({ headers: authHeaders() }),
    [200],
  );
  expect(
    sources.body.connectors.map((entry) => {
      return entry.slug;
    }),
  ).toContain("gmail");
  const workflow = await accept(
    setupApp({ context, routes: onboardingWorkflowConnectorsRoutes })(
      onboardingWorkflowConnectorsContract,
    ).list({ headers: authHeaders() }),
    [200],
  );
  expect(
    workflow.body.connectors
      .map((entry) => {
        return entry.slug;
      })
      .sort(),
  ).toStrictEqual([...ONBOARDING_WORKFLOW_CONNECTOR_SLUGS].sort());
});

test("production synchronization still serves connectors outside the preview selection", async () => {
  const publication = createPublicConnectorCatalog(context);
  mockEnv("ENV", "production");
  await publication.publish(previewOnboardingCatalogFixture());
  const visible = await accept(
    catalogClient().get({
      headers: authHeaders(),
      params: { connectorSlug: "preview-unrelated-0" },
    }),
    [200],
  );
  expect(visible.body.connector.slug).toBe("preview-unrelated-0");
  await accept(seed(), [404]);
});

test("preview seed retains official byte-digest validation", async () => {
  const publication = createPublicConnectorCatalog(context);
  publication.stage(previewOnboardingCatalogFixture());
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
