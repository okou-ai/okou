import { usageRecordContract } from "@okouai/api-contracts/contracts/usage-record";
import { expect } from "vitest";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { usageRecordRoutes } from "../../usage-record";
import type { ApiTestUser } from "./api-bdd";
import { createRouteMocks } from "./route-test";

/** User-visible model credits for one owned thread, across the full response. */
export async function readThreadModelUsage(
  context: TestContext,
  actor: ApiTestUser,
  threadId: string,
): Promise<{ readonly credits: number; readonly tokens: number }> {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  const client = setupApp({ context, routes: usageRecordRoutes })(
    usageRecordContract,
  );
  let page = 1;
  let credits = 0;
  let tokens = 0;
  while (true) {
    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
        query: { scope: "mine", range: "24h", tz: "UTC", page, pageSize: 100 },
      }),
      [200],
    );
    const ownedRows = response.body.rows.filter((row) => {
      return row.threadId === threadId;
    });
    tokens += ownedRows.reduce((sum, row) => {
      return sum + row.tokens;
    }, 0);
    credits += ownedRows
      .flatMap((row) => {
        return row.breakdown;
      })
      .filter((entry) => {
        return entry.kind === "model";
      })
      .reduce((total, entry) => {
        return total + entry.credits;
      }, 0);
    if (
      page * response.body.pagination.pageSize >=
      response.body.pagination.total
    ) {
      break;
    }
    page += 1;
  }
  return { credits, tokens };
}

export async function readThreadModelCredits(
  context: TestContext,
  actor: ApiTestUser,
  threadId: string,
): Promise<number> {
  return (await readThreadModelUsage(context, actor, threadId)).credits;
}

export async function expectThreadModelCredits(
  context: TestContext,
  actor: ApiTestUser,
  threadId: string,
  expectedCredits: number,
): Promise<void> {
  await expect(readThreadModelCredits(context, actor, threadId)).resolves.toBe(
    expectedCredits,
  );
}
