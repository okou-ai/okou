import type {
  McpCreateChatWithMessageInput,
  McpCreateChatWithMessageOutput,
  McpCreateChatThreadInput,
  McpCreateChatThreadOutput,
} from "@okouai/api-contracts/contracts/mcp-chat-creation";
import type { McpChatMutationResult } from "@okouai/api-contracts/contracts/mcp-chat-mutations";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";
import { assertErasureSubjectWritable } from "@okouai/db/operations/account-erasure";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { chatThreadEvents } from "@okouai/db/schema/chat-thread-event";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";

import type { Tx } from "../../lib/db-types";
import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { now } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { settle, settleIncludingAbort } from "../utils";
import { visibleJoinedAgentCondition } from "./agent-data.service";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { appendMcpQueuedUserMessageInTransaction } from "./chat-events.command";
import { drainChatThreadQueueForThread$ } from "./chat-thread-queue-drain.service";
import { createChatThreadInTransaction } from "./chat-thread.service";
import { chatThreadServiceTierFromCodex } from "./chat-thread-event.service";
import { chatThreadModelPinColumns } from "./chat-thread-model.service";
import { loadNewChatThreadMediaModels } from "./chat-thread-media-model.service";
import { loadNewChatThreadModelSettings } from "./chat-thread-model-settings.service";
import { resolveChatReasoningEffort } from "./chat-reasoning-effort.service";
import { mcpChatThreadModels } from "./mcp-chat-thread-model.service";
import { mcpInputDisposition } from "./mcp-chat-send.service";
import {
  MCP_SUBMISSION_RETRY_MS,
  resolveMcpSubmission,
} from "./mcp-chat-submission.service";
import {
  MODEL_FIRST_SELECTION_PROVIDER_ID,
  resolveModelSelectionPin,
  type ModelFirstPin,
} from "./model-selection.service";

const CREATION_RETRY_MS = 24 * 60 * 60 * 1000;
const CREATION_NAMESPACE = "107f0e3c-b577-40c5-b2e8-0ebdcce13242";
const COMBINED_INPUT_NAMESPACE = "c2559c1c-a5f8-4d43-88a6-9738ef189420";
const L = logger("McpChatCreation");

interface Principal {
  readonly userId: string;
  readonly orgId: string;
}

class McpThreadCreationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

function creationConflict(): never {
  throw new McpThreadCreationError(
    "request_id_conflict",
    "Creation request cannot be replayed. Use the original requestId and exact create parameters, including optional field presence and message; inspect your conversations before creating new work.",
  );
}

function isCombinedCreation(
  input: McpCreateChatThreadInput,
): input is McpCreateChatWithMessageInput {
  return "message" in input;
}

function optionalIdentity(value: string | undefined): readonly string[] {
  return value === undefined ? ["omitted"] : ["present", value];
}

function creationIdentity(input: McpCreateChatThreadInput): string {
  return JSON.stringify([
    "create_chat_thread",
    input.requestId,
    optionalIdentity(input.agentId),
    optionalIdentity(input.title),
    optionalIdentity(input.model),
    isCombinedCreation(input) ? ["present", input.message] : ["omitted"],
  ]);
}

function creationEventId(input: McpCreateChatThreadInput): string {
  return uuidv5(creationIdentity(input), CREATION_NAMESPACE);
}

function combinedInputId(input: McpCreateChatWithMessageInput): string {
  return uuidv5(input.requestId, COMBINED_INPUT_NAMESPACE);
}

async function admitCreation(
  tx: Tx,
  principal: Principal,
  agentId: string,
  signal: AbortSignal,
): Promise<void> {
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
    throw new McpThreadCreationError("not_found", "Agent not found.");
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
      "unavailable",
      "Agent availability changed. Refresh list_agents and retry the same creation request.",
      true,
    );
  }
}

