import { randomUUID } from "node:crypto";

import {
  runStatusSchema,
  type RunStatus,
} from "@okouai/api-contracts/contracts/runs";
import {
  activeInputDeliveries,
  activeInputDeliveryItems,
} from "@okouai/db/schema/active-input-delivery";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  notExists,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Db } from "../external/db";
import {
  activeInputDeliveryPromptFitsControlPayload,
  activeInputRowsByIds,
  materializePendingActiveInputPrompts,
  pendingActiveInputBudgetRows,
  pendingActiveInputRows,
  type MaterializedActiveInputPrompt,
  type PendingActiveInputRow,
} from "./active-input-prompt.service";
import { logTemplateUsage } from "../../lib/template-usage-log";
import type { GenerationTemplateIdentity } from "@okouai/core/generation-template-identity";
import { lockChatQueueThread } from "./chat-event-queue.service";
import { replaceLoadedChatEvent } from "./chat-event.service";
import { lockPiApiFirstTurnLifecycle } from "./pi-api-first-turn-lifecycle.service";

interface ActiveInputDeliveryScope {
  readonly runId: string;
  readonly chatThreadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly status: RunStatus;
}

interface ActiveInputReservationScope extends ActiveInputDeliveryScope {
  readonly allowPendingApiOwner: boolean;
}

interface ActiveInputDeliveryReference {
  readonly deliveryId: string;
  readonly sourceEventId: string;
}

interface LockedOpenActiveInputDelivery {
  readonly deliveryId: string;
  readonly items: LockedActiveInputDeliveryReceipt["items"];
}

interface ActiveInputDeliveryIdentity {
  readonly runId: string;
  readonly chatThreadId: string;
}

export interface FinalizeActiveInputDeliveryResult {
  readonly finalized: boolean;
  readonly chatEventsAppended: boolean;
}

type ReserveActiveInputDeliveryResult =
  | ({
      readonly outcome: "reserved";
      readonly prompt: string;
    } & ActiveInputDeliveryReference)
  | { readonly outcome: "empty" }
  | { readonly outcome: "terminal" }
  | ({ readonly outcome: "held" } & ActiveInputDeliveryReference)
  | {
      readonly outcome: "rejected";
      readonly reason: "payload_too_large" | "run_not_running";
    }
  | { readonly outcome: "forbidden" };

type RecordActiveInputDeliveryReceiptResult =
  | {
      readonly outcome: "delivered";
      readonly replacementsAppended: boolean;
      readonly chatThreadId: string;
    }
  | { readonly outcome: "rejected"; readonly replacementsAppended: false }
  | { readonly outcome: "forbidden"; readonly replacementsAppended: false };

type ActiveInputDeliveryTransaction = Parameters<
  Parameters<Db["transaction"]>[0]
>[0];

type PreparedReservation =
  | { readonly kind: "empty" }
  | { readonly kind: "rejected"; readonly reason: "payload_too_large" }
  | {
      readonly kind: "ready";
      readonly deliveryId: string;
      readonly sourceEventId: string;
      readonly prompt: string;
      readonly templateIdentities: readonly GenerationTemplateIdentity[];
    };

type ReserveTransitionResult =
  | Exclude<ReserveActiveInputDeliveryResult, { readonly outcome: "reserved" }>
  | ({
      readonly outcome: "created";
      readonly prompt: string;
    } & ActiveInputDeliveryReference)
  | ({ readonly outcome: "retrieve" } & ActiveInputDeliveryReference)
  | { readonly outcome: "retry" };

const deliveryRevoker = alias(chatEvents, "active_input_delivery_revoker");

function isTerminalRunStatus(status: RunStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "timeout" ||
    status === "cancelled"
  );
}

function canReserveActiveInput(
  status: RunStatus,
  allowPendingApiOwner: boolean,
): boolean {
  return status === "running" || (allowPendingApiOwner && status === "pending");
}

async function loadActiveInputDeliveryScope(
  db: Db,
  args: {
    readonly runId: string;
    readonly userId: string;
    readonly orgId: string;
  },
  signal: AbortSignal,
): Promise<ActiveInputDeliveryScope | null> {
  const [row] = await db
    .select({
      runId: agentRuns.id,
      chatThreadId: agentRuns.chatThreadId,
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
      status: agentRuns.status,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, args.runId),
        eq(agentRuns.userId, args.userId),
        eq(agentRuns.orgId, args.orgId),
        isNotNull(agentRuns.triggerSource),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!row?.chatThreadId) {
    return null;
  }
  return {
    ...row,
    chatThreadId: row.chatThreadId,
    status: runStatusSchema.parse(row.status),
  };
}

