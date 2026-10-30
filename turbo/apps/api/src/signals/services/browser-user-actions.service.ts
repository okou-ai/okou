import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  BROWSER_USER_ACTION_MAX_FILE_BYTES,
  BROWSER_USER_ACTION_MAX_FILES,
  browserUserActionDisplayFieldSchema,
  browserUserActionFieldKindSchema,
  type BrowserUserActionApplyRequest,
  type BrowserUserActionCreateRequest,
  type BrowserUserActionResponse,
  type BrowserUserActionState,
  type BrowserUserActionPrepareFileUploadRequest,
} from "@okouai/api-contracts/contracts/browser-user-actions";
import {
  BROWSER_IDLE_LEASE_MINUTES,
  type BrowserWindowContext,
} from "@okouai/api-contracts/contracts/browser";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { browserOwnerProfiles } from "@okouai/db/schema/browser-owner";
import { browserChatSessions } from "@okouai/db/schema/browser-chat-session";
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
  type SQLWrapper,
  asc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notExists,
  not,
  or,
  sql,
} from "drizzle-orm";
import { command } from "ccstate";
import { QueryBuilder } from "drizzle-orm/pg-core";

import { env } from "../../lib/env";
import { nullableDriverValueDecoder } from "../../lib/db-structured-result";
import { logger } from "../../lib/log";
import { nowDate, nowDateSql } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { publishBrowserUserActionChangedSafely } from "../external/realtime";
import {
  deleteS3Objects,
  downloadS3BufferWithMaxBytes,
  generatePresignedPutUrl,
} from "../external/s3";
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
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";

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

function noSharedInputOwner(owner: {
  readonly orgId: string;
  readonly userId: string;
}) {
  return notExists(
    new QueryBuilder()
      .select({ id: browserOwnerProfiles.id })
      .from(browserOwnerProfiles)
      .where(
        and(
          eq(browserOwnerProfiles.orgId, owner.orgId),
          eq(browserOwnerProfiles.userId, owner.userId),
        ),
      ),
  );
}

function sharedInputWindowCondition(
  owner: {
    readonly orgId: string;
    readonly userId: string;
    readonly chatThreadId: string;
    readonly providerSessionId: string;
  },
  window: BrowserWindowContext,
  at: Date,
) {
  return and(
    eq(browserChatSessions.chatThreadId, owner.chatThreadId),
    eq(browserChatSessions.instanceId, window.instanceId),
    eq(browserChatSessions.primaryWindowId, window.primaryWindowId),
    eq(browserChatSessions.state, "active"),
    gt(browserChatSessions.expiresAt, at),
    exists(
      new QueryBuilder()
        .select({ id: browserOwnerProfiles.id })
        .from(browserOwnerProfiles)
        .where(
          and(
            eq(browserOwnerProfiles.orgId, owner.orgId),
            eq(browserOwnerProfiles.userId, owner.userId),
            eq(browserOwnerProfiles.instanceId, window.instanceId),
            eq(browserOwnerProfiles.providerSessionId, owner.providerSessionId),
            eq(browserOwnerProfiles.status, "active"),
            gt(browserOwnerProfiles.timeoutAt, at),
          ),
        ),
    ),
  );
}

const storedInputWindow = sql`${browserUserActionRequests.payload}->'target'->'window'`;

function storedSharedInputIsLive(at: Date) {
  return exists(
    new QueryBuilder()
      .select({ id: browserChatSessions.chatThreadId })
      .from(browserChatSessions)
      .innerJoin(
        browserOwnerProfiles,
        eq(browserOwnerProfiles.instanceId, browserChatSessions.instanceId),
      )
      .where(
        and(
          eq(
            browserChatSessions.chatThreadId,
            browserUserActionRequests.chatThreadId,
          ),
          eq(browserOwnerProfiles.orgId, browserUserActionRequests.orgId),
          eq(browserOwnerProfiles.userId, browserUserActionRequests.userId),
          eq(
            browserOwnerProfiles.providerSessionId,
            browserUserActionRequests.providerSessionId,
          ),
          sql`${browserOwnerProfiles.instanceId}::text = ${storedInputWindow}->>'instanceId'`,
          sql`${browserChatSessions.primaryWindowId}::text = ${storedInputWindow}->>'primaryWindowId'`,
          eq(browserChatSessions.state, "active"),
          gt(browserChatSessions.expiresAt, at),
          eq(browserOwnerProfiles.status, "active"),
          gt(browserOwnerProfiles.timeoutAt, at),
        ),
      ),
  );
}

function storedInputHasSharedOwner() {
  return exists(
    new QueryBuilder()
      .select({ id: browserOwnerProfiles.id })
      .from(browserOwnerProfiles)
      .where(
        and(
          eq(browserOwnerProfiles.orgId, browserUserActionRequests.orgId),
          eq(browserOwnerProfiles.userId, browserUserActionRequests.userId),
        ),
      ),
  );
}

export interface BrowserUserActionServiceError {
  readonly kind: "error";
  readonly status: 400 | 404 | 409 | 410 | 502 | 503;
  readonly code: string;
  readonly message: string;
}

type ServiceResult<T> =
  { readonly kind: "ok"; readonly value: T } | BrowserUserActionServiceError;

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
/**
 * Expiry is derived from the browser lease, not persisted. A write that finds
 * it notifies the thread so every open card reads the expired state.
 */
