import { createHash, randomBytes, randomUUID } from "node:crypto";

import type {
  BrowserUserActionApplyRequest,
  BrowserUserActionCreateRequest,
  BrowserUserActionResponse,
} from "@okouai/api-contracts/contracts/browser-user-actions";
import { BROWSER_IDLE_LEASE_MINUTES } from "@okouai/api-contracts/contracts/browser";
import {
  parseBrowserUserActionPayload,
  type BrowserUserActionPayload,
} from "@okouai/db/jsonb-contracts/browser-user-action";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  browserSessionInstances,
  browserSessions,
  browserUserActionRequests,
} from "@okouai/db/schema/browser-session";
import { and, eq, inArray, lt } from "drizzle-orm";
import { command } from "ccstate";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { safeSync, settle, settleIncludingAbort, throwIfAbort } from "../utils";
import {
  activateBrowserUseUserActionTarget,
  applyBrowserUseUserAction,
  BrowserUseProviderError,
  type BrowserUseUserActionCapture,
  BrowserUseUserActionCaptureError,
  BrowserUseUserActionMutationError,
  captureBrowserUseUserAction,
  getBrowserUseSession,
} from "./browser-use.service";
import {
  type ChatThreadContentIdentity,
  withChatThreadContentRead,
  withChatThreadContentWrite,
} from "./chat-thread-content-erasure-admission.service";

const REQUEST_TOKEN_PREFIX = "vm0_browser_user_action";
const APPLY_STUCK_AFTER_MS = 60_000;
const IDLE_LEASE_MS = BROWSER_IDLE_LEASE_MINUTES * 60_000;

type RequestRow = typeof browserUserActionRequests.$inferSelect;

export interface BrowserUserActionServiceError {
  readonly kind: "error";
  readonly status: 400 | 404 | 409 | 410 | 502 | 503;
  readonly code: string;
  readonly message: string;
}

type ServiceResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | BrowserUserActionServiceError;

function failure(
  status: BrowserUserActionServiceError["status"],
  code: string,
  message: string,
): BrowserUserActionServiceError {
  return { kind: "error", status, code, message };
}

const notFound = () => {
  return failure(
    404,
    "BROWSER_USER_ACTION_NOT_FOUND",
    "Browser user-action request not found",
  );
};
const expired = () => {
  return failure(
    410,
    "BROWSER_USER_ACTION_EXPIRED",
    "Browser user-action request expired",
  );
};
const conflict = (message: string, code = "BROWSER_USER_ACTION_CONFLICT") => {
  return failure(409, code, message);
};

