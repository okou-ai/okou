import { and, asc, eq, exists, gt, ne, or } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import { z } from "zod";

import {
  renewErasureLease,
  type EncryptedErasureSelector,
  type ErasureHandler,
  type ErasureInventoryPage,
  type ErasureLease,
  type ErasureProof,
  type ErasureUnresolved,
} from "@okouai/db/operations/account-erasure";
import {
  browserSessionInstances,
  browserSessions,
} from "@okouai/db/schema/browser-session";
import { chatThreads } from "@okouai/db/runtime/chat-thread";

import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import { safeJsonParse, settle } from "../utils";
import {
  browserUseSessionAbsent,
  BrowserUseProviderError,
  stopBrowserUseSessionForCleanup,
} from "./browser-use.service";
import {
  decryptErasureSelector,
  encryptErasureSelector,
} from "./account-erasure-selector";

const NAMESPACE = "efc32d91-59ba-463d-8555-d7178d35aff6";
const PAGE_SIZE = 100;
export const BROWSER_SESSION_ERASURE_COLLECTOR_VERSION =
  "23917360-4419-45b2-bcf2-66db4e5d4fc2";

function ref(parts: readonly unknown[]): string {
  return uuidv5(JSON.stringify(parts), NAMESPACE);
}

function unresolved(
  code: NonNullable<ErasureUnresolved["errorCode"]>,
  outcome: ErasureUnresolved["outcome"] = "capability_unresolved",
): ErasureUnresolved {
  return { outcome, errorCode: code, requestRef: null };
}

async function selected(lease: ErasureLease) {
  if (!lease.item.selectorCiphertext || !lease.item.selectorDigest) {
    return undefined;
  }
  const selector = await decryptErasureSelector({
    ciphertext: lease.item.selectorCiphertext,
    digest: lease.item.selectorDigest,
  });
  return selector;
}

async function inventory(
  db: Db,
  lease: ErasureLease,
  cursor: EncryptedErasureSelector | null,
): Promise<ErasureInventoryPage | ErasureUnresolved> {
  const subject = await selected(lease);
  if (subject?.kind !== "subject" || subject.subjectKind !== "user") {
    return unresolved("selector_missing");
  }
  await renewErasureLease(db, lease);
  let after: string | undefined;
  if (cursor) {
    const decoded = await decryptErasureSelector(cursor);
    const parsed =
      decoded.kind === "cursor"
        ? z.uuid().safeParse(safeJsonParse(decoded.after))
        : undefined;
    if (!parsed?.success) {
      return unresolved("selector_missing");
    }
    after = parsed.data;
  }
  const ids = await readPage(db, subject.subjectId, after);
  for (const row of ids) {
    if (await otherOwnerReferences(db, row.threadId, subject.subjectId)) {
      return unresolved("ownership_unknown");
    }
  }
  const items = await Promise.all(
    ids.map(async (row) => {
      return {
        sinkId: lease.item.sinkId,
        itemKey: ref(["browser-session", row.id]),
        kind: "erase" as const,
        selector: await encryptErasureSelector({
          version: 1,
          kind: "provider",
          accountRef: ref(["browser-use", subject.subjectId]),
          subjectId: subject.subjectId,
          sourceId: row.threadId,
          resourceType: "browser_session",
          resourceId: row.id,
        }),
        dependencies: [],
      };
    }),
  );
  const last = ids.at(-1);
  return {
    pageKey: ref([
      "browser-session-page",
      lease.jobId,
      lease.captureRevision,
      after ?? null,
    ]),
    inputCursorDigest: lease.item.cursorDigest,
    nextCursor:
      ids.length < PAGE_SIZE || !last
        ? null
        : await encryptErasureSelector({
            version: 1,
            kind: "cursor",
            after: JSON.stringify(last.id),
          }),
    enumerationRef:
      ids.length < PAGE_SIZE
        ? ref([
            "browser-session-enumeration",
            subject.subjectId,
            BROWSER_SESSION_ERASURE_COLLECTOR_VERSION,
          ])
        : null,
    items,
  };
}

/** The immutable thread key outlives the nullable legacy session FK. Both
 * user-owned roots are read before either disappears. */