function materializedPrompt(
  row: PendingActiveInputRow,
  prompts: ReadonlyMap<string, MaterializedActiveInputPrompt>,
): MaterializedActiveInputPrompt {
  const materialized = prompts.get(row.id);
  if (materialized === undefined) {
    throw new Error("Active input prompt materialization is missing");
  }
  return materialized;
}

async function prepareReservation(
  db: Db,
  scope: ActiveInputDeliveryScope,
  signal: AbortSignal,
): Promise<PreparedReservation> {
  const rows = await pendingActiveInputRows(
    db,
    scope.chatThreadId,
    scope.runId,
  ).limit(1);
  signal.throwIfAborted();
  const [row] = rows;
  if (!row) {
    return { kind: "empty" };
  }
  const prompts = await materializePendingActiveInputPrompts(
    db,
    rows,
    scope,
    signal,
  );
  if (!prompts) {
    throw new Error("Pending active input cannot be materialized");
  }
  const materialized = materializedPrompt(row, prompts);
  const deliveryId = randomUUID();
  if (
    !activeInputDeliveryPromptFitsControlPayload(
      deliveryId,
      materialized.prompt,
    )
  ) {
    return { kind: "rejected", reason: "payload_too_large" };
  }
  return {
    kind: "ready",
    deliveryId,
    sourceEventId: row.id,
    prompt: materialized.prompt,
    templateIdentities: materialized.templateIdentities,
  };
}

async function canReturnEmptyReservation(
  db: Db,
  scope: ActiveInputReservationScope,
  signal: AbortSignal,
): Promise<boolean> {
  const [run] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, scope.runId),
        eq(agentRuns.chatThreadId, scope.chatThreadId),
        eq(agentRuns.userId, scope.userId),
        eq(agentRuns.orgId, scope.orgId),
        inArray(
          agentRuns.status,
          scope.allowPendingApiOwner ? ["pending", "running"] : ["running"],
        ),
        notExists(
          db
            .select({ id: activeInputDeliveries.id })
            .from(activeInputDeliveries)
            .where(
              and(
                eq(activeInputDeliveries.runId, scope.runId),
                eq(activeInputDeliveries.status, "open"),
              ),
            ),
        ),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return run !== undefined;
}

async function lockOpenDelivery(
  tx: ActiveInputDeliveryTransaction,
  scope: ActiveInputDeliveryIdentity,
): Promise<LockedOpenActiveInputDelivery | null> {
  const [delivery] = await tx
    .select({
      id: activeInputDeliveries.id,
      chatThreadId: activeInputDeliveries.chatThreadId,
    })
    .from(activeInputDeliveries)
    .where(
      and(
        eq(activeInputDeliveries.runId, scope.runId),
        eq(activeInputDeliveries.status, "open"),
      ),
    )
    .for("update")
    .limit(1);
  if (!delivery) {
    return null;
  }
  if (delivery.chatThreadId !== scope.chatThreadId) {
    throw new Error("Active input delivery belongs to an unexpected thread");
  }
  const items = await tx
    .select({
      sourceEventId: activeInputDeliveryItems.sourceEventId,
      disposition: activeInputDeliveryItems.disposition,
    })
    .from(activeInputDeliveryItems)
    .where(eq(activeInputDeliveryItems.deliveryId, delivery.id))
    .orderBy(asc(activeInputDeliveryItems.position))
    .for("update");
  if (
    items.length === 0 ||
    items.some((item) => {
      return item.disposition !== null;
    })
  ) {
    throw new Error("Open active input delivery has invalid items");
  }
  return {
    deliveryId: delivery.id,
    items,
  };
}

