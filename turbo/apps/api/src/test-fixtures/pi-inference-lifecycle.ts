/**
 * Infrastructure fixture: no production endpoint can create the default-off
 * lifecycle. Seed only owned synthetic identities; tests observe existing HTTP
 * readers/cancellation/cleanup. SQL probes cover fencing and FK erasure that
 * cannot be requested through a public API.
 */
import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { eq, sql } from "drizzle-orm";
import { conversations } from "@okouai/db/schema/conversation";
import { checkpoints } from "@okouai/db/schema/checkpoint";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { usageEvent } from "@okouai/db/schema/usage-event";
import {
  cleanupClerkDeletedOrg$,
  cleanupClerkDeletedUser$,
} from "../signals/services/webhooks-clerk-cleanup.service";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import {
  agentRunInference,
  agentRunSandboxIntent,
  agentRunSandboxLease,
} from "@okouai/db/schema/agent-run-inference";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import type { Tx } from "../lib/db-types";
import { db } from "../lib/db";
import { nowDate } from "../lib/time";
import {
  piInferenceOwnerPredicate,
  readPiInferenceLifecycle,
} from "../signals/services/pi-inference-lifecycle.service";
import { chatThreadAdmissionBlocked } from "../signals/services/chat-active-run.service";
import { completeAgentRun$ } from "../signals/services/agent-webhook-complete.service";
import {
  deleteRunConversations,
  deleteLockedRuns,
  releaseDeletedConversationReferences,
} from "../signals/services/conversation-history-deletion.service";

type Phase = typeof agentRunInference.$inferInsert.phase;
type LeaseState = typeof agentRunSandboxLease.$inferInsert.state;

export async function seedPiInferenceFixture(
  args: {
    readonly phase?: Phase;
    readonly leaseState?: LeaseState;
    readonly orgId?: string;
    readonly userId?: string;
    readonly legacy?: true;
  } = {},
) {
  const runId = randomUUID();
  const sessionId = randomUUID();
  const threadId = randomUUID();
  const agentId = randomUUID();
  const userId = args.userId ?? `pi-foundation-${randomUUID()}`;
  const orgId = args.orgId ?? `pi-foundation-${randomUUID()}`;
  const phase = args.phase ?? "ready";
  const at = nowDate();
  const old = new Date(at.getTime() - 10 * 60_000);
  const deadline = new Date(at.getTime() + 60_000);
  const launchSnapshot = args.legacy
    ? ({
        schemaVersion: 3,
        framework: "pi",
        runnerProfile: "vm0/default",
      } as const)
    : ({
        schemaVersion: 4,
        framework: "pi",
        executionMode: "api-inference",
        inferenceContractVersion: 1,
      } as const);
  await db().transaction(async (tx) => {
    await tx.insert(agents).values({
      id: agentId,
      owner: userId,
      orgId,
      name: `foundation-${agentId}`,
    });
    await tx
      .insert(agentSessions)
      .values({ id: sessionId, agentId, userId, orgId });
    await tx
      .insert(chatThreads)
      .values({ id: threadId, userId, agentId, agentSessionId: sessionId });
    await tx
      .insert(orgPlanEntitlements)
      .values({
        orgId,
        planKey: "test",
        planRank: 1,
        source: "test",
        restrictedBuiltInModels: false,
        baseConcurrencyLimit: 100,
      })
      .onConflictDoNothing();
    await tx.insert(agentRuns).values({
      id: runId,
      sessionId,
      userId,
      orgId,
      chatThreadId: threadId,
      prompt: "Synthetic foundation fixture",
      triggerSource: "chat",
      autonomyBudget: 0,
      status:
        phase === "sandbox_running"
          ? "running"
          : phase === "terminal"
            ? "completed"
            : "pending",
      launchSnapshot,
      selectedModel: "deepseek-v4-flash",
      modelProvider: "deepseek-api",
      modelRuntimeProvider: "deepseek",
      modelRuntimeModel: "deepseek-v4-flash",
      builtInModelKeyId: randomUUID(),
      apiStartedAt: old,
      createdAt: old,
      creditAdmitted: true,
      ...(args.legacy ? { lastHeartbeatAt: at } : {}),
    });
    if (args.legacy) {
      return;
    }
    await seedInferenceState(tx, {
      runId,
      phase,
      at,
      old,
      deadline,
      leaseState: args.leaseState,
    });
  });
  return {
    runId,
    sessionId,
    threadId,
    agentId,
    userId,
    orgId,
    launchSnapshot,
    apiStartedAt: old,
  };
}

