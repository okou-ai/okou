import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { testComputerUseStateContract } from "@okouai/api-contracts/contracts/test-computer-use-state";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { and, eq, isNotNull, sql } from "drizzle-orm";

import { bodyResultOf, queryOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { normalizeRunMetadata } from "../services/agent-run-metadata-write.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const postBody$ = bodyResultOf(testComputerUseStateContract.post);
const getQuery$ = queryOf(testComputerUseStateContract.get);
const deleteQuery$ = queryOf(testComputerUseStateContract.delete);

interface RunState {
  readonly id: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly triggerSource: string | null;
  readonly chatThreadId: string | null;
}

interface BaseComputerUseRunSeed {
  readonly agentId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly threadId: string | null;
}

type ComputerUseTriggerSource = "web" | "slack" | "teams";

async function loadRunState(db: Db, runId: string): Promise<RunState | null> {
  const [run] = await db
    .select({
      id: agentRuns.id,
      sessionId: agentRuns.sessionId,
      agentId: sql`${agentSessions.agentId}`.mapWith(agentSessions.id),
      triggerSource: agentRuns.triggerSource,
      chatThreadId: agentRuns.chatThreadId,
    })
    .from(agentRuns)
    .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
    .where(
      and(
        eq(agentRuns.id, runId),
        isNotNull(agentRuns.triggerSource),
        isNotNull(agentSessions.agentId),
      ),
    )
    .limit(1);
  return run ?? null;
}

async function sourceComputerUseHostId(
  db: Db,
  run: RunState,
): Promise<string | null> {
  if (!run.chatThreadId) {
    return null;
  }

  const [thread] = await db
    .select({ computerUseHostId: chatThreads.computerUseHostId })
    .from(chatThreads)
    .where(eq(chatThreads.id, run.chatThreadId))
    .limit(1);
  return thread?.computerUseHostId ?? null;
}

async function seedBaseComputerUseRun(args: {
  readonly db: Db;
  readonly userId: string;
  readonly orgId: string;
  readonly triggerSource: ComputerUseTriggerSource;
  readonly canonicalThread: boolean;
  readonly signal: AbortSignal;
}): Promise<BaseComputerUseRunSeed> {
  const agentId = randomUUID();
  const sessionId = randomUUID();
  const runId = randomUUID();
  const threadId =
    args.triggerSource === "web" || args.canonicalThread ? randomUUID() : null;
  const metadata = normalizeRunMetadata({
    triggerSource: args.triggerSource,
    chatThreadId: threadId,
  });

  await args.db.insert(agents).values({
    id: agentId,
    owner: args.userId,
    orgId: args.orgId,
    name: `computer-use-auth-${agentId.slice(0, 8)}`,
    visibility: "private",
  });
  args.signal.throwIfAborted();

  if (threadId) {
    await args.db.insert(chatThreads).values({
      id: threadId,
      userId: args.userId,
      agentId,
      title: "Computer Use authorization test",
    });
    args.signal.throwIfAborted();
  }

  await args.db.insert(agentSessions).values({
    id: sessionId,
    userId: args.userId,
    orgId: args.orgId,
    agentId,
  });
  args.signal.throwIfAborted();

  await args.db.insert(agentRuns).values({
    id: runId,
    userId: args.userId,
    orgId: args.orgId,
    sessionId,
    status: "running",
    prompt: "Need Computer Use",
    ...metadata,
  });
  args.signal.throwIfAborted();

  return { agentId, sessionId, runId, threadId };
}

const postComputerUseState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(postBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const body = bodyResult.data;
    if (!body.user_id || !body.org_id || !body.trigger_source) {
      return {
        status: 400 as const,
        body: { error: "user_id, org_id, and trigger_source are required" },
      };
    }
    if (body.trigger_source === "slack" && body.canonical_thread !== true) {
      return {
        status: 400 as const,
        body: { error: "Slack test runs require canonical_thread" },
      };
    }

    const db = set(writeDb$);
    const seed = await seedBaseComputerUseRun({
      db,
      userId: body.user_id,
      orgId: body.org_id,
      triggerSource: body.trigger_source,
      canonicalThread: body.canonical_thread === true,
      signal,
    });
    return {
      status: 200 as const,
      body: {
        ok: true as const,
        compose_id: seed.agentId,
        run_id: seed.runId,
        session_id: seed.sessionId,
        thread_id: seed.threadId,
      },
    };
  },
);

const getComputerUseState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const query = get(getQuery$);
    const runId = query.run_id;
    if (!runId) {
      return {
        status: 400 as const,
        body: { error: "run_id query param is required" },
      };
    }

    const db = set(writeDb$);
    const run = await loadRunState(db, runId);
    signal.throwIfAborted();
    if (!run) {
      return {
        status: 200 as const,
        body: { source: null, computer_use_host_id: null },
      };
    }

    return {
      status: 200 as const,
      body: {
        source:
          run.triggerSource === "web" ||
          run.triggerSource === "slack" ||
          run.triggerSource === "teams"
            ? run.triggerSource
            : null,
        computer_use_host_id: await sourceComputerUseHostId(db, run),
      },
    };
  },
);

const deleteComputerUseState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const query = get(deleteQuery$);
    const runId = query.run_id;
    if (!runId) {
      return {
        status: 400 as const,
        body: { error: "run_id query param is required" },
      };
    }

    const db = set(writeDb$);
    const run = await loadRunState(db, runId);
    signal.throwIfAborted();
    if (!run) {
      return { status: 200 as const, body: { ok: true as const } };
    }

    await db.delete(agentRuns).where(eq(agentRuns.id, run.id));
    signal.throwIfAborted();
    await db.delete(agentSessions).where(eq(agentSessions.id, run.sessionId));
    signal.throwIfAborted();
    if (run.chatThreadId) {
      await db.delete(chatThreads).where(eq(chatThreads.id, run.chatThreadId));
      signal.throwIfAborted();
    }
    await db.delete(agents).where(eq(agents.id, run.agentId));
    signal.throwIfAborted();

    return { status: 200 as const, body: { ok: true as const } };
  },
);

export const testComputerUseStateRoutes: readonly RouteEntry[] = [
  {
    route: testComputerUseStateContract.post,
    handler: postComputerUseState$,
  },
  {
    route: testComputerUseStateContract.get,
    handler: getComputerUseState$,
  },
  {
    route: testComputerUseStateContract.delete,
    handler: deleteComputerUseState$,
  },
];
