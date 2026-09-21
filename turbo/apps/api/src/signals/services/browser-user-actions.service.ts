import { createHash, randomBytes, randomUUID } from "node:crypto";

import type {
  BrowserUserActionApplyRequest,
  BrowserUserActionCreateRequest,
  BrowserUserActionResponse,
} from "@okouai/api-contracts/contracts/browser-user-actions";
import { BROWSER_IDLE_LEASE_MINUTES } from "@okouai/api-contracts/contracts/browser";
import {
  browserUserActionFieldSupportsTarget,
  parseBrowserUserActionPayload,
  type BrowserUserActionCallbackIds,
  type BrowserUserActionPayload,
} from "@okouai/db/jsonb-contracts/browser-user-action";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  browserSessionInstances,
  browserSessions,
  browserUserActionRequests,
} from "@okouai/db/schema/browser-session";
import { and, eq, gt, inArray, lt } from "drizzle-orm";
import { command } from "ccstate";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { safeSync, settle, settleIncludingAbort } from "../utils";
import {
  applyBrowserUseUserAction,
  BrowserUseProviderError,
  type BrowserUseUserActionValidation,
  BrowserUseUserActionValidationError,
  BrowserUseUserActionMutationError,
  getBrowserUseSession,
  validateBrowserUseUserAction,
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
  const parsed = safeSync(() => {
    return parseBrowserUserActionPayload(row.payload);
  });
  return "ok" in parsed ? parsed.ok : null;
}

function publicRequest(
  row: RequestRow,
  requestToken: string,
  payload: BrowserUserActionPayload,
): BrowserUserActionResponse {
  const common = {
    requestToken,
    state: row.status,
    completedAt: row.completedAt?.toISOString() ?? null,
    agentId: row.agentId,
    threadId: row.chatThreadId,
    callbackIds: payload.callbackIds,
  };
  if (payload.kind === "direct_interaction") {
    return { ...common, kind: payload.kind, reason: payload.reason };
  }
  return {
    ...common,
    kind: payload.kind,
    siteOrigin: payload.target.siteOrigin,
    fields: payload.target.fields.map((field) => {
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
  };
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
  const now = nowDate();
  const [row] = await db
    .select({
      runId: browserSessions.runId,
      providerSessionId: browserSessionInstances.providerSessionId,
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
        gt(browserSessionInstances.timeoutAt, now),
        gt(browserSessionInstances.idleExpiresAt, now),
      ),
    )
    .limit(1)
    .for("share");
  return row ?? null;
}

async function requestHasLiveBrowser(
  db: Db,
  row: RequestRow,
): Promise<boolean> {
  const now = nowDate();
  const [live] = await db
    .select({ providerSessionId: browserSessionInstances.providerSessionId })
    .from(browserSessionInstances)
    .where(
      and(
        eq(browserSessionInstances.providerSessionId, row.providerSessionId),
        eq(browserSessionInstances.chatThreadId, row.chatThreadId),
        eq(browserSessionInstances.status, "active"),
        gt(browserSessionInstances.timeoutAt, now),
        gt(browserSessionInstances.idleExpiresAt, now),
      ),
    )
    .limit(1);
  return live !== undefined;
}

async function touchExactProvider(db: Db, row: RequestRow): Promise<boolean> {
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
        gt(browserSessionInstances.timeoutAt, now),
        gt(browserSessionInstances.idleExpiresAt, now),
      ),
    )
    .returning({
      providerSessionId: browserSessionInstances.providerSessionId,
    });
  return touched !== undefined;
}

async function restorePending(db: Db, requestTokenHash: string): Promise<void> {
  await db
    .update(browserUserActionRequests)
    .set({ status: "pending", applyStartedAt: null })
    .where(
      and(
        eq(browserUserActionRequests.requestTokenHash, requestTokenHash),
        eq(browserUserActionRequests.status, "applying"),
      ),
    );
}

