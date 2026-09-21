import { createHash } from "node:crypto";

import { browserUserActionRequests } from "@okouai/db/schema/browser-session";
import { eq } from "drizzle-orm";

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
      updatedAt: args.applyStartedAt,
    })
    .where(
      eq(
        browserUserActionRequests.requestTokenHash,
        requestTokenHash(args.requestToken),
      ),
    )
    .returning({ id: browserUserActionRequests.id });
  if (updated.length !== 1) {
    throw new Error("Expected one Browser user-action request to be staged");
  }
}
