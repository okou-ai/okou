import { randomUUID } from "node:crypto";

import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { expect } from "vitest";

import type { TestContext } from "../../../../__tests__/test-context";
import { env, mockEnv } from "../../../../lib/env";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { createBddApi, type ApiTestUserOptions } from "./api-bdd";
import { createConnectorBddApi } from "./api-bdd-connectors";
import { createFirewallApi } from "./api-bdd-firewall";
import { createRunReadsApi } from "./api-bdd-run-reads";
import { createRunsApi } from "./api-bdd-runs";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";
import { deleteFeatureSwitchesForUser } from "./feature-switches";
import { createFixtureOperationOwner } from "./fixture-operation-owner";

/** A real paid actor; the selected OAuth scenarios own setup through teardown. */
export function createPublicFirewallFixture(
  context: TestContext,
  options: ApiTestUserOptions = {},
) {
  const actor = createBddApi(context).user(options);
  const orgId = actor.orgId;
  if (!orgId) {
    throw new Error("Expected an owned firewall organization");
  }
  const customerId = `cus_firewall_${randomUUID()}`;
  const subscriptionId = `sub_firewall_${randomUUID()}`;
  const kmsKeyId = env("SECRETS_KMS_KEY_ID");
  const storageBucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const agentIds = new Set<string>();
  const runIds = new Set<string>();
  const builtinAccounts = new Map<ConnectorSlug, Set<string>>();
  const customAccounts = new Map<string, Set<string>>();
  let restoreStorage: (() => void) | undefined;

  const owner = createFixtureOperationOwner(async () => {
    mockEnv("SECRETS_KMS_KEY_ID", kmsKeyId);
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", storageBucket);
    restoreStorage?.();
    context.mocks.ably.publish.mockResolvedValue(undefined);
    const runs = createRunsApi(context);
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    for (const runId of runIds) {
      const run = await runs.readRun(actor, runId);
      if (run.status === "pending" || run.status === "running") {
        await runs.requestCancelRun(actor, runId, [200]);
      }
    }
    await flushWaitUntilForTest();

    const connectors = createConnectorBddApi(context);
    for (const [slug, ownedIds] of builtinAccounts) {
      const accounts = await connectors.listBuiltinConnectorAccounts(
        actor,
        slug,
      );
      for (const account of accounts) {
        ownedIds.add(account.id);
      }
      for (const connectionId of ownedIds) {
        await connectors.deleteBuiltinConnectorAccount(
          actor,
          slug,
          connectionId,
        );
      }
    }
    for (const [connectorId, ownedIds] of customAccounts) {
      const accounts = await connectors.listCustomConnectorAccounts(
        actor,
        connectorId,
      );
      for (const account of accounts) {
        ownedIds.add(account.id);
      }
      for (const connectionId of ownedIds) {
        await connectors.deleteCustomConnectorAccount(
          actor,
          connectorId,
          connectionId,
        );
      }
      await connectors.deleteCustomConnector(actor, connectorId);
    }
    await flushWaitUntilForTest();
    await deleteFeatureSwitchesForUser(context, {
      userId: actor.userId,
      orgId,
      orgRole: actor.orgRole,
    });

    context.mocks.s3.send.mockResolvedValue({
      Contents: [],
      IsTruncated: false,
    });
    const webhooks = createWebhookCallbackApi(context);
    webhooks.configureStripeBillingEnv();
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
      await createBddApi(context).requestReadAgent(actor, agentId, [404]);
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
    // Production retains UUID-owned billing history after organization deletion.
  });

  return {
    actor,
    run: owner.run,
    async fund(): Promise<void> {
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
      createFirewallApi(context).seedClerkDirectory(actor);
      // These eight scenarios observe authorization, not the old synthetic 100000.
      await createRunsApi(context).grantProEntitlement(actor, {
        customerId,
        subscriptionId,
      });
    },
    registerAgent(agentId: string): void {
      agentIds.add(agentId);
    },
    registerRun(runId: string): void {
      runIds.add(runId);
    },
    registerBuiltinConnector(slug: ConnectorSlug): Set<string> {
      const accountIds = new Set<string>();
      builtinAccounts.set(slug, accountIds);
      return accountIds;
    },
    registerCustomConnector(connectorId: string): Set<string> {
      const accountIds = new Set<string>();
      customAccounts.set(connectorId, accountIds);
      return accountIds;
    },
  };
}

export type PublicFirewallFixture = ReturnType<
  typeof createPublicFirewallFixture
>;
