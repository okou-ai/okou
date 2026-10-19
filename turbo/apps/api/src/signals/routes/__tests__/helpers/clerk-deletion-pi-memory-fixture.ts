import { runnersCancellationContract } from "@okouai/api-contracts/contracts/runners";
import { expect } from "vitest";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { runnerCancellationRoutes } from "../../runner-cancellation";
import { createPiMemoryMaintenanceFixture } from "./pi-memory-maintenance-fixture";

export type Deletion = "user.deleted" | "organization.deleted";

export function createClerkDeletionPiMemoryFixture(
  context: TestContext,
  onboarding: "paid" | "limited-free" = "paid",
) {
  const fixture = createPiMemoryMaintenanceFixture(context, onboarding);
  const { webhooks, cronHeaders, prepareSources, prepareMaintenance } = fixture;

  type Sources = Awaited<ReturnType<typeof prepareSources>>;
  type Maintenance = Awaited<ReturnType<typeof prepareMaintenance>>;

  async function deleteOwner(type: Deletion, owner: Sources["actor"]) {
    webhooks.configureClerkWebhookSecret();
    webhooks.verifyNextClerkWebhook({
      type,
      data: { id: type === "user.deleted" ? owner.userId : owner.orgId },
    });
    await webhooks.requestClerkWebhook("{}", {}, [200]);
    await flushWaitUntilForTest();
  }

  async function cancellation(
    run: Pick<Maintenance, "runId" | "headers" | "runnerGroup">,
    source: Sources,
  ) {
    const response = await accept(
      setupApp({ context, routes: runnerCancellationRoutes })(
        runnersCancellationContract,
      ).get({
        params: { runId: run.runId },
        headers: run.headers,
        query: { runnerGroup: run.runnerGroup, ...source.runnerIdentity },
      }),
      [200],
    );
    return response.body;
  }

  async function extract(source: Sources, succeeded: number) {
    const response = await accept(
      source.stage1.extract({ headers: cronHeaders() }),
      [200],
    );
    expect(response.body).toMatchObject({
      success: true,
      succeeded,
      terminalFailure: 0,
      retryableFailure: 0,
    });
  }

  async function dispatch(source: Sources) {
    const response = await accept(
      source.stage2.consolidate({ headers: cronHeaders() }),
      [200],
    );
    expect(response.body).toMatchObject({ claimed: 1, failed: 0, stale: 0 });
  }

  async function extractIndependentOwnerAfterDeletion(type: Deletion) {
    const source = await prepareSources({
      independentOwner: true,
      peerScope: "foreign",
    });
    await deleteOwner(type, source.actor);
    await extract(source, 1);
    await dispatch(source);
    const independent = await source.claimMaintenance();
    expect(independent.actor.userId).toBe(source.peerActor?.actor.userId);
    expect(independent.actor.orgId).toBe(source.peerActor?.actor.orgId);
    expect(independent.maintenance.selected).toContainEqual(
      expect.objectContaining({ sourceRunId: source.peerSource?.runId }),
    );
    expect(independent.maintenance.selected).not.toContainEqual(
      expect.objectContaining({ sourceRunId: source.source.runId }),
    );
    return { source, independent };
  }

  return {
    ...fixture,
    deleteOwner,
    cancellation,
    extract,
    dispatch,
    extractIndependentOwnerAfterDeletion,
  };
}
