import { randomUUID } from "node:crypto";

import {
  testSshConnectionStateContract,
  type TestSshConnectionStateActionBody,
} from "@okouai/api-contracts/contracts/test-ssh-connection-state";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { agents } from "@okouai/db/schema/agent";
import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { billingRunAttributionWrite } from "../services/managed-usage-attribution";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { generateSandboxToken } from "../auth/tokens";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

type TestSshConnectionStateAction<
  TAction extends TestSshConnectionStateActionBody["action"],
> = Extract<TestSshConnectionStateActionBody, { action: TAction }>;

async function createRuntime(
  db: Db,
  body: TestSshConnectionStateAction<"create-runtime">,
) {
  const agentId = body.agentId ?? randomUUID();
  const sessionId = randomUUID();
  const runId = randomUUID();
  const threadId = body.chat ? randomUUID() : null;
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0034; new non-billing transactions are prohibited.
  await db.transaction(async (tx) => {
    if (body.agentId) {
      const [agent] = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.orgId, body.orgId)));
      if (!agent) {
        throw new Error("Runtime fixture requires an Agent in its workspace");
      }
    } else {
      await tx.insert(agents).values({
        id: agentId,
        orgId: body.orgId,
        owner: body.userId,
        name: `ssh-${agentId}`,
      });
    }
    await tx.insert(agentSessions).values({
      id: sessionId,
      agentId,
      orgId: body.orgId,
      userId: body.userId,
    });
    if (threadId) {
      await tx
        .insert(chatThreads)
        .values({ id: threadId, agentId, userId: body.userId });
    }
    let workflowAutomationId: string | null = null;
    if (
      body.triggerSource === "automation-schedule" ||
      body.triggerSource === "automation-event"
    ) {
      const workflowId = randomUUID();
      workflowAutomationId = randomUUID();
      await tx.insert(workflows).values({
        id: workflowId,
        orgId: body.orgId,
        agentId,
        name: `ssh-${workflowId}`,
        ownerUserId: body.userId,
        createdBy: body.userId,
        updatedBy: body.userId,
      });
      const trigger =
        body.triggerSource === "automation-schedule"
          ? {
              kind: "schedule" as const,
              scheduleType: "loop" as const,
              intervalSeconds: 3600,
            }
          : {
              kind: "event" as const,
              eventType: "webhook-received" as const,
              eventConfig: {},
            };
      await tx.insert(workflowAutomations).values({
        id: workflowAutomationId,
        workflowId,
        orgId: body.orgId,
        ownerUserId: body.userId,
        ...trigger,
        enabled: false,
      });
    }
    const [run] = await tx
      .insert(agentRuns)
      .values({
        id: runId,
        sessionId,
        orgId: body.orgId,
        userId: body.userId,
        status: body.status,
        prompt: "SSH runtime fixture",
        triggerSource: body.triggerSource,
        autonomyBudget: body.triggerSource === null ? null : 3,
        chatThreadId: body.chat ? threadId : null,
        workflowAutomationId,
        runnerId: body.runnerId,
        runnerGroup: body.runnerGroup,
        runnerHeartbeatGeneration: body.heartbeatGeneration,
      })
      .returning({
        id: agentRuns.id,
        orgId: agentRuns.orgId,
        userId: agentRuns.userId,
        startedAt: sql`${agentRuns.createdAt}::text`.mapWith(pgTextDecoder),
        triggerSource: agentRuns.triggerSource,
        threadId: agentRuns.chatThreadId,
      });
    if (!run) {
      throw new Error("SSH fixture Run insertion returned no identity");
    }
    const capture = billingRunAttributionWrite(run);
    await tx
      .insert(billingRunAttribution)
      .values(capture.values)
      .onConflictDoNothing();
  });
  return {
    status: 200 as const,
    body: {
      ok: true as const,
      agentId,
      runId,
      ...(body.chat && threadId ? { threadId } : {}),
      sandboxToken: generateSandboxToken(body.userId, runId, body.orgId),
    },
  };
}

async function setLearnedHostKey(
  db: Db,
  body: TestSshConnectionStateAction<"set-learned-host-key">,
) {
  const [updated] = await db
    .update(sshConnections)
    .set({
      learnedHostKeyAlgorithm: body.algorithm,
      learnedHostKeyFingerprint: body.fingerprint,
      generation: sql`${sshConnections.generation} + 1`,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(sshConnections.id, body.connectionId),
        eq(sshConnections.orgId, body.orgId),
        eq(sshConnections.userId, body.userId),
      ),
    )
    .returning({ generation: sshConnections.generation });
  if (!updated) {
    return { status: 400 as const, body: { error: "Connection not found" } };
  }
  return {
    status: 200 as const,
    body: { ok: true as const, generation: updated.generation },
  };
}

const mutateSshConnectionState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(
      bodyResultOf(testSshConnectionStateContract.action),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const db = set(writeDb$);
    switch (bodyResult.data.action) {
      case "create-runtime": {
        return await createRuntime(db, bodyResult.data);
      }
      case "set-learned-host-key": {
        return await setLearnedHostKey(db, bodyResult.data);
      }
    }
  },
);

export const testSshConnectionStateRoutes: readonly RouteEntry[] = [
  {
    route: testSshConnectionStateContract.action,
    handler: mutateSshConnectionState$,
  },
];