async function transitionReservation(
  tx: ActiveInputDeliveryTransaction,
  scope: ActiveInputReservationScope,
  prepared: PreparedReservation,
): Promise<ReserveTransitionResult> {
  await lockPiApiFirstTurnLifecycle(tx, scope.runId);
  if (!(await lockChatQueueThread(tx, scope.chatThreadId))) {
    return { outcome: "forbidden" };
  }
  const [run] = await tx
    .select({ status: agentRuns.status })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, scope.runId),
        eq(agentRuns.userId, scope.userId),
        eq(agentRuns.orgId, scope.orgId),
      ),
    )
    .for("update")
    .limit(1);
  if (!run) {
    return { outcome: "forbidden" };
  }
  const status = runStatusSchema.parse(run.status);
  const openDelivery = await lockOpenDelivery(tx, scope);
  if (openDelivery) {
    const [item] = openDelivery.items;
    if (!item || openDelivery.items.length !== 1) {
      throw new Error("Open active input reservation has invalid cardinality");
    }
    const reference = {
      deliveryId: openDelivery.deliveryId,
      sourceEventId: item.sourceEventId,
    };
    return canReserveActiveInput(status, scope.allowPendingApiOwner)
      ? { outcome: "retrieve", ...reference }
      : { outcome: "held", ...reference };
  }
  if (isTerminalRunStatus(status)) {
    return { outcome: "terminal" };
  }
  if (!canReserveActiveInput(status, scope.allowPendingApiOwner)) {
    return { outcome: "rejected", reason: "run_not_running" };
  }
  if (prepared.kind === "empty") {
    return { outcome: "empty" };
  }
  if (prepared.kind === "rejected") {
    return { outcome: "rejected", reason: prepared.reason };
  }
  const currentRows = await pendingActiveInputRows(
    tx,
    scope.chatThreadId,
    scope.runId,
    [prepared.sourceEventId],
  );
  if (
    currentRows.length !== 1 ||
    currentRows[0]?.id !== prepared.sourceEventId
  ) {
    return { outcome: "retry" };
  }
  await tx.insert(activeInputDeliveries).values({
    id: prepared.deliveryId,
    runId: scope.runId,
    chatThreadId: scope.chatThreadId,
    status: "open",
  });
  await tx.insert(activeInputDeliveryItems).values({
    deliveryId: prepared.deliveryId,
    sourceEventId: prepared.sourceEventId,
    position: 0,
  });
  return {
    outcome: "created",
    deliveryId: prepared.deliveryId,
    sourceEventId: prepared.sourceEventId,
    prompt: prepared.prompt,
  };
}

async function materializeDelivery(
  db: Db,
  scope: ActiveInputDeliveryScope,
  delivery: ActiveInputDeliveryReference,
  signal: AbortSignal,
): Promise<string> {
  const rows = await activeInputRowsByIds(db, scope.chatThreadId, [
    delivery.sourceEventId,
  ]);
  signal.throwIfAborted();
  const [row] = rows;
  if (!row || rows.length !== 1 || row.id !== delivery.sourceEventId) {
    throw new Error("Active input delivery source membership is invalid");
  }
  const prompts = await materializePendingActiveInputPrompts(
    db,
    rows,
    scope,
    signal,
  );
  if (!prompts) {
    throw new Error("Active input delivery cannot be rematerialized");
  }
  const { prompt } = materializedPrompt(row, prompts);
  if (
    !activeInputDeliveryPromptFitsControlPayload(delivery.deliveryId, prompt)
  ) {
    throw new Error("Active input delivery exceeds the control payload limit");
  }
  return prompt;
}

interface ReserveActiveInputArgs {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly allowPendingApiOwner: boolean;
}