async function finalize(
  db: Db,
  requestTokenHash: string,
  status: "succeeded" | "stale" | "uncertain",
): Promise<RequestRow | null> {
  const now = nowDate();
  const [row] = await db
    .update(browserUserActionRequests)
    .set({ status, completedAt: now })
    .where(
      and(
        eq(browserUserActionRequests.requestTokenHash, requestTokenHash),
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
  readonly validation: BrowserUseUserActionValidation | null;
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
  if (args.input.kind === "direct_interaction") {
    return {
      kind: "ok",
      value: {
        chatThreadId: run.chatThreadId,
        providerSessionId: live.providerSessionId,
        validation: null,
      },
    };
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
  const validationResult = await settle(
    validateBrowserUseUserAction(
      providerResult.value.cdpUrl,
      {
        pageTargetId: args.input.pageTargetId,
        backendNodeIds: args.input.fields.map((field) => {
          return field.backendNodeId;
        }),
      },
      signal,
    ),
  );
  signal.throwIfAborted();
  if (!validationResult.ok) {
    return validationResult.error instanceof BrowserUseUserActionValidationError
      ? conflict(
          "The Browser page target or requested controls are not available",
          `BROWSER_USER_ACTION_${validationResult.error.code.toUpperCase()}`,
        )
      : providerFailure(validationResult.error);
  }
  if (
    validationResult.value.fields.length !== args.input.fields.length ||
    args.input.fields.some((field, index) => {
      const target = validationResult.value.fields[index];
      return (
        !target ||
        !browserUserActionFieldSupportsTarget(
          field.fieldKind,
          target.fingerprint,
        )
      );
    })
  ) {
    return conflict(
      "The requested Browser field kind does not match its control",
      "BROWSER_USER_ACTION_UNSUPPORTED_CONTROL",
    );
  }
  return {
    kind: "ok",
    value: {
      chatThreadId: run.chatThreadId,
      providerSessionId: live.providerSessionId,
      validation: validationResult.value,
    },
  };
}

function buildBrowserUserActionPayload(
  input: BrowserUserActionCreateRequest,
  validation: BrowserUseUserActionValidation | null,
  callbackIds: BrowserUserActionCallbackIds,
): BrowserUserActionPayload {
  if (input.kind === "direct_interaction") {
    return {
      version: 1,
      kind: input.kind,
      callbackIds,
      reason: input.reason,
    };
  }
  if (!validation) {
    throw new Error("Browser input request has no validated targets");
  }
  return {
    version: 1,
    kind: input.kind,
    callbackIds,
    target: {
      pageTargetId: validation.pageTargetId,
      documentLoaderId: validation.documentLoaderId,
      siteOrigin: validation.siteOrigin,
      pageUrlHash: hash(validation.pageUrl),
      fields: input.fields.map((field, index) => {
        const target = validation.fields[index];
        if (!target) {
          throw new Error("Missing validated Browser field");
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
    },
  };
}

async function persistBrowserUserAction(
  db: Db,
  input: {
    readonly args: CreateBrowserUserActionArgs;
    readonly prepared: PreparedBrowserUserAction;
    readonly requestToken: string;
    readonly payload: BrowserUserActionPayload;
  },
  signal: AbortSignal,
): Promise<RequestRow | null> {
  const { args, payload, prepared, requestToken } = input;
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
            gt(browserSessionInstances.timeoutAt, now),
            gt(browserSessionInstances.idleExpiresAt, now),
          ),
        )
        .returning({
          providerSessionId: browserSessionInstances.providerSessionId,
        });
      if (!leased) {
        return null;
      }
      const [created] = await tx
        .insert(browserUserActionRequests)
        .values({
          requestTokenHash: hash(requestToken),
          orgId: args.orgId,
          userId: args.userId,
          agentId: identity.agentId,
          chatThreadId: prepared.chatThreadId,
          status: "pending",
          providerSessionId: prepared.providerSessionId,
          payload,
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
    const callbackIds: BrowserUserActionCallbackIds = {
      success: {
        clientEventId: randomUUID(),
        chatThreadSortEventId: randomUUID(),
      },
      cancellation: {
        clientEventId: randomUUID(),
        chatThreadSortEventId: randomUUID(),
      },
    };
    const payload = buildBrowserUserActionPayload(
      args.input,
      prepared.value.validation,
      callbackIds,
    );
    const created = await persistBrowserUserAction(
      db,
      {
        args,
        prepared: prepared.value,
        requestToken,
        payload,
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
    async (tx) => {
      const operationDb = tx as Db;
      const now = nowDate();
      const [updated] = await operationDb
        .update(browserUserActionRequests)
        .set({
          status: "uncertain",
          completedAt: now,
        })
        .where(
          and(
            eq(
              browserUserActionRequests.requestTokenHash,
              row.requestTokenHash,
            ),
            eq(browserUserActionRequests.status, "applying"),
            lt(
              browserUserActionRequests.applyStartedAt,
              new Date(now.getTime() - APPLY_STUCK_AFTER_MS),
            ),
          ),
        )
        .returning();
      return updated ?? (await loadExactRequest(operationDb, row));
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
      !(await requestHasLiveBrowser(db, row))
    ) {
      return expired();
    }
    signal.throwIfAborted();
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
    payload.target.fields.map((field) => {
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
    payload.target.fields.some((field) => {
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
  return {
    kind: "ok",
    value: new Map(
      input.values.flatMap((entry) => {
        return entry.value.length === 0 ? [] : [[entry.key, entry.value]];
      }),
    ),
  };
}

function exactInputTarget(
  payload: Extract<BrowserUserActionPayload, { kind: "input" }>,
): {
  readonly pageTargetId: string;
  readonly documentLoaderId: string;
  readonly pageUrlHash: string;
} {
  return {
    pageTargetId: payload.target.pageTargetId,
    documentLoaderId: payload.target.documentLoaderId,
    pageUrlHash: payload.target.pageUrlHash,
  };
}

async function claimBrowserUserAction(
  db: Db,
  located: RequestRow,
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
    async (tx): Promise<ServiceResult<RequestRow>> => {
      const operationDb = tx as Db;
      const current = await loadExactRequest(operationDb, located);
      if (!current) {
        return notFound();
      }
      if (!(await requestHasLiveBrowser(operationDb, current))) {
        return expired();
      }
      if (current.status !== "pending") {
        return conflict("Browser input has already been claimed");
      }
      const startedAt = nowDate();
      const [claimed] = await operationDb
        .update(browserUserActionRequests)
        .set({
          status: "applying",
          applyStartedAt: startedAt,
        })
        .where(
          and(
            eq(
              browserUserActionRequests.requestTokenHash,
              current.requestTokenHash,
            ),
            eq(browserUserActionRequests.status, "pending"),
          ),
        )
        .returning();
      if (!claimed) {
        return conflict("Browser input has already been claimed");
      }
      return { kind: "ok", value: claimed };
    },
    signal,
  );
  return admitted.outcome === "written" ? admitted.value : notFound();
}

async function applyClaimedBrowserUserAction(
  db: Db,
  claimed: RequestRow,
  payload: Extract<BrowserUserActionPayload, { kind: "input" }>,
  values: ReadonlyMap<string, string>,
  signal: AbortSignal,
): Promise<ServiceResult<RequestRow>> {
  // The claim above is already visible. Re-enter canonical admission before
  // the Browser effect so closure in the gap prevents mutation, while this
  // transaction retains its barriers until the terminal state commits. The
  // sequential transactions never reserve one pool connection while waiting
  // to acquire a second one.
  const commitSignal = new AbortController().signal;
  const admitted = await withChatThreadContentWrite(
    db,
    {
      chatThreadId: claimed.chatThreadId,
      authorize: (identity) => {
        return authorized(claimed, identity);
      },
      threadLock: "update",
    },
    async (tx): Promise<ServiceResult<RequestRow>> => {
      const operationDb = tx as Db;
      const current = await loadExactRequest(operationDb, claimed);
      if (
        !current ||
        current.status !== "applying" ||
        current.applyStartedAt?.getTime() !== claimed.applyStartedAt?.getTime()
      ) {
        return conflict("Browser input state changed during application");
      }
      const leased = await touchExactProvider(operationDb, current);
      if (!leased) {
        const terminal = await finalize(
          operationDb,
          current.requestTokenHash,
          "stale",
        );
        return terminal
          ? { kind: "ok", value: terminal }
          : conflict("Browser input state changed during application");
      }
      const target = exactInputTarget(payload);
      const provider = await settleIncludingAbort(
        getBrowserUseSession(current.providerSessionId, signal),
      );
      if (!provider.ok) {
        await restorePending(operationDb, current.requestTokenHash);
        return providerFailure(provider.error);
      }
      if (provider.value.status !== "active" || !provider.value.cdpUrl) {
        await restorePending(operationDb, current.requestTokenHash);
        return providerFailure(new Error("Browser provider is not active"));
      }
      const operation = await settle(
        applyBrowserUseUserAction(
          provider.value.cdpUrl,
          {
            ...target,
            fields: payload.target.fields.map((field) => {
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
            operationDb,
            current.requestTokenHash,
            "uncertain",
          );
          return terminal
            ? { kind: "ok", value: terminal }
            : conflict("Browser input state changed during application");
        }
        await restorePending(operationDb, current.requestTokenHash);
        return providerFailure(operation.error);
      }
      const terminal = await finalize(
        operationDb,
        current.requestTokenHash,
        operation.value,
      );
      return terminal
        ? { kind: "ok", value: terminal }
        : conflict("Browser input state changed during application");
    },
    commitSignal,
  );
  signal.throwIfAborted();
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

    const claimed = await claimBrowserUserAction(db, located, signal);
    if (claimed.kind === "error") {
      return claimed;
    }
    const applied = await applyClaimedBrowserUserAction(
      db,
      claimed.value,
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
    async (tx): Promise<ServiceResult<RequestRow>> => {
      const operationDb = tx as Db;
      const current = await loadExactRequest(operationDb, args.row);
      if (!current) {
        return notFound();
      }
      if (current.status === args.terminal) {
        return { kind: "ok", value: current };
      }
      if (!(await requestHasLiveBrowser(operationDb, current))) {
        return expired();
      }
      if (current.status !== "pending") {
        return conflict(
          "Browser user-action state no longer permits this action",
        );
      }
      const now = nowDate();
      const [updated] = await operationDb
        .update(browserUserActionRequests)
        .set({
          status: args.terminal,
          completedAt: now,
        })
        .where(
          and(
            eq(
              browserUserActionRequests.requestTokenHash,
              current.requestTokenHash,
            ),
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
    return await mutatePendingRequest(
      db,
      { row, requestToken: args.requestToken, terminal: "succeeded" },
      signal,
    );
  },
);
