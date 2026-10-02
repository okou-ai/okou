import { createHash } from "node:crypto";

import { browserUserActionRequests } from "@okouai/db/schema/browser-session";
import { eq, sql } from "drizzle-orm";

import { db } from "../lib/db";

function requestTokenHash(requestToken: string): string {
  return createHash("sha256").update(requestToken).digest("hex");
}

/**
 * Historical-data exception: the current API cannot create the retired direct
 * action variant. Convert one test-owned input row to the old payload shape so
 * the public reconciliation route can prove it removes legacy rows.
 */
export async function stageRetiredDirectBrowserUserActionFixture(
  requestToken: string,
): Promise<void> {
  const updated = await db()
    .update(browserUserActionRequests)
    .set({
      payload: sql`jsonb_build_object(
        'version', 1,
        'kind', 'direct_interaction',
        'callbackIds', ${browserUserActionRequests.payload}->'callbackIds',
        'reason', 'Complete the site challenge'
      )`,
    })
    .where(
      eq(
        browserUserActionRequests.requestTokenHash,
        requestTokenHash(requestToken),
      ),
    )
    .returning({
      requestTokenHash: browserUserActionRequests.requestTokenHash,
    });
  if (updated.length !== 1) {
    throw new Error("Expected one Browser user-action request to be staged");
  }
}