async function reserveActiveInputDeliveryForOwner(
  db: Db,
  args: ReserveActiveInputArgs,
  signal: AbortSignal,
): Promise<ReserveActiveInputDeliveryResult> {
  const loaded = await loadActiveInputDeliveryScope(db, args, signal);
  if (!loaded) {
    return { outcome: "forbidden" };
  }
  const scope: ActiveInputReservationScope = {
    ...loaded,
    allowPendingApiOwner: args.allowPendingApiOwner,
  };
  while (true) {
    const reservable = canReserveActiveInput(
      scope.status,
      scope.allowPendingApiOwner,
    );
    const prepared = reservable
      ? await prepareReservation(db, scope, signal)
      : ({ kind: "empty" } as const);
    // A committed open delivery hides its source from the pending query, so
    // recheck for one after an empty preparation before bypassing serialization.
    if (
      reservable &&
      prepared.kind === "empty" &&
      (await canReturnEmptyReservation(db, scope, signal))
    ) {
      return { outcome: "empty" };
    }
    const result = await db.transaction(async (tx) => {
      return await transitionReservation(tx, scope, prepared);
    });
    signal.throwIfAborted();
    if (result.outcome === "retry") {
      continue;
    }
    if (result.outcome === "created") {
      // The delivery row now exists, so this prompt reaches the run exactly
      // once. Materialization is the wrong place to report it: it runs again on
      // every retry and on every retrieval of an already-open delivery.
      if (prepared.kind === "ready") {
        logTemplateUsage(
          {
            dispatchPath: "active-input",
            orgId: scope.orgId,
            userId: scope.userId,
            chatThreadId: scope.chatThreadId,
          },
          prepared.templateIdentities,
        );
      }
      return {
        outcome: "reserved",
        deliveryId: result.deliveryId,
        sourceEventId: result.sourceEventId,
        prompt: result.prompt,
      };
    }
    if (result.outcome === "retrieve") {
      return {
        outcome: "reserved",
        deliveryId: result.deliveryId,
        sourceEventId: result.sourceEventId,
        prompt: await materializeDelivery(db, scope, result, signal),
      };
    }
    return result;
  }
}

export async function reserveActiveInputDelivery(
  db: Db,
  args: Omit<ReserveActiveInputArgs, "allowPendingApiOwner">,
  signal: AbortSignal,
): Promise<ReserveActiveInputDeliveryResult> {
  return await reserveActiveInputDeliveryForOwner(
    db,
    { ...args, allowPendingApiOwner: false },
    signal,
  );
}

/** Internal API-first owner seam. Pending v4 inference may reserve the same
 * canonical delivery that a claimed Runner later retrieves. */
export async function reservePendingPiApiFirstTurnInput(
  db: Db,
  args: Omit<ReserveActiveInputArgs, "allowPendingApiOwner">,
  signal: AbortSignal,
): Promise<ReserveActiveInputDeliveryResult> {
  return await reserveActiveInputDeliveryForOwner(
    db,
    { ...args, allowPendingApiOwner: true },
    signal,
  );
}

async function replacePendingActiveInputEvent(
  tx: ActiveInputDeliveryTransaction,
  event: PendingActiveInputRow,
  runId: string,
): Promise<void> {
  if (!event.userMessage) {
    throw new Error("Pending active input has invalid prompt data");
  }
  if (
    event.eventType !== "input.prompt" &&
    event.eventType !== "input.budget"
  ) {
    throw new Error("Pending active input has invalid event type");
  }
  const target = activeInputReplacementTarget(event);
  const replacement =
    event.eventType === "input.budget"
      ? await replaceLoadedChatEvent(tx, target, {
          chatThreadId: event.chatThreadId,
          eventType: "input.budget",
          runId,
          userMessage: event.userMessage,
        })
      : await replaceLoadedChatEvent(tx, target, {
          chatThreadId: event.chatThreadId,
          eventType: "input.prompt",
          runId,
          userMessage: event.userMessage,
        });
  if (!replacement) {
    throw new Error("Active input replacement lost after locking the thread");
  }
}

type ActiveInputSourceRow = Awaited<
  ReturnType<typeof activeInputRowsByIds>
>[number];

type ActiveInputReplacementTargetSource = Pick<
  ActiveInputSourceRow,
  | "id"
  | "chatThreadId"
  | "createdAt"
  | "eventType"
  | "contextType"
  | "contextId"
>;

function activeInputReplacementTarget(
  event: ActiveInputReplacementTargetSource,
): {
  readonly id: string;
  readonly chatThreadId: string;
  readonly createdAt: Date;
  readonly eventType: ActiveInputSourceRow["eventType"];
  readonly contextType: ActiveInputSourceRow["contextType"];
  readonly contextId: ActiveInputSourceRow["contextId"];
} {
  return {
    id: event.id,
    chatThreadId: event.chatThreadId,
    createdAt: event.createdAt,
    eventType: event.eventType,
    contextType: event.contextType,
    contextId: event.contextId,
  };
}

function sourceIsPendingForRun(
  source: ActiveInputSourceRow,
  runId: string,
): boolean {
  if (source.runId !== null) {
    return false;
  }
  if (source.eventType === "input.prompt") {
    return true;
  }
  return (
    source.eventType === "input.budget" &&
    source.contextType === "agent_run" &&
    source.contextId === runId
  );
}

