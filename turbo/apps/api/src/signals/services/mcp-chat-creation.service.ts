import type {
  McpCreateChatThreadInput,
  McpCreateChatThreadOutput,
} from "@okouai/api-contracts/contracts/mcp-chat-creation";
import type { McpChatMutationResult } from "@okouai/api-contracts/contracts/mcp-chat-mutations";
import { assertErasureSubjectWritable } from "@okouai/db/operations/account-erasure";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { chatThreadEvents } from "@okouai/db/schema/chat-thread-event";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { env } from "../../lib/env";
import { now } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { settle } from "../utils";
import { visibleJoinedAgentCondition } from "./agent-data.service";
import { createChatThreadInTransaction } from "./chat-thread.service";
import { chatThreadServiceTierFromCodex } from "./chat-thread-event.service";
import { chatThreadModelPinColumns } from "./chat-thread-model.service";
import { loadNewChatThreadMediaModels } from "./chat-thread-media-model.service";
import { loadNewChatThreadModelSettings } from "./chat-thread-model-settings.service";
import { resolveChatReasoningEffort } from "./chat-reasoning-effort.service";
import { mcpChatThreadModels } from "./mcp-chat-thread-model.service";
import {
  MODEL_FIRST_SELECTION_PROVIDER_ID,
  resolveModelSelectionPin,
} from "./model-selection.service";

const CREATION_RETRY_MS = 24 * 60 * 60 * 1000;

interface Principal {
  readonly userId: string;
  readonly orgId: string;
}

class McpThreadCreationError extends Error {}

function creationConflict(): never {
  throw new McpThreadCreationError(
    "Creation request cannot be replayed. Use the original requestId, Agent, exact title and model; inspect your conversations before creating new work.",
  );
}

async function admitCreation(
  tx: Tx,
  principal: Principal,
  agentId: string,
  signal: AbortSignal,
): Promise<void> {
  await tx.execute(sql`SELECT set_config('lock_timeout', '1s', true)`);
  await tx.execute(sql`SELECT set_config('statement_timeout', '3s', true)`);
  const condition = and(
    eq(agents.id, agentId),
    eq(agents.orgId, principal.orgId),
    visibleJoinedAgentCondition(principal.userId),
  );
  // Resolve the canonical owner before taking subject locks. A private or
  // foreign Agent never grants authority to admit its owner's account.
  const [selected] = await tx
    .select({ owner: agents.owner })
    .from(agents)
    .where(condition)
    .limit(1);
  signal.throwIfAborted();
  if (!selected) {
    throw new McpThreadCreationError("Agent not found.");
  }
  await assertErasureSubjectWritable(tx, [
    { subjectKind: "user", subjectId: principal.userId },
    { subjectKind: "user", subjectId: selected.owner },
    { subjectKind: "organization", subjectId: principal.orgId },
  ]);
  signal.throwIfAborted();
  // SHARE also fences visibility updates, which do not change the ownership
  // key and therefore do not conflict with KEY SHARE. Subjects stay first.
  const [locked] = await tx
    .select({ owner: agents.owner })
    .from(agents)
    .where(condition)
    .for("share")
    .limit(1);
  signal.throwIfAborted();
  if (!locked || locked.owner !== selected.owner) {
    throw new McpThreadCreationError(
      "Agent availability changed. Refresh list_agents and retry the same creation request.",
    );
  }
}

async function readCreation(
  tx: Tx,
  principal: Principal,
  input: McpCreateChatThreadInput,
) {
  const [thread] = await tx
    .select({
      id: chatThreads.id,
      userId: chatThreads.userId,
      agentId: chatThreads.agentId,
      title: sql`left(${chatThreads.title}, 500)`.mapWith(
        nullableDriverValueDecoder(pgTextDecoder),
      ),
      titleTruncated:
        sql`COALESCE(length(${chatThreads.title}) > 500, false)`.mapWith(
          pgBooleanDecoder,
        ),
      selectedModel: chatThreads.selectedModel,
      codexServiceTier: chatThreads.codexServiceTier,
      createdAt: chatThreads.createdAt,
    })
    .from(chatThreads)
    .where(eq(chatThreads.id, input.requestId))
    .for("key share")
    .limit(1);
  const [event] = await tx
    .select({
      userId: chatThreadEvents.userId,
      orgId: chatThreadEvents.orgId,
      threadId: chatThreadEvents.chatThreadId,
      agentId: chatThreadEvents.agentId,
      kind: chatThreadEvents.kind,
      titleMatches: sql`${chatThreadEvents.title} = ${input.title}`.mapWith(
        nullableDriverValueDecoder(pgBooleanDecoder),
      ),
      model: chatThreadEvents.selectedModel,
      createdAt: chatThreadEvents.createdAt,
    })
    .from(chatThreadEvents)
    .where(eq(chatThreadEvents.id, input.requestId))
    .limit(1);
  if (!thread && !event) {
    return null;
  }
  if (
    !thread ||
    !event ||
    thread.userId !== principal.userId ||
    thread.agentId !== input.agentId ||
    event.userId !== principal.userId ||
    event.orgId !== principal.orgId ||
    event.threadId !== input.requestId ||
    event.agentId !== input.agentId ||
    event.kind !== "created" ||
    event.titleMatches !== true ||
    event.model !== input.model ||
    event.createdAt.getTime() !== thread.createdAt.getTime()
  ) {
    creationConflict();
  }
  if (event.createdAt.getTime() + CREATION_RETRY_MS <= now()) {
    throw new McpThreadCreationError(
      "The 24-hour creation retry window has expired. Inspect the original conversation before creating new work; this request was not applied again.",
    );
  }
  return { thread, acceptedAt: event.createdAt };
}