async function seedInferenceState(
  tx: Tx,
  args: {
    readonly runId: string;
    readonly phase: Phase;
    readonly at: Date;
    readonly old: Date;
    readonly deadline: Date;
    readonly leaseState?: LeaseState;
  },
) {
  const { runId, phase, at, old, deadline } = args;
  await tx.insert(agentRunInference).values({
    runId,
    phase,
    ownerEpoch: 1,
    deadlineAt: deadline,
    activationReady: phase !== "admitted",
    publication: ["admitted", "ready", "provider"].includes(phase)
      ? null
      : {
          h1Hash: "c".repeat(64),
          manifestGeneration: 3,
          lastEventSequence: 4,
        },
    providerAttemptId: randomUUID(),
    providerAttemptState:
      phase === "provider"
        ? "may-have-started"
        : ["admitted", "ready"].includes(phase)
          ? "not-started"
          : "settled",
    input: {
      schemaVersion: 1,
      inputEventId: null,
      inputGeneration: 0,
      configurationHash: "a".repeat(64),
      contextHash: "b".repeat(64),
      h0: { kind: "empty" },
      deferredSecrets: { kind: "none" },
    },
  });
  if (phase.startsWith("sandbox_") || args.leaseState) {
    await tx.insert(agentRunSandboxIntent).values({
      runId,
      generation: 1,
      ownerEpoch: 1,
      continuation: {
        mode: "pending-tools",
        h1Hash: "c".repeat(64),
        manifestGeneration: 3,
        pendingToolIds: ["tool-1"],
        lastEventSequence: 4,
      },
      state:
        phase === "sandbox_preparing"
          ? "preparing"
          : phase === "sandbox_ready"
            ? "ready"
            : phase === "sandbox_running"
              ? "claimed"
              : phase === "terminal"
                ? "settled"
                : "waiting",
      enqueuedAt: old,
      expiresAt: new Date(at.getTime() + 60 * 60_000),
      attemptDeadlineAt: phase === "sandbox_preparing" ? deadline : null,
    });
  }
  const leaseState =
    args.leaseState ??
    (phase === "sandbox_preparing"
      ? "preparing"
      : phase === "sandbox_ready"
        ? "ready"
        : phase === "sandbox_running"
          ? "claimed"
          : undefined);
  if (leaseState) {
    await tx.insert(agentRunSandboxLease).values({
      runId,
      state: leaseState,
      ownerEpoch: 1,
      deadlineAt: deadline,
      runnerId: leaseState === "claimed" ? randomUUID() : null,
      releaseEvidence:
        leaseState === "released" ? "fixture:confirmed-stopped" : null,
    });
  }
}

export type PiInferenceFixture = Awaited<
  ReturnType<typeof seedPiInferenceFixture>
>;

export async function removePiInferenceFixture(f: PiInferenceFixture) {
  // These fixtures never allocate external resources; teardown owns all rows.
  await db().delete(usageEvent).where(eq(usageEvent.runId, f.runId));
  await db()
    .delete(agentRunSandboxLease)
    .where(eq(agentRunSandboxLease.runId, f.runId));
  await db()
    .delete(agentRunInference)
    .where(eq(agentRunInference.runId, f.runId));
  await db().delete(agents).where(eq(agents.id, f.agentId));
  await db()
    .delete(orgPlanEntitlements)
    .where(eq(orgPlanEntitlements.orgId, f.orgId));
}