interface LockedActiveInputDeliveryReceipt {
  readonly status: (typeof activeInputDeliveries.$inferSelect)["status"];
  readonly items: readonly {
    readonly sourceEventId: string;
    readonly disposition: (typeof activeInputDeliveryItems.$inferSelect)["disposition"];
  }[];
}

interface ActiveInputDeliveryRevoker {
  readonly eventType: (typeof chatEvents.$inferSelect)["eventType"];
  readonly runId: string | null;
}

interface LockedActiveInputDeliverySources {
  readonly sources: readonly ActiveInputSourceRow[];
  readonly revokerBySource: ReadonlyMap<string, ActiveInputDeliveryRevoker>;
}

async function lockActiveInputDeliveryReceipt(
  tx: ActiveInputDeliveryTransaction,
  scope: ActiveInputDeliveryScope,
  deliveryId: string,
): Promise<LockedActiveInputDeliveryReceipt | null> {
  if (!(await lockChatQueueThread(tx, scope.chatThreadId))) {
    return null;
  }
  const [run] = await tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, scope.runId),
        eq(agentRuns.userId, scope.userId),
        eq(agentRuns.orgId, scope.orgId),
      ),
    )
    .for("update")
    .limit(1);
  if (!run) {
    return null;
  }
  const [delivery] = await tx
    .select({ status: activeInputDeliveries.status })
    .from(activeInputDeliveries)
    .where(
      and(
        eq(activeInputDeliveries.id, deliveryId),
        eq(activeInputDeliveries.runId, scope.runId),
        eq(activeInputDeliveries.chatThreadId, scope.chatThreadId),
      ),
    )
    .for("update")
    .limit(1);
  if (!delivery) {
    return null;
  }
  const items = await tx
    .select({
      sourceEventId: activeInputDeliveryItems.sourceEventId,
      disposition: activeInputDeliveryItems.disposition,
    })
    .from(activeInputDeliveryItems)
    .where(eq(activeInputDeliveryItems.deliveryId, deliveryId))
    .orderBy(asc(activeInputDeliveryItems.position))
    .for("update");
  if (items.length === 0) {
    throw new Error("Active input delivery has no items");
  }
  return { status: delivery.status, items };
}

async function lockActiveInputDeliverySources(
  tx: ActiveInputDeliveryTransaction,
  scope: ActiveInputDeliveryIdentity,
  items: LockedActiveInputDeliveryReceipt["items"],
): Promise<LockedActiveInputDeliverySources> {
  const eventIds = items.map((item) => {
    return item.sourceEventId;
  });
  const sources = await activeInputRowsByIds(
    tx,
    scope.chatThreadId,
    eventIds,
  ).for("update");
  if (
    sources.length !== eventIds.length ||
    sources.some((source, index) => {
      return source.id !== eventIds[index];
    })
  ) {
    throw new Error("Active input delivery source membership is invalid");
  }
  const revokers = await tx
    .select({
      revokesEventId: deliveryRevoker.revokesEventId,
      eventType: deliveryRevoker.eventType,
      runId: deliveryRevoker.runId,
    })
    .from(deliveryRevoker)
    .where(inArray(deliveryRevoker.revokesEventId, eventIds))
    .for("update");
  const revokerBySource = new Map(
    revokers.map((revoker) => {
      if (!revoker.revokesEventId) {
        throw new Error("Active input revoker is missing its source event");
      }
      return [
        revoker.revokesEventId,
        { eventType: revoker.eventType, runId: revoker.runId },
      ] as const;
    }),
  );
  return { sources, revokerBySource };
}

function activeInputDeliverySourcesAreDeliverable(
  scope: ActiveInputDeliveryIdentity,
  state: LockedActiveInputDeliverySources,
): boolean {
  return state.sources.every((source) => {
    const revoker = state.revokerBySource.get(source.id);
    if (revoker) {
      return (
        revoker.runId === scope.runId &&
        revoker.eventType === source.eventType &&
        (source.eventType === "input.prompt" ||
          source.eventType === "input.budget")
      );
    }
    return sourceIsPendingForRun(source, scope.runId);
  });
}

