import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import {
  builtinConnectorManualGrantContract,
  builtinConnectorsSearchContract,
} from "@okouai/api-contracts/contracts/connectors";
import { customConnectorsContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { cronConnectorCatalogContract } from "@okouai/api-contracts/contracts/cron";
import {
  CONNECTOR_CATALOG_ACTIVE_KEY,
  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { env, mockOptionalEnv } from "../../../lib/env";
import { connectorCatalogRoutes } from "../connector-catalog";
import { builtinConnectorsRoutes } from "../connectors";
import { cronConnectorCatalogRoutes } from "../cron-connector-catalog";
import { customConnectorsRoutes } from "../custom-connectors";
import { createBddApi } from "./helpers/api-bdd";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { publicRunOwner } from "./helpers/public-run-owner";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function signInAdmin() {
  createRouteMocks(context).clerk.session(
    `user_${randomUUID()}`,
    `org_${randomUUID()}`,
  );
}

describe("connector catalog v4 preparation", () => {
  it("cron-connector-catalog-v4-009 finds the current Monday MCP connector by name and slug", async () => {
    signInAdmin();
    const search = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsSearchContract,
    );
    const catalog = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );

    for (const keyword of ["Monday.com", "monday-mcp"]) {
      const searched = await accept(
        search.search({ headers, query: { keyword } }),
        [200],
      );
      const discovered = await accept(
        catalog.discovery({ headers, query: { keyword } }),
        [200],
      );

      expect(searched.body.connectors[0]?.slug).toBe("monday-mcp");
      expect(discovered.body.connectors[0]?.slug).toBe("monday-mcp");
    }
  });

  it("cron-connector-catalog-v4-006 keeps serving the catalog when its source is unavailable", async () => {
    signInAdmin();
    context.mocks.s3.send.mockRejectedValue(
      Object.assign(new Error("The specified key does not exist."), {
        name: "NoSuchKey",
        $metadata: { httpStatusCode: 404 },
      }),
    );
    const catalog = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const cron = setupApp({ context, routes: cronConnectorCatalogRoutes })(
      cronConnectorCatalogContract,
    );

    const before = await accept(catalog.list({ headers }), [200]);
    const synced = await accept(
      cron.sync({
        headers: { authorization: `Bearer ${env("CRON_SECRET")}` },
      }),
      [200],
    );
    const after = await accept(catalog.list({ headers }), [200]);

    expect(synced.body).toStrictEqual({
      outcome: "rejected",
      failureCode: "source-unavailable",
    });
    expect(after.body).toStrictEqual(before.body);
  });

  it("cron-connector-catalog-v4-010 does not expose an MCP transport as an executable HTTP permission bundle", async () => {
    signInAdmin();
    const catalog = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const customConnectors = setupApp({
      context,
      routes: customConnectorsRoutes,
    })(customConnectorsContract);

    const detail = await accept(
      catalog.get({ headers, params: { connectorSlug: "plaud-mcp" } }),
      [200],
    );
    const created = await accept(
      customConnectors.create({
        headers,
        body: {
          displayName: "Plaud over HTTP",
          prefixTemplates: [`https://api-${randomUUID()}.example.test/v1/`],
          fields: [],
          headerInjections: [],
          queryInjections: [],
          authMode: "none",
          permissionBundleRef: "builtin:plaud-mcp@1",
        },
      }),
      [400],
    );

    expect(
      detail.body.connector.authMethods.map((method) => {
        return method.grantKind;
      }),
    ).toContain("automatic");
    expect(created.body.error.message).toBe(
      "Unknown custom connector permission bundle: builtin:plaud-mcp@1",
    );
  });

  it(
    "cron-connector-catalog-v4-007 dispatches and completes a healthy Run after rejecting malformed catalog auth",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const bdd = createBddApi(context);
      const actor = bdd.user();
      const owner = publicRunOwner(context, actor);
      fixture.chatCallbacks.acceptChatObjectStorage();
      fixture.api.acceptStorageDownloads();
      fixture.api.acceptTelemetryIngest();
      mockOptionalEnv("OPENROUTER_API_KEY", undefined);
      fixture.chatCallbacks.disableVapid();

      const catalogVersion = `20261128-${randomUUID().slice(0, 8)}`;
      const catalogKey = `connectors/v${SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION}/releases/${catalogVersion}/catalog.json`;
      const malformedCatalogBytes = Buffer.from(
        JSON.stringify({
          artifactSchemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
          catalogVersion,
          categoryMetadata: {
            categories: [{ id: "design", label: "Design" }],
            groups: [],
          },
          connectors: [
            {
              slug: "malformed-service",
              firewall: { headers: { Authorization: 12_345 } },
            },
          ],
        }),
        "utf8",
      );
      const catalogDigest = `sha256:${createHash("sha256").update(malformedCatalogBytes).digest("hex")}`;
      const pointerBytes = Buffer.from(
        JSON.stringify({ catalogVersion, catalogKey, catalogDigest }),
        "utf8",
      );

      const previousS3 = context.mocks.s3.send.getMockImplementation();
      context.mocks.s3.send.mockImplementation((command: unknown) => {
        if (command instanceof GetObjectCommand) {
          if (command.input.Key === CONNECTOR_CATALOG_ACTIVE_KEY) {
            return Promise.resolve({
              Body: Readable.from([pointerBytes]),
              ContentLength: pointerBytes.byteLength,
            });
          }
          if (command.input.Key === catalogKey) {
            return Promise.resolve({
              Body: Readable.from([malformedCatalogBytes]),
              ContentLength: malformedCatalogBytes.byteLength,
            });
          }
        }
        return previousS3 ? previousS3(command) : Promise.resolve({});
      });

      const catalog = setupApp({ context, routes: connectorCatalogRoutes })(
        connectorCatalogContract,
      );
      const cron = setupApp({ context, routes: cronConnectorCatalogRoutes })(
        cronConnectorCatalogContract,
      );
      const manualGrant = setupApp({
        context,
        routes: builtinConnectorsRoutes,
      })(builtinConnectorManualGrantContract);
      const cronHeaders = { authorization: `Bearer ${env("CRON_SECRET")}` };

      createRouteMocks(context).clerk.session(
        actor.userId,
        actor.orgId,
        actor.orgRole,
      );
      const [beforeCatalog] = await Promise.all([
        accept(catalog.list({ headers }), [200]),
        accept(
          manualGrant.connect({
            headers,
            params: { connectorSlug: "figma" },
            body: {
              authMethod: "api-token",
              values: { accessToken: "accepted-catalog-figma-token" },
              account: { intent: "add" },
            },
          }),
          [200],
        ),
        fixture.api.configureRunnerGroup(),
        owner.run(() => {
          return bdd.bootstrapLimitedFreeOnboarding(actor);
        }),
      ]);

      const firstSync = await accept(
        cron.sync({ headers: cronHeaders }),
        [200],
      );
      expect(firstSync.body).toStrictEqual({
        outcome: "rejected",
        failureCode: "invalid-artifact",
      });

      const launched = await owner.run(() => {
        return fixture.sendChatRun(actor, {
          prompt: "Use Figma connector after rejected catalog sync",
          model: null,
        });
      });
      const execution = await owner.executionInput(launched.runId);
      const resolved = await createFirewallApi(context).requestFirewallAuth(
        { authorization: `Bearer ${execution.firewallToken}` },
        {
          authHeaders: {
            "X-Figma-Token": secretTemplate("FIGMA_TOKEN"),
          },
          secretConnectorMap: execution.secretConnectorMap ?? undefined,
          secretConnectorMetadataMap:
            execution.secretConnectorMetadataMap ?? undefined,
        },
        [200],
      );
      if (!("headers" in resolved.body)) {
        throw new Error("Expected resolved firewall headers");
      }
      expect(resolved.body.headers).toStrictEqual({
        "X-Figma-Token": "accepted-catalog-figma-token",
      });

      await createWebhookCallbackApi(context).requestAgentComplete(
        {
          runId: launched.runId,
          exitCode: 0,
          completion: {
            cliAgentType:
              execution.cliAgentType === "pi"
                ? "pi"
                : execution.cliAgentType === "codex"
                  ? "codex"
                  : "claude-code",
            cliAgentSessionId: execution.piSessionId ?? launched.threadId,
            cliAgentSessionHistoryDisposition: "native_only",
            storageOutputs: [],
          },
        },
        { authorization: `Bearer ${execution.sandboxToken}` },
        [200],
      );
      const completedRun = await owner.run(() => {
        return fixture.api.readRun(actor, launched.runId);
      });
      expect(completedRun.status).toBe("completed");

      const secondSync = await accept(
        cron.sync({ headers: cronHeaders }),
        [200],
      );
      expect(secondSync.body).toStrictEqual({
        outcome: "rejected",
        failureCode: "invalid-artifact",
      });
      createRouteMocks(context).clerk.session(
        actor.userId,
        actor.orgId,
        actor.orgRole,
      );
      const afterCatalog = await accept(catalog.list({ headers }), [200]);
      expect(afterCatalog.body).toStrictEqual(beforeCatalog.body);
    },
  );
});
