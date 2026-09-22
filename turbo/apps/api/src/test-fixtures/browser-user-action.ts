import { createHash } from "node:crypto";

import type { BrowserUserActionState } from "@okouai/api-contracts/contracts/browser-user-actions";
import {
  browserSessionInstances,
  browserSessions,
  browserUserActionRequests,
} from "@okouai/db/schema/browser-session";
import { asc, eq, inArray } from "drizzle-orm";

import { db } from "../lib/db";

function requestTokenHash(requestToken: string): string {
  return createHash("sha256").update(requestToken).digest("hex");
}

/**
 * Infrastructure exception: an old `applying` row represents a process dying
 * after its durable claim. No production endpoint can intentionally create
 * that crash boundary, so this fixture changes only the test-owned request's
 * state and claim timestamp before the public read route performs recovery.
 */
export async function stageStuckBrowserUserActionFixture(args: {
  readonly requestToken: string;
  readonly applyStartedAt: Date;
}): Promise<void> {
  const updated = await db()
    .update(browserUserActionRequests)
    .set({
      status: "applying",
      applyStartedAt: args.applyStartedAt,
    })
    .where(
      eq(
        browserUserActionRequests.requestTokenHash,
        requestTokenHash(args.requestToken),
      ),
    )
    .returning({
      requestTokenHash: browserUserActionRequests.requestTokenHash,
    });
  if (updated.length !== 1) {
    throw new Error("Expected one Browser user-action request to be staged");
  }
}

/**
 * Infrastructure exception: retention tests need exact terminal clocks and
 * states that no public route can manufacture independently of the Browser
 * effect. The request token keeps this mutation confined to a test-owned row.
 */
export async function stageBrowserUserActionStateFixture(args: {
  readonly requestToken: string;
  readonly status: Exclude<BrowserUserActionState, "pending" | "applying">;
  readonly completedAt: Date;
}): Promise<void> {
  const updated = await db()
    .update(browserUserActionRequests)
    .set({
      status: args.status,
      completedAt: args.completedAt,
      applyStartedAt: null,
    })
    .where(
      eq(
        browserUserActionRequests.requestTokenHash,
        requestTokenHash(args.requestToken),
      ),
    )
    .returning({
      requestTokenHash: browserUserActionRequests.requestTokenHash,
    });
  if (updated.length !== 1) {
    throw new Error("Expected one Browser user-action request to be staged");
  }
}

/**
 * Infrastructure exception: public Browser routes intentionally own the
 * current clock. Retention tests stage one test-owned Browser's exact historic
 * finish boundary so the real reconciler can exercise conversion and cleanup.
 */
export async function stageBrowserUserActionClosureFixture(args: {
  readonly requestToken: string;
  readonly finishedAt: Date;
}): Promise<string> {
  const requestHash = requestTokenHash(args.requestToken);
  return await db().transaction(async (tx) => {
    const [request] = await tx
      .select({
        chatThreadId: browserUserActionRequests.chatThreadId,
        providerSessionId: browserUserActionRequests.providerSessionId,
      })
      .from(browserUserActionRequests)
      .where(eq(browserUserActionRequests.requestTokenHash, requestHash))
      .limit(1);
    if (!request) {
      throw new Error("Expected a Browser user-action request to close");
    }
    const stopped = await tx
      .update(browserSessionInstances)
      .set({
        status: "stopped",
        stopRequestedAt: args.finishedAt,
        finishedAt: args.finishedAt,
        updatedAt: args.finishedAt,
      })
      .where(
        eq(
          browserSessionInstances.providerSessionId,
          request.providerSessionId,
        ),
      )
      .returning({
        providerSessionId: browserSessionInstances.providerSessionId,
      });
    if (stopped.length !== 1) {
      throw new Error("Expected one Browser instance to be staged as stopped");
    }
    const suspended = await tx
      .update(browserSessions)
      .set({
        status: "suspended",
        suspendedAt: args.finishedAt,
        suspensionReason: "reconcile",
        updatedAt: args.finishedAt,
      })
      .where(eq(browserSessions.chatThreadId, request.chatThreadId))
      .returning({ chatThreadId: browserSessions.chatThreadId });
    if (suspended.length !== 1) {
      throw new Error("Expected one logical Browser to be staged as suspended");
    }
    return request.providerSessionId;
  });
}

export interface BrowserUserActionFixtureRow {
  readonly requestTokenHash: string;
  readonly status: BrowserUserActionState;
  readonly completedAt: Date | null;
}

/** Read only explicit test-owned request tokens for physical retention checks. */
export async function readBrowserUserActionFixtures(
  requestTokens: readonly string[],
): Promise<readonly BrowserUserActionFixtureRow[]> {
  if (requestTokens.length === 0) {
    return [];
  }
  return await db()
    .select({
      requestTokenHash: browserUserActionRequests.requestTokenHash,
      status: browserUserActionRequests.status,
      completedAt: browserUserActionRequests.completedAt,
    })
    .from(browserUserActionRequests)
    .where(
      inArray(
        browserUserActionRequests.requestTokenHash,
        requestTokens.map(requestTokenHash),
      ),
    )
    .orderBy(asc(browserUserActionRequests.requestTokenHash));
}

/** Inspect only the exact provider captured from a test-owned action row. */
export async function browserUserActionProviderExistsFixture(
  providerSessionId: string,
): Promise<boolean> {
  const [instance] = await db()
    .select({
      providerSessionId: browserSessionInstances.providerSessionId,
    })
    .from(browserSessionInstances)
    .where(eq(browserSessionInstances.providerSessionId, providerSessionId))
    .limit(1);
  return instance !== undefined;
}
