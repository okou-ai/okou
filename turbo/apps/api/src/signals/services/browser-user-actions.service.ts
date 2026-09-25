import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  browserUserActionDisplayFieldSchema,
  browserUserActionFieldKindSchema,
  type BrowserUserActionApplyRequest,
  type BrowserUserActionCreateRequest,
  type BrowserUserActionResponse,
  type BrowserUserActionState,
} from "@okouai/api-contracts/contracts/browser-user-actions";
import { BROWSER_IDLE_LEASE_MINUTES } from "@okouai/api-contracts/contracts/browser";
import {
  browserUserActionFieldSupportsTarget,
  parseBrowserUserActionPayload,
  type BrowserUserActionCallbackIds,
  type BrowserUserActionInputField,
  type BrowserUserActionPayload,
} from "@okouai/db/jsonb-contracts/browser-user-action";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { chatEvents } from "@okouai/db/schema/chat-event";
import {
  browserSessionInstances,
  browserSessions,
  browserUserActionRequests,
} from "@okouai/db/schema/browser-session";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  lt,
  lte,
  sql,
} from "drizzle-orm";
import { command } from "ccstate";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { safeSync, settle, settleIncludingAbort } from "../utils";
import {
  applyBrowserUseUserAction,
  BrowserUseProviderError,
  type BrowserUseControlInspection,
  type BrowserUseUserActionExactTarget,
  type BrowserUseUserActionValidation,
  BrowserUseUserActionValidationError,
  BrowserUseUserActionMutationError,
  getBrowserUseSession,
  preflightBrowserUseUserAction,
  validateBrowserUseUserAction,
} from "./browser-use.service";