function providerFailure(error: unknown): BrowserUserActionServiceError {
  return error instanceof BrowserUseProviderError
    ? failure(error.status, error.code, error.message)
    : failure(
        502,
        "BROWSER_USER_ACTION_PROVIDER_ERROR",
        "Managed Browser operation failed",
      );
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function generateToken(): string {
  return `${REQUEST_TOKEN_PREFIX}_${randomBytes(32).toString("base64url")}`;
}

function actionUrl(args: {
  readonly requestToken: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly callbackPrompt: string;
}): string {
  const url = new URL(
    `/browser/actions/${encodeURIComponent(args.requestToken)}`,
    env("APP_URL"),
  );
  url.searchParams.set("agentId", args.agentId);
  url.searchParams.set("threadId", args.threadId);
  url.searchParams.set("callbackPrompt", args.callbackPrompt);
  return url.toString();
}

function decodePayload(row: RequestRow): BrowserUserActionPayload | null {
  if (row.payloadVersion !== 1) {
    return null;
  }
  const parsed = safeSync(() => {
    return parseBrowserUserActionPayload(row.payload);
  });
  return "ok" in parsed && parsed.ok.kind === row.kind ? parsed.ok : null;
}

function publicRequest(
  row: RequestRow,
  requestToken: string,
  payload: BrowserUserActionPayload,
): BrowserUserActionResponse {
  const common = {
    requestToken,
    state: row.status,
    siteOrigin: row.siteOrigin,
    expiresAt: row.expiresAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    agentId: row.agentId,
    threadId: row.chatThreadId,
    callbackIds: {
      success: {
        clientEventId: row.successClientEventId,
        chatThreadSortEventId: row.successChatThreadSortEventId,
      },
      cancellation: {
        clientEventId: row.cancellationClientEventId,
        chatThreadSortEventId: row.cancellationChatThreadSortEventId,
      },
    },
  };
  return payload.kind === "input"
    ? {
        ...common,
        kind: payload.kind,
        fields: payload.fields.map((field) => {
          return {
            key: field.key,
            label: field.label,
            ...(field.description === undefined
              ? {}
              : { description: field.description }),
            fieldKind: field.fieldKind,
            required: field.required,
          };
        }),
      }
    : { ...common, kind: payload.kind, reason: payload.reason };
}

function authorized(
  row: RequestRow,
  identity: ChatThreadContentIdentity,
): boolean {
  return (
    identity.userId === row.userId &&
    identity.agentId === row.agentId &&
    identity.orgId === row.orgId
  );
}

async function loadOwnedRequest(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly requestToken: string;
  },
): Promise<RequestRow | null> {
  const [row] = await db
    .select()
    .from(browserUserActionRequests)
    .where(
      and(
        eq(browserUserActionRequests.requestTokenHash, hash(args.requestToken)),
        eq(browserUserActionRequests.orgId, args.orgId),
        eq(browserUserActionRequests.userId, args.userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function loadExactRequest(
  db: Db,
  row: RequestRow,
): Promise<RequestRow | null> {
  const [current] = await db
    .select()
    .from(browserUserActionRequests)
    .where(
      and(
        eq(browserUserActionRequests.id, row.id),
        eq(browserUserActionRequests.requestTokenHash, row.requestTokenHash),
        eq(browserUserActionRequests.orgId, row.orgId),
        eq(browserUserActionRequests.userId, row.userId),
        eq(browserUserActionRequests.chatThreadId, row.chatThreadId),
        eq(browserUserActionRequests.agentId, row.agentId),
      ),
    )
    .limit(1);
  return current ?? null;
}

async function loadLiveBrowser(
  db: Db,
  args: {
    readonly chatThreadId: string;
    readonly orgId: string;
    readonly userId: string;
  },
) {
  const [row] = await db
    .select({
      runId: browserSessions.runId,
      providerSessionId: browserSessionInstances.providerSessionId,
      timeoutAt: browserSessionInstances.timeoutAt,
      idleExpiresAt: browserSessionInstances.idleExpiresAt,
    })
    .from(browserSessions)
    .innerJoin(
      browserSessionInstances,
      eq(browserSessionInstances.chatThreadId, browserSessions.chatThreadId),
    )
    .where(
      and(
        eq(browserSessions.chatThreadId, args.chatThreadId),
        eq(browserSessions.orgId, args.orgId),
        eq(browserSessions.userId, args.userId),
        eq(browserSessions.status, "active"),
        eq(browserSessionInstances.status, "active"),
      ),
    )
    .limit(1)
    .for("share");
  return row ?? null;
}

async function touchExactProvider(
  db: Db,
  row: RequestRow,
): Promise<{ readonly timeoutAt: Date; readonly idleExpiresAt: Date } | null> {
  const now = nowDate();
  const [touched] = await db
    .update(browserSessionInstances)
    .set({
      lastTouchedAt: now,
      idleExpiresAt: new Date(now.getTime() + IDLE_LEASE_MS),
      updatedAt: now,
    })
    .where(
      and(
        eq(browserSessionInstances.providerSessionId, row.providerSessionId),
        eq(browserSessionInstances.chatThreadId, row.chatThreadId),
        eq(browserSessionInstances.status, "active"),
      ),
    )
    .returning({
      timeoutAt: browserSessionInstances.timeoutAt,
      idleExpiresAt: browserSessionInstances.idleExpiresAt,
    });
  return touched ?? null;
}

async function restorePending(db: Db, requestId: string): Promise<void> {
  await db
    .update(browserUserActionRequests)
    .set({ status: "pending", applyStartedAt: null, updatedAt: nowDate() })
    .where(
      and(
        eq(browserUserActionRequests.id, requestId),
        eq(browserUserActionRequests.status, "applying"),
      ),
    );
}

async function finalize(
  db: Db,
  requestId: string,
  status: "succeeded" | "stale" | "uncertain",
  terminalReason: string,
): Promise<RequestRow | null> {
  const now = nowDate();
  const [row] = await db
    .update(browserUserActionRequests)
    .set({ status, terminalReason, completedAt: now, updatedAt: now })
    .where(
      and(
        eq(browserUserActionRequests.id, requestId),
        eq(browserUserActionRequests.status, "applying"),
      ),
    )
    .returning();
  return row ?? null;
}

interface CreateBrowserUserActionArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
  readonly input: BrowserUserActionCreateRequest;
}

interface PreparedBrowserUserAction {
  readonly chatThreadId: string;
  readonly providerSessionId: string;
  readonly capture: BrowserUseUserActionCapture;
}

async function prepareBrowserUserAction(
  db: Db,
  args: CreateBrowserUserActionArgs,
  signal: AbortSignal,
): Promise<ServiceResult<PreparedBrowserUserAction>> {
  const [run] = await db
    .select({
      chatThreadId: agentRuns.chatThreadId,
      triggerSource: agentRuns.triggerSource,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, args.runId),
        eq(agentRuns.orgId, args.orgId),
        eq(agentRuns.userId, args.userId),
        inArray(agentRuns.status, ["pending", "running"]),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (
    !run?.chatThreadId ||
    (run.triggerSource !== "web" && run.triggerSource !== "agent")
  ) {
    return conflict(
      "Browser user actions require an active chat run",
      "BROWSER_USER_ACTION_RUN_REQUIRED",
    );
  }
  const live = await loadLiveBrowser(db, {
    chatThreadId: run.chatThreadId,
    orgId: args.orgId,
    userId: args.userId,
  });
  signal.throwIfAborted();
  if (!live || live.runId !== args.runId) {
    return conflict(
      "The current chat run has no live managed Browser",
      "BROWSER_USER_ACTION_BROWSER_NOT_LIVE",
    );
  }
  const providerResult = await settle(
    getBrowserUseSession(live.providerSessionId, signal),
  );
  signal.throwIfAborted();
  if (!providerResult.ok) {
    return providerFailure(providerResult.error);
  }
  if (
    providerResult.value.status !== "active" ||
    !providerResult.value.cdpUrl
  ) {
    return conflict(
      "The managed Browser is no longer live",
      "BROWSER_USER_ACTION_BROWSER_NOT_LIVE",
    );
  }
  const selectors =
    args.input.kind === "input"
      ? args.input.fields.map((field) => {
          return field.selector;
        })
      : [];
  const captureResult = await settle(
    captureBrowserUseUserAction(providerResult.value.cdpUrl, selectors, signal),
  );
  signal.throwIfAborted();
  if (!captureResult.ok) {
    return captureResult.error instanceof BrowserUseUserActionCaptureError
      ? conflict(
          "The focused Browser page or requested controls are not available",
          `BROWSER_USER_ACTION_${captureResult.error.code.toUpperCase()}`,
        )
      : providerFailure(captureResult.error);
  }
  return {
    kind: "ok",
    value: {
      chatThreadId: run.chatThreadId,
      providerSessionId: live.providerSessionId,
      capture: captureResult.value,
    },
  };
}

function buildBrowserUserActionPayload(
  input: BrowserUserActionCreateRequest,
  capture: BrowserUseUserActionCapture,
): BrowserUserActionPayload {
  if (input.kind === "direct_interaction") {
    return { version: 1, kind: input.kind, reason: input.reason };
  }
  return {
    version: 1,
    kind: input.kind,
    fields: input.fields.map((field, index) => {
      const target = capture.fields[index];
      if (!target) {
        throw new Error("Missing captured Browser field");
      }
      return {
        key: field.key,
        label: field.label,
        ...(field.description === undefined
          ? {}
          : { description: field.description }),
        fieldKind: field.fieldKind,
        required: field.required,
        backendNodeId: target.backendNodeId,
        fingerprint: target.fingerprint,
      };
    }),
  };
}

async function persistBrowserUserAction(
  db: Db,
  input: {
    readonly args: CreateBrowserUserActionArgs;
    readonly prepared: PreparedBrowserUserAction;
    readonly requestToken: string;
    readonly payload: BrowserUserActionPayload;
    readonly callbackIds: {
      readonly successClientEventId: string;
      readonly successChatThreadSortEventId: string;
      readonly cancellationClientEventId: string;
      readonly cancellationChatThreadSortEventId: string;
    };
  },
  signal: AbortSignal,
): Promise<RequestRow | null> {
  const { args, callbackIds, payload, prepared, requestToken } = input;
  const admitted = await withChatThreadContentWrite(
    db,
    {
      chatThreadId: prepared.chatThreadId,
      authorize: (identity) => {
        return (
          identity.userId === args.userId &&
          identity.agentId !== null &&
          identity.orgId === args.orgId
        );
      },
    },
    async (tx, identity): Promise<RequestRow | null> => {
      const [currentRun] = await tx
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, args.runId),
            eq(agentRuns.orgId, args.orgId),
            eq(agentRuns.userId, args.userId),
            eq(agentRuns.chatThreadId, prepared.chatThreadId),
            inArray(agentRuns.status, ["pending", "running"]),
          ),
        )
        .limit(1)
        .for("share");
      if (!currentRun || !identity.agentId) {
        return null;
      }
      const currentLive = await loadLiveBrowser(tx as Db, {
        chatThreadId: prepared.chatThreadId,
        orgId: args.orgId,
        userId: args.userId,
      });
      if (
        currentLive?.runId !== args.runId ||
        currentLive.providerSessionId !== prepared.providerSessionId
      ) {
        return null;
      }
      const now = nowDate();
      const [leased] = await tx
        .update(browserSessionInstances)
        .set({
          lastTouchedAt: now,
          idleExpiresAt: new Date(now.getTime() + IDLE_LEASE_MS),
          updatedAt: now,
        })
        .where(
          and(
            eq(
              browserSessionInstances.providerSessionId,
              prepared.providerSessionId,
            ),
            eq(browserSessionInstances.chatThreadId, prepared.chatThreadId),
            eq(browserSessionInstances.status, "active"),
          ),
        )
        .returning({
          timeoutAt: browserSessionInstances.timeoutAt,
          idleExpiresAt: browserSessionInstances.idleExpiresAt,
        });
      if (!leased) {
        return null;
      }
      const expiresAt = new Date(
        Math.min(leased.timeoutAt.getTime(), leased.idleExpiresAt.getTime()),
      );
      if (expiresAt <= now) {
        return null;
      }
      const [created] = await tx
        .insert(browserUserActionRequests)
        .values({
          requestTokenHash: hash(requestToken),
          orgId: args.orgId,
          userId: args.userId,
          runId: args.runId,
          agentId: identity.agentId,
          chatThreadId: prepared.chatThreadId,
          kind: args.input.kind,
          status: "pending",
          providerSessionId: prepared.providerSessionId,
          pageTargetId: prepared.capture.pageTargetId,
          documentLoaderId: prepared.capture.documentLoaderId,
          siteOrigin: prepared.capture.siteOrigin,
          pageUrlHash: hash(prepared.capture.pageUrl),
          payloadVersion: 1,
          payload,
          ...callbackIds,
          expiresAt,
        })
        .returning();
      return created ?? null;
    },
    signal,
  );
  return admitted.outcome === "written" ? admitted.value : null;
}

export const createBrowserUserAction$ = command(
  async (
    { set },
    args: CreateBrowserUserActionArgs,
    signal: AbortSignal,
  ): Promise<
    ServiceResult<{
      readonly actionUrl: string;
      readonly action: BrowserUserActionResponse;
    }>
  > => {
    const db = set(writeDb$);
    const prepared = await prepareBrowserUserAction(db, args, signal);
    if (prepared.kind === "error") {
      return prepared;
    }
    const requestToken = generateToken();
    const callbackIds = {
      successClientEventId: randomUUID(),
      successChatThreadSortEventId: randomUUID(),
      cancellationClientEventId: randomUUID(),
      cancellationChatThreadSortEventId: randomUUID(),
    };
    const payload = buildBrowserUserActionPayload(
      args.input,
      prepared.value.capture,
    );
    const created = await persistBrowserUserAction(
      db,
      {
        args,
        prepared: prepared.value,
        requestToken,
        payload,
        callbackIds,
      },
      signal,
    );
    if (!created) {
      return notFound();
    }
    const decoded = decodePayload(created);
    if (!decoded) {
      return conflict(
        "Browser user-action request payload is unavailable",
        "BROWSER_USER_ACTION_UNAVAILABLE",
      );
    }
    return {
      kind: "ok",
      value: {
        actionUrl: actionUrl({
          requestToken,
          agentId: created.agentId,
          threadId: created.chatThreadId,
          callbackPrompt: args.input.callbackPrompt,
        }),
        action: publicRequest(created, requestToken, decoded),
      },
    };
  },
);

async function normalizeStuckApplying(
  db: Db,
  row: RequestRow,
  signal: AbortSignal,
): Promise<RequestRow | null> {
  if (
    row.status !== "applying" ||
    !row.applyStartedAt ||
    row.applyStartedAt.getTime() > nowDate().getTime() - APPLY_STUCK_AFTER_MS
  ) {
    return row;
  }
  const admitted = await withChatThreadContentWrite(
    db,
    {
      chatThreadId: row.chatThreadId,
      authorize: (identity) => {
        return authorized(row, identity);
      },
      threadLock: "update",
    },
    async () => {
      const now = nowDate();
      const [updated] = await db
        .update(browserUserActionRequests)
        .set({
          status: "uncertain",
          terminalReason: "stuck_applying",
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(browserUserActionRequests.id, row.id),
            eq(browserUserActionRequests.status, "applying"),
            lt(
              browserUserActionRequests.applyStartedAt,
              new Date(now.getTime() - APPLY_STUCK_AFTER_MS),
            ),
          ),
        )
        .returning();
      return updated ?? (await loadExactRequest(db, row));
    },
    signal,
  );
  return admitted.outcome === "written" ? admitted.value : null;
}

export const readBrowserUserAction$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly requestToken: string;
    },
    signal: AbortSignal,
  ): Promise<ServiceResult<BrowserUserActionResponse>> => {
    const db = set(writeDb$);
    let row = await loadOwnedRequest(db, args);
    signal.throwIfAborted();
    if (!row) {
      return notFound();
    }
    row = await normalizeStuckApplying(db, row, signal);
    if (!row) {
      return notFound();
    }
    const readRow = row;
    const admitted = await withChatThreadContentRead(
      db,
      {
        chatThreadId: readRow.chatThreadId,
        authorize: (identity) => {
          return authorized(readRow, identity);
        },
      },
      async (tx) => {
        return await loadExactRequest(tx as Db, readRow);
      },
      signal,
    );
    if (admitted.outcome !== "written" || !admitted.value) {
      return notFound();
    }
    row = admitted.value;
    if (
      (row.status === "pending" || row.status === "applying") &&
      row.expiresAt <= nowDate()
    ) {
      return expired();
    }
    const payload = decodePayload(row);
    return payload
      ? { kind: "ok", value: publicRequest(row, args.requestToken, payload) }
      : conflict(
          "Browser user-action request payload is unavailable",
          "BROWSER_USER_ACTION_UNAVAILABLE",
        );
  },
);

