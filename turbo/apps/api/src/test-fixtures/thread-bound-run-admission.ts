import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { db } from "../lib/db";
import { now } from "../lib/time";
import { createAgentRun$ } from "../signals/services/background-agent-run.service";
import { createTestFixtureAgentRun$ } from "../signals/services/test-agent-run-fixture.service";
import {
  clearAgentRunPiExecutionSnapshotHookForTest,
  setAgentRunPiExecutionSnapshotHookForTest,
  type AgentRunPiExecutionSnapshot,
} from "../signals/services/agent-run-preparation-hooks";
import { buildAgentExecutionConfig } from "../signals/services/agent-execution-config";
import { createDeferredPromise } from "../signals/utils";
import { loadModelCatalog } from "../signals/services/model-catalog.service";
const USER_ID = "thread-run-invariant-user";
const ORG_ID = "thread-run-invariant-org";

export function holdAgentRunPiExecutionSnapshotFixture(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly signal: AbortSignal;
}): {
  readonly arrival: Promise<AgentRunPiExecutionSnapshot>;
  readonly release: () => void;
} {
  const arrival = createDeferredPromise<AgentRunPiExecutionSnapshot>(
    args.signal,
  );
  const released = createDeferredPromise<void>(args.signal);
  setAgentRunPiExecutionSnapshotHookForTest(async (snapshot) => {
    if (snapshot.userId !== args.userId || snapshot.orgId !== args.orgId) {
      return;
    }
    arrival.resolve(snapshot);
    await released.promise;
  });
  return {
    arrival: arrival.promise,
    release: () => {
      clearAgentRunPiExecutionSnapshotHookForTest();
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
  };
}

/**
 * Exercise the agent-runs-create service boundary that public contracts cannot
 * construct: a chat-thread id without an atomic queue association.
 */
export async function createUnassociatedThreadBoundAgentRunsServiceFixture(
  chatThreadId: string = randomUUID(),
): Promise<void> {
  await createStore().set(
    createTestFixtureAgentRun$,
    {
      auth: {
        tokenType: "session",
        userId: USER_ID,
        orgId: ORG_ID,
        orgRole: "member",
      },
      body: {
        agentId: "thread-run-invariant-agent",
        prompt: "must be rejected before agent run preparation",
      },
      apiStartTime: now(),
      piExecution: false,
      chatThreadId,
    },
    new AbortController().signal,
  );
}

/**
 * Exercise the lower agent-run boundary so internal callers outside Chat cannot
 * bypass the same queue-claim invariant.
 */
export async function createUnassociatedThreadBoundAgentRunFixture(
  chatThreadId: string = randomUUID(),
): Promise<void> {
  await createStore().set(
    createAgentRun$,
    {
      catalog: await loadModelCatalog(db()),
      userId: USER_ID,
      orgId: ORG_ID,
      body: {
        prompt: "must be rejected before agent run preparation",
        triggerSource: "test",
      },
      apiStartTime: now(),
      productAgentExecutionPlan: {
        identity: "agent",
        content: buildAgentExecutionConfig("thread-run-invariant-agent"),
      },
      piExecution: false,
      chatThreadId,
      connectorScope: {
        allowedConnectorSlugs: [],
        allowedCustomConnectorIds: [],
      },
    },
    new AbortController().signal,
  );
}