const expiredAfterNotify = async (row: RequestRow) => {
  await publishBrowserUserActionChangedSafely(row.userId, row.chatThreadId);
  return expired();
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

const FILE_UPLOAD_PREFIX = "browser-native-input/";
const FILE_UPLOAD_CONTENT_TYPE = "application/octet-stream";

function temporaryFileKey(
  row: Pick<RequestRow, "requestTokenHash">,
  index: number,
): string {
  return `${FILE_UPLOAD_PREFIX}${row.requestTokenHash}/${index.toString()}`;
}

export function temporaryBrowserFileKeys(
  requestTokenHash: string,
): readonly string[] {
  const row = { requestTokenHash };
  return Array.from({ length: BROWSER_USER_ACTION_MAX_FILES }, (_, index) => {
    return temporaryFileKey(row, index);
  });
}

export const prepareBrowserUserFileUpload$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly requestToken: string;
      readonly input: BrowserUserActionPrepareFileUploadRequest;
    },
    signal: AbortSignal,
  ): Promise<ServiceResult<{ readonly uploadUrl: string }>> => {
    const row = await set(loadOwnedBrowserUserActionRequest$, args, signal);
    signal.throwIfAborted();
    if (!row) {
      return notFound();
    }
    const payload = decodePayload(row);
    if (
      row.status !== "pending" ||
      payload?.kind !== "input" ||
      payload.target.fields.length !== 1 ||
      payload.target.fields[0]?.fieldKind !== "file" ||
      payload.target.fields[0].key !== args.input.key
    ) {
      return conflict("Browser file upload is not available");
    }
    if (!(await set(requestHasLiveBrowser$, row))) {
      return await expiredAfterNotify(row);
    }
    const uploadUrl = await get(
      generatePresignedPutUrl(
        env("R2_USER_STORAGES_BUCKET_NAME"),
        temporaryFileKey(row, args.input.index),
        FILE_UPLOAD_CONTENT_TYPE,
        {
          usePublicEndpoint: true,
          contentLength: args.input.size,
          expiresInSeconds: BROWSER_IDLE_LEASE_MINUTES * 60,
        },
        signal,
      ),
    );
    signal.throwIfAborted();
    // The signed PUT and the provider's idle lease use the same duration.
    // Its absolute timeout and request state still gate the subsequent apply.
    if (!(await set(touchExactProvider$, row, signal))) {
      return await expiredAfterNotify(row);
    }
    signal.throwIfAborted();
    return { kind: "ok", value: { uploadUrl } };
  },
);

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
    title: payload.title,
    reason: payload.reason,
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
                ...(observed.fileSetFingerprint === undefined
                  ? {}
                  : {
                      accept: observed.accept,
                      files: observed.files,
                      fileSetFingerprint: observed.fileSetFingerprint,
                    }),
                ...(observed.checked === undefined
                  ? {}
                  : { checked: observed.checked }),
                ...(observed.rangeValue === undefined
                  ? {}
                  : { rangeValue: observed.rangeValue }),
                ...(observed.colorValue === undefined
                  ? {}
                  : {
                      colorValue: observed.colorValue,
                      colorMode: observed.colorMode,
                    }),
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

const loadOwnedBrowserUserActionRequest$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly requestToken: string;
    },
    signal: AbortSignal,
  ): Promise<RequestRow | null> => {
    const [row] = await get(db$)
      .select()
      .from(browserUserActionRequests)
      .where(
        and(
          eq(
            browserUserActionRequests.requestTokenHash,
            hash(args.requestToken),
          ),
          eq(browserUserActionRequests.orgId, args.orgId),
          eq(browserUserActionRequests.userId, args.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return row ?? null;
  },
);

const loadExactBrowserUserActionRequest$ = command(
  async ({ get }, row: RequestRow): Promise<RequestRow | null> => {
    const [current] = await get(db$)
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
  },
);

const requestHasLiveBrowser$ = command(
  async ({ get }, row: RequestRow): Promise<boolean> => {
    const db = get(db$);
    const now = nowDate();
    const payload = decodePayload(row);
    if (!payload) {
      return false;
    }
    if (payload.target.window) {
      const [live] = await db
        .select({ id: browserChatSessions.chatThreadId })
        .from(browserChatSessions)
        .where(sharedInputWindowCondition(row, payload.target.window, now));
      return live !== undefined;
    }
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
          noSharedInputOwner(row),
        ),
      )
      .limit(1);
    return live !== undefined;
  },
);

const touchExactProvider$ = command(
  async ({ set }, row: RequestRow, signal: AbortSignal): Promise<boolean> => {
    const db = set(writeDb$);
    const now = nowDate();
    const payload = decodePayload(row);
    if (!payload) {
      return false;
    }
    if (payload.target.window) {
      const features = await set(
        loadUserFeatureSwitchContext$,
        row.orgId,
        row.userId,
        signal,
      );
      signal.throwIfAborted();
      if (!isFeatureEnabled(FeatureSwitchKey.BrowserSharedOwner, features)) {
        return false;
      }
      const leaseTime = nowDate();
      const [touched] = await db
        .update(browserChatSessions)
        .set({
          expiresAt: sql`least(greatest(${browserChatSessions.expiresAt}, ${sql.param(new Date(leaseTime.getTime() + IDLE_LEASE_MS), browserChatSessions.expiresAt)}::timestamp), (${new QueryBuilder().select({ timeoutAt: browserOwnerProfiles.timeoutAt }).from(browserOwnerProfiles).where(eq(browserOwnerProfiles.instanceId, payload.target.window.instanceId))}))`,
          updatedAt: leaseTime,
        })
        .where(
          sharedInputWindowCondition(row, payload.target.window, leaseTime),
        )
        .returning({ id: browserChatSessions.chatThreadId });
      signal.throwIfAborted();
      return touched !== undefined;
    }
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
          noSharedInputOwner(row),
        ),
      )
      .returning({
        providerSessionId: browserSessionInstances.providerSessionId,
      });
    signal.throwIfAborted();
    return touched !== undefined;
  },
);

const restorePending$ = command(
  async ({ set }, requestTokenHash: string): Promise<void> => {
    const db = set(writeDb$);
    const [restored] = await db
      .update(browserUserActionRequests)
      .set({ status: "pending", applyStartedAt: null })
      .where(
        and(
          eq(browserUserActionRequests.requestTokenHash, requestTokenHash),
          eq(browserUserActionRequests.status, "applying"),
        ),
      )
      .returning({
        userId: browserUserActionRequests.userId,
        chatThreadId: browserUserActionRequests.chatThreadId,
      });
    if (restored) {
      await publishBrowserUserActionChangedSafely(
        restored.userId,
        restored.chatThreadId,
      );
    }
  },
);

const finalize$ = command(
  async (
    { set },
    requestTokenHash: string,
    status: "succeeded" | "stale" | "uncertain",
  ): Promise<RequestRow | null> => {
    const db = set(writeDb$);
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
    if (row) {
      await publishBrowserUserActionChangedSafely(row.userId, row.chatThreadId);
    }
    return row ?? null;
  },
);