const REQUEST_TOKEN_PREFIX = "vm0_browser_user_action";
const APPLY_STUCK_AFTER_MS = 60_000;
const IDLE_LEASE_MS = BROWSER_IDLE_LEASE_MINUTES * 60_000;
const CALLBACK_RECOVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const L = logger("BrowserUserActions");
const TERMINAL_STATES: readonly BrowserUserActionState[] = [
  "succeeded",
  "cancelled",
  "stale",
  "uncertain",
];

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
  controls?: readonly BrowserUseControlInspection[],
): BrowserUserActionResponse {
  const common = {
    requestToken,
    state: row.status,
    completedAt: row.completedAt?.toISOString() ?? null,
    agentId: row.agentId,
    threadId: row.chatThreadId,
    callbackIds: payload.callbackIds,
  };
  return {
    ...common,
    kind: payload.kind,
    siteOrigin: payload.target.siteOrigin,
    fields: payload.target.fields.map((field, index) => {
      const observed = controls?.[index];
      return {
        key: field.key,
        label: field.label,
        ...(field.description === undefined
          ? {}
          : { description: field.description }),
        fieldKind: field.fieldKind,
        required: field.required,
        control: browserUserActionDisplayFieldSchema.shape.control.parse({
          ...field.fingerprint,
          ...(observed === undefined
            ? {}
            : {
                siteRequired: observed.siteRequired,
                multiple: observed.multiple,
                ...(observed.checked === undefined
                  ? {}
                  : { checked: observed.checked }),
                ...(observed.radioGroupFingerprint === undefined
                  ? {}
                  : {
                      radioGroupFingerprint: observed.radioGroupFingerprint,
                      radioOptions: observed.radioOptions,
                    }),
                ...(observed.optionSetFingerprint === undefined
                  ? {}
                  : { optionSetFingerprint: observed.optionSetFingerprint }),
                ...(observed.options === undefined
                  ? {}
                  : {
                      options: observed.options.map((option) => {
                        return {
                          index: option.index,
                          label: option.label,
                          disabled: option.disabled,
                          selected: option.selected,
                          empty: option.empty,
                        };
                      }),
                    }),
                ...(observed.minLength === undefined
                  ? {}
                  : { minLength: observed.minLength }),
                ...(observed.maxLength === undefined
                  ? {}
                  : { maxLength: observed.maxLength }),
                ...(observed.pattern === undefined
                  ? {}
                  : { pattern: observed.pattern }),
                ...(observed.min === undefined ? {} : { min: observed.min }),
                ...(observed.max === undefined ? {} : { max: observed.max }),
                ...(observed.step === undefined ? {} : { step: observed.step }),
              }),
        }),
      };
    }),
  };
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

async function convertClosedBrowserUserActions(
  db: Db,
  limit: number,
  chatThreadIds: readonly string[] | null,
  signal: AbortSignal,
): Promise<number> {
  const candidates = await db
    .select({
      requestTokenHash: browserUserActionRequests.requestTokenHash,
      providerSessionId: browserUserActionRequests.providerSessionId,
      status: browserUserActionRequests.status,
      finishedAt: browserSessionInstances.finishedAt,
    })
    .from(browserUserActionRequests)
    .innerJoin(
      browserSessionInstances,
      eq(
        browserSessionInstances.providerSessionId,
        browserUserActionRequests.providerSessionId,
      ),
    )
    .where(
      and(
        inArray(browserUserActionRequests.status, ["pending", "applying"]),
        eq(browserSessionInstances.status, "stopped"),
        isNotNull(browserSessionInstances.finishedAt),
        chatThreadIds === null
          ? undefined
          : inArray(browserUserActionRequests.chatThreadId, chatThreadIds),
      ),
    )
    .orderBy(asc(browserUserActionRequests.requestTokenHash))
    .limit(limit);
  signal.throwIfAborted();

  for (const candidate of candidates) {
    if (
      candidate.finishedAt === null ||
      (candidate.status !== "pending" && candidate.status !== "applying")
    ) {
      throw new Error("Expected a closed Browser user-action candidate");
    }
    const nextStatus = candidate.status === "pending" ? "stale" : "uncertain";
    await db
      .update(browserUserActionRequests)
      .set({
        status: nextStatus,
        completedAt: candidate.finishedAt,
      })
      .where(
        and(
          eq(
            browserUserActionRequests.requestTokenHash,
            candidate.requestTokenHash,
          ),
          eq(
            browserUserActionRequests.providerSessionId,
            candidate.providerSessionId,
          ),
          eq(browserUserActionRequests.status, candidate.status),
        ),
      );
    signal.throwIfAborted();
  }
  return candidates.length;
}

async function deleteRetiredDirectBrowserUserActions(
  db: Db,
  limit: number,
  chatThreadIds: readonly string[] | null,
  signal: AbortSignal,
): Promise<number> {
  const retiredKind = sql`${browserUserActionRequests.payload}->>'kind' = 'direct_interaction'`;
  const candidates = db
    .select({ requestTokenHash: browserUserActionRequests.requestTokenHash })
    .from(browserUserActionRequests)
    .where(
      and(
        retiredKind,
        chatThreadIds === null
          ? undefined
          : inArray(browserUserActionRequests.chatThreadId, chatThreadIds),
      ),
    )
    .orderBy(asc(browserUserActionRequests.requestTokenHash))
    .limit(limit);
  const removed = await db
    .delete(browserUserActionRequests)
    .where(inArray(browserUserActionRequests.requestTokenHash, candidates))
    .returning({
      requestTokenHash: browserUserActionRequests.requestTokenHash,
    });
  signal.throwIfAborted();
  return removed.length;
}

async function deleteExpiredBrowserUserActions(
  db: Db,
  limit: number,
  chatThreadIds: readonly string[] | null,
  signal: AbortSignal,
): Promise<number> {
  const cutoff = new Date(nowDate().getTime() - CALLBACK_RECOVERY_RETENTION_MS);
  const candidates = await db
    .select({
      requestTokenHash: browserUserActionRequests.requestTokenHash,
      providerSessionId: browserUserActionRequests.providerSessionId,
      status: browserUserActionRequests.status,
      completedAt: browserUserActionRequests.completedAt,
    })
    .from(browserUserActionRequests)
    .innerJoin(
      browserSessionInstances,
      eq(
        browserSessionInstances.providerSessionId,
        browserUserActionRequests.providerSessionId,
      ),
    )
    .where(
      and(
        inArray(browserUserActionRequests.status, [...TERMINAL_STATES]),
        isNotNull(browserUserActionRequests.completedAt),
        lte(browserUserActionRequests.completedAt, cutoff),
        eq(browserSessionInstances.status, "stopped"),
        isNotNull(browserSessionInstances.finishedAt),
        lte(browserSessionInstances.finishedAt, cutoff),
        chatThreadIds === null
          ? undefined
          : inArray(browserUserActionRequests.chatThreadId, chatThreadIds),
      ),
    )
    .orderBy(asc(browserUserActionRequests.requestTokenHash))
    .limit(limit);
  signal.throwIfAborted();

  for (const candidate of candidates) {
    if (
      candidate.completedAt === null ||
      !TERMINAL_STATES.includes(candidate.status)
    ) {
      throw new Error("Expected a retained Browser user-action candidate");
    }
    await db
      .delete(browserUserActionRequests)
      .where(
        and(
          eq(
            browserUserActionRequests.requestTokenHash,
            candidate.requestTokenHash,
          ),
          eq(
            browserUserActionRequests.providerSessionId,
            candidate.providerSessionId,
          ),
          eq(browserUserActionRequests.status, candidate.status),
          eq(browserUserActionRequests.completedAt, candidate.completedAt),
        ),
      );
    signal.throwIfAborted();
  }
  return candidates.length;
}

export async function reconcileBrowserUserActions(
  db: Db,
  limit: number,
  chatThreadIds: readonly string[] | null,
  signal: AbortSignal,
): Promise<number> {
  const retired = await deleteRetiredDirectBrowserUserActions(
    db,
    limit,
    chatThreadIds,
    signal,
  );
  const checkedForConversion = await convertClosedBrowserUserActions(
    db,
    limit,
    chatThreadIds,
    signal,
  );
  const checkedForCleanup = await deleteExpiredBrowserUserActions(
    db,
    limit,
    chatThreadIds,
    signal,
  );
  return retired + checkedForConversion + checkedForCleanup;
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
  readonly validation: BrowserUseUserActionValidation;
}

function browserCreationValidationMessage(
  error: BrowserUseUserActionValidationError,
): string {
  const field = error.fieldPosition ? `--field ${error.fieldPosition}: ` : "";
  switch (error.code) {
    case "page_target_not_found": {
      return "The selected Browser page no longer exists; inspect the active tab and recapture the controls";
    }
    case "unsupported_page": {
      return "The selected Browser page is not an HTTP or HTTPS page";
    }
    case "backend_node_not_found": {
      return `${field}the selected Browser control no longer exists; inspect the page and recapture it`;
    }
    case "unsupported_control": {
      return `${field}the selected Browser control is not a writable top-level input, textarea, or select`;
    }
  }
}

function browserCreationControlType(
  fingerprint: BrowserUseUserActionValidation["fields"][number]["fingerprint"],
): string {
  if (fingerprint.tagName === "TEXTAREA") {
    return "textarea";
  }
  if (fingerprint.tagName === "SELECT") {
    return fingerprint.inputType === "select-multiple"
      ? "multiple select"
      : "single select";
  }
  const knownTypes = [
    "text",
    "password",
    "email",
    "tel",
    "url",
    "search",
    "number",
    "checkbox",
    "radio",
  ];
  return knownTypes.includes(fingerprint.inputType)
    ? `input type '${fingerprint.inputType}'`
    : "input control";
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
          browserCreationValidationMessage(validationResult.error),
          `BROWSER_USER_ACTION_${validationResult.error.code.toUpperCase()}`,
        )
      : providerFailure(validationResult.error);
  }
  const mismatchedPosition = args.input.fields.findIndex((field, index) => {
    const target = validationResult.value.fields[index];
    return (
      !target ||
      !browserUserActionFieldSupportsTarget(field.fieldKind, target.fingerprint)
    );
  });
  if (
    validationResult.value.fields.length !== args.input.fields.length ||
    mismatchedPosition !== -1
  ) {
    const position = mismatchedPosition === -1 ? 0 : mismatchedPosition + 1;
    const field = args.input.fields[mismatchedPosition];
    const target = validationResult.value.fields[mismatchedPosition];
    const compatibleKinds = target
      ? browserUserActionFieldKindSchema.options.filter((kind) => {
          return browserUserActionFieldSupportsTarget(kind, target.fingerprint);
        })
      : [];
    return conflict(
      position > 0 && field && target
        ? `--field ${position}: fieldKind '${field.fieldKind}' does not match the observed ${browserCreationControlType(target.fingerprint)}; use ${compatibleKinds.join(" or ")}`
        : "The requested Browser fields do not match the observed controls",
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
  validation: BrowserUseUserActionValidation,
  callbackIds: BrowserUserActionCallbackIds,
): BrowserUserActionPayload {
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
          ...(target.radioMemberNodeIds
            ? { radioMemberNodeIds: target.radioMemberNodeIds }
            : {}),
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
): Promise<RequestRow | null> {
  const { args, payload, prepared, requestToken } = input;
  return await db.transaction(async (tx): Promise<RequestRow | null> => {
    const [currentRun] = await tx
      .select({ agentId: chatThreads.agentId })
      .from(agentRuns)
      .innerJoin(chatThreads, eq(chatThreads.id, agentRuns.chatThreadId))
      .where(
        and(
          eq(agentRuns.id, args.runId),
          eq(agentRuns.orgId, args.orgId),
          eq(agentRuns.userId, args.userId),
          eq(agentRuns.chatThreadId, prepared.chatThreadId),
          inArray(agentRuns.status, ["pending", "running"]),
          eq(chatThreads.userId, args.userId),
        ),
      )
      .limit(1)
      .for("share", { of: agentRuns });
    if (!currentRun?.agentId) {
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
        agentId: currentRun.agentId,
        chatThreadId: prepared.chatThreadId,
        status: "pending",
        providerSessionId: prepared.providerSessionId,
        payload,
      })
      .returning();
    return created ?? null;
  });
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
    const created = await persistBrowserUserAction(db, {
      args,
      prepared: prepared.value,
      requestToken,
      payload,
    });
    signal.throwIfAborted();
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
): Promise<RequestRow | null> {
  if (
    row.status !== "applying" ||
    !row.applyStartedAt ||
    row.applyStartedAt.getTime() > nowDate().getTime() - APPLY_STUCK_AFTER_MS
  ) {
    return row;
  }
  const now = nowDate();
  const [updated] = await db
    .update(browserUserActionRequests)
    .set({
      status: "uncertain",
      completedAt: now,
    })
    .where(
      and(
        eq(browserUserActionRequests.requestTokenHash, row.requestTokenHash),
        eq(browserUserActionRequests.status, "applying"),
        lt(
          browserUserActionRequests.applyStartedAt,
          new Date(now.getTime() - APPLY_STUCK_AFTER_MS),
        ),
      ),
    )
    .returning();
  return updated ?? (await loadExactRequest(db, row));
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
    row = await normalizeStuckApplying(db, row);
    signal.throwIfAborted();
    if (!row) {
      return notFound();
    }
    const payload = decodePayload(row);
    const callbackId =
      row.status === "succeeded"
        ? payload?.callbackIds.success.clientEventId
        : row.status === "cancelled"
          ? payload?.callbackIds.cancellation.clientEventId
          : undefined;
    let callbackDelivered = false;
    if (callbackId) {
      const [callbackEvent] = await db
        .select({ id: chatEvents.id })
        .from(chatEvents)
        .where(
          and(
            eq(chatEvents.id, callbackId),
            eq(chatEvents.chatThreadId, row.chatThreadId),
            eq(chatEvents.eventType, "input.prompt"),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      callbackDelivered = callbackEvent !== undefined;
    }
    if (
      (row.status === "pending" || row.status === "applying") &&
      !(await requestHasLiveBrowser(db, row))
    ) {
      return expired();
    }
    signal.throwIfAborted();
    return payload
      ? {
          kind: "ok",
          value: {
            ...publicRequest(row, args.requestToken, payload),
            callbackDelivered,
          },
        }
      : conflict(
          "Browser user-action request payload is unavailable",
          "BROWSER_USER_ACTION_UNAVAILABLE",
        );
  },
);

type SubmittedBrowserValue = BrowserUserActionApplyRequest["values"][number];

function submittedValues(
  payload: Extract<BrowserUserActionPayload, { kind: "input" }>,
  input: BrowserUserActionApplyRequest,
): ServiceResult<Map<string, SubmittedBrowserValue>> {
  const allowed = new Map(
    payload.target.fields.map((field) => {
      return [field.key, field];
    }),
  );
  const values = new Map(
    input.values.map((entry) => {
      return [entry.key, entry];
    }),
  );
  if (
    input.values.some((entry) => {
      const field = allowed.get(entry.key);
      return (
        !field ||
        (field.fieldKind === "select" && !("optionIndexes" in entry)) ||
        (field.fieldKind === "checkbox" && !("checked" in entry)) ||
        (field.fieldKind === "radio" && !("memberIndex" in entry)) ||
        (field.fieldKind !== "select" &&
          field.fieldKind !== "checkbox" &&
          field.fieldKind !== "radio" &&
          !("value" in entry))
      );
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
      if (!field.required) {
        return false;
      }
      const entry = values.get(field.key);
      return (
        !entry ||
        ("optionIndexes" in entry
          ? entry.optionIndexes.length === 0
          : "checked" in entry
            ? entry.checked !== true
            : "memberIndex" in entry
              ? entry.memberIndex < 0
              : entry.value.length === 0)
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
        return "value" in entry &&
          entry.value.length === 0 &&
          allowed.get(entry.key)?.fieldKind !== "number"
          ? []
          : [[entry.key, entry]];
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

async function markPendingBrowserUserActionStale(
  db: Db,
  row: RequestRow,
): Promise<RequestRow | null> {
  const [stale] = await db
    .update(browserUserActionRequests)
    .set({ status: "stale", completedAt: nowDate() })
    .where(
      and(
        eq(browserUserActionRequests.requestTokenHash, row.requestTokenHash),
        eq(browserUserActionRequests.status, "pending"),
      ),
    )
    .returning();
  return stale ?? null;
}

type BrowserInputInspection =
  | { readonly kind: "stale" }
  | {
      readonly kind: "valid";
      readonly controls: readonly BrowserUseControlInspection[];
    };

async function inspectPendingBrowserUserAction(
  row: RequestRow,
  payload: Extract<BrowserUserActionPayload, { kind: "input" }>,
  signal: AbortSignal,
): Promise<ServiceResult<BrowserInputInspection>> {
  const attemptId = randomUUID();
  const providerStartedAt = performance.now();
  const provider = await settle(
    getBrowserUseSession(row.providerSessionId, signal),
  );
  signal.throwIfAborted();
  const providerPhase = {
    type: "browser_input_preflight_phase",
    attemptId,
    phase: "provider_session",
    outcome: provider.ok ? "ok" : "error",
    durationMs: Math.round(performance.now() - providerStartedAt),
  };
  if (provider.ok && providerPhase.durationMs < 1000) {
    L.debug("Browser input preflight provider phase", providerPhase);
  } else {
    L.warn("Browser input preflight provider phase", providerPhase);
  }
  if (!provider.ok) {
    return providerFailure(provider.error);
  }
  if (provider.value.status === "stopped") {
    return { kind: "ok", value: { kind: "stale" } };
  }
  if (!provider.value.cdpUrl) {
    return providerFailure(new Error("Browser provider is not active"));
  }
  const checked = await settle(
    preflightBrowserUseUserAction(
      provider.value.cdpUrl,
      {
        ...exactInputTarget(payload),
        fields: payload.target.fields.map((field) => {
          return {
            backendNodeId: field.backendNodeId,
            fingerprint: field.fingerprint,
            ...(field.radioMemberNodeIds
              ? { radioMemberNodeIds: field.radioMemberNodeIds }
              : {}),
            required: field.required,
          };
        }),
      },
      signal,
      attemptId,
    ),
  );
  signal.throwIfAborted();
  return checked.ok
    ? { kind: "ok", value: checked.value }
    : providerFailure(checked.error);
}

export const preflightBrowserUserAction$ = command(
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
    if (located.status !== "pending") {
      return conflict("Browser input is no longer pending");
    }
    const leased = await touchExactProvider(db, located);
    signal.throwIfAborted();
    if (!leased) {
      return expired();
    }
    const inspected = await inspectPendingBrowserUserAction(
      located,
      payload,
      signal,
    );
    if (inspected.kind === "error") {
      return inspected;
    }
    const inspection = inspected.value;
    // Apply or cancellation may have consumed the request while the check was
    // running.
    const current = await loadExactRequest(db, located);
    signal.throwIfAborted();
    if (!current) {
      return notFound();
    }
    if (current.status !== "pending") {
      return conflict("Browser input state changed during preflight");
    }
    if (!(await requestHasLiveBrowser(db, current))) {
      return expired();
    }
    if (inspection.kind === "stale") {
      const stale = await markPendingBrowserUserActionStale(db, current);
      signal.throwIfAborted();
      return stale
        ? {
            kind: "ok",
            value: publicRequest(stale, args.requestToken, payload),
          }
        : conflict("Browser input state changed during preflight");
    }
    return {
      kind: "ok",
      value: publicRequest(
        current,
        args.requestToken,
        payload,
        inspection.controls,
      ),
    };
  },
);

async function claimBrowserUserAction(
  db: Db,
  located: RequestRow,
): Promise<ServiceResult<RequestRow>> {
  if (!(await requestHasLiveBrowser(db, located))) {
    return expired();
  }
  if (located.status !== "pending") {
    return conflict("Browser input has already been claimed");
  }
  const [claimed] = await db
    .update(browserUserActionRequests)
    .set({
      status: "applying",
      applyStartedAt: nowDate(),
    })
    .where(
      and(
        eq(
          browserUserActionRequests.requestTokenHash,
          located.requestTokenHash,
        ),
        eq(browserUserActionRequests.status, "pending"),
      ),
    )
    .returning();
  if (!claimed) {
    return conflict("Browser input has already been claimed");
  }
  return { kind: "ok", value: claimed };
}

function browserApplyField(
  field: BrowserUserActionInputField,
  entry: SubmittedBrowserValue | undefined,
): BrowserUseUserActionExactTarget["fields"][number] {
  return {
    backendNodeId: field.backendNodeId,
    fingerprint: field.fingerprint,
    ...(field.radioMemberNodeIds
      ? { radioMemberNodeIds: field.radioMemberNodeIds }
      : {}),
    required: field.required,
    ...(entry === undefined
      ? {}
      : "value" in entry
        ? { value: entry.value }
        : "checked" in entry
          ? {
              checkbox: {
                checked: entry.checked,
                observedChecked: entry.observedChecked,
              },
            }
          : "memberIndex" in entry
            ? {
                radioChoice: {
                  memberIndex: entry.memberIndex,
                  observedSelectedIndex: entry.observedSelectedIndex,
                  groupFingerprint: entry.groupFingerprint,
                },
              }
            : {
                selection: {
                  optionIndexes: entry.optionIndexes,
                  optionSetFingerprint: entry.optionSetFingerprint,
                },
              }),
  };
}

async function applyClaimedBrowserUserAction(
  db: Db,
  claimed: RequestRow,
  payload: Extract<BrowserUserActionPayload, { kind: "input" }>,
  values: ReadonlyMap<string, SubmittedBrowserValue>,
  signal: AbortSignal,
): Promise<ServiceResult<RequestRow>> {
  // Once claimed, every exit settles the request: a terminal state or a
  // restored pending state, each conditional on the claim still applying.
  const leased = await touchExactProvider(db, claimed);
  if (!leased) {
    const terminal = await finalize(db, claimed.requestTokenHash, "stale");
    return terminal
      ? { kind: "ok", value: terminal }
      : conflict("Browser input state changed during application");
  }
  const target = exactInputTarget(payload);
  const provider = await settleIncludingAbort(
    getBrowserUseSession(claimed.providerSessionId, signal),
  );
  if (!provider.ok) {
    await restorePending(db, claimed.requestTokenHash);
    return providerFailure(provider.error);
  }
  if (provider.value.status !== "active" || !provider.value.cdpUrl) {
    await restorePending(db, claimed.requestTokenHash);
    return providerFailure(new Error("Browser provider is not active"));
  }
  const operation = await settle(
    applyBrowserUseUserAction(
      provider.value.cdpUrl,
      {
        ...target,
        fields: payload.target.fields.map((field) => {
          return browserApplyField(field, values.get(field.key));
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
        claimed.requestTokenHash,
        "uncertain",
      );
      return terminal
        ? { kind: "ok", value: terminal }
        : conflict("Browser input state changed during application");
    }
    await restorePending(db, claimed.requestTokenHash);
    return providerFailure(operation.error);
  }
  if (operation.value === "invalid") {
    await restorePending(db, claimed.requestTokenHash);
    return conflict(
      "Browser input does not meet the website control constraints",
      "BROWSER_USER_ACTION_INVALID_VALUE",
    );
  }
  const terminal = await finalize(
    db,
    claimed.requestTokenHash,
    operation.value,
  );
  signal.throwIfAborted();
  return terminal
    ? { kind: "ok", value: terminal }
    : conflict("Browser input state changed during application");
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

    const claimed = await claimBrowserUserAction(db, located);
    signal.throwIfAborted();
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
    readonly terminal: "cancelled";
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
  const current = args.row;
  if (current.status === args.terminal) {
    return {
      kind: "ok",
      value: publicRequest(current, args.requestToken, payload),
    };
  }
  if (!(await requestHasLiveBrowser(db, current))) {
    return expired();
  }
  if (current.status !== "pending") {
    return conflict("Browser user-action state no longer permits this action");
  }
  const [updated] = await db
    .update(browserUserActionRequests)
    .set({
      status: args.terminal,
      completedAt: nowDate(),
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
  signal.throwIfAborted();
  return updated
    ? {
        kind: "ok",
        value: publicRequest(updated, args.requestToken, payload),
      }
    : conflict("Browser user-action state changed");
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