async function initializeThread(
  tx: Tx,
  principal: Principal,
  input: McpCreateChatThreadInput,
  signal: AbortSignal,
): Promise<boolean> {
  // Policy seeding/repair is a write. Resolve only after account admission,
  // on this transaction so the resolver's nested transaction is a savepoint.
  const pin = await resolveModelSelectionPin({
    db: tx,
    ...principal,
    modelSelection: {
      modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
      selectedModel: input.model,
    },
  });
  signal.throwIfAborted();
  if ("status" in pin) {
    throw new McpThreadCreationError(pin.body.error.message);
  }
  const media = await loadNewChatThreadMediaModels(tx, principal);
  const settings = await loadNewChatThreadModelSettings(tx, principal);
  signal.throwIfAborted();
  const effort = resolveChatReasoningEffort({
    selectedModel: pin.selectedModel,
    modelSettings: settings,
    requested: undefined,
  });
  if ("status" in effort) {
    throw new McpThreadCreationError(effort.body.error.message);
  }
  const created = await createChatThreadInTransaction(tx, {
    ...principal,
    agentId: input.agentId,
    title: input.title,
    clientThreadId: input.requestId,
    eventId: input.requestId,
    ...chatThreadModelPinColumns(pin),
    modelSettings: effort.modelSettings,
    codexServiceTier: null,
    ...media,
    connectorSelections: [],
  });
  signal.throwIfAborted();
  if (created.kind === "invalid_connector_selection") {
    throw new McpThreadCreationError(created.message);
  }
  return created.kind === "created";
}

async function createInTransaction(
  tx: Tx,
  principal: Principal,
  input: McpCreateChatThreadInput,
  signal: AbortSignal,
): Promise<McpCreateChatThreadOutput> {
  await admitCreation(tx, principal, input.agentId, signal);
  // Serialize only this idempotency identity, including requests that select
  // different Agents. PK/event validation still handles non-MCP collisions.
  const lockKey = `mcp:create_chat_thread:${input.requestId}`;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
  );
  signal.throwIfAborted();
  let creation = await readCreation(tx, principal, input);
  let replayed = true;
  if (!creation) {
    replayed = !(await initializeThread(tx, principal, input, signal));
    // appendChatThreadEvent tolerates event-ID duplicates. Never commit a
    // newly inserted thread unless its exact initial event was also written.
    creation = await readCreation(tx, principal, input);
    if (!creation) {
      throw new Error("Canonical creation did not persist its identity");
    }
  }
  signal.throwIfAborted();
  const { thread, acceptedAt } = creation;
  const models = await mcpChatThreadModels(tx, principal, [
    thread.selectedModel,
  ]);
  signal.throwIfAborted();
  const model = models.get(thread.selectedModel);
  if (!model) {
    throw new Error("Created thread model projection is missing");
  }
  return {
    threadId: thread.id,
    agentId: input.agentId,
    title: thread.title,
    titleTruncated: thread.titleTruncated,
    model,
    serviceTier: chatThreadServiceTierFromCodex(thread.codexServiceTier),
    createdAt: thread.createdAt.toISOString(),
    url: new URL(`/chats/${thread.id}`, env("APP_URL")).toString(),
    replayed,
    retryUntil: new Date(
      acceptedAt.getTime() + CREATION_RETRY_MS,
    ).toISOString(),
    nextAction: {
      tool: "send_chat_message",
      arguments: { threadId: thread.id },
    },
  };
}

/** Finite mutation ownership belongs to the MCP route, not its response wait. */
export const createMcpChatThread$ = command(
  async (
    { set },
    args: {
      readonly principal: Principal;
      readonly input: McpCreateChatThreadInput;
    },
    signal: AbortSignal,
  ): Promise<McpChatMutationResult<McpCreateChatThreadOutput>> => {
    const operationSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(15_000),
    ]);
    const result = await settle(
      // The route's waitUntil owner retains the real transaction through
      // commit/rollback. The deadline stops admission/work; it must not race
      // away from a transaction that can still hold locks or finish a write.
      set(writeDb$).transaction(
        async (tx) => {
          operationSignal.throwIfAborted();
          return await createInTransaction(
            tx,
            args.principal,
            args.input,
            operationSignal,
          );
        },
        { isolationLevel: "read committed" },
      ),
      signal,
    );
    if (!result.ok) {
      if (result.error instanceof McpThreadCreationError) {
        return { kind: "error", message: result.error.message };
      }
      if (
        result.error instanceof Error &&
        result.error.message === "account_erasure:subject_closed"
      ) {
        return { kind: "error", message: "Account content is closed." };
      }
      throw result.error;
    }
    await publishThreadListChanged(args.principal);
    signal.throwIfAborted();
    return { kind: "ok", data: result.value };
  },
);
