import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { browserRoutes } from "../browser";
import {
  createSharedBrowserFixtures,
  START,
  MINUTE,
} from "./helpers/browser-shared-fixture";

const context = testContext();
const { fixture, open, view } = createSharedBrowserFixtures(context);

test("a mounted viewer renews only its current chat window without input evidence", async () => {
  const f = await fixture();
  await f.owned.run(async () => {
    const a = await f.start();
    const b = await f.start();
    const first = await open(a);
    const sibling = await open(b);
    mockNow(START + 2 * MINUTE);
    const result = await accept(
      setupApp({ context, routes: browserRoutes })(
        browserContract,
      ).leaseByThread({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: a.threadId },
        body: {},
      }),
      [200],
    );
    expect(result.body.browser.threadId).toBe(a.threadId);
    expect(result.body.browser.window).toStrictEqual(first.window);
    expect((await view(a)).idleExpiresAt).toBe(
      new Date(START + 12 * MINUTE).toISOString(),
    );
    expect((await view(b)).idleExpiresAt).toBe(sibling.idleExpiresAt);
  });
});
