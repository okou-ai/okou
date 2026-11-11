import { randomUUID } from "node:crypto";

import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import {
  customConnectorByIdContract,
  customConnectorProposalContract,
  customConnectorsContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { createStore } from "ccstate";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { customConnectorsRoutes } from "../custom-connectors";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const query = Object.freeze({ view: "scoped" as const });
const configs = () => {
  return setupApp({ context, routes: cloudflareAccessRoutes })(
    cloudflareAccessContract,
  );
};
const connectors = () => {
  return setupApp({ context, routes: customConnectorsRoutes })(
    customConnectorsContract,
  );
};
const connectorById = () => {
  return setupApp({ context, routes: customConnectorsRoutes })(
    customConnectorByIdContract,
  );
};

async function actor() {
  const identity = {
    orgId: `org_binding_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
  await store.set(
    seedOrgMembership$,
    { ...identity, role: "admin" },
    context.signal,
  );
  mocks.clerk.session(identity.userId, identity.orgId, "org:admin");
  mocks.s3.listObjects([]);
}

test.each(["http", "mcp"] as const)(
  "%s preparation keeps Direct behavior and negotiates the strict Cloudflare reader",
  async (kind) => {
    useSecretKmsProbe();
    await actor();
    const config = (
      await accept(
        configs().create({
          headers,
          query,
          body: {
            id: randomUUID(),
            scope: "organization",
            name: "Protected gateway",
            credentials: {
              clientId: "synthetic-id",
              clientSecret: "synthetic-secret",
            },
          },
        }),
        [201],
      )
    ).body;
    const definition = {
      displayName: "Direct connector",
      authMode: "none" as const,
      fields: [],
      headerInjections: [],
      queryInjections: [],
      ...(kind === "http"
        ? {
            kind: "http" as const,
            prefixTemplates: ["https://api.example.com/"],
          }
        : {
            kind: "mcp" as const,
            endpoint: "https://api.example.com/mcp",
            transport: "streamable-http" as const,
          }),
    };
    const connector = (
      await accept(connectors().create({ headers, body: definition }), [201])
    ).body;
    expect(
      (
        await accept(
          connectorById().get({ headers, params: { id: connector.id } }),
          [200],
        )
      ).body,
    ).not.toHaveProperty("networkBinding");
    const updated = (
      await accept(
        connectorById().update({
          headers,
          params: { id: connector.id },
          body: {
            ...definition,
            displayName: "Renamed connector",
            storageVersion: connector.storageVersion,
          },
        }),
        [200],
      )
    ).body;
    expect(updated.displayName).toBe("Renamed connector");
    expect(updated).not.toHaveProperty("networkBinding");

    const legacy = (await accept(configs().list({ headers, query }), [200]))
      .body.configs;
    expect(legacy[0]).not.toHaveProperty("customConnectors");
    const optedIn = (
      await accept(
        configs().list({
          headers,
          query: { ...query, includeCustomConnectors: "true" },
        }),
        [200],
      )
    ).body.configs;
    expect(optedIn[0]?.customConnectors).toStrictEqual([]);
    expect(JSON.stringify(optedIn)).not.toContain("synthetic-secret");
    const preview = (
      await accept(
        configs().impactPreview({
          headers,
          params: { configId: config.id },
          query: { operation: "convert", includeCustomConnectors: "true" },
        }),
        [200],
      )
    ).body;
    expect(preview.customConnectors).toStrictEqual([]);
    await accept(
      configs().convertToPersonal({
        headers,
        params: { configId: config.id },
        body: {
          expectedRevision: preview.expectedRevision,
          impactSnapshot: preview.impactSnapshot,
        },
      }),
      [200],
    );
    await accept(
      connectorById().delete({ headers, params: { id: connector.id } }),
      [204],
    );
  },
);

test.each([
  null,
  {
    type: "cloudflare_access" as const,
    configId: randomUUID(),
    protectedOrigins: ["https://api.example.com"],
  },
])(
  "preparation rejects an explicit binding mutation instead of silently dropping it: %j",
  async (networkBinding) => {
    await actor();
    const definition = {
      displayName: "No early activation",
      prefixTemplates: ["https://api.example.com/"],
      authMode: "none" as const,
      fields: [],
      headerInjections: [],
      queryInjections: [],
    };
    await accept(
      connectors().create({ headers, body: { ...definition, networkBinding } }),
      [400],
    );
    await accept(
      setupApp({ context, routes: customConnectorsRoutes })(
        customConnectorProposalContract,
      ).save({
        headers,
        body: {
          proposal: { ...definition, operation: "create", networkBinding },
          values: [],
        },
      }),
      [400],
    );
    expect(
      (await accept(connectors().list({ headers }), [200])).body.connectors,
    ).toStrictEqual([]);
    const connector = (
      await accept(connectors().create({ headers, body: definition }), [201])
    ).body;
    await accept(
      connectorById().update({
        headers,
        params: { id: connector.id },
        body: { ...definition, networkBinding },
      }),
      [400],
    );
    expect(
      (
        await accept(
          connectorById().get({ headers, params: { id: connector.id } }),
          [200],
        )
      ).body,
    ).not.toHaveProperty("networkBinding");
  },
);