const deleteTemporaryBrowserUserActionFiles$ = command(
  async (
    { get },
    requestTokenHash: string,
    signal: AbortSignal,
  ): Promise<void> => {
    await get(
      deleteS3Objects(
        env("R2_USER_STORAGES_BUCKET_NAME"),
        temporaryBrowserFileKeys(requestTokenHash),
        signal,
      ),
    );
  },
);

const convertClosedBrowserUserActions$ = command(
  async (
    { set },
    limit: number,
    maintenanceSignal: AbortSignal,
  ): Promise<number> => {
    const db = set(writeDb$);
    const now = nowDate();
    const candidates = await db
      .select({
        requestTokenHash: browserUserActionRequests.requestTokenHash,
        userId: browserUserActionRequests.userId,
        chatThreadId: browserUserActionRequests.chatThreadId,
        payload: browserUserActionRequests.payload,
        providerSessionId: browserUserActionRequests.providerSessionId,
        status: browserUserActionRequests.status,
        finishedAt:
          sql`CASE WHEN ${browserSessionInstances.status} = 'stopped' AND ${browserSessionInstances.finishedAt} IS NOT NULL THEN ${browserSessionInstances.finishedAt} ELSE ${sql.param(now, browserSessionInstances.finishedAt)}::timestamp END`
            .mapWith(browserSessionInstances.finishedAt)
            .as("finished_at"),
      })
      .from(browserUserActionRequests)
      .leftJoin(
        browserSessionInstances,
        eq(
          browserSessionInstances.providerSessionId,
          browserUserActionRequests.providerSessionId,
        ),
      )
      .where(
        and(
          inArray(browserUserActionRequests.status, ["pending", "applying"]),
          or(
            and(
              isNotNull(storedInputWindow),
              not(storedSharedInputIsLive(now)),
            ),
            and(
              isNull(storedInputWindow),
              or(
                and(
                  eq(browserSessionInstances.status, "stopped"),
                  isNotNull(browserSessionInstances.finishedAt),
                ),
                storedInputHasSharedOwner(),
              ),
            ),
          ),
        ),
      )
      .orderBy(asc(browserUserActionRequests.requestTokenHash))
      .limit(limit);
    maintenanceSignal.throwIfAborted();

    for (const candidate of candidates) {
      if (
        candidate.finishedAt === null ||
        (candidate.status !== "pending" && candidate.status !== "applying")
      ) {
        throw new Error("Expected a closed Browser user-action candidate");
      }
      const nextStatus = candidate.status === "pending" ? "stale" : "uncertain";
      const [updated] = await db
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
        )
        .returning({
          userId: browserUserActionRequests.userId,
          chatThreadId: browserUserActionRequests.chatThreadId,
        });
      if (updated) {
        await publishBrowserUserActionChangedSafely(
          updated.userId,
          updated.chatThreadId,
        );
        maintenanceSignal.throwIfAborted();
      }
      if (
        updated &&
        candidate.payload.kind === "input" &&
        candidate.payload.target.fields[0]?.fieldKind === "file"
      ) {
        const cleanup = await settle(
          set(
            deleteTemporaryBrowserUserActionFiles$,
            candidate.requestTokenHash,
            maintenanceSignal,
          ),
        );
        if (!cleanup.ok) {
          L.warn("Temporary Browser file cleanup failed");
        }
      }
      maintenanceSignal.throwIfAborted();
    }
    return candidates.length;
  },
);

const deleteRetiredDirectBrowserUserActions$ = command(
  async ({ set }, limit: number, signal: AbortSignal): Promise<number> => {
    const db = set(writeDb$);
    const retiredKind = sql`${browserUserActionRequests.payload}->>'kind' = 'direct_interaction'`;
    const candidates = db
      .select({ requestTokenHash: browserUserActionRequests.requestTokenHash })
      .from(browserUserActionRequests)
      .where(retiredKind)
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
  },
);

const deleteExpiredBrowserUserActions$ = command(
  async (
    { set },
    limit: number,
    maintenanceSignal: AbortSignal,
  ): Promise<number> => {
    const db = set(writeDb$);
    const cutoff = new Date(
      nowDate().getTime() - CALLBACK_RECOVERY_RETENTION_MS,
    );
    const candidates = await db
      .select({
        requestTokenHash: browserUserActionRequests.requestTokenHash,
        payload: browserUserActionRequests.payload,
        providerSessionId: browserUserActionRequests.providerSessionId,
        status: browserUserActionRequests.status,
        completedAt: browserUserActionRequests.completedAt,
      })
      .from(browserUserActionRequests)
      .leftJoin(
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
          or(
            and(
              isNotNull(storedInputWindow),
              not(storedSharedInputIsLive(nowDate())),
            ),
            and(
              isNull(storedInputWindow),
              eq(browserSessionInstances.status, "stopped"),
              isNotNull(browserSessionInstances.finishedAt),
              lte(browserSessionInstances.finishedAt, cutoff),
            ),
          ),
        ),
      )
      .orderBy(asc(browserUserActionRequests.requestTokenHash))
      .limit(limit);
    maintenanceSignal.throwIfAborted();

    for (const candidate of candidates) {
      if (
        candidate.completedAt === null ||
        !TERMINAL_STATES.includes(candidate.status)
      ) {
        throw new Error("Expected a retained Browser user-action candidate");
      }
      if (
        candidate.payload.kind === "input" &&
        candidate.payload.target.fields[0]?.fieldKind === "file"
      ) {
        const cleanup = await settle(
          set(
            deleteTemporaryBrowserUserActionFiles$,
            candidate.requestTokenHash,
            maintenanceSignal,
          ),
        );
        if (!cleanup.ok) {
          L.warn("Temporary Browser file cleanup failed");
          continue;
        }
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
      maintenanceSignal.throwIfAborted();
    }
    return candidates.length;
  },
);

export const reconcileBrowserUserActions$ = command(
  async ({ set }, limit: number, signal: AbortSignal): Promise<number> => {
    const retired = await set(
      deleteRetiredDirectBrowserUserActions$,
      limit,
      signal,
    );
    const checkedForConversion = await set(
      convertClosedBrowserUserActions$,
      limit,
      signal,
    );
    const checkedForCleanup = await set(
      deleteExpiredBrowserUserActions$,
      limit,
      signal,
    );
    return retired + checkedForConversion + checkedForCleanup;
  },
);

