import { reserveFixtureChatEventSequence } from "./chat-event-sequences";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Client } from "pg";
import { z } from "zod";
import { closeDbPool, db } from "../lib/db";
import { env, mockEnv, optionalEnv } from "../lib/env";
import { flushWaitUntilForTest } from "../signals/context/wait-until";
import { installApiTestConnectorCatalog } from "./connector-catalog";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { nowDate } from "../lib/time";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { eq, and, lte, ne } from "drizzle-orm";
import { chatEventSnapshots } from "@okouai/db/schema/chat-event-snapshot";
import {
  insertChatEvent,
  replaceLoadedChatEvent,
} from "../signals/services/chat-event.service";

/** Run the real complete migration sequence in a test-owned database. */
export async function withContractedGoalSchema(
  work: (statements: () => readonly string[]) => Promise<void>,
): Promise<void> {
  const originalUrl = env("DATABASE_URL");
  const url = new URL(originalUrl);
  if (!["localhost", "127.0.0.1", "postgres"].includes(url.hostname)) {
    throw new Error("Schema contraction fixtures require local PostgreSQL");
  }
  const name = `goal_contraction_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: originalUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  url.pathname = `/${name}`;
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const packageDir = fileURLToPath(
    new URL("../../../../packages/db", import.meta.url),
  );
  const run = async () => {
    await promisify(execFile)(
      "node",
      [
        fileURLToPath(import.meta.resolve("tsx/cli")),
        join(packageDir, "scripts/migrate.ts"),
      ],
      {
        cwd: packageDir,
        env: {
          PATH: optionalEnv("PATH"),
          HOME: optionalEnv("HOME"),
          DATABASE_URL: url.toString(),
        },
        timeout: 120_000,
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    await closeDbPool();
    mockEnv("DATABASE_URL", url.toString());
    trace.disable();
    trace.setGlobalTracerProvider(provider);
    await installApiTestConnectorCatalog();
    exporter.reset();
    await work(() => {
      return exporter.getFinishedSpans().flatMap((span) => {
        const statement = span.attributes["db.statement"];
        return typeof statement === "string" ? [statement] : [];
      });
    });
  };
  const [result] = await Promise.allSettled([run()]);
  await flushWaitUntilForTest();
  await closeDbPool();
  mockEnv("DATABASE_URL", originalUrl);
  trace.disable();
  await provider.shutdown();
  await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
  if (result.status === "rejected") {
    throw result.reason;
  }
}

/** A legacy terminal run retains canonical provenance without a Goal row. */
export async function seedRetainedRunProvenance(
  runId: string,
  threadId: string,
  groupId: string | null,
  triggerSource: "goal" | "web" = "goal",
): Promise<void> {
  await db().transaction(async (tx) => {
    await tx
      .update(agentRuns)
      .set({ triggerSource })
      .where(eq(agentRuns.id, runId));
    if (groupId !== null) {
      await insertChatEvent(tx, {
        chatThreadId: threadId,
        runId,
        runGroupId: groupId,
        eventType: "output.message",
        content: "Retained historical output",
      });
    }
  });
}

export async function removeSnapshottedRunEvents(
  threadId: string,
  keepEventId?: string,
): Promise<void> {
  const [head] = await db()
    .select({ lastSeqId: chatEventSnapshots.lastSeqId })
    .from(chatEventSnapshots)
    .where(eq(chatEventSnapshots.chatThreadId, threadId));
  if (!head) {
    throw new Error("Expected a published snapshot before removing hot rows");
  }
  await db()
    .delete(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, threadId),
        lte(chatEvents.seqId, head.lastSeqId),
        keepEventId === undefined ? undefined : ne(chatEvents.id, keepEventId),
      ),
    );
}

export async function retainedUsageRows(runId: string) {
  return await db()
    .select()
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.runId, runId),
        eq(chatEvents.eventType, "usage.recorded"),
      ),
    )
    .orderBy(chatEvents.seqId);
}

/** An old active-input claim can survive after its run's earlier output was archived. */
export async function appendRetainedRunPrompt(
  runId: string,
  threadId: string,
): Promise<void> {
  await db().transaction(async (tx) => {
    const userMessage = {
      version: 1 as const,
      parts: [{ type: "text" as const, text: "Later retained input" }],
    };
    const source = await insertChatEvent(tx, {
      chatThreadId: threadId,
      eventType: "input.prompt",
      runId: null,
      contextType: "web",
      userMessage,
    });
    if (!source) {
      throw new Error("Expected retained active input");
    }
    await replaceLoadedChatEvent(
      tx,
      {
        ...source,
        chatThreadId: threadId,
        eventType: "input.prompt",
        contextType: "web",
        contextId: null,
      },
      {
        chatThreadId: threadId,
        eventType: "input.prompt",
        runId,
        userMessage,
      },
    );
  });
}

/** Append an old producer's usage revision; the live writer cannot set a web source. */
export async function appendRetainedUsageWebContext(
  runId: string,
): Promise<void> {
  const prior = (await retainedUsageRows(runId)).at(-1);
  if (!prior) {
    throw new Error("Expected prior usage for a legacy revision");
  }
  await db().transaction(async (tx) => {
    const thread = {
      seqId: await reserveFixtureChatEventSequence(tx, prior.chatThreadId, 1),
    };
    if (!thread) {
      throw new Error("Expected retained thread");
    }
    await tx.insert(chatEvents).values({
      ...prior,
      id: randomUUID(),
      seqId: thread.seqId,
      revokesEventId: prior.id,
      createdAt: new Date(
        Math.max(nowDate().getTime(), prior.createdAt.getTime() + 1),
      ),
      contextType: "web",
      contextId: null,
    });
  });
}

/** Hold a real database response across snapshot publication, without replacing its rows. */
export async function withEmptySnapshotReadBarrier(args: {
  readonly threadId: string;
  readonly whileResponseHeld: () => Promise<void>;
  readonly work: () => Promise<void>;
}): Promise<void> {
  await closeDbPool();
  const original = Client.prototype.query;
  let held = false;
  Client.prototype.query = new Proxy(original, {
    apply(target, receiver: unknown, queryArgs: unknown[]): unknown {
      const result: unknown = Reflect.apply(target, receiver, queryArgs);
      const query = z
        .object({ text: z.string(), values: z.array(z.unknown()) })
        .safeParse(queryArgs[0]);
      if (
        held ||
        !(result instanceof Promise) ||
        !query.success ||
        !query.data.text.startsWith("select ") ||
        !query.data.text.includes('from "chat_event_snapshots"') ||
        !query.data.values.includes(args.threadId)
      ) {
        return result;
      }
      return (async () => {
        const response: unknown = await result;
        if (
          !held &&
          z.object({ rows: z.array(z.unknown()).length(0) }).safeParse(response)
            .success
        ) {
          held = true;
          await args.whileResponseHeld();
        }
        return response;
      })();
    },
  });
  const run = async () => {
    await args.work();
    if (!held) {
      throw new Error("Expected the empty snapshot response barrier");
    }
  };
  const [result] = await Promise.allSettled([run()]);
  // Pool instrumentation captures bound query methods on each client.
  const [closed] = await Promise.allSettled([closeDbPool()]);
  Client.prototype.query = original;
  if (result.status === "rejected") {
    throw result.reason;
  }
  if (closed.status === "rejected") {
    throw closed.reason;
  }
}