function submittedValues(
  payload: Extract<BrowserUserActionPayload, { kind: "input" }>,
  input: BrowserUserActionApplyRequest,
): ServiceResult<Map<string, string>> {
  const allowed = new Map(
    payload.fields.map((field) => {
      return [field.key, field];
    }),
  );
  const values = new Map(
    input.values.map((entry) => {
      return [entry.key, entry.value];
    }),
  );
  if (
    input.values.some((entry) => {
      return !allowed.has(entry.key);
    })
  ) {
    return failure(
      400,
      "BROWSER_USER_ACTION_INVALID_VALUES",
      "Submitted values do not match the requested fields",
    );
  }
  if (
    payload.fields.some((field) => {
      return (
        field.required &&
        (!values.has(field.key) || values.get(field.key)?.length === 0)
      );
    })
  ) {
    return failure(
      400,
      "BROWSER_USER_ACTION_REQUIRED_VALUE_MISSING",
      "A required Browser input value is missing",
    );
  }
  return { kind: "ok", value: values };
}

async function applyClaimedBrowserUserAction(
  db: Db,
  located: RequestRow,
  payload: Extract<BrowserUserActionPayload, { kind: "input" }>,
  values: ReadonlyMap<string, string>,
  signal: AbortSignal,
): Promise<ServiceResult<RequestRow>> {
  const admitted = await withChatThreadContentWrite(
    db,
    {
      chatThreadId: located.chatThreadId,
      authorize: (identity) => {
        return authorized(located, identity);
      },
      threadLock: "update",
    },
    async (): Promise<ServiceResult<RequestRow>> => {
      const current = await loadExactRequest(db, located);
      if (!current) {
        return notFound();
      }
      if (current.expiresAt <= nowDate()) {
        return expired();
      }
      if (current.status !== "pending") {
        return conflict("Browser input has already been claimed");
      }
      const startedAt = nowDate();
      const [claimed] = await db
        .update(browserUserActionRequests)
        .set({
          status: "applying",
          applyStartedAt: startedAt,
          updatedAt: startedAt,
        })
        .where(
          and(
            eq(browserUserActionRequests.id, current.id),
            eq(browserUserActionRequests.status, "pending"),
          ),
        )
        .returning();
      if (!claimed) {
        return conflict("Browser input has already been claimed");
      }
      const leased = await touchExactProvider(db, claimed);
      if (!leased) {
        const terminal = await finalize(
          db,
          claimed.id,
          "stale",
          "provider_replaced",
        );
        return terminal
          ? { kind: "ok", value: terminal }
          : conflict("Browser input state changed during application");
      }
      const provider = await settleIncludingAbort(
        getBrowserUseSession(claimed.providerSessionId, signal),
      );
      if (!provider.ok) {
        await restorePending(db, claimed.id);
        throwIfAbort(provider.error);
        return providerFailure(provider.error);
      }
      if (provider.value.status !== "active" || !provider.value.cdpUrl) {
        await restorePending(db, claimed.id);
        return providerFailure(new Error("Browser provider is not active"));
      }
      const operation = await settle(
        applyBrowserUseUserAction(
          provider.value.cdpUrl,
          {
            pageTargetId: claimed.pageTargetId,
            documentLoaderId: claimed.documentLoaderId,
            pageUrlHash: claimed.pageUrlHash,
            fields: payload.fields.map((field) => {
              const value = values.get(field.key);
              return {
                backendNodeId: field.backendNodeId,
                fingerprint: field.fingerprint,
                ...(value === undefined ? {} : { value }),
              };
            }),
          },
          signal,
        ),
      );
      if (!operation.ok) {
        if (
          operation.error instanceof BrowserUseUserActionMutationError &&
          operation.error.writeStarted
        ) {
          const terminal = await finalize(
            db,
            claimed.id,
            "uncertain",
            "possible_partial_write",
          );
          return terminal
            ? { kind: "ok", value: terminal }
            : conflict("Browser input state changed during application");
        }
        await restorePending(db, claimed.id);
        return providerFailure(operation.error);
      }
      const terminal = await finalize(
        db,
        claimed.id,
        operation.value,
        operation.value === "stale" ? "target_stale" : "verified",
      );
      return terminal
        ? { kind: "ok", value: terminal }
        : conflict("Browser input state changed during application");
    },
    signal,
  );
  return admitted.outcome === "written" ? admitted.value : notFound();
}