interface CreateBrowserUserActionArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
  readonly input: BrowserUserActionCreateRequest;
}

interface PreparedBrowserUserAction {
  readonly chatThreadId: string;
  readonly providerSessionId: string;
  readonly window?: BrowserWindowContext;
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
    "range",
    "date",
    "time",
    "datetime-local",
    "month",
    "week",
    "checkbox",
    "radio",
    "file",
  ];
  return knownTypes.includes(fingerprint.inputType)
    ? `input type '${fingerprint.inputType}'`
    : "input control";
}

function hasMixedFileFields(input: BrowserUserActionCreateRequest): boolean {
  return (
    input.fields.length !== 1 &&
    input.fields.some((field) => {
      return field.fieldKind === "file";
    })
  );
}

function requestedBrowserFieldsError(
  input: BrowserUserActionCreateRequest,
  validation: BrowserUseUserActionValidation,
): BrowserUserActionServiceError | null {
  if (hasMixedFileFields(input)) {
    return conflict(
      "File input must be requested on its own",
      "BROWSER_USER_ACTION_UNSUPPORTED_CONTROL",
    );
  }
  const mismatchedPosition = input.fields.findIndex((field, index) => {
    const target = validation.fields[index];
    return (
      !target ||
      !browserUserActionFieldSupportsTarget(field.fieldKind, target.fingerprint)
    );
  });
  if (
    validation.fields.length !== input.fields.length ||
    mismatchedPosition !== -1
  ) {
    const position = mismatchedPosition === -1 ? 0 : mismatchedPosition + 1;
    const field = input.fields[mismatchedPosition];
    const target = validation.fields[mismatchedPosition];
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
  return null;
}

interface BrowserUserActionLifetime {
  readonly runId: string | null;
  readonly providerSessionId: string;
  readonly window?: BrowserWindowContext;
}
const resolveBrowserUserActionLifetime$ = command(
  async (
    { get, set },
    args: CreateBrowserUserActionArgs,
    chatThreadId: string,
    signal: AbortSignal,
  ): Promise<ServiceResult<BrowserUserActionLifetime>> => {
    const db = get(db$);
    const now = nowDate();
    const [shared] = await db
      .select({
        instanceId: browserOwnerProfiles.instanceId,
        providerSessionId: browserOwnerProfiles.providerSessionId,
        status: browserOwnerProfiles.status,
        timeoutAt: browserOwnerProfiles.timeoutAt,
        window: {
          primaryWindowId: browserChatSessions.primaryWindowId,
          state: browserChatSessions.state,
          expiresAt: browserChatSessions.expiresAt,
        },
      })
      .from(browserOwnerProfiles)
      .leftJoin(
        browserChatSessions,
        and(
          eq(browserChatSessions.instanceId, browserOwnerProfiles.instanceId),
          eq(browserChatSessions.chatThreadId, chatThreadId),
        ),
      )
      .where(
        and(
          eq(browserOwnerProfiles.orgId, args.orgId),
          eq(browserOwnerProfiles.userId, args.userId),
        ),
      );
    signal.throwIfAborted();
    let live: {
      readonly runId: string | null;
      readonly providerSessionId: string;
      readonly window?: BrowserWindowContext;
    } | null = null;
    if (shared) {
      const features = await set(
        loadUserFeatureSwitchContext$,
        args.orgId,
        args.userId,
        signal,
      );
      if (
        !isFeatureEnabled(FeatureSwitchKey.BrowserSharedOwner, features) ||
        shared.status !== "active" ||
        !shared.providerSessionId ||
        shared.timeoutAt <= now ||
        !shared.window ||
        shared.window.state !== "active" ||
        shared.window.primaryWindowId === null ||
        shared.window.expiresAt === null ||
        shared.window.expiresAt <= now
      ) {
        return conflict(
          "The current chat has no live shared Browser window",
          "BROWSER_USER_ACTION_BROWSER_NOT_LIVE",
        );
      }
      live = {
        runId: args.runId,
        providerSessionId: shared.providerSessionId,
        window: {
          instanceId: shared.instanceId,
          primaryWindowId: shared.window.primaryWindowId,
        },
      };
    } else {
      const [legacy = null] = await db
        .select({
          runId: browserSessions.runId,
          providerSessionId: browserSessionInstances.providerSessionId,
        })
        .from(browserSessions)
        .innerJoin(
          browserSessionInstances,
          eq(
            browserSessionInstances.chatThreadId,
            browserSessions.chatThreadId,
          ),
        )
        .where(
          and(
            eq(browserSessions.chatThreadId, chatThreadId),
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
      signal.throwIfAborted();
      live = legacy;
    }
    signal.throwIfAborted();
    if (!live || live.runId !== args.runId) {
      return conflict(
        "The current chat run has no live managed Browser",
        "BROWSER_USER_ACTION_BROWSER_NOT_LIVE",
      );
    }

    return { kind: "ok", value: live };
  },
);

const prepareBrowserUserAction$ = command(
  async (
    { get, set },
    args: CreateBrowserUserActionArgs,
    signal: AbortSignal,
  ): Promise<ServiceResult<PreparedBrowserUserAction>> => {
    const db = get(db$);
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
    const resolved = await set(
      resolveBrowserUserActionLifetime$,
      args,
      run.chatThreadId,
      signal,
    );
    signal.throwIfAborted();
    if (resolved.kind === "error") {
      return resolved;
    }
    const live = resolved.value;
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
          ...(live.window
            ? { primaryWindowId: live.window.primaryWindowId }
            : {}),
          backendNodeIds: args.input.fields.map((field) => {
            return field.backendNodeId;
          }),
        },
        signal,
      ),
    );
    signal.throwIfAborted();
    if (!validationResult.ok) {
      return validationResult.error instanceof
        BrowserUseUserActionValidationError
        ? conflict(
            browserCreationValidationMessage(validationResult.error),
            `BROWSER_USER_ACTION_${validationResult.error.code.toUpperCase()}`,
          )
        : providerFailure(validationResult.error);
    }
    const fieldsError = requestedBrowserFieldsError(
      args.input,
      validationResult.value,
    );
    if (fieldsError) {
      return fieldsError;
    }
    return {
      kind: "ok",
      value: {
        chatThreadId: run.chatThreadId,
        providerSessionId: live.providerSessionId,
        ...(live.window ? { window: live.window } : {}),
        validation: validationResult.value,
      },
    };
  },
);

