import { randomUUID } from "node:crypto";

import type { ConnectorCatalogArtifact } from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { expect } from "vitest";

import type { TestContext } from "../../../../__tests__/test-context";
import { env, mockEnv } from "../../../../lib/env";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { settleIncludingAbort } from "../../../utils";
import { createBddApi } from "./api-bdd";
import { createConnectorBddApi } from "./api-bdd-connectors";
import { createRunReadsApi } from "./api-bdd-run-reads";
import { createRunsApi } from "./api-bdd-runs";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";
import {
  buildAutomaticMcpCatalog,
  type AutomaticMcpCatalogOptions,
} from "./connector-automatic-catalog";
import { createFixtureOperationOwner } from "./fixture-operation-owner";
import { createPublicConnectorCatalog } from "./public-connector-catalog";
import { createRouteMocks } from "./route-test";

/** Own both accepted catalog generations and their real account/Run consumers. */
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
  const customerId = `cus_automatic_${randomUUID()}`;
  const subscriptionId = `sub_automatic_${randomUUID()}`;
  const { catalog: initialCatalog, ...descriptor } =
    buildAutomaticMcpCatalog(options);
  const runIds = new Map<string, string | undefined>();
  const agentIds = new Set<string>();
  const accountIds = new Set<string>();
  const accountDeletionIntents = new Set<string>();
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

  // The source still exists during account and organization cleanup. Its one
  // publisher removes only that source after this callback finishes.
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

    await cleanup(async () => {
      const connectors = createConnectorBddApi(context);
      const accounts = await connectors.listBuiltinConnectorAccounts(
        actor,
        descriptor.slug,
      );
      const existingIds = new Set(
        accounts.map((account) => {
          return account.id;
        }),
      );
      for (const account of accounts) {
        // Covers an account whose creation committed before its response was lost.
        accountIds.add(account.id);
      }
      for (const connectionId of accountIds) {
        if (
          accountDeletionIntents.has(connectionId) &&
          !existingIds.has(connectionId)
        ) {
          continue;
        }
        await cleanup(async () => {
          await connectors.deleteBuiltinConnectorAccount(
            actor,
            descriptor.slug,
            connectionId,
          );
        });
      }
      await flushWaitUntilForTest();
    });
    for (const agentId of agentIds) {
      await cleanup(async () => {
        await bdd.deleteAgent(actor, agentId);
      });
    }
    await cleanup(flushWaitUntilForTest);

    await cleanup(async () => {
      context.mocks.s3.send.mockResolvedValue({
        Contents: [],
        IsTruncated: false,
      });
      webhooks.configureStripeBillingEnv();
      context.mocks.stripe.customers.retrieve.mockResolvedValue({
        id: customerId,
        metadata: { orgId },
      });
      context.mocks.stripe.subscriptions.list.mockResolvedValue({
        data: [],
        has_more: false,
      });
      context.mocks.stripe.invoices.list.mockResolvedValue({
        data: [],
        has_more: false,
      });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        id: subscriptionId,
        status: "active",
        metadata: {},
      });
      context.mocks.stripe.subscriptions.update.mockResolvedValue({
        id: subscriptionId,
      });
      context.mocks.stripe.subscriptions.cancel.mockResolvedValue({
        id: subscriptionId,
        status: "canceled",
      });
      webhooks.configureClerkWebhookSecret();
      webhooks.verifyNextClerkWebhook({
        type: "organization.deleted",
        data: { id: orgId },
      });
      await webhooks.requestClerkWebhook("{}", {}, [200]);
      await flushWaitUntilForTest();
      for (const agentId of agentIds) {
        await bdd.requestReadAgent(actor, agentId, [404]);
      }
      expect(
        (
          await createRunReadsApi(context).requestListLogs(
            actor,
            { limit: 50 },
            [200],
          )
        ).body.data,
      ).toStrictEqual([]);
      // Production retains UUID-owned financial/usage history after org deletion.
    });
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
      await runs.grantProEntitlement(actor, { customerId, subscriptionId });
      await runs.ensurePersonalSubscriptionModel(actor);
      const agent = await bdd.createAgent(actor, {
        displayName: "BDD lifecycle agent",
        description: "Exercises the full run lifecycle.",
        visibility: "private",
      });
      agentIds.add(agent.agentId);
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
    registerAccount(connectionId: string) {
      accountIds.add(connectionId);
    },
    registerAccountDeletion(connectionId: string) {
      accountDeletionIntents.add(connectionId);
    },
  };
}