export const applyBrowserUserAction$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly requestToken: string;
      readonly input: BrowserUserActionApplyRequest;
    },
    signal: AbortSignal,
  ): Promise<ServiceResult<BrowserUserActionResponse>> => {
    const db = set(writeDb$);
    const located = await loadOwnedRequest(db, args);
    signal.throwIfAborted();
    if (!located) {
      return notFound();
    }
    const payload = decodePayload(located);
    if (!payload) {
      return conflict(
        "Browser user-action request payload is unavailable",
        "BROWSER_USER_ACTION_UNAVAILABLE",
      );
    }
    if (payload.kind !== "input") {
      return conflict("This Browser request does not accept input values");
    }
    const valuesResult = submittedValues(payload, args.input);
    if (valuesResult.kind === "error") {
      return valuesResult;
    }

    const applied = await applyClaimedBrowserUserAction(
      db,
      located,
      payload,
      valuesResult.value,
      signal,
    );
    if (applied.kind === "error") {
      return applied;
    }
    return {
      kind: "ok",
      value: publicRequest(applied.value, args.requestToken, payload),
    };
  },
);

async function mutatePendingRequest(
  db: Db,
  args: {
    readonly row: RequestRow;
    readonly requestToken: string;
    readonly terminal: "cancelled" | "succeeded";
  },
  signal: AbortSignal,
): Promise<ServiceResult<BrowserUserActionResponse>> {
  const payload = decodePayload(args.row);
  if (!payload) {
    return conflict(
      "Browser user-action request payload is unavailable",
      "BROWSER_USER_ACTION_UNAVAILABLE",
    );
  }
  const admitted = await withChatThreadContentWrite(
    db,
    {
      chatThreadId: args.row.chatThreadId,
      authorize: (identity) => {
        return authorized(args.row, identity);
      },
      threadLock: "update",
    },
    async (): Promise<ServiceResult<RequestRow>> => {
      const current = await loadExactRequest(db, args.row);
      if (!current) {
        return notFound();
      }
      if (current.status === args.terminal) {
        return { kind: "ok", value: current };
      }
      if (current.expiresAt <= nowDate()) {
        return expired();
      }
      if (current.status !== "pending") {
        return conflict(
          "Browser user-action state no longer permits this action",
        );
      }
      const now = nowDate();
      const [updated] = await db
        .update(browserUserActionRequests)
        .set({
          status: args.terminal,
          terminalReason:
            args.terminal === "cancelled" ? "user_cancelled" : "user_completed",
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(browserUserActionRequests.id, current.id),
            eq(browserUserActionRequests.status, "pending"),
          ),
        )
        .returning();
      return updated
        ? { kind: "ok", value: updated }
        : conflict("Browser user-action state changed");
    },
    signal,
  );
  if (admitted.outcome !== "written") {
    return notFound();
  }
  return admitted.value.kind === "error"
    ? admitted.value
    : {
        kind: "ok",
        value: publicRequest(admitted.value.value, args.requestToken, payload),
      };
}