async function resolveDefaultAgent(
  tx: Tx,
  principal: Principal,
): Promise<string> {
  const [selected] = await tx
    .select({ agentId: agents.id })
    .from(orgMetadata)
    .innerJoin(agents, eq(agents.id, orgMetadata.defaultAgentId))
    .where(
      and(
        eq(orgMetadata.orgId, principal.orgId),
        eq(agents.orgId, principal.orgId),
        visibleJoinedAgentCondition(principal.userId),
      ),
    )
    .limit(1);
  if (!selected) {
    throw new McpThreadCreationError(
      "selection_unavailable",
      "No visible default Agent is configured. Pass agentId explicitly or configure an organization default Agent.",
    );
  }
  return selected.agentId;
}

function optionalSelectionMatches(
  expected: string | undefined,
  actual: string | null,
): boolean {
  return expected === undefined || expected === actual;
}

function creationMetadataMatches(args: {
  readonly principal: Principal;
  readonly input: McpCreateChatThreadInput;
  readonly thread: {
    readonly userId: string;
    readonly agentId: string | null;
    readonly createdAt: Date;
  };
  readonly event: {
    readonly userId: string;
    readonly orgId: string;
    readonly threadId: string;
    readonly agentId: string | null;
    readonly kind: string;
    readonly titleMatches: boolean | null;
    readonly model: string | null;
    readonly createdAt: Date;
  };
}): boolean {
  const expectedModel = args.input.model ?? null;
  return [
    args.thread.userId === args.principal.userId,
    args.thread.agentId !== null,
    optionalSelectionMatches(args.input.agentId, args.thread.agentId),
    args.event.userId === args.principal.userId,
    args.event.orgId === args.principal.orgId,
    args.event.threadId === args.input.requestId,
    args.event.agentId === args.thread.agentId,
    optionalSelectionMatches(args.input.agentId, args.event.agentId),
    args.event.kind === "created",
    args.event.titleMatches === true,
    args.event.model === expectedModel,
    args.event.createdAt.getTime() === args.thread.createdAt.getTime(),
  ].every(Boolean);
}

async function readCreation(
  tx: Tx,
  principal: Principal,
  input: McpCreateChatThreadInput,
) {
  const expectedEventId = creationEventId(input);
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
      titleMatches:
        sql`${chatThreadEvents.title} IS NOT DISTINCT FROM ${input.title ?? null}`.mapWith(
          nullableDriverValueDecoder(pgBooleanDecoder),
        ),
      model: chatThreadEvents.selectedModel,
      createdAt: chatThreadEvents.createdAt,
    })
    .from(chatThreadEvents)
    .where(eq(chatThreadEvents.id, expectedEventId))
    .limit(1);
  if (!thread && !event) {
    return null;
  }
  if (!thread || !event) {
    creationConflict();
  }
  if (!creationMetadataMatches({ principal, input, thread, event })) {
    creationConflict();
  }
  if (event.createdAt.getTime() + CREATION_RETRY_MS <= now()) {
    throw new McpThreadCreationError(
      "request_expired",
      "The 24-hour creation retry window has expired. Inspect the original conversation before creating new work; this request was not applied again.",
    );
  }
  if (!isCombinedCreation(input)) {
    return { thread, acceptedAt: event.createdAt };
  }
  const inputId = combinedInputId(input);
  const submission = await resolveMcpSubmission(
    tx,
    { requestId: inputId, text: input.message },
    {
      userId: principal.userId,
      orgId: principal.orgId,
      threadId: input.requestId,
    },
  );
  if (submission.kind === "expired") {
    throw new McpThreadCreationError(
      "request_expired",
      "The 24-hour creation retry window has expired. Inspect the original conversation and input before creating new work; this request was not applied again.",
    );
  }
  if (submission.kind !== "accepted") {
    creationConflict();
  }
  return {
    thread,
    acceptedAt: event.createdAt,
    submission: submission.receipt,
  };
}