async function settleActiveInputDeliveryItems(
  tx: ActiveInputDeliveryTransaction,
  deliveryId: string,
  sourceEventIds: readonly string[],
  disposition: "delivered" | "released" | "expired",
): Promise<void> {
  if (sourceEventIds.length === 0) {
    return;
  }
  const updatedItems = await tx
    .update(activeInputDeliveryItems)
    .set({ disposition })
    .where(
      and(
        eq(activeInputDeliveryItems.deliveryId, deliveryId),
        inArray(activeInputDeliveryItems.sourceEventId, sourceEventIds),
        isNull(activeInputDeliveryItems.disposition),
      ),
    )
    .returning({ sourceEventId: activeInputDeliveryItems.sourceEventId });
  if (updatedItems.length !== sourceEventIds.length) {
    throw new Error("Active input delivery item settlement was incomplete");
  }
}

async function settleActiveInputDelivery(
  tx: ActiveInputDeliveryTransaction,
  deliveryId: string,
): Promise<void> {
  const [settled] = await tx
    .update(activeInputDeliveries)
    .set({ status: "settled" })
    .where(
      and(
        eq(activeInputDeliveries.id, deliveryId),
        eq(activeInputDeliveries.status, "open"),
      ),
    )
    .returning({ id: activeInputDeliveries.id });
  if (!settled) {
    throw new Error("Active input delivery settlement was incomplete");
  }
}

async function settleOpenActiveInputDeliveryAsDelivered(
  tx: ActiveInputDeliveryTransaction,
  scope: ActiveInputDeliveryIdentity,
  deliveryId: string,
  items: LockedActiveInputDeliveryReceipt["items"],
): Promise<{ readonly replacementsAppended: boolean } | null> {
  const state = await lockActiveInputDeliverySources(tx, scope, items);
  if (!activeInputDeliverySourcesAreDeliverable(scope, state)) {
    return null;
  }
  let replacementsAppended = false;
  for (const source of state.sources) {
    if (!state.revokerBySource.has(source.id)) {
      await replacePendingActiveInputEvent(tx, source, scope.runId);
      replacementsAppended = true;
    }
  }
  await settleActiveInputDeliveryItems(
    tx,
    deliveryId,
    items.map((item) => {
      return item.sourceEventId;
    }),
    "delivered",
  );
  await settleActiveInputDelivery(tx, deliveryId);
  return { replacementsAppended };
}

async function settleOpenActiveInputDeliveryAsUndelivered(
  tx: ActiveInputDeliveryTransaction,
  scope: ActiveInputDeliveryIdentity,
  deliveryId: string,
  items: LockedActiveInputDeliveryReceipt["items"],
): Promise<FinalizeActiveInputDeliveryResult> {
  const state = await lockActiveInputDeliverySources(tx, scope, items);
  if (
    state.sources.some((source) => {
      return (
        state.revokerBySource.has(source.id) ||
        !sourceIsPendingForRun(source, scope.runId)
      );
    })
  ) {
    throw new Error("Undelivered active input source is no longer pending");
  }
  const promptEventIds: string[] = [];
  const budgetEventIds: string[] = [];
  for (const source of state.sources) {
    if (source.eventType === "input.prompt") {
      promptEventIds.push(source.id);
      continue;
    }
    if (source.eventType !== "input.budget") {
      throw new Error("Active input delivery has an invalid source type");
    }
    const revoked = await replaceLoadedChatEvent(
      tx,
      activeInputReplacementTarget(source),
      {
        chatThreadId: scope.chatThreadId,
        eventType: "control.revoke",
        runId: scope.runId,
      },
    );
    if (!revoked) {
      throw new Error("Active input budget expiry was not appended");
    }
    budgetEventIds.push(source.id);
  }
  await settleActiveInputDeliveryItems(
    tx,
    deliveryId,
    promptEventIds,
    "released",
  );
  await settleActiveInputDeliveryItems(
    tx,
    deliveryId,
    budgetEventIds,
    "expired",
  );
  await settleActiveInputDelivery(tx, deliveryId);
  return {
    finalized: true,
    chatEventsAppended: budgetEventIds.length > 0,
  };
}