export const cancelBrowserUserAction$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly requestToken: string;
    },
    signal: AbortSignal,
  ): Promise<ServiceResult<BrowserUserActionResponse>> => {
    const db = set(writeDb$);
    const row = await loadOwnedRequest(db, args);
    signal.throwIfAborted();
    return row
      ? await mutatePendingRequest(
          db,
          { row, requestToken: args.requestToken, terminal: "cancelled" },
          signal,
        )
      : notFound();
  },
);

export const completeBrowserUserAction$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly requestToken: string;
    },
    signal: AbortSignal,
  ): Promise<ServiceResult<BrowserUserActionResponse>> => {
    const db = set(writeDb$);
    const row = await loadOwnedRequest(db, args);
    signal.throwIfAborted();
    if (!row) {
      return notFound();
    }
    if (row.kind !== "direct_interaction") {
      return conflict("This Browser request is not a direct interaction");
    }
    return await mutatePendingRequest(
      db,
      { row, requestToken: args.requestToken, terminal: "succeeded" },
      signal,
    );
  },
);

export const openBrowserUserAction$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly requestToken: string;
    },
    signal: AbortSignal,
  ): Promise<ServiceResult<BrowserUserActionResponse>> => {
    const db = set(writeDb$);
    const row = await loadOwnedRequest(db, args);
    signal.throwIfAborted();
    if (!row) {
      return notFound();
    }
    const payload = decodePayload(row);
    if (!payload) {
      return conflict(
        "Browser user-action request payload is unavailable",
        "BROWSER_USER_ACTION_UNAVAILABLE",
      );
    }
    if (payload.kind !== "direct_interaction") {
      return conflict("This Browser request is not a direct interaction");
    }
    const admitted = await withChatThreadContentWrite(
      db,
      {
        chatThreadId: row.chatThreadId,
        authorize: (identity) => {
          return authorized(row, identity);
        },
        threadLock: "update",
      },
      async (): Promise<ServiceResult<RequestRow>> => {
        const current = await loadExactRequest(db, row);
        if (!current) {
          return notFound();
        }
        if (current.expiresAt <= nowDate()) {
          return expired();
        }
        if (current.status !== "pending") {
          return conflict("Browser direct interaction is no longer pending");
        }
        if (!(await touchExactProvider(db, current))) {
          return conflict(
            "The captured managed Browser is no longer live",
            "BROWSER_USER_ACTION_BROWSER_NOT_LIVE",
          );
        }
        const provider = await settle(
          getBrowserUseSession(current.providerSessionId, signal),
        );
        if (
          !provider.ok ||
          provider.value.status !== "active" ||
          !provider.value.cdpUrl
        ) {
          return provider.ok
            ? providerFailure(new Error("Browser provider is not active"))
            : providerFailure(provider.error);
        }
        const activated = await settle(
          activateBrowserUseUserActionTarget(
            provider.value.cdpUrl,
            current.pageTargetId,
            signal,
          ),
        );
        if (!activated.ok) {
          return providerFailure(activated.error);
        }
        if (activated.value === "stale") {
          const now = nowDate();
          const [stale] = await db
            .update(browserUserActionRequests)
            .set({
              status: "stale",
              terminalReason: "target_stale",
              completedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(browserUserActionRequests.id, current.id),
                eq(browserUserActionRequests.status, "pending"),
              ),
            )
            .returning();
          return stale
            ? { kind: "ok", value: stale }
            : conflict("Browser user-action state changed");
        }
        return { kind: "ok", value: current };
      },
      signal,
    );
    if (admitted.outcome !== "written") {
      return notFound();
    }
    return admitted.value.kind === "error"
      ? admitted.value
      : {
          kind: "ok",
          value: publicRequest(
            admitted.value.value,
            args.requestToken,
            payload,
          ),
        };
  },
);