function buildBrowserUserActionPayload(
  input: BrowserUserActionCreateRequest,
  validation: BrowserUseUserActionValidation,
  callbackIds: BrowserUserActionCallbackIds,
  window?: BrowserWindowContext,
): BrowserUserActionPayload {
  return {
    version: 1,
    kind: input.kind,
    title: input.title,
    reason: input.reason,
    callbackIds,
    target: {
      ...(window ? { window } : {}),
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

/** Read descriptions only. The request owner executes the dependent writes. */
function browserUserActionCreationPlan(args: {
  readonly runId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId: string;
  readonly providerSessionId: string;
  readonly window?: BrowserWindowContext;
}) {
  const query = new QueryBuilder();
  const runQuery = query
    .select({ agentId: chatThreads.agentId })
    .from(agentRuns)
    .innerJoin(chatThreads, eq(chatThreads.id, agentRuns.chatThreadId))
    .where(
      and(
        eq(agentRuns.id, args.runId),
        eq(agentRuns.orgId, args.orgId),
        eq(agentRuns.userId, args.userId),
        eq(agentRuns.chatThreadId, args.chatThreadId),
        inArray(agentRuns.status, ["pending", "running"]),
        eq(chatThreads.userId, args.userId),
        isNotNull(chatThreads.agentId),
        args.window ? eq(chatThreads.cloudBrowserEnabled, true) : undefined,
      ),
    )
    .limit(1);
  const run = query
    .$with("action_run")
    .as(args.window ? runQuery : runQuery.for("share", { of: agentRuns }));
  const liveClock = query.$with("action_live_clock").as(
    query
      .select({
        at: nowDateSql()
          .mapWith(browserSessionInstances.lastTouchedAt)
          .as("at"),
      })
      .from(run),
  );
  const browser = args.window
    ? query.$with("action_browser").as(
        query
          .select({
            runId: sql`${args.runId}`
              .mapWith(nullableDriverValueDecoder(browserSessions.runId))
              .as("input_run_id"),
            providerSessionId: sql`${browserOwnerProfiles.providerSessionId}`
              .mapWith(browserSessionInstances.providerSessionId)
              .as("input_provider_session_id"),
          })
          .from(browserChatSessions)
          .innerJoin(
            browserOwnerProfiles,
            eq(browserOwnerProfiles.instanceId, browserChatSessions.instanceId),
          )
          .innerJoin(
            liveClock,
            gt(browserOwnerProfiles.timeoutAt, liveClock.at),
          )
          .where(
            and(
              eq(browserOwnerProfiles.orgId, args.orgId),
              eq(browserOwnerProfiles.userId, args.userId),
              eq(browserOwnerProfiles.instanceId, args.window.instanceId),
              eq(
                browserOwnerProfiles.providerSessionId,
                args.providerSessionId,
              ),
              eq(browserOwnerProfiles.status, "active"),
              eq(browserChatSessions.chatThreadId, args.chatThreadId),
              eq(
                browserChatSessions.primaryWindowId,
                args.window.primaryWindowId,
              ),
              eq(browserChatSessions.state, "active"),
              gt(browserChatSessions.expiresAt, liveClock.at),
            ),
          ),
      )
    : query.$with("action_browser").as(
        query
          .select({
            runId: sql`${browserSessions.runId}`
              .mapWith(nullableDriverValueDecoder(browserSessions.runId))
              .as("input_run_id"),
            providerSessionId: sql`${browserSessionInstances.providerSessionId}`
              .mapWith(browserSessionInstances.providerSessionId)
              .as("input_provider_session_id"),
          })
          .from(browserSessions)
          .innerJoin(
            browserSessionInstances,
            eq(
              browserSessionInstances.chatThreadId,
              browserSessions.chatThreadId,
            ),
          )
          .innerJoin(
            liveClock,
            gt(browserSessionInstances.timeoutAt, liveClock.at),
          )
          .where(
            and(
              eq(browserSessions.chatThreadId, args.chatThreadId),
              eq(browserSessions.orgId, args.orgId),
              eq(browserSessions.userId, args.userId),
              eq(browserSessions.status, "active"),
              eq(browserSessionInstances.status, "active"),
              gt(browserSessionInstances.idleExpiresAt, liveClock.at),
              noSharedInputOwner(args),
            ),
          )
          .limit(1)
          .for("share"),
      );
  const leaseClock = query.$with("action_lease_clock").as(
    query
      .select({
        at: nowDateSql()
          .mapWith(browserSessionInstances.lastTouchedAt)
          .as("at"),
        runId: browser.runId,
        providerSessionId: browser.providerSessionId,
      })
      .from(browser),
  );
  return { run, liveClock, browser, leaseClock };
}

function browserUserActionRequestProjection(
  input: {
    readonly args: CreateBrowserUserActionArgs;
    readonly prepared: PreparedBrowserUserAction;
    readonly requestToken: string;
    readonly payload: BrowserUserActionPayload;
  },
  agentId: SQLWrapper,
  providerSessionId: SQLWrapper,
) {
  const { args, prepared, requestToken, payload } = input;
  const t = browserUserActionRequests;
  return {
    requestTokenHash: sql`${sql.param(hash(requestToken), t.requestTokenHash)}`
      .mapWith(t.requestTokenHash)
      .as("request_token_hash"),
    orgId: sql`${sql.param(args.orgId, t.orgId)}`.mapWith(t.orgId).as("org_id"),
    userId: sql`${sql.param(args.userId, t.userId)}`
      .mapWith(t.userId)
      .as("user_id"),
    agentId: sql`${agentId}`.mapWith(t.agentId).as("agent_id"),
    chatThreadId: sql`${sql.param(prepared.chatThreadId, t.chatThreadId)}::uuid`
      .mapWith(t.chatThreadId)
      .as("chat_thread_id"),
    status: sql`'pending'`.mapWith(t.status).as("status"),
    providerSessionId: sql`${providerSessionId}`
      .mapWith(t.providerSessionId)
      .as("provider_session_id"),
    payload: sql`${sql.param(payload, t.payload)}::jsonb`
      .mapWith(t.payload)
      .as("payload"),
    applyStartedAt: sql`NULL`
      .mapWith(nullableDriverValueDecoder(t.applyStartedAt))
      .as("apply_started_at"),
    completedAt: sql`NULL`
      .mapWith(nullableDriverValueDecoder(t.completedAt))
      .as("completed_at"),
  };
}

const persistBrowserUserAction = command(
  async (
    { set },
    input: {
      readonly args: CreateBrowserUserActionArgs;
      readonly prepared: PreparedBrowserUserAction;
      readonly requestToken: string;
      readonly payload: BrowserUserActionPayload;
    },
  ): Promise<RequestRow | null> => {
    const db = set(writeDb$);
    const { args, prepared } = input;
    const plan = browserUserActionCreationPlan({ ...args, ...prepared });
    const leased = prepared.window
      ? db.$with("action_leased_browser").as(
          db
            .update(browserChatSessions)
            .set({
              expiresAt: sql`least(greatest(${browserChatSessions.expiresAt}, ${plan.leaseClock.at} + ${IDLE_LEASE_MS} * interval '1 millisecond'), (${new QueryBuilder().select({ timeoutAt: browserOwnerProfiles.timeoutAt }).from(browserOwnerProfiles).where(eq(browserOwnerProfiles.instanceId, prepared.window.instanceId))}))`,
              updatedAt: sql`${plan.leaseClock.at}`,
            })
            .from(plan.leaseClock)
            .where(
              and(
                eq(plan.leaseClock.runId, args.runId),
                eq(
                  plan.leaseClock.providerSessionId,
                  prepared.providerSessionId,
                ),
                eq(browserChatSessions.chatThreadId, prepared.chatThreadId),
                eq(browserChatSessions.instanceId, prepared.window.instanceId),
                eq(
                  browserChatSessions.primaryWindowId,
                  prepared.window.primaryWindowId,
                ),
                eq(browserChatSessions.state, "active"),
                gt(browserChatSessions.expiresAt, plan.leaseClock.at),
                exists(
                  new QueryBuilder()
                    .select({ id: browserOwnerProfiles.id })
                    .from(browserOwnerProfiles)
                    .where(
                      and(
                        eq(browserOwnerProfiles.orgId, args.orgId),
                        eq(browserOwnerProfiles.userId, args.userId),
                        eq(
                          browserOwnerProfiles.instanceId,
                          prepared.window.instanceId,
                        ),
                        eq(
                          browserOwnerProfiles.providerSessionId,
                          prepared.providerSessionId,
                        ),
                        eq(browserOwnerProfiles.status, "active"),
                        gt(browserOwnerProfiles.timeoutAt, plan.leaseClock.at),
                      ),
                    ),
                ),
              ),
            )
            .returning({
              providerSessionId: sql`${plan.leaseClock.providerSessionId}`
                .mapWith(browserSessionInstances.providerSessionId)
                .as("provider_session_id"),
            }),
        )
      : db.$with("action_leased_browser").as(
          db
            .update(browserSessionInstances)
            .set({
              lastTouchedAt: sql`${plan.leaseClock.at}`,
              idleExpiresAt: sql`${plan.leaseClock.at} + ${IDLE_LEASE_MS} * interval '1 millisecond'`,
              updatedAt: sql`${plan.leaseClock.at}`,
            })
            .from(plan.leaseClock)
            .where(
              and(
                eq(plan.leaseClock.runId, args.runId),
                eq(
                  plan.leaseClock.providerSessionId,
                  prepared.providerSessionId,
                ),
                eq(
                  browserSessionInstances.providerSessionId,
                  prepared.providerSessionId,
                ),
                eq(browserSessionInstances.chatThreadId, prepared.chatThreadId),
                eq(browserSessionInstances.status, "active"),
                gt(browserSessionInstances.timeoutAt, plan.leaseClock.at),
                gt(browserSessionInstances.idleExpiresAt, plan.leaseClock.at),
                noSharedInputOwner(args),
              ),
            )
            .returning({
              providerSessionId:
                sql`${browserSessionInstances.providerSessionId}`
                  .mapWith(browserSessionInstances.providerSessionId)
                  .as("provider_session_id"),
            }),
        );
    const source = new QueryBuilder()
      .select(
        browserUserActionRequestProjection(
          input,
          plan.run.agentId,
          leased.providerSessionId,
        ),
      )
      .from(leased)
      .innerJoin(plan.run, sql`TRUE`);
    const [created] = await db
      .with(plan.run, plan.liveClock, plan.browser, plan.leaseClock, leased)
      .insert(browserUserActionRequests)
      .select(source)
      .returning();
    return created ?? null;
  },
);

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
    set(writeDb$);
    const prepared = await set(prepareBrowserUserAction$, args, signal);
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
      prepared.value.window,
    );
    const created = await set(persistBrowserUserAction, {
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
    let row = await set(loadOwnedBrowserUserActionRequest$, args, signal);
    signal.throwIfAborted();
    if (!row) {
      return notFound();
    }
    if (
      row.status === "applying" &&
      row.applyStartedAt &&
      row.applyStartedAt.getTime() <= nowDate().getTime() - APPLY_STUCK_AFTER_MS
    ) {
      const now = nowDate();
      const [uncertain] = await db
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
      signal.throwIfAborted();
      row = uncertain ?? (await set(loadExactBrowserUserActionRequest$, row));
      signal.throwIfAborted();
      if (uncertain) {
        await publishBrowserUserActionChangedSafely(
          uncertain.userId,
          uncertain.chatThreadId,
        );
        signal.throwIfAborted();
      }
    }
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
      !(await set(requestHasLiveBrowser$, row))
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

function validBrowserFileName(name: string): boolean {
  return ![...name].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      code <= 31 || code === 127 || character === "/" || character === "\\"
    );
  });
}

function validSubmittedFiles(
  entry: Extract<SubmittedBrowserValue, { files: unknown }>,
): boolean {
  let total = 0;
  for (const file of entry.files) {
    if (
      !validBrowserFileName(file.name) ||
      /[^\x20-\x7e]/u.test(file.type) ||
      file.type !== file.type.toLowerCase()
    ) {
      return false;
    }
    total += file.size;
    if (total > BROWSER_USER_ACTION_MAX_FILE_BYTES) {
      return false;
    }
  }
  return entry.files.length <= BROWSER_USER_ACTION_MAX_FILES;
}

const materializeBrowserFileChoice$ = command(
  async (
    { get },
    row: RequestRow,
    entry: Extract<SubmittedBrowserValue, { files: unknown }>,
    signal: AbortSignal,
  ): Promise<
    BrowserUseUserActionExactTarget["fields"][number]["fileChoice"] | null
  > => {
    const files: {
      name: string;
      type: string;
      size: number;
      contentBase64: string;
    }[] = [];
    for (const [index, file] of entry.files.entries()) {
      const buffer = await get(
        downloadS3BufferWithMaxBytes(
          env("R2_USER_STORAGES_BUCKET_NAME"),
          temporaryFileKey(row, index),
          BROWSER_USER_ACTION_MAX_FILE_BYTES,
          signal,
        ),
      );
      signal.throwIfAborted();
      if (buffer.length !== file.size) {
        return null;
      }
      files.push({
        name: file.name,
        type: file.type,
        size: file.size,
        contentBase64: buffer.toString("base64"),
      });
    }
    return {
      observedFingerprint: entry.observedFingerprint,
      operation: entry.operation,
      files,
    };
  },
);

function submittedValueMatchesField(
  field: BrowserUserActionInputField,
  entry: SubmittedBrowserValue,
): boolean {
  if (
    ("observedValue" in entry && field.fieldKind !== "range") ||
    ("observedColor" in entry && field.fieldKind !== "color")
  ) {
    return false;
  }
  switch (field.fieldKind) {
    case "range": {
      return "observedValue" in entry;
    }
    case "color": {
      return "observedColor" in entry;
    }
    case "select": {
      return "optionIndexes" in entry;
    }
    case "checkbox": {
      return "checked" in entry;
    }
    case "radio": {
      return "memberIndex" in entry;
    }
    case "file": {
      return "files" in entry && validSubmittedFiles(entry);
    }
    default: {
      return "value" in entry;
    }
  }
}

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
      return !field || !submittedValueMatchesField(field, entry);
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
        ("observedValue" in entry || "observedColor" in entry
          ? entry.value.length === 0
          : "optionIndexes" in entry
            ? entry.optionIndexes.length === 0
            : "checked" in entry
              ? entry.checked !== true
              : "memberIndex" in entry
                ? entry.memberIndex < 0
                : "files" in entry
                  ? entry.operation === "clear"
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
          !["number", "date_time"].includes(
            allowed.get(entry.key)?.fieldKind ?? "",
          )
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
  const provider = await settle(
    getBrowserUseSession(row.providerSessionId, signal),
  );
  signal.throwIfAborted();
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
        ...(payload.target.window
          ? { primaryWindowId: payload.target.window.primaryWindowId }
          : {}),
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
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly requestToken: string;
    },
    signal: AbortSignal,
  ): Promise<ServiceResult<BrowserUserActionResponse>> => {
    const db = set(writeDb$);
    const located = await set(loadOwnedBrowserUserActionRequest$, args, signal);
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
    const leased = await set(touchExactProvider$, located, signal);
    signal.throwIfAborted();
    if (!leased) {
      return await expiredAfterNotify(located);
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
    const current = await set(loadExactBrowserUserActionRequest$, located);
    signal.throwIfAborted();
    if (!current) {
      return notFound();
    }
    if (current.status !== "pending") {
      return conflict("Browser input state changed during preflight");
    }
    if (!(await set(requestHasLiveBrowser$, current))) {
      return await expiredAfterNotify(current);
    }
    if (inspection.kind === "stale") {
      const [stale] = await db
        .update(browserUserActionRequests)
        .set({ status: "stale", completedAt: nowDate() })
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
      if (!stale) {
        return conflict("Browser input state changed during preflight");
      }
      await publishBrowserUserActionChangedSafely(
        stale.userId,
        stale.chatThreadId,
      );
      signal.throwIfAborted();
      if (payload.target.fields[0]?.fieldKind === "file") {
        const cleanup = await settle(
          get(
            deleteS3Objects(
              env("R2_USER_STORAGES_BUCKET_NAME"),
              temporaryBrowserFileKeys(stale.requestTokenHash),
            ),
          ),
        );
        signal.throwIfAborted();
        if (!cleanup.ok) {
          L.warn("Temporary Browser file cleanup failed");
        }
      }
      return {
        kind: "ok",
        value: publicRequest(stale, args.requestToken, payload),
      };
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

function browserApplyField(
  field: BrowserUserActionInputField,
  entry: SubmittedBrowserValue | undefined,
  fileContents?: BrowserUseUserActionExactTarget["fields"][number]["fileChoice"],
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
      : "observedValue" in entry
        ? { rangeChoice: entry }
        : "observedColor" in entry
          ? { colorChoice: entry }
          : "value" in entry
            ? { value: entry.value }
            : "checked" in entry
              ? {
                  checkbox: {
                    checked: entry.checked,
                    observedChecked: entry.observedChecked,
                  },
                }
              : "files" in entry
                ? fileContents
                  ? { fileChoice: fileContents }
                  : {}
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

const applyClaimedBrowserUserAction$ = command(
  async (
    { set },
    claimed: RequestRow,
    payload: Extract<BrowserUserActionPayload, { kind: "input" }>,
    submission: {
      readonly values: ReadonlyMap<string, SubmittedBrowserValue>;
      readonly fileContents:
        | BrowserUseUserActionExactTarget["fields"][number]["fileChoice"]
        | undefined;
    },
    providerSignal: AbortSignal,
  ): Promise<ServiceResult<RequestRow>> => {
    // Once claimed, every exit settles the request: a terminal state or a
    // restored pending state, each conditional on the claim still applying.
    // Provider work is cancellable; the guarded compensation writes below
    // must settle at their existing exits before cancellation propagates.
    const leased = await settleIncludingAbort(
      set(touchExactProvider$, claimed, providerSignal),
    );
    if (!leased.ok) {
      await set(restorePending$, claimed.requestTokenHash);
      throw leased.error;
    }
    if (!leased.value) {
      const terminal = await set(finalize$, claimed.requestTokenHash, "stale");
      return terminal
        ? { kind: "ok", value: terminal }
        : conflict("Browser input state changed during application");
    }
    const target = exactInputTarget(payload);
    const provider = await settleIncludingAbort(
      getBrowserUseSession(claimed.providerSessionId, providerSignal),
    );
    if (!provider.ok) {
      await set(restorePending$, claimed.requestTokenHash);
      return providerFailure(provider.error);
    }
    if (provider.value.status !== "active" || !provider.value.cdpUrl) {
      await set(restorePending$, claimed.requestTokenHash);
      return providerFailure(new Error("Browser provider is not active"));
    }
    if (
      payload.target.window &&
      !(await set(requestHasLiveBrowser$, claimed))
    ) {
      const terminal = await set(finalize$, claimed.requestTokenHash, "stale");
      return terminal
        ? { kind: "ok", value: terminal }
        : conflict("Browser input state changed during application");
    }
    const operation = await settle(
      applyBrowserUseUserAction(
        provider.value.cdpUrl,
        {
          ...target,
          ...(payload.target.window
            ? { primaryWindowId: payload.target.window.primaryWindowId }
            : {}),
          fields: payload.target.fields.map((field) => {
            return browserApplyField(
              field,
              submission.values.get(field.key),
              submission.fileContents,
            );
          }),
        },
        providerSignal,
      ),
    );
    if (!operation.ok) {
      if (
        operation.error instanceof BrowserUseUserActionMutationError &&
        operation.error.writeStarted
      ) {
        const terminal = await set(
          finalize$,
          claimed.requestTokenHash,
          "uncertain",
        );
        return terminal
          ? { kind: "ok", value: terminal }
          : conflict("Browser input state changed during application");
      }
      await set(restorePending$, claimed.requestTokenHash);
      return providerFailure(operation.error);
    }
    if (operation.value === "invalid") {
      await set(restorePending$, claimed.requestTokenHash);
      return conflict(
        "Browser input does not meet the website control constraints",
        "BROWSER_USER_ACTION_INVALID_VALUE",
      );
    }
    const terminal = await set(
      finalize$,
      claimed.requestTokenHash,
      operation.value === "succeeded" &&
        payload.target.window &&
        !(await set(requestHasLiveBrowser$, claimed))
        ? "uncertain"
        : operation.value,
    );
    providerSignal.throwIfAborted();
    return terminal
      ? { kind: "ok", value: terminal }
      : conflict("Browser input state changed during application");
  },
);

export const applyBrowserUserAction$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly requestToken: string;
      readonly input: BrowserUserActionApplyRequest;
    },
    signal: AbortSignal,
  ): Promise<ServiceResult<BrowserUserActionResponse>> => {
    const db = set(writeDb$);
    const located = await set(loadOwnedBrowserUserActionRequest$, args, signal);
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
      return conflict("Browser input has already been claimed");
    }
    const valuesResult = submittedValues(payload, args.input);
    if (valuesResult.kind === "error") {
      return valuesResult;
    }

    const submittedFile =
      payload.target.fields.length === 1
        ? valuesResult.value.get(payload.target.fields[0]!.key)
        : undefined;
    let fileContents:
      | BrowserUseUserActionExactTarget["fields"][number]["fileChoice"]
      | undefined;
    if (submittedFile && "files" in submittedFile) {
      const materialized = await settle(
        set(materializeBrowserFileChoice$, located, submittedFile, signal),
      );
      signal.throwIfAborted();
      if (!materialized.ok || !materialized.value) {
        return conflict(
          "Temporary Browser file is missing or invalid",
          "BROWSER_USER_ACTION_INVALID_VALUE",
        );
      }
      fileContents = materialized.value;
    }

    const live = await set(requestHasLiveBrowser$, located);
    signal.throwIfAborted();
    if (!live) {
      return await expiredAfterNotify(located);
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
    // A committed claim must be settled before cancellation propagates.
    if (signal.aborted) {
      if (claimed) {
        await set(restorePending$, claimed.requestTokenHash);
      }
      signal.throwIfAborted();
    }
    if (!claimed) {
      return conflict("Browser input has already been claimed");
    }
    const applied = await set(
      applyClaimedBrowserUserAction$,
      claimed,
      payload,
      { values: valuesResult.value, fileContents },
      signal,
    );
    if (applied.kind === "error") {
      signal.throwIfAborted();
      return applied;
    }
    if (
      payload.target.fields.length === 1 &&
      payload.target.fields[0]?.fieldKind === "file"
    ) {
      const cleanup = await settle(
        get(
          deleteS3Objects(
            env("R2_USER_STORAGES_BUCKET_NAME"),
            temporaryBrowserFileKeys(applied.value.requestTokenHash),
          ),
        ),
      );
      signal.throwIfAborted();
      if (!cleanup.ok) {
        L.warn("Temporary Browser file cleanup failed");
      }
    }
    signal.throwIfAborted();
    return {
      kind: "ok",
      value: publicRequest(applied.value, args.requestToken, payload),
    };
  },
);

export const cancelBrowserUserAction$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly requestToken: string;
    },
    signal: AbortSignal,
  ): Promise<ServiceResult<BrowserUserActionResponse>> => {
    const db = set(writeDb$);
    const row = await set(loadOwnedBrowserUserActionRequest$, args, signal);
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
    let current = row;
    if (current.status !== "cancelled") {
      if (!(await set(requestHasLiveBrowser$, current))) {
        return await expiredAfterNotify(current);
      }
      if (current.status !== "pending") {
        return conflict(
          "Browser user-action state no longer permits this action",
        );
      }
      const [updated] = await db
        .update(browserUserActionRequests)
        .set({
          status: "cancelled",
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
      if (!updated) {
        return conflict("Browser user-action state changed");
      }
      await publishBrowserUserActionChangedSafely(
        updated.userId,
        updated.chatThreadId,
      );
      signal.throwIfAborted();
      current = updated;
    }
    const result: ServiceResult<BrowserUserActionResponse> = {
      kind: "ok",
      value: publicRequest(current, args.requestToken, payload),
    };
    if (decodePayload(row)?.target.fields[0]?.fieldKind === "file") {
      const cleanup = await settle(
        get(
          deleteS3Objects(
            env("R2_USER_STORAGES_BUCKET_NAME"),
            temporaryBrowserFileKeys(row.requestTokenHash),
          ),
        ),
      );
      signal.throwIfAborted();
      if (!cleanup.ok) {
        L.warn("Temporary Browser file cleanup failed");
      }
    }
    return result;
  },
);
