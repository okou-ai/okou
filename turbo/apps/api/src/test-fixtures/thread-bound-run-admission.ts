import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { now } from "../lib/time";
import {
  createAgentRun$,
  clearAgentRunPiExecutionSnapshotHookForTest,
  createTestFixtureAgentRun$,
  setAgentRunPiExecutionSnapshotHookForTest,
  type AgentRunPiExecutionSnapshot,
} from "../signals/services/pick-chat-run.service";
import { buildAgentExecutionConfig } from "../signals/services/agent-execution-config";
import { createDeferredPromise } from "../signals/utils";

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
