import type { ConnectorCatalogArtifact } from "@okouai/connectors/connector-catalog/artifacts/artifacts";

import type { TestContext } from "../../../../__tests__/test-context";
import { env, mockEnv } from "../../../../lib/env";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { settleIncludingAbort } from "../../../utils";
import { createBddApi } from "./api-bdd";
import { createRunsApi } from "./api-bdd-runs";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";
import {
  buildAutomaticMcpCatalog,
  type AutomaticMcpCatalogOptions,
} from "./connector-automatic-catalog";
import { createFixtureOperationOwner } from "./fixture-operation-owner";
import { createPublicConnectorCatalog } from "./public-connector-catalog";
import { createRouteMocks } from "./route-test";

/** Publish the case catalog and finish any real Runs before its database closes. */
export function createPublicAutomaticCatalog(
  context: TestContext,
  options: AutomaticMcpCatalogOptions & { readonly isolatePg?: boolean } = {},
) {
  const bdd = createBddApi(context);
  const actor = bdd.user();
  const orgId = actor.orgId;
  if (!orgId) {
    throw new Error("Expected an owned Automatic organization");
  }
  const { catalog: initialCatalog, ...descriptor } =
    buildAutomaticMcpCatalog(options);
  const runIds = new Map<string, string | undefined>();
  let published = false;
  const cleanupFailures: unknown[] = [];
  async function cleanup(operation: () => Promise<unknown>) {
    const result = await settleIncludingAbort(operation());
    if (!result.ok) {
      cleanupFailures.push(result.error);
    }
  }
  let restoreStorage: (() => void) | undefined;
  // Register ownership before either catalog publication or actor setup writes.
  const owner = createFixtureOperationOwner(async () => {
    await cleanup(async () => {
      await publisher.cleanup();
    });
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        cleanupFailures,
        "Automatic catalog fixture cleanup failed",
      );
    }
  });
  const publisher = createPublicConnectorCatalog(context, {
    cleanupOwnership: "caller",
    isolatePg: options.isolatePg,
  });
  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  mockEnv("APP_URL", "https://app.okou.ai");
  createRouteMocks(context).clerk.session(actor.userId, orgId);

  // Restore the external catalog environment before cancelling and acknowledging
  // Runs; database rows disappear with the isolated case database.
  publisher.onCleanup(async () => {
    if (!published) {
      return;
    }
    restoreStorage?.();
    context.mocks.ably.publish.mockResolvedValue(undefined);
    const runs = createRunsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    for (const [runId, sandboxToken] of runIds) {
      await cleanup(async () => {
        const run = await runs.readRun(actor, runId);
        const active = run.status === "pending" || run.status === "running";
        if (active) {
          await runs.requestCancelRun(actor, runId, [200]);
        }
        if (sandboxToken && (active || run.status === "cancelled")) {
          await webhooks.requestAgentComplete(
            { runId, exitCode: 1, error: "Run cancelled" },
            { authorization: `Bearer ${sandboxToken}` },
            [200],
          );
        }
      });
    }
    await cleanup(flushWaitUntilForTest);
  });

  return {
    ...descriptor,
    bucket,
    userId: actor.userId,
    orgId,
    run: owner.run,
    async publish(catalog: ConnectorCatalogArtifact = initialCatalog) {
      await publisher.publish(catalog);
      published = true;
    },
    async prepareRuntime() {
      const runs = createRunsApi(context);
      bdd.acceptAgentStorageWrites();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      const runnerGroup = runs.configureRunnerGroup();
      await runs.grantProEntitlement(actor);
      await runs.ensurePersonalSubscriptionModel(actor);
      const agent = await bdd.createAgent(actor, {
        displayName: "BDD lifecycle agent",
        description: "Exercises the full run lifecycle.",
        visibility: "private",
      });
      const storage = context.mocks.s3.send.getMockImplementation();
      const presign = context.mocks.s3.getSignedUrl.getMockImplementation();
      restoreStorage = () => {
        if (storage) {
          context.mocks.s3.send.mockImplementation(storage);
        }
        if (presign) {
          context.mocks.s3.getSignedUrl.mockImplementation(presign);
        }
      };
      return { actor, agentId: agent.agentId, runnerGroup };
    },
    registerRun(runId: string) {
      runIds.set(runId, undefined);
    },
    registerClaim(runId: string, sandboxToken: string) {
      runIds.set(runId, sandboxToken);
    },
  };
}