async function initializeThread(
  tx: Tx,
  principal: Principal,
  input: McpCreateChatThreadInput,
  agentId: string,
  signal: AbortSignal,
): Promise<boolean> {
  // Policy seeding/repair is a write. Resolve only after account admission,
  // on this transaction so the resolver's nested transaction is a savepoint.
  let pin: ModelFirstPin;
  if (input.model === undefined) {
    pin = {
      modelProviderId: null,
      modelProviderType: null,
      modelProviderCredentialScope: null,
      selectedModel: null,
    };
  } else {
    const resolved = await resolveModelSelectionPin({
      db: tx,
      ...principal,
      modelSelection: {
        modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
        selectedModel: input.model,
      },
    });
    signal.throwIfAborted();
    if ("status" in resolved) {
      throw new McpThreadCreationError(
        "selection_unavailable",
        resolved.body.error.message,
      );
    }
    pin = resolved;
  }
  const media = await loadNewChatThreadMediaModels(tx, principal);
  const settings = await loadNewChatThreadModelSettings(tx, principal);
  signal.throwIfAborted();
  const modelSettings =
    input.model === undefined
      ? settings
      : (() => {
          const effort = resolveChatReasoningEffort({
            selectedModel: pin.selectedModel,
            modelSettings: settings,
            requested: undefined,
          });
          if ("status" in effort) {
            throw new McpThreadCreationError(
              "selection_unavailable",
              effort.body.error.message,
            );
          }
          return effort.modelSettings;
        })();
  const created = await createChatThreadInTransaction(tx, {
    ...principal,
    agentId,
    title: input.title,
    clientThreadId: input.requestId,
    eventId: creationEventId(input),
    ...chatThreadModelPinColumns(pin),
    modelSettings,
    codexServiceTier: null,
    ...media,
    connectorSelections: [],
  });
  signal.throwIfAborted();
  if (created.kind === "invalid_connector_selection") {
    throw new McpThreadCreationError("invalid_state", created.message);
  }
  if (created.kind !== "created") {
    return false;
  }
  if (isCombinedCreation(input)) {
    await appendMcpQueuedUserMessageInTransaction(tx, {
      ...principal,
      threadId: input.requestId,
      inputId: combinedInputId(input),
      text: input.message,
      publicBrand: PUBLIC_BRAND,
    });
    signal.throwIfAborted();
  }
  return true;
}

async function createInTransaction(
  tx: Tx,
  principal: Principal,
  input: McpCreateChatThreadInput,
  signal: AbortSignal,
): Promise<McpCreateChatThreadOutput> {
  await tx.execute(sql`SELECT set_config('lock_timeout', '1s', true)`);
  await tx.execute(sql`SELECT set_config('statement_timeout', '3s', true)`);
  // Serialize only this idempotency identity, including requests that select
  // different Agents. PK/event validation still handles non-MCP collisions.
  const lockKey = `mcp:create_chat_thread:${input.requestId}`;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
  );
  signal.throwIfAborted();
  let creation = await readCreation(tx, principal, input);
  let replayed = true;
  if (creation) {
    const agentId = creation.thread.agentId;
    if (agentId === null) {
      creationConflict();
    }
    await admitCreation(tx, principal, agentId, signal);
  } else {
    const agentId = input.agentId ?? (await resolveDefaultAgent(tx, principal));
    await admitCreation(tx, principal, agentId, signal);
    replayed = !(await initializeThread(tx, principal, input, agentId, signal));
    // appendChatThreadEvent tolerates event-ID duplicates. Never commit a
    // newly inserted thread unless its exact initial event and optional input
    // were also written.
    creation = await readCreation(tx, principal, input);
    if (!creation) {
      throw new Error("Canonical creation did not persist its identity");
    }
  }
  signal.throwIfAborted();
  const { thread, acceptedAt } = creation;
  const agentId = thread.agentId;
  if (agentId === null) {
    creationConflict();
  }
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
    agentId,
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
    ...(isCombinedCreation(input)
      ? (() => {
          const submission = creation.submission;
          if (submission === undefined) {
            throw new Error("Created thread input receipt is missing");
          }
          const inputRef = {
            threadId: thread.id,
            eventId: submission.requestId,
            seqId: submission.inputSeqId,
          };
          return {
            input: {
              inputRef,
              acceptedAt: submission.acceptedAt.toISOString(),
              retryUntil: new Date(
                submission.acceptedAt.getTime() + MCP_SUBMISSION_RETRY_MS,
              ).toISOString(),
              disposition: "queued" as const,
              runId: null,
            },
            nextAction: {
              tool: "get_chat_status" as const,
              arguments: { threadId: thread.id, inputRef },
            },
          };
        })()
      : {
          nextAction: {
            tool: "send_chat_message" as const,
            arguments: { threadId: thread.id },
          },
        }),
  };
}

