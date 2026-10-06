import { now } from "../../../../lib/time";
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

/** A real paid actor; the selected firewall scenarios own setup through teardown. */
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
  const invoiceId = `in_public_cash_${randomUUID()}`;
  const kmsKeyId = env("SECRETS_KMS_KEY_ID");
  const storageBucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const agentIds = new Set<string>();
  const runIds = new Set<string>();
  const claims = new Map<string, string>();
  const deletedRuns = new Set<string>();
  const scenarioCleanups: (() => Promise<void>)[] = [];
  const deletedUsers = new Set<string>();
  const builtinAccounts = new Map<ConnectorSlug, Set<string>>();
  const builtinDeletionIntents = new Map<ConnectorSlug, Set<string>>();
  const customAccounts = new Map<string, Set<string>>();
  let restoreStorage: (() => void) | undefined;

  async function cleanupRuns() {
    const runs = createRunsApi(context);
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const accepted = await createRunReadsApi(context).requestListLogs(
      actor,
      { limit: 100 },
      [200],
    );
    for (const run of accepted.body.data) {
      runIds.add(run.id);
    }
    for (const runId of runIds) {
      const response = await runs.requestReadRun(
        actor,
        runId,
        deletedRuns.has(runId) ? [200, 404] : [200],
      );
      if (response.status === 404 && deletedRuns.has(runId)) {
        continue;
      }
      if (response.status !== 200) {
        throw new Error("Expected the owned Run to remain readable");
      }
      const run = response.body;
      if (run.status === "pending" || run.status === "running") {
        await runs.requestCancelRun(actor, runId, [200]);
      }
      const token = claims.get(runId);
      if (token && ["pending", "running", "cancelled"].includes(run.status)) {
        await createWebhookCallbackApi(context).requestAgentComplete(
          { runId, exitCode: 1, error: "Owned carrier cancelled" },
          { authorization: `Bearer ${token}` },
          [200],
        );
      }
    }
    await flushWaitUntilForTest();
  }

  const owner = createFixtureOperationOwner(async () => {
    mockEnv("SECRETS_KMS_KEY_ID", kmsKeyId);
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", storageBucket);
    restoreStorage?.();
    context.mocks.ably.publish.mockResolvedValue(undefined);
    await cleanupRuns();

    for (const cleanup of scenarioCleanups) {
      await cleanup();
    }
    const connectors = createConnectorBddApi(context);
    for (const [slug, ownedIds] of builtinAccounts) {
      const accounts = await connectors.listBuiltinConnectorAccounts(
        actor,
        slug,
      );
      for (const account of accounts) {
        ownedIds.add(account.id);
      }
      const existingIds = new Set(
        accounts.map((account) => {
          return account.id;
        }),
      );
      for (const connectionId of ownedIds) {
        // A scenario delete may commit before its response is interrupted.
        // Only an explicitly registered delete may be absent at teardown.
        if (
          builtinDeletionIntents.get(slug)?.has(connectionId) &&
          !existingIds.has(connectionId)
        ) {
          continue;
        }
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
    for (const userId of deletedUsers) {
      webhooks.verifyNextClerkWebhook({
        type: "user.deleted",
        data: { id: userId },
      });
      await webhooks.requestClerkWebhook("{}", {}, [200]);
      await flushWaitUntilForTest();
    }
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
    customerId,
    subscriptionId,
    run: owner.run,
    registerCleanup(cleanup: () => Promise<void>): void {
      scenarioCleanups.push(cleanup);
    },
    registerRunDeletion(runId: string): void {
      deletedRuns.add(runId);
    },
    async fund(fundingActor = actor, cashCredits?: 100_000) {
      if (fundingActor.orgId !== orgId) {
        throw new Error("Funding must belong to the owned organization");
      }
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
      createFirewallApi(context).seedClerkDirectory(fundingActor);
      if (cashCredits !== undefined) {
        const bdd = createBddApi(context);
        const runs = createRunsApi(context);
        const webhooks = createWebhookCallbackApi(context);
        expect((await bdd.completeOnboarding(fundingActor)).status).toBe(200);
        expect((await runs.readBillingStatus(fundingActor)).credits).toBe(0);
        webhooks.configureStripeBillingEnv();
        context.mocks.stripe.customers.retrieve.mockResolvedValue({
          id: customerId,
          metadata: { orgId },
        });
        const subscription = {
          id: subscriptionId,
          customer: customerId,
          status: "active",
          metadata: {},
          cancel_at_period_end: false,
          cancel_at: null,
          schedule: null,
          trial_end: null,
          items: { data: [{ price: { id: "price_bdd_pro" } }] },
        };
        for (const type of [
          "customer.subscription.created",
          "customer.subscription.updated",
        ]) {
          await webhooks.postStripeEvent(
            {
              id: `evt_public_cash_${randomUUID()}`,
              type,
              created: Math.floor(now() / 1000),
              data: { object: subscription },
            },
            [200],
          );
        }
        await expect(
          runs.readBillingStatus(fundingActor),
        ).resolves.toMatchObject({ tier: "pro", status: "active", credits: 0 });
        await webhooks.postStripeEvent(
          {
            id: `evt_public_cash_${randomUUID()}`,
            type: "invoice.paid",
            created: Math.floor(now() / 1000),
            data: {
              object: {
                id: invoiceId,
                customer: customerId,
                amount_paid: cashCredits / 10,
                metadata: {
                  type: "auto_recharge",
                  orgId,
                  creditsAmount: String(cashCredits),
                },
                parent: null,
                lines: { has_more: false, data: [] },
              },
            },
          },
          [200],
        );
        await flushWaitUntilForTest();
        await expect(
          runs.readBillingStatus(fundingActor),
        ).resolves.toMatchObject({
          tier: "pro",
          status: "active",
          credits: cashCredits,
        });
        return { customerId, subscriptionId, invoiceId };
      }
      // Default authorization fixtures retain their existing subscription grant.
      return await createRunsApi(context).grantProEntitlement(fundingActor, {
        customerId,
        subscriptionId,
      });
    },
    registerAgent(agentId: string): void {
      agentIds.add(agentId);
    },
    registerClaim(runId: string, token: string): void {
      runIds.add(runId);
      claims.set(runId, token);
    },
    registerOwnedUserDeletion(userId = actor.userId): void {
      deletedUsers.add(userId);
    },
    registerRun(runId: string): void {
      runIds.add(runId);
    },
    registerBuiltinConnector(slug: ConnectorSlug): Set<string> {
      const accountIds = new Set<string>();
      builtinAccounts.set(slug, accountIds);
      return accountIds;
    },
    registerBuiltinConnectorDeletion(
      slug: ConnectorSlug,
      connectionId: string,
    ): void {
      const ids = builtinDeletionIntents.get(slug) ?? new Set<string>();
      ids.add(connectionId);
      builtinDeletionIntents.set(slug, ids);
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