export async function expirePiInferenceFixture(f: PiInferenceFixture) {
  await db()
    .update(agentRunInference)
    .set({ deadlineAt: new Date(nowDate().getTime() - 1) })
    .where(eq(agentRunInference.runId, f.runId));
  await db()
    .update(agentRunSandboxIntent)
    .set({ expiresAt: new Date(nowDate().getTime() - 1) })
    .where(eq(agentRunSandboxIntent.runId, f.runId));
}

export async function corruptPiInferenceFixture(f: PiInferenceFixture) {
  await db()
    .delete(agentRunInference)
    .where(eq(agentRunInference.runId, f.runId));
}

export async function readPiInferenceFixture(f: PiInferenceFixture) {
  return await readPiInferenceLifecycle(db(), f.runId, f.launchSnapshot);
}

export async function probePiInferenceOwnership(
  f: PiInferenceFixture,
  epoch: number,
) {
  return await db().transaction(async (tx) => {
    const [run] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.id, f.runId))
      .for("update");
    if (!run) {
      throw new Error("Missing fixture run");
    }
    const result = await tx
      .update(agentRunInference)
      .set({ publishedSequence: 7 })
      .where(
        piInferenceOwnerPredicate({
          runId: f.runId,
          ownerEpoch: epoch,
          at: nowDate(),
        }),
      )
      .returning({ runId: agentRunInference.runId });
    return result.length;
  });
}

export async function fixtureThreadAdmissionBlocked(f: PiInferenceFixture) {
  return await chatThreadAdmissionBlocked(db(), { threadId: f.threadId });
}

export async function finalizePiInferenceFixture(
  f: PiInferenceFixture,
  epoch: number,
  signal: AbortSignal,
  success = false,
) {
  if (success) {
    const [conversation] = await db()
      .insert(conversations)
      .values({
        runId: f.runId,
        cliAgentType: "pi",
        cliAgentSessionId: f.sessionId,
        cliAgentSessionHistoryHash: "c".repeat(64),
      })
      .returning();
    if (!conversation) {
      throw new Error("Missing fixture conversation");
    }
    await db().insert(checkpoints).values({
      runId: f.runId,
      conversationId: conversation.id,
      storageMounts: [],
    });
  }
  return await createStore().set(
    completeAgentRun$,
    {
      auth: { runId: f.runId, userId: f.userId, orgId: f.orgId },
      body: {
        runId: f.runId,
        exitCode: success ? 0 : 1,
        ...(success ? {} : { error: "Synthetic settled failure" }),
      },
      executionOwner: "api-first",
      inferenceOwnerEpoch: epoch,
    },
    signal,
  );
}

export async function erasePiInferenceFixture(f: PiInferenceFixture) {
  return await db().transaction(async (tx) => {
    await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.id, f.runId))
      .for("update");
    const removed = await deleteRunConversations(tx, [f.runId]);
    await deleteLockedRuns(tx, [f.runId]);
    return await releaseDeletedConversationReferences(tx, removed);
  });
}

export async function settlePiInferenceFixture(f: PiInferenceFixture) {
  await db()
    .update(agentRunInference)
    .set({ usageSettled: true })
    .where(eq(agentRunInference.runId, f.runId));
  await db()
    .update(agentRunSandboxLease)
    .set({ state: "released", releaseEvidence: "fixture:confirmed-stopped" })
    .where(eq(agentRunSandboxLease.runId, f.runId));
}