async function finishCombinedCreation(
  args: {
    readonly db: Db;
    readonly principal: Principal;
    readonly input: McpCreateChatWithMessageInput;
    readonly output: McpCreateChatWithMessageOutput;
    readonly drain: () => Promise<unknown>;
  },
  signal: AbortSignal,
): Promise<McpChatMutationResult<McpCreateChatThreadOutput>> {
  const drain = await settleIncludingAbort(args.drain());
  if (!drain.ok) {
    L.warn("Failed to drain initial MCP chat input after commit", {
      threadId: args.output.threadId,
      inputId: args.output.input.inputRef.eventId,
      error: drain.error,
    });
  }
  signal.throwIfAborted();

  const resolved = await resolveMcpSubmission(
    args.db,
    {
      requestId: args.output.input.inputRef.eventId,
      text: args.input.message,
    },
    {
      ...args.principal,
      threadId: args.output.threadId,
    },
  );
  signal.throwIfAborted();
  if (resolved.kind !== "accepted") {
    return {
      kind: "error",
      code: "submission_unavailable",
      message:
        "The accepted initial input could not be resolved. Retry the identical create request within 24 hours.",
      retryable: true,
    };
  }
  const disposition = await mcpInputDisposition(
    args.db,
    args.output.threadId,
    resolved.receipt.requestId,
  );
  signal.throwIfAborted();
  if (disposition.disposition === "unavailable") {
    return {
      kind: "error",
      code: "submission_unavailable",
      message:
        "The accepted initial input disposition is unavailable. Retry the identical create request within 24 hours.",
      retryable: true,
    };
  }
  const inputRef = {
    threadId: args.output.threadId,
    eventId: resolved.receipt.requestId,
    seqId: resolved.receipt.inputSeqId,
  };
  return {
    kind: "ok",
    data: {
      ...args.output,
      input: {
        inputRef,
        acceptedAt: resolved.receipt.acceptedAt.toISOString(),
        retryUntil: new Date(
          resolved.receipt.acceptedAt.getTime() + MCP_SUBMISSION_RETRY_MS,
        ).toISOString(),
        ...disposition,
      },
      nextAction: {
        tool: "get_chat_status",
        arguments: { threadId: args.output.threadId, inputRef },
      },
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
        return {
          kind: "error",
          code: result.error.code,
          message: result.error.message,
          retryable: result.error.retryable,
        };
      }
      if (
        result.error instanceof Error &&
        result.error.message === "account_erasure:subject_closed"
      ) {
        return {
          kind: "error",
          code: "account_closed",
          message: "Account content is closed.",
          retryable: false,
        };
      }
      throw result.error;
    }
    await publishThreadListChanged(args.principal);
    signal.throwIfAborted();
    if (!isCombinedCreation(args.input)) {
      return { kind: "ok", data: result.value };
    }
    if (!("input" in result.value)) {
      throw new Error("Combined creation output is missing input receipt");
    }
    return await finishCombinedCreation(
      {
        db: set(writeDb$),
        principal: args.principal,
        input: args.input,
        output: result.value,
        drain: () => {
          return set(
            drainChatThreadQueueForThread$,
            {
              chatThreadId: result.value.threadId,
              dispatchFailedCallbacks: dispatchFailedRunCallbacks,
            },
            operationSignal,
          );
        },
      },
      signal,
    );
  },
);