async function expirePendingActiveInputBudgetEvents(
  tx: ActiveInputDeliveryTransaction,
  scope: ActiveInputDeliveryIdentity,
): Promise<boolean> {
  const sources = await pendingActiveInputBudgetRows(
    tx,
    scope.chatThreadId,
    scope.runId,
  ).for("update");
  let chatEventsAppended = false;
  for (const source of sources) {
    if (source.eventType !== "input.budget") {
      throw new Error("Pending active input has an invalid source type");
    }
    const revoked = await replaceLoadedChatEvent(
      tx,
      activeInputReplacementTarget(source),
      {
        chatThreadId: scope.chatThreadId,
        eventType: "control.revoke",
        runId: scope.runId,
      },
    );
    if (!revoked) {
      throw new Error("Pending active input budget expiry was not appended");
    }
    chatEventsAppended = true;
  }
  return chatEventsAppended;
}

async function recordActiveInputDeliveryReceiptTransition(
  tx: ActiveInputDeliveryTransaction,
  scope: ActiveInputDeliveryScope,
  deliveryId: string,
): Promise<RecordActiveInputDeliveryReceiptResult> {
  const delivery = await lockActiveInputDeliveryReceipt(tx, scope, deliveryId);
  if (!delivery) {
    return { outcome: "forbidden", replacementsAppended: false };
  }
  if (delivery.status === "settled") {
    if (
      delivery.items.every((item) => {
        return item.disposition === "delivered";
      })
    ) {
      return {
        outcome: "delivered",
        replacementsAppended: false,
        chatThreadId: scope.chatThreadId,
      };
    }
    if (
      delivery.items.every((item) => {
        return item.disposition !== null;
      })
    ) {
      return { outcome: "rejected", replacementsAppended: false };
    }
    throw new Error("Settled active input delivery has open items");
  }
  if (
    delivery.items.some((item) => {
      return item.disposition !== null;
    })
  ) {
    throw new Error("Open active input delivery has settled items");
  }
  const settlement = await settleOpenActiveInputDeliveryAsDelivered(
    tx,
    scope,
    deliveryId,
    delivery.items,
  );
  if (!settlement) {
    return { outcome: "rejected", replacementsAppended: false };
  }
  return {
    outcome: "delivered",
    replacementsAppended: settlement.replacementsAppended,
    chatThreadId: scope.chatThreadId,
  };
}

export async function finalizeActiveInputDelivery(
  tx: ActiveInputDeliveryTransaction,
  args: ActiveInputDeliveryIdentity & {
    readonly deliveredDeliveryIds: ReadonlySet<string>;
  },
): Promise<FinalizeActiveInputDeliveryResult> {
  const delivery = await lockOpenDelivery(tx, args);
  const pendingBudgetExpired = await expirePendingActiveInputBudgetEvents(
    tx,
    args,
  );
  if (!delivery) {
    return {
      finalized: pendingBudgetExpired,
      chatEventsAppended: pendingBudgetExpired,
    };
  }
  if (!args.deliveredDeliveryIds.has(delivery.deliveryId)) {
    const finalization = await settleOpenActiveInputDeliveryAsUndelivered(
      tx,
      args,
      delivery.deliveryId,
      delivery.items,
    );
    return {
      ...finalization,
      chatEventsAppended:
        finalization.chatEventsAppended || pendingBudgetExpired,
    };
  }
  const settlement = await settleOpenActiveInputDeliveryAsDelivered(
    tx,
    args,
    delivery.deliveryId,
    delivery.items,
  );
  if (!settlement) {
    throw new Error("Delivered active input source is no longer valid");
  }
  return {
    finalized: true,
    chatEventsAppended: settlement.replacementsAppended || pendingBudgetExpired,
  };
}

export async function recordActiveInputDeliveryReceipt(
  db: Db,
  args: {
    readonly runId: string;
    readonly deliveryId: string;
    readonly userId: string;
    readonly orgId: string;
  },
  signal: AbortSignal,
): Promise<RecordActiveInputDeliveryReceiptResult> {
  const scope = await loadActiveInputDeliveryScope(db, args, signal);
  if (!scope) {
    return { outcome: "forbidden", replacementsAppended: false };
  }
  const result = await db.transaction(async (tx) => {
    return await recordActiveInputDeliveryReceiptTransition(
      tx,
      scope,
      args.deliveryId,
    );
  });
  signal.throwIfAborted();
  return result;
}