export async function withFixtureCapacityLock(
  f: PiInferenceFixture,
  operation: () => Promise<number>,
) {
  return await db().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${f.orgId}))`);
    return await operation();
  });
}

/** No writer can create this state yet; convert only an owned synthetic run. */
export async function convertPiInferenceFixture(
  runId: string,
  phase: "ready" | "sandbox_waiting",
) {
  const at = nowDate();
  await db().transaction(async (tx) => {
    await tx
      .update(agentRuns)
      .set({
        launchSnapshot: {
          schemaVersion: 4,
          framework: "pi",
          executionMode: "api-inference",
          inferenceContractVersion: 1,
        },
        status: "pending",
        sandboxId: null,
        apiStartedAt: at,
        modelRuntimeProvider: "openai-codex",
        modelRuntimeModel: "gpt-5.6-luna",
      })
      .where(eq(agentRuns.id, runId));
    await tx.delete(runnerJobQueue).where(eq(runnerJobQueue.runId, runId));
    await tx.insert(agentRunInference).values({
      runId,
      phase,
      ownerEpoch: 1,
      deadlineAt: new Date(at.getTime() + 60_000),
      activationReady: true,
      providerAttemptId: randomUUID(),
      providerAttemptState: "not-started",
      input: {
        schemaVersion: 1,
        inputEventId: null,
        inputGeneration: 0,
        configurationHash: "a".repeat(64),
        contextHash: "b".repeat(64),
        h0: { kind: "empty" },
        deferredSecrets: { kind: "none" },
      },
    });
    if (phase === "sandbox_waiting") {
      await tx.insert(agentRunSandboxIntent).values({
        runId,
        generation: 1,
        continuation: { mode: "untouched-h0" },
        state: "waiting",
        ownerEpoch: 1,
        enqueuedAt: at,
        expiresAt: new Date(at.getTime() + 3_600_000),
      });
    }
  });
}

export async function mismatchPiInferenceEpoch(f: PiInferenceFixture) {
  await db()
    .update(agentRunSandboxIntent)
    .set({ ownerEpoch: 2 })
    .where(eq(agentRunSandboxIntent.runId, f.runId));
  await db()
    .update(agentRunSandboxLease)
    .set({ ownerEpoch: 2 })
    .where(eq(agentRunSandboxLease.runId, f.runId));
}

export async function retainPiInferenceSource(
  f: PiInferenceFixture,
  source: PiInferenceFixture,
  mismatchHash = false,
) {
  const [conversation] = await db()
    .insert(conversations)
    .values({
      runId: source.runId,
      cliAgentType: "pi",
      cliAgentSessionId: source.sessionId,
      cliAgentSessionHistoryHash: "d".repeat(64),
    })
    .returning();
  if (!conversation) {
    throw new Error("Missing fixture source");
  }
  const lifecycle = await readPiInferenceFixture(f);
  if (!lifecycle) {
    throw new Error("Missing fixture lifecycle");
  }
  await db()
    .update(agentRuns)
    .set({ continuedFromSessionId: source.sessionId })
    .where(eq(agentRuns.id, f.runId));
  await db()
    .update(agentRunInference)
    .set({
      sourceConversationId: conversation.id,
      input: {
        ...lifecycle.inference.input,
        h0: {
          kind: "history",
          conversationId: conversation.id,
          historyHash: (mismatchHash ? "e" : "d").repeat(64),
        },
      },
    })
    .where(eq(agentRunInference.runId, f.runId));
}

export async function seedPiInferenceUsage(f: PiInferenceFixture) {
  await db().insert(usageEvent).values({
    runId: f.runId,
    idempotencyKey: randomUUID(),
    orgId: f.orgId,
    userId: f.userId,
    kind: "model",
    provider: "deepseek-v4-flash",
    category: "tokens.input",
    quantity: 1,
  });
}

export async function readPiInferenceUsage(f: PiInferenceFixture) {
  return await db()
    .select({ quantity: usageEvent.quantity })
    .from(usageEvent)
    .where(eq(usageEvent.runId, f.runId));
}

export async function erasePiInferenceScope(
  f: PiInferenceFixture,
  kind: "user" | "organization",
  signal: AbortSignal,
) {
  const store = createStore();
  if (kind === "user") {
    return await store.set(cleanupClerkDeletedUser$, f.userId, signal);
  }
  return await store.set(cleanupClerkDeletedOrg$, f.orgId, signal);
}

export async function transferPiFixtureAgentOwner(
  f: PiInferenceFixture,
  owner: string,
) {
  await db().update(agents).set({ owner }).where(eq(agents.id, f.agentId));
}