async function readPage(db: Db, userId: string, after?: string) {
  return await db
    .select({
      id: browserSessionInstances.providerSessionId,
      threadId: browserSessionInstances.chatThreadId,
    })
    .from(browserSessionInstances)
    .where(
      and(
        after
          ? gt(browserSessionInstances.providerSessionId, after)
          : undefined,
        or(
          exists(
            db
              .select({ id: chatThreads.id })
              .from(chatThreads)
              .where(
                and(
                  eq(chatThreads.id, browserSessionInstances.chatThreadId),
                  eq(chatThreads.userId, userId),
                ),
              ),
          ),
          exists(
            db
              .select({ id: browserSessions.id })
              .from(browserSessions)
              .where(
                and(
                  eq(
                    browserSessions.chatThreadId,
                    browserSessionInstances.chatThreadId,
                  ),
                  eq(browserSessions.userId, userId),
                ),
              ),
          ),
        ),
      ),
    )
    .orderBy(asc(browserSessionInstances.providerSessionId))
    .limit(PAGE_SIZE);
}

async function otherOwnerReferences(db: Db, threadId: string, userId: string) {
  const [otherThread] = await db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(and(eq(chatThreads.id, threadId), ne(chatThreads.userId, userId)))
    .limit(1);
  const [otherSession] = await db
    .select({ id: browserSessions.id })
    .from(browserSessions)
    .where(
      and(
        eq(browserSessions.chatThreadId, threadId),
        ne(browserSessions.userId, userId),
      ),
    )
    .limit(1);
  return Boolean(otherThread || otherSession);
}

async function sessionOf(lease: ErasureLease) {
  const selector = await selected(lease);
  return selector?.kind === "provider" &&
    selector.resourceType === "browser_session" &&
    selector.sourceId &&
    selector.accountRef === ref(["browser-use", selector.subjectId])
    ? {
        id: selector.resourceId,
        userId: selector.subjectId,
        threadId: selector.sourceId,
      }
    : undefined;
}

/** Browser Use v3 exposes stop and GET, but not per-session record deletion.
 * A stopped session may still retain history and downloads; never report
 * `verified_erased` unless an authenticated GET proves absence. */
export function createBrowserSessionErasureCollector(db: Db): ErasureHandler {
  return {
    version: BROWSER_SESSION_ERASURE_COLLECTOR_VERSION,
    inventory: async (lease, cursor) => {
      return await inventory(db, lease, cursor);
    },
    erase: async (lease, signal) => {
      const session = await sessionOf(lease);
      if (!session) {
        return unresolved("selector_missing");
      }
      await renewErasureLease(db, lease);
      if (await otherOwnerReferences(db, session.threadId, session.userId)) {
        return unresolved("ownership_unknown");
      }
      const stopped = await settle(
        stopBrowserUseSessionForCleanup(session.id, signal),
        signal,
      );
      if (!stopped.ok) {
        if (!(stopped.error instanceof BrowserUseProviderError)) {
          throw stopped.error;
        }
        return unresolved("verification_failed", "retryable_failure");
      }
      return {
        requestRef: ref([
          "browser-session-stop",
          lease.jobId,
          lease.item.itemKey,
        ]),
      };
    },
    verify: async (
      lease,
      boundary,
      signal,
    ): Promise<ErasureProof | ErasureUnresolved> => {
      const session = await sessionOf(lease);
      if (!session) {
        const subject = await selected(lease);
        if (subject?.kind !== "subject" || subject.subjectKind !== "user") {
          return unresolved("selector_missing");
        }
      } else {
        if (await otherOwnerReferences(db, session.threadId, session.userId)) {
          return unresolved("ownership_unknown");
        }
        const absent = await settle(
          browserUseSessionAbsent(session.id, signal),
          signal,
        );
        if (!absent.ok) {
          if (!(absent.error instanceof BrowserUseProviderError)) {
            throw absent.error;
          }
          return unresolved("verification_failed", "retryable_failure");
        }
        if (!absent.value) {
          // A stopped but retained provider record is an explicit residual.
          return unresolved("verification_failed");
        }
      }
      return {
        workId: lease.workId,
        sinkId: lease.item.sinkId,
        generation: lease.generation,
        captureRevision: lease.captureRevision,
        inventoryRevision: lease.inventoryRevision,
        producerBoundaryRef: boundary,
        outcome: session ? "verified_erased" : "verified_no_applicable_data",
        evidenceRef: ref([
          "browser-session-absence",
          lease.jobId,
          lease.item.itemKey,
        ]),
        authenticatedReaderRef: ref(["browser-use", "session-reader"]),
        enumerationRef: ref([
          "browser-session-item-enumeration",
          lease.item.itemKey,
        ]),
        observedAt: nowDate(),
      };
    },
  };
}
